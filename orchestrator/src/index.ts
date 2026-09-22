// Telegram front: one advisor bot per seat, one herald bot for the world newspaper

import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { advisorGreeting, advisorReply, chroniclerEpic, clerkReply, draftClerk, pronounLine, realmSaga, withPlates, wonderBoon } from "./agents.ts";
import { card, draftCandidates, draftSovereign } from "./characters.ts";

const ADVISOR_MODEL = process.env.ADVISOR_MODEL ?? "claude-opus-5";
import { devFeedInChat, flushDevFeed } from "./devfeed.ts";
import { advisorPortrait, generateImage, imagesIdle, onImageLog, paintedMap } from "./images.ts";
import { host, type RoundResult } from "./host.ts";
import { playRound as runRound, roundLength } from "./round.ts";
import { forgetPicture, persist, recordPicture, remember, state, type Picture, type Seat } from "./store.ts";

/** Rival realms played by the game itself, chosen at random; 0 for an all-human world */
const AI_CIVS = Number(process.env.AI_CIVS ?? 2);
const MAP_SIZES = ["Tiny", "Small", "Medium", "Large", "Huge"];
const DEFAULT_MAP_SIZE = process.env.MAP_SIZE ?? "Medium";
/** Models for agent-ruled realms, dealt in turn */
const AGENT_MODELS = (process.env.AGENT_MODELS ?? "claude-sonnet-5").split(",").map((model) => model.trim());
/** How the game's own peoples are handicapped; rulers' realms always get the player's side of the scale */
const DIFFICULTIES: Record<string, string> = { Even: "Prince", Easy: "Warlord", Gentle: "Chieftain", Hard: "King" };
const WONDERS: Record<string, "all" | "rulers" | "advised"> = { Everyone: "all", "Rulers only": "rulers", "Rulers and sovereigns": "advised" };
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
    seat.character ??= await draftSovereign(seat.civ, seat.model ?? ADVISOR_MODEL).then(({ name, title, sheet }) => ({ name, title, sheet }));
    log(`${seat.civ} is ruled by ${seat.character?.name} (${seat.model})`);
  }
  const ruled = state.seats.map((seat) => seat.civ);
  const free = shuffled((await host.nations()).map((nation) => nation.name).filter((name) => !ruled.includes(name)));
  const others = free.slice(0, state.aiCivs ?? AI_CIVS);
  const mapSize = state.mapSize ?? DEFAULT_MAP_SIZE;
  const noWonders = state.wonders === "rulers" ? [...state.seats.filter((seat) => seat.kind === "agent").map((seat) => seat.civ), ...others]
    : state.wonders === "advised" ? others : [];
  await host.newGame({ ruled, others, noWonders, mapSize, cityStates: CITY_STATES[mapSize] ?? 6, difficulty: state.difficulty ?? "Prince" });
  state.phase = "audience";
  persist();
  log(`New world: ${mapSize}; ruled ${ruled.join(", ")}; AI ${others.join(", ") || "none"}`);
  const overview = `A new world has been made: a ${mapSize.toLowerCase()} one, home to ${ruled.length + others.length} great peoples and ${CITY_STATES[mapSize] ?? 6} lesser cities. ${state.seats.filter((seat) => seat.kind !== "agent").map((seat) => seat.civ).join(" and ")} answer to rulers at this table${state.seats.some((seat) => seat.kind === "agent") ? `; ${state.seats.filter((seat) => seat.kind === "agent").map((seat) => `${seat.civ} is ruled by ${seat.character?.name}`).join(", ")}, who answer to no one` : ""}${others.length ? `; ${others.length} more peoples keep their own counsel, somewhere beyond the horizon` : ""}. History begins in 4000 BC.`;
  await broadcastHerald(overview);
  for (const seat of state.seats)
    if (seat.chatId) await advisors[state.seats.indexOf(seat)].api.sendMessage(seat.chatId, `The world is made, Majesty, and ${seat.civ} stands at its beginning. Tell me what you want this realm to become; we have all the time we need, for no year passes until you give the word.`).catch(() => {});
}

onImageLog((message) => log(message));

/** The painted map costs a picture a round for every ruler; PAINTED_MAPS=off leaves it out (the march map comes either way) */
const PAINTED_MAPS = process.env.PAINTED_MAPS !== "off";
const HOLD_FOR_PICTURES = process.env.HOLD_FOR_PICTURES === "on";

/** Every picture goes through here: noted in the ledger first, so that whoever describes the next one knows not to ask for it again */
/** Paints and returns the picture (or null), keeping the ledger honest either way */
async function paintAndKeep(picture: Picture): Promise<Buffer | null> {
  recordPicture(picture);
  const png = await generateImage(`${picture.description}\n\nThe year is ${picture.year}. Realistic oil painting of the period, no text or lettering.`).catch((error) => { log(`picture failed (${picture.caption}):`, error.message); return null; });
  if (!png) forgetPicture(picture);
  return png;
}

