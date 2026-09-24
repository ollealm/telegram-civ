// Telegram front: one advisor bot per seat, one herald bot for the world newspaper

import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { advisorGreeting, advisorReply, chroniclerEpic, clerkReply, describeDecision, draftClerk, eraScene, pronounLine, realmSaga, wonderBoon } from "./agents.ts";
import { card, draftCandidates, draftSovereign } from "./characters.ts";

const ADVISOR_MODEL = process.env.ADVISOR_MODEL ?? "claude-opus-5";
import { devFeedInChat, flushDevFeed } from "./devfeed.ts";
import { advisorPortrait, generateImage, imagesIdle, onImageLog, paintedMap } from "./images.ts";
import { host, type PublicEvent, type RoundResult } from "./host.ts";
import { playRound as runRound, roundLength } from "./round.ts";
import { forgetPicture, persist, recordPicture, remember, state, type Picture, type Seat } from "./store.ts";

/** Rival realms played by the game itself, chosen at random; 0 for an all-human world */
const AI_CIVS = Number(process.env.AI_CIVS ?? 2);
const MAP_SIZES = ["Tiny", "Small", "Medium", "Large", "Huge"];
const DEFAULT_MAP_SIZE = process.env.MAP_SIZE ?? "Medium";
/** Models for agent-ruled realms, dealt in turn */
const AGENT_MODELS = (process.env.AGENT_MODELS ?? "claude-sonnet-5").split(",").map((model) => model.trim());
/** Per-seat effort for a new game (temporary levers for testing): HUMAN_EFFORTS=high,medium sets each ruler's seat in bot order (an empty entry keeps the per-role setting); AGENT_EFFORT sets every sovereign */
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const asEffort = (value?: string): Effort | undefined => (["low", "medium", "high", "xhigh", "max"].includes(value ?? "") ? (value as Effort) : undefined);
const HUMAN_EFFORTS = (process.env.HUMAN_EFFORTS ?? "").split(",").map((value) => asEffort(value.trim()));
const AGENT_EFFORT = asEffort(process.env.AGENT_EFFORT);
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

/** The ruler's seat this advisor bot speaks for in the present game, if any */
const seatOf = (botIndex: number) => state.seats.find((seat) => seat.bot === botIndex);
/** The advisor bot a ruler hears their court through; a sovereign's realm has none */
const botOf = (seat: Seat) => (seat.bot === undefined ? undefined : advisors[seat.bot]);
/** A word to a ruler through their own advisor's bot; nothing for a seat no ruler sits in */
const tell = async (seat: Seat, text: string) => {
  const bot = botOf(seat);
  if (bot && seat.chatId) await bot.api.sendMessage(seat.chatId, text).catch((error) => log(`telling ${seat.civ} failed:`, error.message));
};

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
  if (state.seats.length === 0) state.seats = advisors.map((_, index) => ({ ...blankSeat(), bot: index, civ: game.running ? game.ruled[index] ?? "" : "" }));
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
    seat.character ??= await draftSovereign(seat.civ, seat.model ?? ADVISOR_MODEL).then(({ name, title, pronouns, sheet }) => ({ name, title, pronouns, sheet }));
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
    await tell(seat, `The world is made, Majesty, and ${seat.civ} stands at its beginning. Tell me what you want this realm to become; we have all the time we need, for no year passes until you give the word.`);
}

onImageLog((message) => log(message));

/** The painted map costs a picture a round for every ruler; PAINTED_MAPS=off leaves it out (the march map comes either way) */
const PAINTED_MAPS = process.env.PAINTED_MAPS !== "off";

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

