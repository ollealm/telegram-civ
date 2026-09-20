// Telegram front: one advisor bot per seat, one herald bot for the world newspaper

import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { advisorGreeting, advisorReply, chroniclerEpic, createCharacter } from "./agents.ts";
import { devFeedInChat, flushDevFeed } from "./devfeed.ts";
import { advisorPortrait, generateImage, onImageLog, paintedMap } from "./images.ts";
import { host } from "./host.ts";
import { playRound as runRound, roundLength } from "./round.ts";
import { persist, remember, state, type Seat } from "./store.ts";

/** Rival realms played by the game itself, chosen at random; 0 for an all-human world */
const AI_CIVS = Number(process.env.AI_CIVS ?? 2);
const MAP_SIZES = ["Tiny", "Small", "Medium", "Large", "Huge"];
const DEFAULT_MAP_SIZE = process.env.MAP_SIZE ?? "Medium";
/** Models for agent-ruled realms, dealt in turn */
const AGENT_MODELS = (process.env.AGENT_MODELS ?? "claude-opus-5,claude-sonnet-5").split(",").map((model) => model.trim());
/** How the game's own peoples are handicapped; rulers' realms always get the player's side of the scale */
const DIFFICULTIES: Record<string, string> = { Even: "Prince", Easy: "Warlord", Gentle: "Chieftain", Hard: "King" };
const CITY_STATES: Record<string, number> = { Tiny: 2, Small: 4, Medium: 6, Large: 8, Huge: 10 };

const advisorTokens = Object.keys(process.env)
  .filter((key) => /^ADVISOR_\d+_BOT_TOKEN$/.test(key))
  .sort()
  .map((key) => process.env[key]!);
if (!process.env.HERALD_BOT_TOKEN || advisorTokens.length === 0) throw new Error("Bot tokens missing - see .env");

const herald = new Bot(process.env.HERALD_BOT_TOKEN);
const advisors = advisorTokens.map((token) => new Bot(token));

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