function paint(picture: Picture, send: (png: Buffer) => Promise<unknown>) {
  recordPicture(picture);
  void generateImage(`${picture.description}\n\nThe year is ${picture.year}. Realistic oil painting of the period, no text or lettering.`)
    .then((png) => (png ? send(png) : forgetPicture(picture)))
    .catch((error) => log(`picture failed (${picture.caption}):`, error.message));
}

/** A completed wonder always gets its picture - once */
const wonderPictures = (round: RoundResult): Picture[] =>
  round.publicEvents.flatMap((event) => {
    const [, civ, wonder, site] = /^(.+?) completed the wonder (.+?)(?: in (.+?))?\.?$/.exec(event.text) ?? [];
    if (!wonder || (state.pictures ?? []).some((picture) => picture.for === "chronicle" && picture.caption.startsWith(`${wonder},`))) return [];
    return [{ turn: event.turn, year: event.year, for: "chronicle", caption: `${wonder}, completed by ${civ} in ${event.year}`,
      description: `${wonder}, newly completed by the ${civ}${site ? ` in their city of ${site}` : ""}, as a painter of the period would have shown it. This is NOT the wonder of that name as it stands in our world: it is the ${civ}' own version, raised by ${civ} builders in ${civ} lands - so the great work takes their forms, materials and ornament, and stands in ${site ? `${site.split(" (")[0]} itself, among that city's houses, walls and people` : "one of their cities"}, with the land as described${site ? ` (${site.split(" (")[1]?.replace(/\)$/, "") ?? ""})` : ""}. The city must be recognisably the ${civ}' - its roofs, dress and crowds are theirs - and the wonder recognisably itself, transformed by their hands. From a vantage that shows its scale, in the light of a particular hour, with builders, priests or crowds in the dress of the age.` }];
  });

/** /map: our own drawing at once (the painted one comes with each dispatch) */
async function sendMap(bot: Bot, seat: Seat) {
  const png = await host.map(seat.civ);
  await bot.api.sendPhoto(seat.chatId!, new InputFile(png, "map.png"));
}

/** The word that ends an audience and lets the years pass */
const LEAVE = ["onward", "go"]; // the advisors offer /onward; /go is the quick way to type it

async function broadcastHerald(text: string) {
  for (const chatId of state.heraldChats) await herald.api.sendMessage(chatId, text).catch((error) => log("herald send failed", error.message));
}

/** Seats whose realm still stands - only these hold audiences and are waited for */
async function standing() {
  const alive = new Set((await host.state()).majorCivs.filter((civ) => civ.alive).map((civ) => civ.civ));
  return state.seats.filter((seat) => seat.chatId && alive.has(seat.civ));
}

/** A saga's plates: one cycle in one medium, made one after the other with the last plate as reference so they read as one work */
async function sendPlates(medium: string, plates: { caption: string; description: string }[], send: (png: Buffer, caption: string) => Promise<unknown>) {
  let previous: Buffer | undefined;
  for (const [index, plate] of plates.entries()) {
    const png = await generateImage(`${plate.description}\n\nMedium, palette and border: ${medium}. It is plate ${index + 1} of a cycle of ${plates.length}${previous ? "; the attached plate is the one before it - same hand, same medium, same border" : ""}. Stylised and symbolic as that medium is, not a realistic painting. No text or lettering.`, previous ? [{ name: "previous-plate.png", png: previous }] : []).catch(() => null);
    if (!png) continue;
    previous = png;
    await send(png, `${["I", "II", "III"][index]}. ${plate.caption}`).catch(() => {});
  }
}

/** One realm's saga, for its ruler (and for the world to read): when it falls, or when the game ends with it standing */
async function sendSaga(seat: Seat, outcome: string, publicly = true) {
  const events = await host.events();
  const history = events.filter((event) => event.text.includes(seat.civ));
  const { text: rawSaga, medium, plates } = withPlates(await realmSaga(seat, history, outcome));
  const saga = `THE SAGA OF ${seat.civ.toUpperCase()}${seat.rulerName ? ` UNDER ${seat.rulerName.toUpperCase()}` : ""}\nas the Chronicler tells it\n\n${rawSaga}`;
  const bot = advisors[state.seats.indexOf(seat)];
  if (seat.chatId) await bot.api.sendMessage(seat.chatId, saga).catch((error: Error) => log("saga send failed", error.message));
  if (publicly) await broadcastHerald(saga); // a living realm's saga draws on its private journal, so it stays with its ruler
  await sendPlates(medium, plates, async (png, caption) => {
    if (seat.chatId) await bot.api.sendPhoto(seat.chatId, new InputFile(png, "plate.png"), { caption });
    if (publicly) for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png, "plate.png"), { caption }).catch(() => {});
  });
}

async function sendEpic(occasion: string) {
  const [events, game] = await Promise.all([host.events(), host.state()]);
  const standings = game.majorCivs.map((civ) => `${civ.civ}: ${civ.alive ? "stands" : "has fallen"}`).join("\n");
  const spoken = (state.proclaimed ?? []).map((entry) => ({ turn: entry.turn, year: entry.year, text: `Proclaimed: ${entry.text}` }));
  const history = [...events, ...spoken].sort((a, b) => a.turn - b.turn);
  const { text, medium, plates } = withPlates(await chroniclerEpic(history, standings, occasion, state.chapters ?? []));
  await broadcastHerald(`THE EPIC OF THE WORLD\nas the Chronicler tells it\n\n${text}`);
  await sendPlates(medium, plates, async (png, caption) => {
    for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png, "plate.png"), { caption }).catch(() => {});
  });
}

async function playRound() {
  const seated = state.seats.filter((seat) => seat.chatId || seat.kind === "agent");
  const botOf = (seat: Seat) => advisors[state.seats.indexOf(seat)];
  try {
    await runRound(seated, {
      working: (seat, work) => (seat.chatId ? whileTyping(botOf(seat), seat.chatId, work) : work),
      dispatch: async (seat, dispatch, round) => {
        const bot = botOf(seat);
        const letter = [dispatch.heading, dispatch.text, dispatch.strategy, dispatch.question].filter(Boolean).join("\n\n");
        await bot.api.sendMessage(seat.chatId!, letter);
        // Pictures follow the letter instead of holding it up: a scene from the realm, then the painted map
        if (dispatch.image) {
          const game = await host.state();
          paint({ turn: game.turn, year: game.year, for: seat.civ, ...dispatch.image }, (png) => bot.api.sendPhoto(seat.chatId!, new InputFile(png, "scene.png"), { caption: dispatch.image!.caption }));
        }
        // With every letter, the marches of the years it covers - ours, drawn by the host, so it costs nothing
        void host.map(seat.civ, "campaign", round.fromTurn).then((png) => bot.api.sendPhoto(seat.chatId!, new InputFile(png, "marches.png"))).catch((error) => log("march map failed:", error.message));
        if (!dispatch.heading && PAINTED_MAPS) void paintedMap(seat.civ).then((png) => bot.api.sendPhoto(seat.chatId!, new InputFile(png, "map.png"))).catch((error) => log("map failed:", error.message));
      },
      notice: async (seat, text) => void (await botOf(seat).api.sendMessage(seat.chatId!, text).catch(() => {})),
      chronicle: async (chapter, images, round) => {
        // With HOLD_FOR_PICTURES=on the chapter waits for its pictures (a real game, one round a day); otherwise the text goes first
        if (!HOLD_FOR_PICTURES) await broadcastHerald(chapter);
        // One or two scenes of the Chronicler's choosing, and every wonder
        // A wonder's picture says what the great work gives its builders
        const wonders = await Promise.all(wonderPictures(round).map(async (picture) => {
          const wonder = picture.caption.split(",")[0];
          const boon = await host.lookup(state.seats[0]?.civ ?? "", wonder).then((entry) => wonderBoon(wonder, /completed by (.+?) in /.exec(picture.caption)?.[1] ?? "its builders", entry)).catch(() => "");
          return { ...picture, note: boon.trim() };
        }));
        // All of the age's pictures are painted together and then sent in the order of the years they show
        const pictures = [...images.map((image) => ({ turn: round.turn, year: round.year, for: "chronicle", note: "", ...image })), ...wonders];
        const yearOf = (picture: Picture) => { const m = /\b(\d{3,4})\b(?:\s*(BC))?/i.exec(picture.caption); return m ? (m[2] ? -Number(m[1]) : Number(m[1])) : Number.MAX_SAFE_INTEGER; };
        const painted = await Promise.all(pictures.map(async (picture) => ({ picture, png: await paintAndKeep(picture) })));
        if (HOLD_FOR_PICTURES) await broadcastHerald(chapter);
        for (const { picture, png } of painted.filter((entry) => entry.png).sort((a, b) => yearOf(a.picture) - yearOf(b.picture) || a.picture.turn - b.picture.turn))
          for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png!, "scene.png"), { caption: [picture.caption, picture.note].filter(Boolean).join(". ") }).catch(() => {});
      },
      log,
    });
    const game = await host.state();
    // A realm that fell this round: its ruler is told once, and gets the saga of their reign
    for (const seat of seated) {
      const fell = !game.majorCivs.find((civ) => civ.civ === seat.civ)?.alive;
      if (fell && !seat.fallen) {
        seat.fallen = true;
        if (seat.chatId) await botOf(seat).api.sendMessage(seat.chatId!, `${seat.civ} is no more, Majesty. Its cities belong to others now, and I have no realm left to counsel. History will remember what you said and did - the Chronicler is writing the saga of your reign now.`).catch(() => {});
        if (seat.kind !== "agent") await sendSaga(seat, `${seat.civ} has fallen.`).catch((error) => log("saga failed:", error.message));
      }
    }
    persist();
    await flushDevFeed(herald, `Round to ${game.year} (turn ${game.turn})${state.pendingRound ? " - interrupted by urgent news" : ""}`);
    // The game is over when someone has won, or when no ruler is left at the table. Only then, after the last chapter, comes the epic of the whole world.
    const rulersLeft = (await standing()).filter((seat) => seat.kind !== "agent");
    const over = !!game.winner || rulersLeft.length === 0;
    // Urgent news that concerns no ruler still at the table (a realm fell): nobody needs to hold council, so time moves on
    if (state.pendingRound && !over && (await standing()).every((seat) => seat.ready)) return void playRound();
    if (over && !state.epicTold) {
      state.epicTold = true;
      state.pendingRound = undefined;
      persist();
      await imagesIdle(); // the last age's pictures land before the closing words
      const closing = game.winner ? `The game is over: ${game.winner} has won a ${game.victoryType} victory.` : "The game is over: the last ruler's realm has fallen.";
      await broadcastHerald(closing);
      for (const seat of state.seats) if (seat.chatId && seat.kind !== "agent" && !rulersLeft.includes(seat)) await advisors[state.seats.indexOf(seat)].api.sendMessage(seat.chatId, closing).catch(() => {});
      for (const seat of rulersLeft) await sendSaga(seat, game.winner === seat.civ ? `${seat.civ} has won the world - a ${game.victoryType} victory.` : `The world has been won by ${game.winner}; ${seat.civ} still stands, but not first.`).catch((error) => log("saga failed:", error.message));
      await sendEpic(game.winner ? `${game.winner} has won a ${game.victoryType} victory, and the story is complete.` : "The last ruler's realm has fallen, and with it the story the rulers were telling ends; the world goes on without them.").catch((error) => log("epic failed:", error.message));
    }
  } catch (error) {
    log("Round failed:", error);
    for (const seat of seated)
      if (seat.chatId) await botOf(seat).api.sendMessage(seat.chatId, "Something went wrong while time was passing. Send /onward to try again.").catch(() => {});
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

function setUpAdvisor(bot: Bot, index: number) {
  const seat = (): Seat => state.seats[index];
  // A bot beyond the number of human rulers has no seat in this game: its slot in the list may belong to an advisor-ruled realm, which no one may sit down in
  bot.use(async (ctx, next) => {
    if (seat() && seat().kind !== "agent") return next();
    if (ctx.chat?.type === "private" && ctx.message) await ctx.reply("There is no ruler's seat behind this door in the present game - this realm is a sovereign's, ruled with no human above it. (A new game with more rulers would open it.)").catch(() => {});
  });

  /** The chat carries the advisor's name, so the ruler always knows who is speaking. Telegram allows only a few renames a day, hence only when it changes. */
  const wearName = async () => {
    // A bot with no ruler's seat goes back to a plain name
    const wanted = seat()?.character && seat().kind !== "agent" ? `${seat().character!.name} · ${seat().civ}`.slice(0, 64) : seat()?.kind === "agent" || !seat() ? `Advisor ${index + 1} · no seat this game` : undefined;
    const worn = seat() ? seat().botName : undefined;
    if (!wanted || worn === wanted) return;
    await bot.api.setMyName(wanted).then(() => { if (seat()) { seat().botName = wanted; persist(); } }).catch((error) => log("renaming the bot failed:", error.message));
  };
  let queue: Promise<unknown> = Promise.resolve();

  /** First of all: which people? Four drawn at random, fate, or any people named in the ruler's own words */
  const askForPeople = async (ctx: Context) => {
    const taken = state.seats.map((other) => other.civ).filter(Boolean);
    const drawn = shuffled((await host.nations()).filter((nation) => !taken.includes(nation.name))).slice(0, 4);
    const keyboard = new InlineKeyboard();
    drawn.forEach((nation) => keyboard.text(`${nation.name} (${nation.leader})`, `people:${nation.name}`).row());
    keyboard.text("Let fate decide", "people:?");
    await ctx.reply("Which people will you lead?\n\n(Pick one, or name any people you like - Persia, the Aztecs, Sweden... Send the word list to see them all.)", { reply_markup: keyboard });
  };

  const choosePeople = async (ctx: Context, wish: string) => {
    const taken = state.seats.map((other) => other.civ).filter(Boolean);
    const nations = (await host.nations()).filter((nation) => !taken.includes(nation.name));
    const clean = wish.trim().toLowerCase().replace(/^the\s+/, "");
    const chosen = wish === "?" ? shuffled(nations)[0]
      : nations.find((nation) => nation.name.toLowerCase() === clean) ?? nations.find((nation) => nation.name.toLowerCase().startsWith(clean.slice(0, 4)) || nation.leader.toLowerCase().includes(clean));
    if (!chosen) return ctx.reply(`I know of no free people by that name. These are all who are still without a ruler - name one, or tap a button above:\n\n${nations.map((nation) => `${nation.name} (${nation.leader})`).sort().join("\n")}`);
    seat().civ = chosen.name;
    persist();
    await ctx.reply(`${chosen.name} it is - the people of ${chosen.leader}.`);
    await presentCandidates(ctx);
  };

  /** Three people present themselves; the ruler takes one, or sends once for three others */
  const presentCandidates = async (ctx: Context) => {
    try {
      const takenNames = state.seats.flatMap((other) => (other.character ? [other.character.name.split(/[ ,]/)[0]] : []));
      seat().candidates = await whileTyping(bot, ctx.chat!.id, draftCandidates(seat().civ, ADVISOR_MODEL, takenNames));
      persist();
      const keyboard = new InlineKeyboard();
      seat().candidates!.forEach((candidate, candidateIndex) => keyboard.text(candidate.name, `advisor:${candidateIndex}`).row());
      if (!seat().rerolled) keyboard.text("Send for three others", "advisor:others");
      await ctx.reply(`Three have come to offer themselves as your chief advisor.\n\n${seat().candidates!.map(card).join("\n\n")}\n\nWhom will you have at your side?`, { reply_markup: keyboard });
    } catch (error) {
      log("drafting candidates failed:", error);
      seat().setup = undefined;
      await ctx.reply("Your advisors are delayed on the road. Send /start to try again.");
    }
  };

  const chooseAdvisor = async (ctx: Context, choice: string) => {
    if (choice === "others") {
      if (seat().rerolled) return;
      seat().rerolled = true;
      return presentCandidates(ctx);
    }
    const chosen = seat().candidates?.[Number(choice)];
    if (!chosen) return;
    const replaced = seat().character?.name;
    try {
      if (seat().character) (seat().formerAdvisors ??= []).push({ name: seat().character!.name, title: seat().character!.title, pronouns: seat().character!.pronouns, until: (await host.state()).year });
      seat().character = { name: chosen.name, title: chosen.title, pronouns: chosen.pronouns, sheet: chosen.sheet };
      void wearName();
      if (!seat().clerk) draftClerk(seat().civ, ADVISOR_MODEL, chosen.name).then((made) => { seat().clerk = made; persist(); }).catch((error) => log("clerk drafting failed:", error.message));
      seat().setup = undefined;
      seat().candidates = undefined;
      seat().rerolled = undefined;
      persist();
      const greeting = await whileTyping(bot, ctx.chat!.id, advisorGreeting(seat(), replaced));
      remember(seat(), { from: "advisor", text: greeting });
      await ctx.reply(`${greeting}\n\n— ${seat().character!.name}\n\nTalk to me freely - nothing in the world moves while we speak.`);
      await flushDevFeed(herald, `Character for ${seat().civ}: ${seat().character!.name}, ${chosen.title}`, [chosen.sheet]);
      if (state.phase === "setup") {
        const missing = state.seats.filter((other) => other.kind !== "agent" && (!other.civ || !other.character)).length;
        if (missing === 0) await createWorld();
        else await ctx.reply(`The world will be made once every ruler has assembled a court - ${missing} still to come.`);
      }
      const era = String((await host.briefing(seat().civ).catch(() => ({ era: "Ancient era" }))).era);
      void advisorPortrait(seat().civ, seat().character!.sheet + pronounLine(seat().character!.pronouns), era).then((png) => png && ctx.replyWithPhoto(new InputFile(png, "portrait.png"), { caption: seat().character!.name })).catch(() => {});
    } catch (error) {
      log("taking on the advisor failed:", error);
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
      await ctx.reply("A new history is about to begin. First, your people.");
      return askForPeople(ctx);
    }
    await ctx.reply(seat().character ? `${seat().character!.name} will step aside once you have chosen another; what they wrote down of your wishes passes to their successor.` : `${seat().civ} is yours to rule. Your court assembles.`);
    await presentCandidates(ctx);
  };

  bot.command("start", (ctx) =>
    seat().character
      ? ctx.reply(`${seat().character!.name} is at your side, Majesty. Talk freely; time only passes when you say so or send /onward.\n\n/status  /map  /will  /usage  /character`)
      : beginSetup(ctx),
  );

  // Who is at the ruler's side: exactly the text the advisor itself is given, and the way to replace them
  bot.command("character", (ctx) =>
    seat().character
      ? ctx.reply(`${seat().character!.name}${seat().character!.title ? `, ${seat().character!.title}` : ""}\n\n${seat().character!.sheet}\n\n${seat().mayDeclareWar ? "You have given them leave to declare war on their own; tell them if you take it back." : "War is yours alone to declare, unless you tell them otherwise."} What else they may do unasked is whatever you tell them - see /will.`,
          { reply_markup: new InlineKeyboard().text("Dismiss them and send for candidates", "advisor:new") })
      : beginSetup(ctx),
  );

  bot.callbackQuery(/^people:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (seat().setup && !seat().civ) await choosePeople(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^advisor:(\d+|others|new)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {}); // a press from before a restart is too old to acknowledge, but still counts
    if (ctx.match[1] === "new") return state.phase === "passing" ? void (await ctx.reply("Wait until time stops passing.")) : beginSetup(ctx);
    if (seat().setup) await chooseAdvisor(ctx, ctx.match[1]);
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
    // What this audience came to, for the saga: the ruler's own words since the dispatch, and the advisor's closing
    const annal = seat().annals?.at(-1);
    if (annal && !annal.settled) {
      const since = seat().chat.slice(seat().chat.findLastIndex((message) => message.from === "advisor" && message.text.startsWith(annal.story.slice(0, 40))) + 1);
      annal.rulerSaid = since.filter((message) => message.from === "ruler").map((message) => message.text).filter((text) => !new RegExp(`^/?(${LEAVE.join("|")})\\b`, "i").test(text.trim()) && !text.startsWith("["));
      annal.settled = since.filter((message) => message.from === "advisor").at(-1)?.text.replace(new RegExp(`\\n*/(${LEAVE.join("|")})\\s*$`, "i"), "");
    }
    const decided = seat().decisionPicture;
    if (decided && seat().chatId) {
      const chatId = seat().chatId!;
      paint({ ...decided, for: seat().civ }, (png) => bot.api.sendPhoto(chatId, new InputFile(png, "decision.png"), { caption: decided.caption }));
    }
    seat().decisionPicture = undefined;
    seat().ready = true;
    seat().dismissed = false;
    persist();
    const waiting = (await standing()).filter((other) => !other.ready).map((other) => other.civ);
    if (waiting.length) return reply(`The court is dismissed. Waiting for the ruler of ${waiting.join(", ")}.`);
    await reply("The court is dismissed. Until next time.");
    for (const other of state.seats)
      if (other !== seat() && other.chatId) await advisors[state.seats.indexOf(other)].api.sendMessage(other.chatId, "All rulers have dismissed their courts. Godspeed.");
    void playRound();
  };

  // "/go" alone dismisses the court; "/go and buy the library first" (or a message that ends in /go) is answered and acted on, then time passes
  const canHoldAudience = () => !seat().fallen && state.phase === "audience" && !!seat().character;
  bot.command(LEAVE, (ctx) => (ctx.match.trim() && canHoldAudience() ? audience(ctx, ctx.match.trim(), true) : dismiss((text) => ctx.reply(text), true)));

  /** The keeper of the rolls answers: while the clocks run, on /clerk, or when addressed by name. Read-only; anything that sounded like an order goes to the council. */
  const clerk = (ctx: Context, message: string) => {
    queue = queue.then(async () => {
      try {
        if (!seat().clerk) { seat().clerk = await draftClerk(seat().civ, ADVISOR_MODEL, seat().character?.name); persist(); }
        const passing = state.phase === "passing";
        // The answer is shown as it is written: one message, edited as the text grows (Telegram tolerates an edit every second or so)
        const chatId = ctx.chat!.id;
        const shown = (text: string) => text.replace(/\n?FOR COUNCIL:[\s\S]*$/m, "").trim();
        let draft: { message_id: number } | undefined;
        let lastEdit = 0;
        let editing: Promise<unknown> = Promise.resolve();
        const show = (soFar: string) => {
          if (Date.now() - lastEdit < 1200) return;
          lastEdit = Date.now();
          const text = shown(soFar);
          if (!text) return;
          editing = editing.then(async () => {
            if (!draft) draft = await bot.api.sendMessage(chatId, text + " …");
            else await bot.api.editMessageText(chatId, draft.message_id, text + " …").catch(() => {});
          });
        };
        const raw = await whileTyping(bot, chatId, clerkReply(seat(), message, passing, show));
        const forCouncil = /^FOR COUNCIL:\s*(.+)$/m.exec(raw)?.[1].trim();
        const reply = shown(raw);
        if (forCouncil && !/^(the ruler )?asked|no order|nothing (was )?(ordered|asked)|none\b/i.test(forCouncil)) (seat().forCouncil ??= []).push(forCouncil);
        (seat().clerkChat ??= []).push({ from: "ruler", text: message }, { from: "clerk", text: reply });
        if (seat().clerkChat!.length > 12) seat().clerkChat!.splice(0, seat().clerkChat!.length - 12);
        persist();
        await editing;
        if (draft) await bot.api.editMessageText(chatId, draft.message_id, reply || "(the rolls are silent)").catch(() => ctx.reply(reply));
        else await ctx.reply(reply);
      } catch (error) {
        log("clerk failed:", error);
        await ctx.reply("The clerk has mislaid the roll. Ask again in a moment.").catch(() => {});
      }
    });
  };

  /** One audience at a time per seat, so replies stay in order */
  /** thenGo: the ruler ended their message with /go - answer it, act on it, and let time pass without another word from them */
  const audience = (ctx: Pick<Context, "reply"> & { chat?: { id: number } }, message: string, thenGo = false) => {
    // Kept on disk until it is answered: a restart in the middle of a reply must not swallow the ruler's words
    seat().unanswered = { text: message, thenGo };
    persist();
    queue = queue.then(async () => {
      try {
        const game = await host.state();
        const raw = await whileTyping(bot, ctx.chat!.id, advisorReply(seat(), thenGo ? `${message}\n\n[The ruler added /onward: this is their last word for this audience. Act on it, decide anything still open yourself as they would wish, and give your closing now - ask nothing further.]` : message, roundLength(game.turn)));
        // The closing carries two lines meant for us, not the ruler: a picture of the decision, and words for the Chronicler
        const image = /^IMAGE:\s*(.+?)\s*\|\s*(.+)$/m.exec(raw);
        const proclamation = /^PROCLAMATION:\s*(.+)$/m.exec(raw)?.[1].trim();
        const reply = raw.replace(/^(IMAGE|PROCLAMATION):.*\n?/gm, "").replace(/\n{3,}/g, "\n\n").trim();
        if (proclamation && !/^\(?none|^-$/i.test(proclamation)) (seat().proclamations ??= []).push(proclamation);
        // The picture of what the audience decided is painted once the court is dismissed - a closing can still be talked over, and only the last one stands
        if (image && !/^\(?none/i.test(image[1])) seat().decisionPicture = { turn: game.turn, year: game.year, caption: image[1], description: image[2] };
        remember(seat(), { from: "ruler", text: message });
        remember(seat(), { from: "advisor", text: reply });
        seat().unanswered = undefined;
        seat().choices = undefined;
        persist(); // or the file still says "unanswered" and a restart answers it a second time
        await ctx.reply(reply);
        await flushDevFeed(herald, `Audience - ${seat().civ}`);
        if (seat().dismissed || thenGo) await dismiss((text) => ctx.reply(text));
      } catch (error) {
        log("advisor failed:", error);
        seat().unanswered = undefined;
        persist();
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

  // The saga of this ruler's reign so far, on request (it also comes by itself when the realm falls or the game ends)
  bot.command("saga", async (ctx) => {
    if (state.phase === "passing") return ctx.reply("Wait until time stops passing.");
    await ctx.reply("The Chronicler is writing...");
    await sendSaga(seat(), seat().fallen ? `${seat().civ} has fallen.` : `${seat().civ} still stands; its ruler has asked for the saga so far.`, !!seat().fallen || !!state.epicTold).catch((error) => log("saga failed:", error.message));
  });

  // The keeper of the rolls, in the middle of an audience or at any hour
  bot.command("clerk", (ctx) => (ctx.match.trim() ? clerk(ctx, ctx.match.trim()) : ctx.reply(seat().clerk ? `${seat().clerk!.name}, ${seat().clerk!.title}, keeps the rolls here. Ask: /clerk what does the Great Library do` : "The keeper of the rolls answers questions of fact - the rules, our cities, our deals, how this court works. Ask: /clerk what does the Great Library do")));

  bot.command("usage", (ctx) => ctx.reply(usageSummary()));

  bot.command("map", (ctx) => sendMap(bot, seat()).catch(() => ctx.reply("No map to show yet.")));

  // The first seat's ruler may start over: /newgame asks how many rulers, how many rival peoples, how large a world
  if (index === 0) {
    const draft: { humans?: number; agents?: number; ai?: number; difficulty?: string; size?: string; wonders?: "all" | "rulers" | "advised" } = {};
    const row = (keyboard: InlineKeyboard, prefix: string, values: (string | number)[]) => values.forEach((value) => keyboard.text(String(value), `ng:${prefix}:${value}`));

    // The workshop door: out-of-character talk with the advisor and clerk, for testing. First seat only; announced to every ruler.
    bot.command("workshop", async (ctx) => {
      state.workshop = !state.workshop;
      persist();
      const word = state.workshop ? "The workshop door is open: you may ask your advisor or clerk to speak out of character (\"out of character: ...\")." : "The workshop door is closed: the court stays in character whatever is asked.";
      for (const other of state.seats) if (other.chatId) await advisors[state.seats.indexOf(other)].api.sendMessage(other.chatId, word).catch(() => {});
    });

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
        return void ctx.editMessageText(`${draft.humans} ruler${draft.humans === 1 ? "" : "s"}. How many sovereigns - realms ruled by an advisor alone, with no human above them? They play under the same limits as yours. (Models, in turn: ${AGENT_MODELS.join(", ")})`, { reply_markup: keyboard });
      }
      if (step === "agents") {
        draft.agents = Number(value);
        const keyboard = new InlineKeyboard();
        row(keyboard, "ai", [0, 1, 2, 3, 4, 5, 6]);
        return void ctx.editMessageText(`${draft.agents} sovereign${draft.agents === 1 ? "" : "s"}. How many of the game's own peoples - played by the game's AI, with no advisor at all? (0 for none)`, { reply_markup: keyboard });
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
        const keyboard = new InlineKeyboard();
        row(keyboard, "wonders", Object.keys(WONDERS));
        return void ctx.editMessageText("Who may raise the world's wonders? Everyone is the usual game. Rulers only leaves them to the rulers' realms - sovereigns and the game's peoples build none, so every wonder is one of yours. Rulers and sovereigns bars only the game's peoples.", { reply_markup: keyboard });
      }
      if (step === "wonders") {
        draft.wonders = WONDERS[value];
        const keyboard = new InlineKeyboard().text("Make it so", "ng:confirm").text("Keep the old world", "ng:cancel");
        return void ctx.editMessageText(`A ${draft.size!.toLowerCase()} world with ${draft.humans} ruler${draft.humans === 1 ? "" : "s"}, ${draft.agents ?? 0} sovereign${draft.agents === 1 ? "" : "s"}, ${draft.ai} of the game's own people${draft.ai === 1 ? "" : "s"} played by the game and ${CITY_STATES[draft.size!] ?? 6} lesser cities${draft.wonders === "rulers" ? "; wonders are for the rulers' realms alone" : draft.wonders === "advised" ? "; the game's peoples raise no wonders" : ""}. Each ruler then chooses a people and assembles a court. The current game ends for everyone.`, { reply_markup: keyboard });
      }
      if (state.phase === "passing" || !draft.humans || !draft.size) return void ctx.editMessageText("Send /newgame to begin again.");
      const before = state.seats;
      state.seats = [
        ...Array.from({ length: draft.humans }, (_, seatIndex) => ({ ...blankSeat(), chatId: before[seatIndex]?.chatId, rulerName: before[seatIndex]?.rulerName })),
        ...Array.from({ length: draft.agents ?? 0 }, (_, agentIndex) => ({ ...blankSeat(), kind: "agent" as const, model: AGENT_MODELS[agentIndex % AGENT_MODELS.length] })),
      ];
      state.difficulty = draft.difficulty;
      state.wonders = draft.wonders ?? "all";
      state.workshop = false; // a new game is a real one: no out-of-character talk unless /workshop opens the door
      state.proclaimed = [];
      state.epicTold = false;
      state.chapters = [];
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
    if (state.phase === "passing" && seat().character) return clerk(ctx, ctx.message.text);
    if (state.phase === "passing") return ctx.reply("Time is passing, Majesty - I will report as soon as there is news.");
    if (seat().clerk && new RegExp(`^\\W*${seat().clerk!.name.split(" ")[0]}\\b`, "i").test(ctx.message.text)) return clerk(ctx, ctx.message.text);
    if (seat().setup && !seat().civ) return choosePeople(ctx, ctx.message.text);
    if (seat().setup) return ctx.reply(seat().candidates ? "Choose one of the three, Majesty - the buttons above." : "A moment - your court is assembling.");
    if (state.phase === "setup") return seat().character ? ctx.reply("The world is not made yet, Majesty - it begins once every ruler has assembled a court.") : beginSetup(ctx);
    if (!seat().character && seat().chat.length === 0) return beginSetup(ctx);
    const closing = new RegExp(`^([\\s\\S]*\\S)\\s+/(${LEAVE.join("|")})\\s*$`, "i").exec(ctx.message.text);
    closing ? audience(ctx, closing[1], true) : audience(ctx, ctx.message.text);
  });

  void wearName();

  // Words the ruler sent just before a restart: answer them now, as if nothing had happened
  const left = seat()?.unanswered;
  if (left && seat().chatId && state.phase === "audience") {
    const chatId = seat().chatId!;
    log(`${seat().civ}: answering a message left unanswered by the restart`);
    audience({ chat: { id: chatId }, reply: ((text: string) => bot.api.sendMessage(chatId, text)) as Context["reply"] }, left.text, left.thenGo);
  }

  bot.catch((error) => log(`advisor ${index + 1} error:`, error.message));
}