/** A people's entry into a new age always gets its picture - once; the Chronicler chooses the instant from what that people has lately done */
const eraPictures = async (round: RoundResult): Promise<Picture[]> => {
  const entries = round.publicEvents.flatMap((event) => {
    const [, civ, era] = /^(.+?) entered the (.+?)\.?$/.exec(event.text) ?? [];
    return !era || /^Ancient/i.test(era) ? [] : [{ event, civ, era }];
  });
  if (!entries.length) return [];
  const all = await host.events().catch(() => [] as PublicEvent[]);
  return Promise.all(entries.map(async ({ event, civ, era }) => {
    const tag = `${civ} enter the ${era}`;
    if ((state.pictures ?? []).some((picture) => picture.for === "chronicle" && picture.caption.startsWith(tag))) return [];
    const recent = all.filter((entry) => entry.turn <= event.turn && entry.text.startsWith(civ)).slice(-12);
    const scene = await eraScene(civ, era, event.year, recent).catch((error) => { log(`era picture failed (${civ}):`, error.message); return null; });
    if (!scene) return [];
    return [{ turn: event.turn, year: event.year, for: "chronicle", caption: `${tag}, ${event.year}. ${scene.caption}`, description: scene.description }];
  })).then((pictures) => pictures.flat());
};

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
  const { text: rawSaga, medium, plates } = await realmSaga(seat, history, outcome);
  const saga = `THE SAGA OF ${seat.civ.toUpperCase()}${seat.rulerName ? ` UNDER ${seat.rulerName.toUpperCase()}` : ""}\nas the Chronicler tells it\n\n${rawSaga}`;
  const bot = botOf(seat);
  if (bot && seat.chatId) await bot.api.sendMessage(seat.chatId, saga).catch((error: Error) => log("saga send failed", error.message));
  if (publicly) await broadcastHerald(saga); // a living realm's saga draws on its private journal, so it stays with its ruler
  await sendPlates(medium, plates, async (png, caption) => {
    if (bot && seat.chatId) await bot.api.sendPhoto(seat.chatId, new InputFile(png, "plate.png"), { caption });
    if (publicly) for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png, "plate.png"), { caption }).catch(() => {});
  });
}

async function sendEpic(occasion: string) {
  const [events, game] = await Promise.all([host.events(), host.state()]);
  const standings = game.majorCivs.map((civ) => `${civ.civ}: ${civ.alive ? "stands" : "has fallen"}`).join("\n");
  const spoken = (state.proclaimed ?? []).map((entry) => ({ turn: entry.turn, year: entry.year, text: `Proclaimed: ${entry.text}` }));
  const history = [...events, ...spoken].sort((a, b) => a.turn - b.turn);
  const { text, medium, plates } = await chroniclerEpic(history, standings, occasion, state.chapters ?? []);
  await broadcastHerald(`THE EPIC OF THE WORLD\nas the Chronicler tells it\n\n${text}`);
  await sendPlates(medium, plates, async (png, caption) => {
    for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png, "plate.png"), { caption }).catch(() => {});
  });
}