/** Show "typing…" for as long as the work takes */
async function whileTyping<T>(bot: Bot, chatId: number, work: Promise<T>): Promise<T> {
  const tick = () => bot.api.sendChatAction(chatId, "typing").catch(() => {});
  tick();
  const timer = setInterval(tick, 4500);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

const blankSeat = (): Seat => ({ civ: "", will: "", journal: [], chat: [], ready: false });

/** One seat per advisor bot. With no world yet, the rulers first choose their peoples (the setup phase). */
async function ensureGame() {
  const game = await host.state();
  // Seats are dealt by /newgame (one per human ruler); only a first-ever run deals one to every advisor bot
  if (state.seats.length === 0) advisors.forEach((_, index) => (state.seats[index] = game.running && game.ruled[index] ? { ...blankSeat(), civ: game.ruled[index] } : blankSeat()));
  if (!game.running || state.seats.some((seat) => !seat.civ)) state.phase = "setup";
  persist();
}

const shuffled = <T,>(items: T[]) => items.map((item) => [Math.random(), item] as const).sort((a, b) => a[0] - b[0]).map(([, item]) => item);

/** Every ruler has chosen a people: make the world */
async function createWorld() {
  const nations = await host.nations();
  for (const seat of state.seats.filter((other) => other.kind === "agent")) {
    const taken = state.seats.map((other) => other.civ).filter(Boolean);
    seat.civ ||= shuffled(nations.filter((nation) => !taken.includes(nation.name)))[0].name;
    seat.character ??= await createCharacter(seat, [
      { question: "What kind of sovereign rules this people?", answer: "Someone unexpected, with a clear ambition of their own" },
      { question: "How do they rule?", answer: "Alone and decisively - there is no one above them" },
    ]).then((character) => ({ ...character, autonomy: "bold" as const }));
    log(`${seat.civ} is ruled by ${seat.character?.name} (${seat.model})`);
  }
  const ruled = state.seats.map((seat) => seat.civ);
  const free = shuffled((await host.nations()).map((nation) => nation.name).filter((name) => !ruled.includes(name)));
  const others = free.slice(0, state.aiCivs ?? AI_CIVS);
  const mapSize = state.mapSize ?? DEFAULT_MAP_SIZE;
  await host.newGame({ ruled, others, mapSize, cityStates: CITY_STATES[mapSize] ?? 6, difficulty: state.difficulty ?? "Prince" });
  state.phase = "audience";
  persist();
  log(`New world: ${mapSize}; ruled ${ruled.join(", ")}; AI ${others.join(", ") || "none"}`);
  const overview = `A new world has been made: a ${mapSize.toLowerCase()} one, home to ${ruled.length + others.length} great peoples and ${CITY_STATES[mapSize] ?? 6} lesser cities. ${state.seats.filter((seat) => seat.kind !== "agent").map((seat) => seat.civ).join(" and ")} answer to rulers at this table${state.seats.some((seat) => seat.kind === "agent") ? `; ${state.seats.filter((seat) => seat.kind === "agent").map((seat) => `${seat.civ} is ruled by ${seat.character?.name}`).join(", ")}, who answer to no one` : ""}${others.length ? `; ${others.length} more peoples keep their own counsel, somewhere beyond the horizon` : ""}. History begins in 4000 BC.`;
  await broadcastHerald(overview);
  for (const seat of state.seats)
    if (seat.chatId) await advisors[state.seats.indexOf(seat)].api.sendMessage(seat.chatId, `The world is made, Majesty, and ${seat.civ} stands at its beginning. Tell me what you want this realm to become - and when we are done, /go.`).catch(() => {});
}

onImageLog((message) => log(message));

/** /map: our own drawing at once (the painted one comes with each dispatch) */
async function sendMap(bot: Bot, seat: Seat) {
  const png = await host.map(seat.civ);
  await bot.api.sendPhoto(seat.chatId!, new InputFile(png, "map.png"));
}

async function broadcastHerald(text: string) {
  for (const chatId of state.heraldChats) await herald.api.sendMessage(chatId, text).catch((error) => log("herald send failed", error.message));
}

/** Seats whose realm still stands - only these hold audiences and are waited for */
async function standing() {
  const alive = new Set((await host.state()).majorCivs.filter((civ) => civ.alive).map((civ) => civ.civ));
  return state.seats.filter((seat) => seat.chatId && alive.has(seat.civ));
}

async function sendEpic(occasion: string) {
  const [events, game] = await Promise.all([host.events(), host.state()]);
  const standings = game.majorCivs.map((civ) => `${civ.civ}: ${civ.alive ? "stands" : "has fallen"}`).join("\n");
  const spoken = (state.proclaimed ?? []).map((entry) => ({ turn: entry.turn, year: entry.year, text: `Proclaimed: ${entry.text}` }));
  const history = [...events, ...spoken].sort((a, b) => a.turn - b.turn);
  await broadcastHerald(await chroniclerEpic(history, standings, occasion));
}

async function playRound() {
  const seated = state.seats.filter((seat) => seat.chatId || seat.kind === "agent");
  const botOf = (seat: Seat) => advisors[state.seats.indexOf(seat)];
  try {
    await runRound(seated, {
      working: (seat, work) => (seat.chatId ? whileTyping(botOf(seat), seat.chatId, work) : work),
      dispatch: async (seat, dispatch) => {
        const bot = botOf(seat);
        const letter = [dispatch.text, dispatch.strategy && `Where this is heading: ${dispatch.strategy}`, dispatch.question].filter(Boolean).join("\n\n");
        await bot.api.sendMessage(seat.chatId!, letter);
        // Pictures follow the letter instead of holding it up: a scene from the realm, then the painted map
        if (dispatch.image)
          void generateImage(`${dispatch.image.description}\n\nRealistic oil painting of the period, no text or lettering.`)
            .then((png) => png && bot.api.sendPhoto(seat.chatId!, new InputFile(png, "scene.png"), { caption: dispatch.image!.caption }))
            .catch((error) => log("scene failed:", error.message));
        if (dispatch.strategy) void paintedMap(seat.civ).then((png) => bot.api.sendPhoto(seat.chatId!, new InputFile(png, "map.png"))).catch((error) => log("map failed:", error.message));
      },
      notice: async (seat, text) => void (await botOf(seat).api.sendMessage(seat.chatId!, text).catch(() => {})),
      chronicle: async (chapter, images, round) => {
        await broadcastHerald(chapter);
        for (const image of images)
          void generateImage(`${image.description}\n\nThe year is ${round.year}. Realistic oil painting of the period, no text or lettering.`).then(async (png) => {
            if (png) for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png, "scene.png"), { caption: image.caption }).catch(() => {});
          });
      },
      log,
    });
    const game = await host.state();
    // A realm that fell this round: its ruler is told once, and the world gets the epic so far
    for (const seat of seated) {
      const fell = !game.majorCivs.find((civ) => civ.civ === seat.civ)?.alive;
      if (fell && !seat.fallen) {
        seat.fallen = true;
        if (seat.chatId) await botOf(seat).api.sendMessage(seat.chatId!, `${seat.civ} is no more, Majesty. Its cities belong to others now, and I have no realm left to counsel. History will remember what you said and did - the Chronicler's pages are in the other chat. It was an honour.`).catch(() => {});
        void sendEpic(`${seat.civ} has just fallen, and an age ends with it.`).catch((error) => log("epic failed:", error.message));
      }
    }
    persist();
    await flushDevFeed(herald, `Round to ${game.year} (turn ${game.turn})${state.pendingRound ? " - interrupted by urgent news" : ""}`);
    // Urgent news that concerns no ruler still at the table (a realm fell): nobody needs to hold council, so time moves on
    if (state.pendingRound && !game.winner && (await standing()).every((seat) => seat.ready)) return void playRound();
    if (game.winner) await broadcastHerald(`The game is over: ${game.winner} has won a ${game.victoryType} victory.`);
  } catch (error) {
    log("Round failed:", error);
    for (const seat of seated)
      if (seat.chatId) await botOf(seat).api.sendMessage(seat.chatId, "Something went wrong while time was passing. Send /go to try again.").catch(() => {});
  }
}

