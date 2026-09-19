// Telegram front: one advisor bot per seat, one herald bot for the world newspaper

import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { advisorGreeting, advisorReply, createCharacter } from "./agents.ts";
import { flushDevFeed } from "./devfeed.ts";
import { host } from "./host.ts";
import { playRound as runRound, roundLength } from "./round.ts";
import { persist, remember, state, type Seat } from "./store.ts";

const RULED_CIVS = (process.env.RULED_CIVS ?? "Rome,Greece").split(",").map((civ) => civ.trim());
const OTHER_CIVS = (process.env.OTHER_CIVS ?? "Egypt,China").split(",").map((civ) => civ.trim());

const advisorTokens = Object.keys(process.env)
  .filter((key) => /^ADVISOR_\d+_BOT_TOKEN$/.test(key))
  .sort()
  .map((key) => process.env[key]!);
if (!process.env.HERALD_BOT_TOKEN || advisorTokens.length === 0) throw new Error("Bot tokens missing - see .env");
if (advisorTokens.length > RULED_CIVS.length) throw new Error("More advisor bots than RULED_CIVS");

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

async function ensureGame() {
  const game = await host.state();
  const civs = RULED_CIVS.slice(0, advisors.length);
  if (!game.running) {
    await host.newGame({ ruled: civs, others: [...RULED_CIVS.slice(advisors.length), ...OTHER_CIVS] });
    log("Started a new game; ruled:", civs.join(", "));
  }
  civs.forEach((civ, index) => {
    const seat = state.seats[index];
    if (!seat || seat.civ !== civ) state.seats[index] = { civ, will: "", journal: [], chat: [], ready: false };
  });
  persist();
}

async function sendMap(bot: Bot, seat: Seat) {
  const png = await host.map(seat.civ);
  await bot.api.sendPhoto(seat.chatId!, new InputFile(png, "map.png"));
}

async function broadcastHerald(text: string) {
  for (const chatId of state.heraldChats) await herald.api.sendMessage(chatId, text).catch((error) => log("herald send failed", error.message));
}

async function playRound() {
  const seated = state.seats.filter((seat) => seat.chatId);
  const botOf = (seat: Seat) => advisors[state.seats.indexOf(seat)];
  try {
    await runRound(seated, {
      working: (seat, work) => whileTyping(botOf(seat), seat.chatId!, work),
      dispatch: async (seat, dispatch) => {
        await sendMap(botOf(seat), seat).catch((error) => log("map failed:", error.message));
        const ways = dispatch.choices.map((choice, index) => `${index + 1}. ${choice}`).join("\n");
        const keyboard = new InlineKeyboard();
        dispatch.choices.forEach((_, index) => keyboard.text(`${index + 1}`, `choice:${index}`));
        await botOf(seat).api.sendMessage(seat.chatId!, `${dispatch.text}${ways ? `\n\nWays forward:\n${ways}\n\nPick one, tell me something else, or /go and I will choose.` : ""}`, ways ? { reply_markup: keyboard } : {});
      },
      chronicle: broadcastHerald,
      log,
    });
    const game = await host.state();
    await flushDevFeed(herald, `Round to ${game.year} (turn ${game.turn})`);
    if (game.winner) await broadcastHerald(`The game is over: ${game.winner} has won a ${game.victoryType} victory.`);
  } catch (error) {
    log("Round failed:", error);
    for (const seat of seated)
      await botOf(seat).api.sendMessage(seat.chatId!, "Something went wrong while time was passing. Send /go to try again.").catch(() => {});
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
    if (isRuler(ctx)) await next();
    else await ctx.reply(`${seat().civ} already has a ruler.`);
  });

  const beginSetup = async (ctx: Context) => {
    seat().setup = [];
    persist();
    await ctx.reply(`${seat().civ} is yours to rule. Before your court assembles, three questions.`);
    await askSetupQuestion(ctx);
  };

  bot.command("start", (ctx) =>
    seat().character
      ? ctx.reply(`${seat().character!.name} is at your side, Majesty. Talk freely; time only passes when you say so or send /go.\n\n/status  /map  /usage  /character (choose a new advisor)`)
      : beginSetup(ctx),
  );

  bot.command("character", (ctx) => (state.phase === "passing" ? ctx.reply("Wait until time stops passing.") : beginSetup(ctx)));

  bot.callbackQuery(/^setup:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!seat().setup) return;
    const option = SETUP[seat().setup!.length]?.options[Number(ctx.match[1])];
    if (option) await answerSetup(ctx, option);
  });

  const dismiss = async (reply: (text: string) => Promise<unknown>, silently = false) => {
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
    const waiting = state.seats.filter((other) => other.chatId && !other.ready).map((other) => other.civ);
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
        const reply = await whileTyping(bot, ctx.chat!.id, advisorReply(seat(), message, roundLength(game.turn)));
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
    await ctx.answerCallbackQuery();
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

  bot.command("usage", (ctx) => ctx.reply(usageSummary()));

  bot.command("map", (ctx) => sendMap(bot, seat()).catch(() => ctx.reply("No map to show yet.")));

  // The first seat's ruler may start over: /newgame, then /newgame confirm
  bot.command("newgame", async (ctx) => {
    if (index !== 0) return ctx.reply("Only the ruler of the first seat may start a new game.");
    if (state.phase === "passing") return ctx.reply("Wait until time stops passing.");
    if (!/confirm/i.test(ctx.match)) return ctx.reply("This ends the current game for everyone. Send /newgame confirm to do it.");
    await host.newGame({ ruled: RULED_CIVS.slice(0, advisors.length), others: [...RULED_CIVS.slice(advisors.length), ...OTHER_CIVS] });
    for (const other of state.seats) Object.assign(other, { will: "", plan: "", journal: [], chat: [], ready: false, character: undefined, setup: undefined, choices: undefined });
    persist();
    for (const other of state.seats)
      if (other.chatId) await advisors[state.seats.indexOf(other)].api.sendMessage(other.chatId, `A new age begins, and ${other.civ} is yours. Send /start to assemble your court.`).catch(() => {});
    await broadcastHerald("A new world has been created. The Herald will report from turn one.");
  });

  bot.on("message:text", async (ctx) => {
    if (state.phase === "passing") return ctx.reply("Time is passing, Majesty - I will report as soon as there is news.");
    if (seat().setup) return answerSetup(ctx, ctx.message.text);
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
  herald.on("my_chat_member", subscribe);
  herald.on("message", subscribe);
  herald.catch((error) => log("herald error:", error.message));
}

await ensureGame();
advisors.forEach(setUpAdvisor);
setUpHerald();
// Dev feed, start of session: the settings everything below runs with
const devChat = Number(process.env.DEV_CHAT_ID) || state.heraldChats[0];
if (devChat)
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