function setUpHerald() {
  const subscribe = async (ctx: Context) => {
    if (!ctx.chat || state.heraldChats.includes(ctx.chat.id)) return;
    state.heraldChats.push(ctx.chat.id);
    persist();
    log("Herald now publishes to chat", ctx.chat.id);
    await ctx.reply("The Chronicler will set down every chapter of the world's history here.");
  };
  herald.command("epic", async (ctx) => {
    await subscribe(ctx);
    await ctx.replyWithChatAction("typing").catch(() => {});
    await sendEpic("A reader has asked for the story so far.").catch((error) => log("epic failed:", error.message));
  });
  herald.on("my_chat_member", subscribe);
  herald.on("message", subscribe);
  // The one voice all rulers read is the Chronicler; the bot carries that name (renames are rationed by Telegram, so only once)
  if (state.heraldName !== "The Chronicler")
    void herald.api.setMyName("The Chronicler").then(() => { state.heraldName = "The Chronicler"; persist(); }).catch((error) => log("renaming the Chronicler failed:", error.message));
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
      `rounds: ${process.env.TURNS_PER_ROUND ?? 12} turns (${process.env.EARLY_ROUND_TURNS ?? 24} before turn ${process.env.EARLY_GAME_UNTIL_TURN ?? 24}), govern every ${process.env.GOVERN_EVERY_TURNS ?? 4}`,
      ...state.seats.map((seat) => `${seat.civ}: ${seat.character ? `${seat.character.name}${seat.character.title ? `, ${seat.character.title}` : ""}` : "no character yet - /start"}`),
      "Full prompts arrive as .md files after each audience and round.",
    ].join("\n")).catch(() => {}),
  );

for (const bot of [herald, ...advisors]) void bot.start({ onStart: (me) => log(`@${me.username} is listening`) });