function usageSummary() {
  const rows = Object.entries(state.usage).map(
    ([role, usage]) =>
      `${role}: ${usage.calls} calls, ${Math.round(usage.inputTokens / 1000)}k in / ${Math.round(usage.outputTokens / 1000)}k out, $${usage.costUsd.toFixed(2)}`,
  );
  const total = Object.values(state.usage).reduce((sum, usage) => sum + usage.costUsd, 0);
  return rows.length ? `${rows.join("\n")}\nTotal: $${total.toFixed(2)} (API-price equivalent)` : "No usage yet.";
}

/** The setup round: a few questions whose answers become the advisor's character - different every game */
const SETUP = [
  { question: "What kind of reign shall this be?", options: ["A golden age of builders and scholars", "An empire won by the sword", "A web of trade and alliances", "Surprise me"] },
  { question: "Who do you want at your side?", options: ["A blunt old soldier", "A silver-tongued courtier", "A dry, bookish scholar", "Someone unexpected"] },
  { question: "When you are away, how much may your advisor decide alone?", options: ["Keep things steady and ask me", "Use your judgement", "Run the realm and tell me after"] },
];

function setUpAdvisor(bot: Bot, index: number) {
  const seat = (): Seat => state.seats[index];
  let queue: Promise<unknown> = Promise.resolve();

  /** First of all: which people? Four drawn at random, fate, or any people named in the ruler's own words */
  const askForPeople = async (ctx: Context) => {
    const taken = state.seats.map((other) => other.civ).filter(Boolean);
    const drawn = shuffled((await host.nations()).filter((nation) => !taken.includes(nation.name))).slice(0, 4);
    const keyboard = new InlineKeyboard();
    drawn.forEach((nation) => keyboard.text(`${nation.name} (${nation.leader})`, `people:${nation.name}`).row());
    keyboard.text("Let fate decide", "people:?");
    await ctx.reply("Which people will you lead?\n\n(Pick one, or name any people you like - Persia, the Aztecs, Sweden...)", { reply_markup: keyboard });
  };

  const choosePeople = async (ctx: Context, wish: string) => {
    const taken = state.seats.map((other) => other.civ).filter(Boolean);
    const nations = (await host.nations()).filter((nation) => !taken.includes(nation.name));
    const clean = wish.trim().toLowerCase().replace(/^the\s+/, "");
    const chosen = wish === "?" ? shuffled(nations)[0]
      : nations.find((nation) => nation.name.toLowerCase() === clean) ?? nations.find((nation) => nation.name.toLowerCase().startsWith(clean.slice(0, 4)) || nation.leader.toLowerCase().includes(clean));
    if (!chosen) return ctx.reply(`I know of no free people by that name. Try one of: ${shuffled(nations).slice(0, 8).map((nation) => nation.name).join(", ")}...`);
    seat().civ = chosen.name;
    persist();
    await ctx.reply(`${chosen.name} it is - the people of ${chosen.leader}.`);
    await askSetupQuestion(ctx);
  };

  const askSetupQuestion = async (ctx: Context) => {
    const step = SETUP[seat().setup!.length];
    const keyboard = new InlineKeyboard();
    step.options.forEach((option, optionIndex) => keyboard.text(option, `setup:${optionIndex}`).row());
    await ctx.reply(`${step.question}\n\n(Pick one, or answer in your own words.)`, { reply_markup: keyboard });
  };

  const answerSetup = async (ctx: Context, answer: string) => {
    seat().setup!.push(answer);
    persist();
    if (seat().setup!.length < SETUP.length) return askSetupQuestion(ctx);
    const answers = SETUP.map((step, stepIndex) => ({ question: step.question, answer: seat().setup![stepIndex] }));
    try {
      seat().character = await whileTyping(bot, ctx.chat!.id, createCharacter(seat(), answers));
      seat().setup = undefined;
      persist();
      const greeting = await whileTyping(bot, ctx.chat!.id, advisorGreeting(seat()));
      remember(seat(), { from: "advisor", text: greeting });
      await ctx.reply(`${greeting}\n\n— ${seat().character!.name}\n\nTalk to me freely; time only passes when you say so or send /go.  /status  /map  /usage`);
      await flushDevFeed(herald, `Character for ${seat().civ}: ${seat().character!.name}`, [`autonomy: ${seat().character!.autonomy}`]);
      if (state.phase === "setup") {
        const missing = state.seats.filter((other) => other.kind !== "agent" && (!other.civ || !other.character)).length;
        if (missing === 0) await createWorld();
        else await ctx.reply(`The world will be made once every ruler has assembled a court - ${missing} still to come.`);
      }
      const era = String((await host.briefing(seat().civ).catch(() => ({ era: "Ancient era" }))).era);
      void advisorPortrait(seat().civ, seat().character!.sheet, era).then((png) => png && ctx.replyWithPhoto(new InputFile(png, "portrait.png"), { caption: seat().character!.name })).catch(() => {});
    } catch (error) {
      log("character creation failed:", error);
      seat().setup = undefined;
      await ctx.reply("Your advisor is delayed on the road. Send /start to try again.");
    }
  };

  /** Only the first person to speak to this advisor becomes its ruler */
  const isRuler = (ctx: Context) => {
    if (ctx.chat?.type !== "private") return false;
    if (seat().chatId === undefined) {
      seat().chatId = ctx.chat.id;
      seat().rulerName = ctx.from?.first_name;
      persist();
      log(`${seat().civ} is now ruled by ${seat().rulerName}`);
    }
    return seat().chatId === ctx.chat.id;
  };

  bot.use(async (ctx, next) => {
    if (!seat()) return void (await ctx.reply("This advisor has no seat in the current game."));
    if (isRuler(ctx)) await next();
    else await ctx.reply(`${seat().civ} already has a ruler.`);
  });

  const beginSetup = async (ctx: Context) => {
    seat().setup = [];
    persist();
    if (!seat().civ) {
      await ctx.reply("A new history is about to begin. Before your court assembles, a few questions.");
      return askForPeople(ctx);
    }
    await ctx.reply(`${seat().civ} is yours to rule. Before your court assembles, three questions.`);
    await askSetupQuestion(ctx);
  };

  bot.command("start", (ctx) =>
    seat().character
      ? ctx.reply(`${seat().character!.name} is at your side, Majesty. Talk freely; time only passes when you say so or send /go.\n\n/status  /map  /usage  /character (choose a new advisor)`)
      : beginSetup(ctx),
  );

  bot.command("character", (ctx) => (state.phase === "passing" ? ctx.reply("Wait until time stops passing.") : beginSetup(ctx)));

  bot.callbackQuery(/^people:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (seat().setup && !seat().civ) await choosePeople(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^setup:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {}); // a press from before a restart is too old to acknowledge, but still counts
    if (!seat().setup) return;
    const option = SETUP[seat().setup!.length]?.options[Number(ctx.match[1])];
    if (option) await answerSetup(ctx, option);
  });

  const dismiss = async (reply: (text: string) => Promise<unknown>, silently = false) => {
    if (seat().fallen) return reply(`${seat().civ} is no more, Majesty.`);
    if (state.phase === "setup") return reply("The world is not made yet - it begins once every ruler has assembled a court (/start).");
    if (state.phase === "passing") return reply("Time is already passing, Majesty.");
    // Dismissed without answering the advisor's last question: silence is assent to what it recommended
    const last = seat().chat.at(-1);
    if (silently && last?.from === "advisor" && (seat().choices?.length || /\?/.test(last.text))) {
      const message = "[The ruler dismisses the court without another word. The choice is yours now: pick among the ways forward you offered (or act on your last recommendation) as your character and the ruler's will suggest - a cautious advisor takes the safest, a bold one the one they believe in. Apply it, update your plan, and say in one or two sentences which way you went and why.]";
      try {
        const answer = await whileTyping(bot, seat().chatId!, advisorReply(seat(), message, roundLength((await host.state()).turn)));
        remember(seat(), { from: "advisor", text: answer });
        seat().choices = undefined;
        await reply(answer);
      } catch (error) {
        log("closing pass failed:", error);
      }
    }
    seat().ready = true;
    seat().dismissed = false;
    persist();
    const waiting = (await standing()).filter((other) => !other.ready).map((other) => other.civ);
    if (waiting.length) return reply(`The court is dismissed. Waiting for the ruler of ${waiting.join(", ")}.`);
    await reply("The court is dismissed. Time passes…");
    for (const other of state.seats)
      if (other !== seat() && other.chatId) await advisors[state.seats.indexOf(other)].api.sendMessage(other.chatId, "All rulers have dismissed their courts. Time passes…");
    void playRound();
  };

  bot.command("go", (ctx) => dismiss((text) => ctx.reply(text), true));

  /** One audience at a time per seat, so replies stay in order */
  const audience = (ctx: Context, message: string) => {
    queue = queue.then(async () => {
      try {
        const game = await host.state();
        const raw = await whileTyping(bot, ctx.chat!.id, advisorReply(seat(), message, roundLength(game.turn)));
        // The closing carries two lines meant for us, not the ruler: a picture of the decision, and words for the Chronicler
        const image = /^IMAGE:\s*(.+?)\s*\|\s*(.+)$/m.exec(raw);
        const proclamation = /^PROCLAMATION:\s*(.+)$/m.exec(raw)?.[1].trim();
        const reply = raw.replace(/^(IMAGE|PROCLAMATION):.*\n?/gm, "").replace(/\n{3,}/g, "\n\n").trim();
        if (proclamation && !/^\(?none|^-$/i.test(proclamation)) (seat().proclamations ??= []).push(proclamation);
        if (image)
          void generateImage(`${image[2]}\n\nRealistic oil painting of the period, no text or lettering.`)
            .then((png) => png && bot.api.sendPhoto(ctx.chat!.id, new InputFile(png, "decision.png"), { caption: image[1] }))
            .catch((error) => log("decision image failed:", error.message));
        remember(seat(), { from: "ruler", text: message });
        remember(seat(), { from: "advisor", text: reply });
        seat().choices = undefined;
        await ctx.reply(reply);
        await flushDevFeed(herald, `Audience - ${seat().civ}`);
        if (seat().dismissed) await dismiss((text) => ctx.reply(text));
      } catch (error) {
        log("advisor failed:", error);
        await ctx.reply("Forgive me, Majesty, I lost my train of thought. Could you say that again?");
      }
    });
  };

  bot.callbackQuery(/^choice:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {}); // a press from before a restart is too old to acknowledge, but still counts
    const choice = seat().choices?.[Number(ctx.match[1])];
    if (!choice) return void ctx.reply("That moment has passed, Majesty - tell me what you want now.");
    if (state.phase === "passing") return void ctx.reply("Time is passing, Majesty.");
    await ctx.reply(`You chose: ${choice}`);
    audience(ctx, `I choose this way forward: "${choice}". Make it so, and tell me briefly what you are setting in motion.`);
  });

  bot.command("status", async (ctx) => {
    const game = await host.state();
    const ready = state.seats.filter((other) => other.chatId).map((other) => `${other.civ}: ${other.ready ? "ready" : "in audience"}`);
    await ctx.reply(`${game.year} (turn ${game.turn}). ${state.phase === "passing" ? "Time is passing." : ready.join(", ")}\n\nYour recorded will:\n${seat().will || "(none yet)"}`);
  });

  // The record the advisor governs by while the ruler is away - theirs to read, and to correct by saying so in the audience
  bot.command("will", (ctx) => ctx.reply(`What ${seat().character?.name ?? "your advisor"} has written down as your standing wishes, and governs by while you are away. "My reading" lines are the advisor's guesses - tell them if one is wrong or has had its day.\n\n${seat().will || "(nothing recorded yet)"}`));

  bot.command("usage", (ctx) => ctx.reply(usageSummary()));

  bot.command("map", (ctx) => sendMap(bot, seat()).catch(() => ctx.reply("No map to show yet.")));

  // The first seat's ruler may start over: /newgame asks how many rulers, how many rival peoples, how large a world
  if (index === 0) {
    const draft: { humans?: number; agents?: number; ai?: number; difficulty?: string; size?: string } = {};
    const row = (keyboard: InlineKeyboard, prefix: string, values: (string | number)[]) => values.forEach((value) => keyboard.text(String(value), `ng:${prefix}:${value}`));

    bot.command("newgame", async (ctx) => {
      if (state.phase === "passing") return ctx.reply("Wait until time stops passing.");
      const keyboard = new InlineKeyboard();
      row(keyboard, "humans", advisors.map((_, seatIndex) => seatIndex + 1));
      await ctx.reply(`A new world, then. This ends the current game for everyone - nothing changes until you confirm at the end.\n\nHow many rulers will sit at the table? (There are ${advisors.length} advisor bots.)`, { reply_markup: keyboard });
    });

    bot.callbackQuery(/^ng:(humans|agents|ai|difficulty|size|confirm|cancel):?(.*)$/, async (ctx) => {
      await ctx.answerCallbackQuery().catch(() => {});
      const [, step, value] = ctx.match;
      if (step === "cancel") return void ctx.editMessageText("The old world carries on.");
      if (step === "humans") {
        draft.humans = Number(value);
        const keyboard = new InlineKeyboard();
        row(keyboard, "agents", [0, 1, 2, 3, 4]);
        return void ctx.editMessageText(`${draft.humans} ruler${draft.humans === 1 ? "" : "s"}. How many realms should be ruled by an advisor alone, with no human above them? They play under the same limits as yours. (Models, in turn: ${AGENT_MODELS.join(", ")})`, { reply_markup: keyboard });
      }
      if (step === "agents") {
        draft.agents = Number(value);
        const keyboard = new InlineKeyboard();
        row(keyboard, "ai", [0, 1, 2, 3, 4, 5, 6]);
        return void ctx.editMessageText(`${draft.agents} advisor-ruled realm${draft.agents === 1 ? "" : "s"}. How many peoples should the game itself play? (0 for none)`, { reply_markup: keyboard });
      }
      if (step === "ai") {
        draft.ai = Number(value);
        if (draft.ai > 0) {
          const keyboard = new InlineKeyboard();
          row(keyboard, "difficulty", Object.keys(DIFFICULTIES));
          return void ctx.editMessageText(`${draft.ai} people${draft.ai === 1 ? "" : "s"} played by the game. How should they be matched? Even is level terms and the usual choice; Easy and Gentle slow them down and help the ruled realms; Hard favours them.`, { reply_markup: keyboard });
        }
      }
      if (step === "ai" || step === "difficulty") {
        if (step === "difficulty") draft.difficulty = DIFFICULTIES[value];
        const keyboard = new InlineKeyboard();
        row(keyboard, "size", MAP_SIZES);
        const crowd = draft.humans! + (draft.agents ?? 0) + draft.ai!;
        return void ctx.editMessageText(`How large a world for ${crowd} peoples? (Small suits up to 4, Medium 6, Large 8.)`, { reply_markup: keyboard });
      }
      if (step === "size") {
        draft.size = value;
        const keyboard = new InlineKeyboard().text("Make it so", "ng:confirm").text("Keep the old world", "ng:cancel");
        return void ctx.editMessageText(`A ${value.toLowerCase()} world with ${draft.humans} ruler${draft.humans === 1 ? "" : "s"}, ${draft.agents ?? 0} advisor-ruled realm${draft.agents === 1 ? "" : "s"}, ${draft.ai} people${draft.ai === 1 ? "" : "s"} played by the game and ${CITY_STATES[value] ?? 6} lesser cities. Each ruler then chooses a people and assembles a court. The current game ends for everyone.`, { reply_markup: keyboard });
      }
      if (state.phase === "passing" || !draft.humans || !draft.size) return void ctx.editMessageText("Send /newgame to begin again.");
      const before = state.seats;
      state.seats = [
        ...Array.from({ length: draft.humans }, (_, seatIndex) => ({ ...blankSeat(), chatId: before[seatIndex]?.chatId, rulerName: before[seatIndex]?.rulerName })),
        ...Array.from({ length: draft.agents ?? 0 }, (_, agentIndex) => ({ ...blankSeat(), kind: "agent" as const, model: AGENT_MODELS[agentIndex % AGENT_MODELS.length] })),
      ];
      state.difficulty = draft.difficulty;
      state.proclaimed = [];
      state.pendingRound = undefined;
      state.mapSize = draft.size;
      state.aiCivs = draft.ai ?? AI_CIVS;
      state.phase = "setup";
      persist();
      await ctx.editMessageText(`So be it: a ${draft.size.toLowerCase()} world, ${draft.humans} ruler${draft.humans === 1 ? "" : "s"}, ${state.aiCivs} rival peoples.`);
      for (const [seatIndex, other] of state.seats.entries())
        if (other.chatId) await advisors[seatIndex].api.sendMessage(other.chatId, "A new history is about to begin. Send /start to choose your people and assemble your court.").catch(() => {});
    });
  } else bot.command("newgame", (ctx) => ctx.reply("Only the ruler of the first seat may start a new game."));

  bot.on("message:text", async (ctx) => {
    if (seat().fallen) return ctx.reply(`${seat().civ} is no more, Majesty. Only the Chronicler writes of it now.`);
    if (state.phase === "passing") return ctx.reply("Time is passing, Majesty - I will report as soon as there is news.");
    if (seat().setup && !seat().civ) return choosePeople(ctx, ctx.message.text);
    if (seat().setup) return answerSetup(ctx, ctx.message.text);
    if (state.phase === "setup") return seat().character ? ctx.reply("The world is not made yet, Majesty - it begins once every ruler has assembled a court.") : beginSetup(ctx);
    if (!seat().character && seat().chat.length === 0) return beginSetup(ctx);
    audience(ctx, ctx.message.text);
  });

  bot.catch((error) => log(`advisor ${index + 1} error:`, error.message));
}