async function playRound() {
  // Two rulers dismissing at the same moment must start one round, not two: the round sets the phase before its first await
  if (state.phase === "passing") return;
  const seated = state.seats.filter((seat) => seat.chatId || seat.kind === "agent");
  type Painting = Promise<Buffer | null>;
  const letters: { seat: Seat; letter: string; caption?: string; scene: Painting; marches: Painting; painted: Painting }[] = [];
  const chapters: { chapter: string; pictures: { picture: Picture & { note?: string }; png: Buffer | null }[] }[] = [];
  try {
    await runRound(seated, {
      working: (seat, work) => {
        const bot = botOf(seat);
        return bot && seat.chatId ? whileTyping(bot, seat.chatId, work) : work;
      },
      // Nothing is sent as it is written: letters, scenes, maps and the chapter are gathered, painted, and go out together once the age is complete
      dispatch: async (seat, dispatch, round) => {
        const bot = botOf(seat);
        if (!bot || !seat.chatId) return;
        const letter = [dispatch.heading, dispatch.text, dispatch.strategy, dispatch.question].filter(Boolean).join("\n\n");
        const game = await host.state();
        const scene = dispatch.image ? paintAndKeep({ turn: game.turn, year: game.year, for: seat.civ, ...dispatch.image }) : Promise.resolve(null);
        // With every letter, the marches of the years it covers - ours, drawn by the host, so it costs nothing
        const marches = host.map(seat.civ, "campaign", round.fromTurn).catch((error) => { log("march map failed:", error.message); return null; });
        const painted = !round.stoppedEarly && PAINTED_MAPS ? paintedMap(seat.civ).catch((error) => { log("map failed:", error.message); return null; }) : Promise.resolve(null);
        letters.push({ seat, letter, caption: dispatch.image?.caption, scene, marches, painted });
      },
      notice: tell,
      chronicle: async (chapter, images, round) => {
        // One or two scenes of the Chronicler's choosing, and every wonder
        // A wonder's picture says what the great work gives its builders
        const wonders = await Promise.all(wonderPictures(round).map(async (picture) => {
          const wonder = picture.caption.split(",")[0];
          const boon = await host.lookup(state.seats[0]?.civ ?? "", wonder).then((entry) => wonderBoon(wonder, /completed by (.+?) in /.exec(picture.caption)?.[1] ?? "its builders", entry)).catch(() => "");
          return { ...picture, note: boon.trim() };
        }));
        // All of the age's pictures are painted together and then sent in the order of the years they show
        const pictures = [...images.map((image) => ({ turn: round.turn, year: round.year, for: "chronicle", note: "", ...image })), ...wonders, ...(await eraPictures(round)).map((picture) => ({ ...picture, note: "" }))];
        const yearOf = (picture: Picture) => { const m = /\b(\d{3,4})\b(?:\s*(BC))?/i.exec(picture.caption); return m ? (m[2] ? -Number(m[1]) : Number(m[1])) : Number.MAX_SAFE_INTEGER; };
        const painted = await Promise.all(pictures.map(async (picture) => ({ picture, png: await paintAndKeep(picture) })));
        chapters.push({ chapter, pictures: painted.filter((entry) => entry.png).sort((a, b) => yearOf(a.picture) - yearOf(b.picture) || a.picture.turn - b.picture.turn) });
      },
      log,
    });
    // The age is complete and painted: every ruler's letter goes out now, then the Chronicler's chapter, all within the same minute
    for (const post of letters) {
      const bot = botOf(post.seat)!;
      const chatId = post.seat.chatId!;
      const [scene, marches, painted] = await Promise.all([post.scene, post.marches, post.painted]);
      await bot.api.sendMessage(chatId, post.letter).catch((error) => log(`letter to ${post.seat.civ} failed:`, error.message));
      if (scene) await bot.api.sendPhoto(chatId, new InputFile(scene, "scene.png"), { caption: post.caption }).catch((error) => log(`scene to ${post.seat.civ} failed:`, error.message));
      if (marches) await bot.api.sendPhoto(chatId, new InputFile(marches, "marches.png")).catch((error) => log(`marches to ${post.seat.civ} failed:`, error.message));
      if (painted) await bot.api.sendPhoto(chatId, new InputFile(painted, "map.png")).catch((error) => log(`map to ${post.seat.civ} failed:`, error.message));
    }
    for (const post of chapters) {
      await broadcastHerald(post.chapter);
      for (const { picture, png } of post.pictures)
        for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png!, "scene.png"), { caption: [picture.caption, picture.note].filter(Boolean).join(". ") }).catch(() => {});
    }
    const game = await host.state();
    // A realm that fell this round: its ruler is told once, and gets the saga of their reign
    for (const seat of seated) {
      const fell = !game.majorCivs.find((civ) => civ.civ === seat.civ)?.alive;
      if (fell && !seat.fallen) {
        seat.fallen = true;
        await tell(seat, `${seat.civ} is no more, Majesty. Its cities belong to others now, and I have no realm left to counsel. History will remember what you said and did - the Chronicler is writing the saga of your reign now.`);
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
      for (const seat of state.seats) if (!rulersLeft.includes(seat)) await tell(seat, closing);
      for (const seat of rulersLeft) await sendSaga(seat, game.winner === seat.civ ? `${seat.civ} has won the world - a ${game.victoryType} victory.` : `The world has been won by ${game.winner}; ${seat.civ} still stands, but not first.`).catch((error) => log("saga failed:", error.message));
      await sendEpic(game.winner ? `${game.winner} has won a ${game.victoryType} victory, and the story is complete.` : "The last ruler's realm has fallen, and with it the story the rulers were telling ends; the world goes on without them.").catch((error) => log("epic failed:", error.message));
    }
  } catch (error) {
    log("Round failed:", error);
    for (const seat of seated) await tell(seat, "Something went wrong while time was passing. Send /onward to try again.");
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

/** Each advisor bot's name-changer, so that a new game can re-dress them all */
const wearNames: (() => Promise<void>)[] = [];

function setUpAdvisor(bot: Bot, index: number) {
  // Only past the first middleware below, which turns away a bot with no ruler's seat in this game
  const seat = (): Seat => seatOf(index)!;
  bot.use(async (ctx, next) => {
    if (seatOf(index)) return next();
    if (ctx.chat?.type === "private" && ctx.message) await ctx.reply("There is no ruler's seat behind this door in the present game. (A new game with more rulers would open it.)").catch(() => {});
  });

  /** The chat carries the advisor's name, so the ruler always knows who is speaking. Telegram allows only a few renames a day, hence only when it changes. */
  const wearName = async () => {
    // A bot with no ruler's seat goes back to a plain name; one whose ruler has no advisor yet keeps what it wears
    const here = seatOf(index);
    const wanted = here?.character ? `${here.character.name} · ${here.civ}`.slice(0, 64) : !here ? `Advisor ${index + 1} · no seat this game` : undefined;
    if (!wanted || state.botNames?.[index] === wanted) return;
    await bot.api.setMyName(wanted).then(() => { (state.botNames ??= {})[index] = wanted; persist(); }).catch((error) => log("renaming the bot failed:", error.message));
  };
  wearNames[index] = wearName;
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
    // Every dismissal leaves the ruler a picture to carry off while they wait: the advisor's, or one asked for now if the closing came without. It is painted beside the dismissal, not before it
    const asked = seat().decisionPicture;
    seat().decisionPicture = undefined;
    if (seat().chatId && seat().character) {
      const chatId = seat().chatId!;
      const civ = seat().civ;
      void (async () => {
        const game = await host.state();
        const decided: Picture = asked ? { ...asked, for: civ } : { turn: game.turn, year: game.year, for: civ, ...(await describeDecision(seat())) };
        paint(decided, (png) => bot.api.sendPhoto(chatId, new InputFile(png, "decision.png"), { caption: decided.caption }));
      })().catch((error) => log("decision picture failed:", error.message));
    }
    seat().ready = true;
    seat().dismissed = false;
    persist();
    // The same words whether the other rulers are done or not: what the wait is for is not the ruler's concern
    await reply("The court is dismissed. Until next time.");
    if ((await standing()).some((other) => !other.ready)) return;
    void playRound();
  };

  // "/go" alone dismisses the court; "/go and buy the library first" (or a message that ends in /go) is answered and acted on, then time passes
  const canHoldAudience = () => !seat().fallen && state.phase === "audience" && !!seat().character;
  // A bare /onward waits its turn behind any reply still being written, like every other message
  bot.command(LEAVE, (ctx) => (ctx.match.trim() && canHoldAudience() ? audience(ctx, ctx.match.trim(), true) : void (queue = queue.then(() => dismiss((text) => ctx.reply(text), true)).catch((error) => log("dismiss failed:", error)))));

  /** The keeper of the rolls answers: while the clocks run, on /clerk, or when addressed by name. Read-only; anything that sounded like an order goes to the council. */
  const clerk = (ctx: Context, message: string) => {
    queue = queue.then(async () => {
      try {
        if (!seat().clerk) { seat().clerk = await draftClerk(seat().civ, ADVISOR_MODEL, seat().character?.name); persist(); }
        const away = state.phase === "passing" ? "passing" : seat().ready ? "dismissed" : undefined;
        // The answer is shown as it is written: one message, edited as the text grows (Telegram tolerates an edit every second or so)
        const chatId = ctx.chat!.id;
        let draft: { message_id: number } | undefined;
        let lastEdit = 0;
        let editing: Promise<unknown> = Promise.resolve();
        const show = (soFar: string) => {
          if (Date.now() - lastEdit < 1200) return;
          lastEdit = Date.now();
          const text = soFar.trim();
          if (!text) return;
          editing = editing.then(async () => {
            if (!draft) draft = await bot.api.sendMessage(chatId, text + " …");
            else await bot.api.editMessageText(chatId, draft.message_id, text + " …").catch(() => {});
          });
        };
        // Anything that sounded like an order went to the council by the clerk's own tool
        const reply = await whileTyping(bot, chatId, clerkReply(seat(), message, away, show));
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
        let reply = await whileTyping(bot, ctx.chat!.id, advisorReply(seat(), thenGo ? `${message}\n\n[The ruler added /onward: this is their last word for this audience. Act on it, decide anything still open yourself as they would wish, and give your closing now - ask nothing further, and do not end with the /onward line: the court is dismissed as soon as you finish.]` : message, roundLength(game.turn)));
        // A closing's picture of the decision and the ruler's words for the Chronicler went by the advisor's own tools. The picture is painted once
        // the court is dismissed - a closing can still be talked over, and only the last one stands.
        // A court the advisor dismissed by its own call is not also offered the tap
        if (seat().dismissed) reply = reply.replace(new RegExp(`\\n*/(${LEAVE.join("|")})\\s*$`, "i"), "");
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
      for (const other of state.seats) await tell(other, word);
    });

    bot.command("newgame", async (ctx) => {
      if (state.phase === "passing") return ctx.reply("Wait until time stops passing.");
      const keyboard = new InlineKeyboard();
      row(keyboard, "humans", advisors.map((_, seatIndex) => seatIndex + 1));
      await ctx.reply(`A new world, then. This ends the current game for everyone - nothing changes until you confirm at the end.\n\nHow many rulers will sit at the table? (There are ${advisors.length} advisor bots.)`, { reply_markup: keyboard });
    });

    bot.callbackQuery(/^ng:(humans|agents|ai|difficulty|size|wonders|confirm|cancel):?(.*)$/, async (ctx) => {
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
      // A ruler keeps their advisor bot's chat from one game to the next; the first seats go to the first bots
      state.seats = [
        ...Array.from({ length: draft.humans }, (_, botIndex) => ({ ...blankSeat(), bot: botIndex, chatId: seatOf(botIndex)?.chatId, rulerName: seatOf(botIndex)?.rulerName, effort: HUMAN_EFFORTS[botIndex] })),
        ...Array.from({ length: draft.agents ?? 0 }, (_, agentIndex) => ({ ...blankSeat(), kind: "agent" as const, model: AGENT_MODELS[agentIndex % AGENT_MODELS.length], effort: AGENT_EFFORT })),
      ];
      state.difficulty = draft.difficulty;
      state.wonders = draft.wonders ?? "all";
      state.workshop = false; // a new game is a real one: no out-of-character talk unless /workshop opens the door
      state.proclaimed = [];
      state.epicTold = false;
      state.chapters = [];
      state.pictures = []; // the last world's paintings must not steer this one's
      state.pendingRound = undefined;
      state.mapSize = draft.size;
      state.aiCivs = draft.ai ?? AI_CIVS;
      state.phase = "setup";
      persist();
      await ctx.editMessageText(`So be it: a ${draft.size.toLowerCase()} world, ${draft.humans} ruler${draft.humans === 1 ? "" : "s"}, ${state.aiCivs} rival peoples.`);
      for (const other of state.seats) await tell(other, "A new history is about to begin. Send /start to choose your people and assemble your court.");
      for (const wear of wearNames) void wear?.();
    });
  } else bot.command("newgame", (ctx) => ctx.reply("Only the ruler of the first seat may start a new game."));

  /** Whether a message opens by calling someone by their first name */
  const addressed = (name: string, text: string) => new RegExp(`^[^\\p{L}\\p{N}]*${name.split(" ")[0].replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text);
  bot.on("message:text", async (ctx) => {
    if (seat().fallen) return ctx.reply(`${seat().civ} is no more, Majesty. Only the Chronicler writes of it now.`);
    if (state.phase === "passing" && seat().character) return clerk(ctx, ctx.message.text);
    if (state.phase === "passing") return ctx.reply("Time is passing, Majesty - I will report as soon as there is news.");
    if (seat().clerk && addressed(seat().clerk!.name, ctx.message.text)) return clerk(ctx, ctx.message.text);
    // A dismissed court: the advisor has withdrawn until every ruler is ready, and the clerk keeps the ruler company - unless the advisor is called back by name
    if (seat().ready && seat().character && state.phase === "audience") {
      if (!addressed(seat().character!.name, ctx.message.text)) return clerk(ctx, ctx.message.text);
      seat().ready = false;
      const annal = seat().annals?.at(-1);
      if (annal) annal.settled = undefined; // the closing is talked over again; the next dismissal records the last word
      persist();
      log(`${seat().civ}: the court is reopened`);
    }
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