function setUpHerald() {
  const subscribe = async (ctx: Context) => {
    if (!ctx.chat || state.heraldChats.includes(ctx.chat.id)) return;
    state.heraldChats.push(ctx.chat.id);
    persist();
    log("Herald now publishes to chat", ctx.chat.id);
    await ctx.reply("The Herald will deliver every edition of the world's news here.");
  };
  herald.command("epic", async (ctx) => {
    await subscribe(ctx);
    await ctx.replyWithChatAction("typing").catch(() => {});
    await sendEpic("A reader has asked for the story so far.").catch((error) => log("epic failed:", error.message));
  });
  herald.on("my_chat_member", subscribe);
  herald.on("message", subscribe);
  herald.catch((error) => log("herald error:", error.message));
}

await ensureGame();
advisors.forEach(setUpAdvisor);
setUpHerald();
// Dev feed, start of session: the settings everything below runs with
const devChat = Number(process.env.DEV_CHAT_ID) || state.heraldChats[0];
if (devChat && devFeedInChat())
  void host.state().then((game) =>
    herald.api.sendMessage(devChat, [
      "🛠 Session started",
      `game: ${game.year} (turn ${game.turn}); ruled ${game.ruled.join(", ")}; others ${game.majorCivs.map((civ) => civ.civ).filter((civ) => !game.ruled.includes(civ)).join(", ") || "none"}`,
      `models: advisor ${process.env.ADVISOR_MODEL ?? "claude-opus-5"}, govern ${process.env.GOVERN_MODEL ?? process.env.ADVISOR_MODEL ?? "claude-opus-5"}, chronicler ${process.env.HERALD_MODEL ?? process.env.ADVISOR_MODEL ?? "claude-opus-5"}`,
      `rounds: ${process.env.TURNS_PER_ROUND ?? 12} turns (${process.env.EARLY_ROUND_TURNS ?? 24} before turn ${process.env.EARLY_GAME_UNTIL_TURN ?? 48}), govern every ${process.env.GOVERN_EVERY_TURNS ?? 4}`,
      ...state.seats.map((seat) => `${seat.civ}: ${seat.character ? `${seat.character.name} (${seat.character.autonomy})` : "no character yet - /start"}`),
      "Full prompts arrive as .md files after each audience and round.",
    ].join("\n")).catch(() => {}),
  );

for (const bot of [herald, ...advisors]) void bot.start({ onStart: (me) => log(`@${me.username} is listening`) });
