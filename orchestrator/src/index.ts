// Telegram front: one advisor bot per seat, one herald bot for the world newspaper

import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { advisorGreeting, loadSchema, advisorReply, chooseWonder, textModel, chroniclerEpic, clerkReply, describeDecision, draftClerk, eraScene, oddityScene, pronounLine, realmSaga, victoryScene, wonderBoon } from "./agents.ts";
import { card, draftCandidates, draftSovereign } from "./characters.ts";

const ADVISOR_MODEL = process.env.ADVISOR_MODEL ?? "claude-opus-5";
import { devFeedInChat, flushDevFeed } from "./devfeed.ts";
import { advisorPortrait, asJpeg, campaignMap, chroniclerEmblem, generateImage, imagesIdle, onImageLog, paintedMap } from "./images.ts";
import { host, type GameState, type PublicEvent, type RoundResult } from "./host.ts";
import { playRound as runRound, turnsAhead } from "./round.ts";
import { diedPassing, forgetPicture, persist, recordPicture, remember, state, type Annal, type Picture, type Seat } from "./store.ts";

/** Rival realms played by the game itself, chosen at random; 0 for an all-human world */
const AI_CIVS = Number(process.env.AI_CIVS ?? 2);
const MAP_SIZES = ["Tiny", "Small", "Medium", "Large", "Huge"];
/** The shapes of world the /newgame wizard offers (the engine's map types), each as the world's own words would put it */
const MAP_TYPES: Record<string, string> = {
  "Pangaea": "one great landmass",
  "Continent and Islands": "one great continent and its islands",
  "Two Continents": "two continents divided by the sea",
  "Three Continents": "three continents divided by the sea",
  "Small Continents": "scattered small continents",
  "Archipelago": "a sea of islands",
  "Fractal": "lands of every shape, torn by inlets",
  "Perlin": "rolling lands and inland seas",
};
const DEFAULT_MAP_SIZE = process.env.MAP_SIZE ?? "Medium";
/** Models for agent-ruled realms, dealt in turn */
const AGENT_MODELS = (process.env.AGENT_MODELS ?? "claude-sonnet-5").split(",").map((model) => model.trim());
/** Effort for every sovereign in a new game. (A ruler's seat keeps the per-role settings, so a letter can be written with more care than a reply.) */
type Effort = "low" | "medium" | "high" | "xhigh" | "max";
const asEffort = (value?: string): Effort | undefined => (["low", "medium", "high", "xhigh", "max"].includes(value ?? "") ? (value as Effort) : undefined);
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

// A harness points the bots at a stand-in for Telegram (harness/probe-ending.mts), so the orchestrator can run whole on a copy of a game
const telegram = process.env.TELEGRAM_API_ROOT ? { client: { apiRoot: process.env.TELEGRAM_API_ROOT } } : undefined;
const herald = new Bot(process.env.HERALD_BOT_TOKEN, telegram);
const advisors = advisorTokens.map((token) => new Bot(token, telegram));

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);
// A failure nobody caught is logged, not fatal: one lost reply must not take every court down with it
process.on("unhandledRejection", (error) => log("unhandled rejection:", error));

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
    seat.character ??= await draftSovereign(seat.civ, textModel(seat.model)).then(({ name, title, pronouns, sheet }) => ({ name, title, pronouns, sheet }));
    log(`${seat.civ} is ruled by ${seat.character?.name} (${seat.model})`);
  }
  const ruled = state.seats.map((seat) => seat.civ);
  const free = shuffled((await host.nations()).map((nation) => nation.name).filter((name) => !ruled.includes(name)));
  const others = free.slice(0, state.aiCivs ?? AI_CIVS);
  // The Chronicler wears this world's emblem: painted once, beside the making of the world, and set as the bot's face when it is done
  // The emblem is the world's first picture: posted to every Chronicler chat as the history opens, then worn as the bot's face
  void chroniclerEmblem([...ruled, ...others]).then(async (png) => {
    if (!png) return;
    for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png, "emblem.png"), { caption: `The emblem of this world: ${[...ruled, ...others].join(", ")}.` }).catch((error) => log("emblem post failed:", error.message));
    await herald.api.setMyProfilePhoto({ type: "static", photo: new InputFile(await asJpeg(png), "emblem.jpg") });
    log("the Chronicler wears the new world's emblem");
  }).catch((error) => log("the Chronicler's emblem failed:", error.message));
  const mapSize = state.mapSize ?? DEFAULT_MAP_SIZE;
  const noWonders = state.wonders === "rulers" ? [...state.seats.filter((seat) => seat.kind === "agent").map((seat) => seat.civ), ...others]
    : state.wonders === "advised" ? others : [];
  const mapType = state.mapType ?? "Pangaea";
  await host.newGame({ ruled, others, noWonders, mapSize, mapType, cityStates: CITY_STATES[mapSize] ?? 6, difficulty: state.difficulty ?? "Prince" });
  // The war leave, the host's to hold: a sovereign has it; an advisor only by the ruler's plain word (the officials' own acts have their defaults in the host)
  for (const seat of state.seats)
    await host.setOrders(seat.civ, { mayDeclareWar: seat.kind === "agent" || !!seat.mayDeclareWar }).catch((error) => log(`setting the war leave for ${seat.civ} failed:`, error.message));
  state.phase = "audience";
  persist();
  log(`New world: ${mapSize}; ruled ${ruled.join(", ")}; AI ${others.join(", ") || "none"}`);
  const overview = `A new world has been made: a ${mapSize.toLowerCase()} world of ${MAP_TYPES[mapType] ?? mapType}, home to ${ruled.length + others.length} great peoples and ${CITY_STATES[mapSize] ?? 6} lesser cities. ${state.seats.filter((seat) => seat.kind !== "agent").map((seat) => seat.civ).join(" and ")} answer to rulers at this table${state.seats.some((seat) => seat.kind === "agent") ? `; ${state.seats.filter((seat) => seat.kind === "agent").map((seat) => `${seat.civ} is ruled by ${seat.character?.name}`).join(", ")}, who answer to no one` : ""}${others.length ? `; ${others.length} more peoples keep their own counsel, somewhere beyond the horizon` : ""}. History begins in 4000 BC.`;
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
    const [, civ, era] = /^(.+?) entered the (.+?)(?: with the learning of (?:.+?))?\.?$/.exec(event.text) ?? [];
    return !era || /^Ancient/i.test(era) ? [] : [{ event, civ, era }];
  });
  if (!entries.length) return [];
  const all = await host.events().catch(() => [] as PublicEvent[]);
  // One people at a time: two peoples entering the same age in the same round would otherwise be painted with the same face, neither picture yet known to the other
  const pictures: Picture[] = [];
  for (const { event, civ, era } of entries) {
    const tag = `${civ} enter the ${era}`;
    if ((state.pictures ?? []).some((picture) => picture.for === "chronicle" && picture.caption.startsWith(tag))) continue;
    const recent = all.filter((entry) => entry.turn <= event.turn && entry.text.startsWith(civ)).slice(-12);
    const cities = await host.cities(civ).catch(() => []);
    const scene = await eraScene(civ, era, event.year, recent, cities, pictures.map((picture) => `${picture.caption} - ${picture.description.slice(0, 200)}`)).catch((error) => { log(`era picture failed (${civ}):`, error.message); return null; });
    if (scene) pictures.push({ turn: event.turn, year: event.year, for: "chronicle", caption: `${tag}, ${event.year}. ${scene.caption}`, description: scene.description });
  }
  return pictures;
};

/** The world is won: the Chronicler paints the moment - once - and it leads the last age's pictures */
const victoryPictures = async (round: RoundResult): Promise<Picture[]> => {
  if (!/has won/.test(round.stoppedEarly ?? "")) return [];
  const game = await host.state();
  if (!game.winner) return [];
  const title = `${game.winner} wins the world: ${game.victoryType} victory, ${round.year}`;
  if ((state.pictures ?? []).some((picture) => picture.for === "chronicle" && picture.caption.startsWith(`${game.winner} wins the world`))) return [];
  const era = game.majorCivs.find((civ) => civ.civ === game.winner)?.era ?? "age it had reached";
  const cities = await host.cities(game.winner).catch(() => []);
  const scene = await victoryScene(game.winner, game.victoryType ?? "", era, round.year, cities).catch((error) => { log("victory picture failed:", error.message); return null; });
  if (!scene) return [];
  return [{ turn: round.turn, year: round.year, for: "chronicle", caption: `${title}. ${scene.caption.trim()}`, description: scene.description }];
};

/** The oddity of the age: none most ages, by the Chronicler's own judgement. Every decision is logged, so a game's worth can be counted */
const oddityPictures = async (round: RoundResult, seen: { campaigns: string[]; curiosities: string[] }, painting: string[]): Promise<(Picture & { note: string })[]> => {
  const answer = await oddityScene(round, round.publicEvents, seen.campaigns, seen.curiosities, painting).catch((error) => { log("the oddity of the age failed:", error.message); return null; });
  if (!answer) return [];
  if (!answer.oddity) { log(`no oddity this age (${round.fromYear} to ${round.year}): ${answer.why}`); return []; }
  // The caption stands on its own: no fixed opening (Olle, 2026-10-04: it reads better and funnier without)
  const caption = answer.oddity.caption.trim();
  if ((state.pictures ?? []).some((picture) => picture.for === "chronicle" && picture.caption.replace(/^The oddity of the age\. /, "") === caption)) { log(`the Chronicler's oddity was painted before: ${answer.why}`); return []; }
  log(`the Chronicler found an oddity (${round.fromYear} to ${round.year}): ${answer.why}`);
  return [{ turn: round.turn, year: round.year, for: "chronicle", caption, description: answer.oddity.description, note: "" }];
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
  const ruler = seat.kind === "agent" ? seat.character?.name : seat.rulerName;
  const saga = `THE SAGA OF ${seat.civ.toUpperCase()}${ruler ? ` UNDER ${ruler.toUpperCase()}` : ""}\nas the Chronicler tells it\n\n${rawSaga}`;
  const bot = botOf(seat);
  // Its ruler reads it first. Made public (a living realm's saga draws on its private journal, so it stays with its ruler until the end) it goes to the
  // players' group too, posted by the realm's own advisor; a sovereign's realm has no advisor bot, so the Chronicler posts that one, naming the realm first
  const readers: { bot: Bot; chatId: number; intro?: string }[] = [];
  if (bot && seat.chatId) readers.push({ bot, chatId: seat.chatId });
  if (publicly && bot) {
    if (state.groupChat && seat.bot !== undefined && state.groupBots?.includes(seat.bot)) readers.push({ bot, chatId: state.groupChat });
    else log(`${seat.civ}'s saga stays with its ruler: its advisor bot is not in the players' group`);
  }
  if (publicly && seat.kind === "agent")
    for (const chatId of state.heraldChats) readers.push({ bot: herald, chatId, intro: `The saga of ${seat.civ}, which ${seat.character?.name ?? "its sovereign"} ruled alone, with no ruler at this table:` });
  for (const reader of readers)
    await reader.bot.api.sendMessage(reader.chatId, [reader.intro, saga].filter(Boolean).join("\n\n")).catch((error: Error) => log(`saga of ${seat.civ} to chat ${reader.chatId} failed:`, error.message));
  await sendPlates(medium, plates, async (png, caption) => {
    for (const reader of readers) await reader.bot.api.sendPhoto(reader.chatId, new InputFile(png, "plate.png"), { caption }).catch(() => {});
  });
}

async function sendEpic(occasion: string) {
  const [events, game] = await Promise.all([host.events(), host.state()]);
  const standings = game.majorCivs.map((civ) => `${civ.civ}: ${civ.alive ? "stands" : "has fallen"}`).join("\n");
  const spoken = (state.proclaimed ?? []).map((entry) => ({ turn: entry.turn, year: entry.year, text: `Proclaimed: ${entry.text}` }));
  const history = [...events, ...spoken].sort((a, b) => a.turn - b.turn);
  log(`the epic, told for: ${occasion}`);
  const { text, medium, plates } = await chroniclerEpic(history, standings, occasion, state.chapters ?? []);
  await broadcastHerald(`THE EPIC OF THE WORLD\nas the Chronicler tells it\n\n${text}`);
  await sendPlates(medium, plates, async (png, caption) => {
    for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png, "plate.png"), { caption }).catch(() => {});
  });
}

/** Over: someone has won, or every ruler who sat at the table has fallen */
function gameOver(game: GameState, standingSeats: Seat[]) {
  const rulers = state.seats.filter((seat) => seat.kind !== "agent");
  return !!game.winner || (rulers.some((seat) => seat.fallen) && standingSeats.every((seat) => seat.kind === "agent"));
}

/** What the ending was, for the epic: the occasion it is told on */
const endingOf = (game: GameState) => game.winner ? `${game.winner} has won a ${game.victoryType} victory, and the story is complete.` : "The last ruler's realm has fallen, and with it the story the rulers were telling ends; the world goes on without them.";

let tellingTheEnding: Promise<void> | undefined;
/** The game's closing words: the closing broadcast, the saga of every realm still standing, the epic of the world. Each step logs its start and its end,
 *  is remembered once done (endingDone) and does not stop the next if it fails; the game counts as told (epicTold) only once the epic is out. Olle's Korea game
 *  set the flag first and stalled after it at T257: no saga, no epic, and a restart made it final. Taken up again at startup if it never finished */
function tellTheEnding(game: GameState) {
  tellingTheEnding ??= (async () => {
    state.pendingRound = undefined;
    persist();
    const done = (state.endingDone ??= []);
    const step = async (name: string, work: () => Promise<unknown>) => {
      if (done.includes(name)) return true;
      const started = Date.now();
      log(`ending: ${name} begins`);
      try {
        await work();
        done.push(name);
        persist();
        log(`ending: ${name} done in ${Math.round((Date.now() - started) / 1000)} s`);
        return true;
      } catch (error) {
        log(`ending: ${name} failed:`, (error as Error).message);
        return false;
      }
    };
    await step("the last pictures", imagesIdle); // the last age's pictures land before the closing words
    const rulersLeft = (await standing()).filter((seat) => seat.kind !== "agent");
    const closing = game.winner ? `The game is over: ${game.winner} has won a ${game.victoryType} victory.` : "The game is over: the last ruler's realm has fallen.";
    await step("closing broadcast", async () => {
      await broadcastHerald(closing);
      for (const seat of state.seats) if (!rulersLeft.includes(seat)) await tell(seat, closing);
    });
    // Every realm still standing gets its saga: a ruler's from its own advisor, a sovereign's from the Chronicler
    const sovereignsLeft = state.seats.filter((seat) => seat.kind === "agent" && game.majorCivs.find((civ) => civ.civ === seat.civ)?.alive);
    for (const seat of [...rulersLeft, ...sovereignsLeft])
      await step(`saga of ${seat.civ}`, () => sendSaga(seat, game.winner === seat.civ ? `${seat.civ} has won the world - a ${game.victoryType} victory.` : game.winner ? `The world has been won by ${game.winner}; ${seat.civ} still stands, but not first.` : `The last ruler's realm has fallen; ${seat.civ} still stands.`));
    if (await step("epic", () => sendEpic(endingOf(game)))) {
      state.epicTold = true;
      persist();
      log("ending: told - the game's closing words are all out");
    } else log("ending: not yet told - what failed is taken up again at the next start");
  })().finally(() => { tellingTheEnding = undefined; });
  return tellingTheEnding;
}

async function playRound() {
  // Two rulers dismissing at the same moment must start one round, not two: the round sets the phase before its first await
  if (state.phase === "passing") return;
  const seated = state.seats.filter((seat) => seat.chatId || seat.kind === "agent");
  type Painting = Promise<Buffer | null>;
  const letters: { seat: Seat; annal?: Annal; letter: string; caption?: string; scene: Painting; marches: Painting; painted: Painting; urgent: boolean }[] = [];
  const chapters: { chapter: string; record?: { undelivered?: boolean }; pictures: { picture: Picture & { note?: string }; png: Buffer | null }[] }[] = [];
  let delivered = false;
  try {
    await runRound(seated, {
      working: (seat, work) => {
        const bot = botOf(seat);
        return bot && seat.chatId ? whileTyping(bot, seat.chatId, work) : work;
      },
      // Nothing is sent as it is written: letters, scenes, maps and the chapter are gathered, painted, and go out together once the age is complete
      dispatch: async (seat, dispatch, round) => {
        const annal = seat.annals?.at(-1); // the round has just set this letter down
        const bot = botOf(seat);
        if (!bot || !seat.chatId) return;
        const letter = [dispatch.heading, dispatch.text, dispatch.strategy, dispatch.question].filter(Boolean).join("\n\n");
        const game = await host.state();
        const scene = dispatch.image ? paintAndKeep({ turn: game.turn, year: game.year, for: seat.civ, ...dispatch.image }) : Promise.resolve(null);
        // The map of the age, always in one style: the painted world with the age's movements drawn as an atlas would - or with none, in a quiet age.
        // The host draws the age's campaigns as arrows; the painter repaints exactly those, and the host's own drawing comes with the letter beside the painted one
        const age = dispatch.age;
        const traced = host.map(seat.civ, "campaign", round.fromTurn, round.turn).catch((error) => { log("march map failed:", error.message); return null; });
        // An emergency council's letter gets the map too - the age so far, with the war's first marches on it - unless the game is over
        const painted = !PAINTED_MAPS || /has won/.test(round.stoppedEarly ?? "") ? Promise.resolve(null)
          : traced.then((png) => (png && age ? campaignMap(seat.civ, age, png) : paintedMap(seat.civ))).catch((error) => { log("campaign map failed:", error.message); return null; });
        // The host's campaign map comes with every letter as well, beside the painted one, while the painted maps are still being judged (MARCH_MAP=off stops it)
        const marches = process.env.MARCH_MAP === "off" ? Promise.resolve(null) : traced;
        letters.push({ seat, annal, letter, caption: dispatch.image?.caption, scene, marches, painted, urgent: !!round.stoppedEarly && !/has won/.test(round.stoppedEarly) });
      },
      notice: tell,
      chronicle: async (chapter, images, round, seen) => {
        const record = state.chapters?.at(-1); // the round has just set this chapter down
        // One or two scenes of the Chronicler's choosing, and every wonder
        // A wonder's picture says what the great work gives its builders
        // One wonder picture per people per age: when a people finished several, the Chronicler chooses the one most worth a painting
        const candidates = wonderPictures(round);
        const byCiv = new Map<string, Picture[]>();
        for (const picture of candidates) { const civ = /completed by (.+?) in /.exec(picture.caption)?.[1] ?? ""; byCiv.set(civ, [...(byCiv.get(civ) ?? []), picture]); }
        const chosen = (await Promise.all([...byCiv.entries()].map(async ([civ, pictures]) => {
          if (pictures.length <= 1) return pictures;
          const names = pictures.map((picture) => picture.caption.split(",")[0]);
          const pick = await chooseWonder(civ, names, round.year).catch(() => names[0]);
          log(`${civ} finished ${names.join(", ")}; the Chronicler paints ${pick}`);
          return pictures.filter((picture) => picture.caption.startsWith(`${pick},`)).slice(0, 1);
        }))).flat();
        for (const picture of candidates) if (!chosen.includes(picture)) forgetPicture(picture); // the others go unpainted
        const wonders = await Promise.all(chosen.map(async (picture) => {
          const wonder = picture.caption.split(",")[0];
          const boon = await host.lookup(state.seats[0]?.civ ?? "", wonder).then((entry) => wonderBoon(wonder, /completed by (.+?) in /.exec(picture.caption)?.[1] ?? "its builders", entry)).catch(() => "");
          return { ...picture, note: boon.trim() };
        }));
        // All of the age's pictures are painted together and then sent in the order of the years they show
        const pictures = [...images.map((image) => ({ turn: round.turn, year: round.year, for: "chronicle", note: "", ...image })), ...wonders, ...(await eraPictures(round)).map((picture) => ({ ...picture, note: "" }))];
        const yearOf = (picture: Picture) => { const m = /\b(\d{3,4})\b(?:\s*(BC))?/i.exec(picture.caption); return m ? (m[2] ? -Number(m[1]) : Number(m[1])) : Number.MAX_SAFE_INTEGER; };
        // A victory's picture leads the last age's pictures, whatever the years of the others
        const victory = (await victoryPictures(round)).map((picture) => ({ ...picture, note: "" }));
        // The oddity of the age, rarely: asked of the Chronicler after the rest are chosen, never in the victory's age, and sent last
        // (it is weighed while the others are being painted)
        const paintAll = (list: (Picture & { note: string })[]) => Promise.all(list.map(async (picture) => ({ picture, png: await paintAndKeep(picture) })));
        const [painted, odd] = await Promise.all([
          paintAll([...victory, ...pictures]),
          /has won/.test(round.stoppedEarly ?? "") ? Promise.resolve([]) : oddityPictures(round, seen, [...victory, ...pictures].map((picture) => picture.caption)).then(paintAll),
        ]);
        const first = painted.filter((entry) => entry.png && victory.includes(entry.picture));
        const middle = painted.filter((entry) => entry.png && !victory.includes(entry.picture));
        chapters.push({ chapter, record, pictures: [...first, ...middle.sort((a, b) => yearOf(a.picture) - yearOf(b.picture) || a.picture.turn - b.picture.turn), ...odd.filter((entry) => entry.png)] });
      },
      log,
    });
    // The age is complete and painted: every ruler's letter goes out now, then the Chronicler's chapter, all within the same minute.
    // Time keeps passing until they are delivered: a word sent meanwhile goes to the clerk, not to an advisor who has read a letter the ruler has not
    state.phase = "passing";
    persist();
    for (const post of letters) {
      const bot = botOf(post.seat)!;
      const chatId = post.seat.chatId!;
      // An emergency letter goes the moment it is written; its picture follows. A regular letter waits for its paintings
      const send = async () => {
        await bot.api.sendMessage(chatId, post.letter).catch((error) => log(`letter to ${post.seat.civ} failed:`, error.message));
        if (post.annal) { post.annal.undelivered = undefined; }
        post.seat.floor = undefined; persist(); // a letter opens the court with the advisor speaking
      };
      if (post.urgent) await send();
      const [scene, marches, painted] = await Promise.all([post.scene, post.marches, post.painted]);
      if (!post.urgent) await send();
      if (scene) await bot.api.sendPhoto(chatId, new InputFile(scene, "scene.png"), { caption: post.caption }).catch((error) => log(`scene to ${post.seat.civ} failed:`, error.message));
      if (marches) await bot.api.sendPhoto(chatId, new InputFile(marches, "marches.png")).catch((error) => log(`marches to ${post.seat.civ} failed:`, error.message));
      if (painted) await bot.api.sendPhoto(chatId, new InputFile(painted, "map.png")).catch((error) => log(`map to ${post.seat.civ} failed:`, error.message));
    }
    for (const post of chapters) {
      await broadcastHerald(post.chapter);
      if (post.record) { post.record.undelivered = undefined; persist(); }
      for (const { picture, png } of post.pictures)
        for (const chatId of state.heraldChats) await herald.api.sendPhoto(chatId, new InputFile(png!, "scene.png"), { caption: [picture.caption, picture.note].filter(Boolean).join(". ") }).catch(() => {});
    }
    state.phase = "audience";
    persist();
    delivered = true;
    const game = await host.state();
    // A realm that fell this round: its ruler is told once, and gets the saga of their reign
    for (const seat of seated) {
      const fell = !game.majorCivs.find((civ) => civ.civ === seat.civ)?.alive;
      if (fell && !seat.fallen) {
        seat.fallen = true;
        await tell(seat, `${seat.civ} is no more, Majesty. Its cities belong to others now, and I have no realm left to counsel. History will remember what you said and did - the Chronicler is writing the saga of your reign now.`);
        await sendSaga(seat, `${seat.civ} has fallen.`).catch((error) => log("saga failed:", error.message));
      }
    }
    persist();
    await flushDevFeed(herald, `Round to ${game.year} (turn ${game.turn})${state.pendingRound ? " - interrupted by urgent news" : ""}`);
    // The game is over when someone has won, or when no ruler is left at the table. Only then, after the last chapter, comes the epic of the whole world.
    if (gameOver(game, await standing()) && !state.epicTold) await tellTheEnding(game);
  } catch (error) {
    log("Round failed:", error);
    state.phase = "audience"; // whatever failed, the rulers must be able to speak again
    persist();
    // Once the letters are out, the rulers are in audience as usual: what failed after that (a saga, the epic) is the log's business
    if (!delivered) for (const seat of seated) await tell(seat, "Something went wrong while time was passing. Send /onward to try again.");
  }
}

/** Time passes once every standing ruler has dismissed their court: checked after every dismissal, and at startup */
async function maybeStartRound() {
  try {
    if (state.phase !== "audience" || (await standing()).some((seat) => !seat.ready)) return;
    void playRound();
  } catch (error) {
    log("could not tell whether every court has risen:", error);
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

/** Whether a message opens by calling someone by their first name */
const addressed = (name: string, text: string) => new RegExp(`^[^\\p{L}\\p{N}]*${name.split(" ")[0].replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text);

function setUpAdvisor(bot: Bot, index: number) {
  // Only past the first middleware below, which turns away a bot with no ruler's seat in this game
  const seat = (): Seat => seatOf(index)!;

  // The players' group: an advisor bot added to it learns where the game's public words go - one group per game, the latest wins. Only this
  // membership update counts: a word in some group never makes it the players' group, as the Chronicler's own list works
  bot.on("my_chat_member", (ctx) => {
    if (ctx.chat.type === "private") return;
    const member = ctx.myChatMember.new_chat_member;
    const present = ["member", "administrator", "creator"].includes(member.status) || (member.status === "restricted" && member.is_member);
    if (present) {
      if (state.groupChat !== ctx.chat.id) {
        log(state.groupChat ? `The players' group is now chat ${ctx.chat.id} (was ${state.groupChat}): advisor ${index + 1} was added there` : `The players' group is chat ${ctx.chat.id}: advisor ${index + 1} was added there`);
        state.groupChat = ctx.chat.id;
        state.groupBots = [];
      }
      if (!state.groupBots?.includes(index)) (state.groupBots ??= []).push(index);
    } else if (state.groupChat === ctx.chat.id && state.groupBots?.includes(index)) {
      state.groupBots = state.groupBots.filter((other) => other !== index);
      log(`Advisor ${index + 1} left the players' group (chat ${ctx.chat.id})`);
      if (!state.groupBots.length) { state.groupChat = undefined; state.groupBots = undefined; log("No advisor is left in the players' group; the sagas stay with their rulers"); }
    }
    persist();
  });
  // In a group the court never sits and the advisor says nothing, whoever addresses it: it posts its realm's saga there at the end and no more.
  // Speaking before the assembled courts would be a feature of its own (a public voice that knows every rival reads it), not yet designed
  bot.use(async (ctx, next) => {
    if (!ctx.chat || ctx.chat.type === "private") return next();
  });
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
  /** One reply at a time per seat, so they stay in order. A job that fails is logged and the next one still runs. */
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (job: () => Promise<unknown>) => { queue = queue.then(job).catch((error) => log(`${seatOf(index)?.civ ?? `advisor ${index + 1}`}: a reply failed:`, error)); };
  /** Counts the courts that have risen: a decision picture from a court that was reopened and rose again is not sent */
  let courtsRisen = 0;

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
      void advisorPortrait(seat().civ, seat().character!.sheet + pronounLine(seat().character!.pronouns), era).then(async (png) => {
        if (!png) return;
        await ctx.replyWithPhoto(new InputFile(png, "portrait.png"), { caption: seat().character!.name });
        // The advisor's face is the bot's face: the portrait becomes its profile photo (one advisor per bot, so one face per game)
        await bot.api.setMyProfilePhoto({ type: "static", photo: new InputFile(await asJpeg(png), "portrait.jpg") })
          .catch((error) => log(`setting the profile photo for ${seat().civ}'s advisor failed:`, error.message));
      }).catch((error) => log(`portrait for ${seat().civ} failed:`, error.message));
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
    // Whatever the advisor's dismiss_court asked for is being done now, or cannot be: it never outlives this call
    seat().dismissed = false;
    if (seat().fallen) return reply(`${seat().civ} is no more, Majesty.`);
    if (state.phase === "setup") return reply("The world is not made yet - it begins once every ruler has assembled a court (/start).");
    if (state.phase === "passing") return reply("Time is already passing, Majesty.");
    if (seat().ready) return reply("The court has already risen, Majesty; the years wait only on the other rulers.");
    // Dismissed without answering the advisor's last question: silence is assent to what it recommended
    const last = seat().chat.at(-1);
    // A question left unanswered, or smaller matters left to the advisor: either needs the closing pass, or the leans are never applied
    if (silently && last?.from === "advisor" && (/\?/.test(last.text) || seat().matters?.length)) {
      // A question unanswered needs a word on which way the advisor went; matters alone do not: the ruler has read the leans and needs no retelling
      const message = /\?/.test(last.text) && !last.closing
        ? "[The ruler dismisses the court without another word. The choice is yours now: take the way forward you recommended, or the one the ruler's recorded will and what you know of them point to" + (seat().matters?.length ? ", and settle the smaller matters you listed as you see fit" : "") + ". Apply it, update your plan, and say in one or two sentences which way you went and why. Do not offer /onward - the court is already dismissed.]"
        : "[The ruler dismisses the court without another word, leaving the smaller matters to you. Settle each by your lean and update your plan. Nothing you write here reaches the ruler, who has read your leans; if one had to go another way, your plan carries it to your next dispatch.]";
      // A question left open earns a word; a closing's own question marks (the matters' invitations) do not: the ruler read the leans under it
      const shown = /\?/.test(last.text) && !last.closing;
      try {
        const answer = (await (shown ? whileTyping(bot, seat().chatId!, advisorReply(seat(), message, turnsAhead((await host.state()).turn))) : advisorReply(seat(), message, turnsAhead((await host.state()).turn)))).replace(new RegExp(`\\n*/(${LEAVE.join("|")})\\s*$`, "i"), "").trim();
        if (shown && answer) {
          remember(seat(), { from: "advisor", text: answer });
          await reply(answer);
        }
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
    const court = ++courtsRisen;
    if (seat().chatId && seat().character) {
      const chatId = seat().chatId!;
      const civ = seat().civ;
      void (async () => {
        const game = await host.state();
        const decided: Picture = asked ? { ...asked, for: civ } : { turn: game.turn, year: game.year, for: civ, ...(await describeDecision(seat())) };
        // A court reopened and dismissed again has a newer decision, and its own picture: this one is overtaken
        paint(decided, async (png) => { if (court === courtsRisen) await bot.api.sendPhoto(chatId, new InputFile(png, "decision.png"), { caption: decided.caption }); else forgetPicture(decided); });
      })().catch((error) => log("decision picture failed:", error.message));
    }
    seat().ready = true;
    seat().floor = undefined; // a court that rises returns the floor to the advisor
    seat().matters = undefined; // whatever was not taken up was left to the advisor
    seat().dismissed = false; // a closing pass above may have called dismiss_court again
    persist();
    // The same words whether the other rulers are done or not: what the wait is for is not the ruler's concern
    await reply("The court is dismissed. Until next time.").catch((error) => log(`telling ${seat().civ} of the dismissal failed:`, error.message));
    await maybeStartRound();
  };

  // "/go" alone dismisses the court; "/go and buy the library first" (or a message that ends in /go) is answered and acted on, then time passes
  const canHoldAudience = () => !seat().fallen && state.phase === "audience" && !!seat().character;
  // A bare /onward waits its turn behind any reply still being written, like every other message; words after it while time passes go to the clerk
  bot.command(LEAVE, (ctx) => {
    const words = ctx.match.trim();
    if (words && canHoldAudience()) return audience(ctx, words, true);
    if (words && state.phase === "passing" && seat().character && !seat().fallen) return clerk(ctx, words);
    enqueue(() => dismiss((text) => ctx.reply(text), true));
  });

  /** The keeper of the rolls answers: while the clocks run, on /clerk, or when addressed by name. Read-only; anything that sounded like an order goes to the council. */
  const clerk = (ctx: Context, message: string) => {
    enqueue(async () => {
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
          }).catch(() => {}); // a draft that could not be shown is only a draft: the full answer is sent at the end
        };
        // Anything that sounded like an order went to the council by the clerk's own tool
        const reply = await whileTyping(bot, chatId, clerkReply(seat(), message, away, show));
        (seat().clerkChat ??= []).push({ from: "ruler", text: message }, { from: "clerk", text: reply });
        if (seat().clerkChat!.length > 12) seat().clerkChat!.splice(0, seat().clerkChat!.length - 12);
        persist();
        await editing;
        // While the clerk has the floor in an open court, every reply ends with the tap that calls the advisor back
        const shown = (reply || "(the rolls are silent)") + (seat().floor === "clerk" && state.phase === "audience" && !seat().ready ? "\n\n/advisor" : "");
        if (draft) await bot.api.editMessageText(chatId, draft.message_id, shown).catch(() => ctx.reply(shown));
        else await ctx.reply(shown);
      } catch (error) {
        log("clerk failed:", error);
        await ctx.reply("The clerk has mislaid the roll. Ask again in a moment.").catch(() => {});
      }
    });
  };

  /** One audience at a time per seat, so replies stay in order */
  /** thenGo: the ruler ended their message with /go - answer it, act on it, and let time pass without another word from them */
  const audience = (ctx: Pick<Context, "reply"> & { chat?: { id: number } }, message: string, thenGo = false, waiting?: { text: string; thenGo: boolean }) => {
    // Kept on disk until it is answered: a restart in the middle of a reply must not swallow the ruler's words
    const entry = waiting ?? { text: message, thenGo };
    if (!waiting) (seat().unanswered ??= []).push(entry);
    persist();
    const answered = () => { seat().unanswered = seat().unanswered?.filter((other) => other !== entry); if (!seat().unanswered?.length) seat().unanswered = undefined; persist(); };
    enqueue(async () => {
      // Decided when the reply is due, not when the message came: a court dismissed or a round begun meanwhile changes who answers
      if (state.phase === "passing" && seat().character) { answered(); return clerk(ctx as Context, message); }
      if (seat().ready && state.phase === "audience") {
        seat().ready = false;
        const annal = seat().annals?.at(-1);
        if (annal) annal.settled = undefined; // the closing is talked over again; the next dismissal records the last word
        persist();
        log(`${seat().civ}: the court is reopened by a word that came as it rose`);
      }
      try {
        const game = await host.state();
        let reply = await whileTyping(bot, ctx.chat!.id, advisorReply(seat(), thenGo ? `${message}\n\n[The ruler added /onward: this is their last word for this audience. Act on it, decide anything still open yourself as they would wish, and give your closing now - ask nothing further, and do not end with the /onward line: the court is dismissed as soon as you finish.]` : message, turnsAhead(game.turn)));
        // A closing's picture of the decision and the ruler's words for the Chronicler went by the advisor's own tools. The picture is painted once
        // the court is dismissed - a closing can still be talked over, and only the last one stands.
        // A court the advisor dismissed by its own call is not also offered the tap
        if (seat().dismissed) reply = reply.replace(new RegExp(`\\n*/(${LEAVE.join("|")})\\s*$`, "i"), "");
        remember(seat(), { from: "ruler", text: message });
        remember(seat(), { from: "advisor", text: reply });
        seat().forCouncil = undefined; // what was left with the clerk was before the advisor in this reply
        persist();
        await ctx.reply(reply);
        // A closing that never weighed its smaller matters is asked once: list them, or say there are none (an empty list counts as considered)
        const closed = seat().dismissed || new RegExp(`/(${LEAVE.join("|")})\\s*$`, "i").test(reply);
        if (closed && seat().matters === undefined && !thenGo && !state.pendingRound?.urgent) {
          const listed = await whileTyping(bot, ctx.chat!.id, advisorReply(seat(), "[You closed the court without weighing the smaller matters. If there are calls you would settle alone once it rises, list them now - numbered, one line each with your lean, checked - and give them to smaller_matters, ending with \"Name any you want to raise; otherwise\" and the /onward line. If there are truly none, call smaller_matters with an empty list and say in one line that nothing small waits. This note is the court's, not the ruler's words.]", turnsAhead((await host.state()).turn)))
            .catch((error) => { log(`${seat().civ}: the smaller-matters follow-up failed:`, error.message); return ""; });
          if (listed.trim()) {
            const shown = seat().dismissed ? listed.replace(new RegExp(`\\n*/(${LEAVE.join("|")})\\s*$`, "i"), "") : listed;
            remember(seat(), { from: "advisor", text: shown });
            persist();
            await ctx.reply(shown);
          }
        }
        // Answered once the ruler has it: a restart before this answers it again, which beats never answering it
        answered();
        await flushDevFeed(herald, `Audience - ${seat().civ}`);
        if (seat().dismissed || thenGo) await dismiss((text) => ctx.reply(text));
      } catch (error) {
        log("advisor failed:", error);
        seat().dismissed = false;
        answered();
        await ctx.reply("Forgive me, Majesty, I lost my train of thought. Could you say that again?").catch(() => {});
      }
    });
  };

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
  // /clerk gives the clerk the floor: every word after it goes to the clerk until /advisor (or the advisor's name) calls the advisor back
  bot.command("clerk", (ctx) => {
    if (!seat().character) return void ctx.reply("The court is not assembled yet, Majesty.");
    seat().floor = "clerk"; persist();
    clerk(ctx, ctx.match.trim() || "[The ruler has called you to the desk and said nothing yet: greet them in a line and ask what they want of the rolls.]");
  });
  bot.command("advisor", (ctx) => {
    if (!seat().character) return void ctx.reply("The court is not assembled yet, Majesty.");
    seat().floor = undefined; persist();
    const words = ctx.match.trim();
    if (state.phase === "passing") return void ctx.reply(`${seat().character!.name} is away governing, Majesty, and will report when the age is done. ${seat().clerk?.name ?? "The clerk"} keeps the rolls meanwhile.`);
    if (words) return audience(ctx, words);
    audience(ctx, "[The ruler has turned from the clerk back to you and said nothing yet: take up the audience where it stood, in a line or two.]");
  });

  bot.command("usage", (ctx) => ctx.reply(usageSummary()));

  bot.command("map", (ctx) => sendMap(bot, seat()).catch(() => ctx.reply("No map to show yet.")));

  // The first seat's ruler may start over: /newgame asks how many rulers, how many rival peoples, how large a world
  if (index === 0) {
    const draft: { humans?: number; agents?: number; ai?: number; difficulty?: string; size?: string; mapType?: string; wonders?: "all" | "rulers" | "advised" } = {};
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

    bot.callbackQuery(/^ng:(humans|agents|ai|difficulty|size|maptype|wonders|confirm|cancel):?(.*)$/, async (ctx) => {
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
        Object.keys(MAP_TYPES).forEach((name, index) => { keyboard.text(name, `ng:maptype:${name}`); if (index % 2 === 1) keyboard.row(); });
        return void ctx.editMessageText("One great landmass, or lands divided by sea? On one landmass every people can walk to every other; where the sea divides them, ships and the coast matter, and a people may grow undisturbed for a long while.", { reply_markup: keyboard });
      }
      if (step === "maptype") {
        draft.mapType = MAP_TYPES[value] ? value : "Pangaea";
        const keyboard = new InlineKeyboard();
        row(keyboard, "wonders", Object.keys(WONDERS));
        return void ctx.editMessageText("Who may raise the world's wonders? Everyone is the usual game. Rulers only leaves them to the rulers' realms - sovereigns and the game's peoples build none, so every wonder is one of yours. Rulers and sovereigns bars only the game's peoples.", { reply_markup: keyboard });
      }
      if (step === "wonders") {
        draft.wonders = WONDERS[value];
        const keyboard = new InlineKeyboard().text("Make it so", "ng:confirm").text("Keep the old world", "ng:cancel");
        return void ctx.editMessageText(`A ${draft.size!.toLowerCase()} world of ${MAP_TYPES[draft.mapType ?? "Pangaea"]} with ${draft.humans} ruler${draft.humans === 1 ? "" : "s"}, ${draft.agents ?? 0} sovereign${draft.agents === 1 ? "" : "s"}, ${draft.ai} of the game's own people${draft.ai === 1 ? "" : "s"} played by the game and ${CITY_STATES[draft.size!] ?? 6} lesser cities${draft.wonders === "rulers" ? "; wonders are for the rulers' realms alone" : draft.wonders === "advised" ? "; the game's peoples raise no wonders" : ""}. Each ruler then chooses a people and assembles a court. The current game ends for everyone.`, { reply_markup: keyboard });
      }
      if (state.phase === "passing" || !draft.humans || !draft.size) return void ctx.editMessageText("Send /newgame to begin again.");
      // A reply still being written belongs to the old world: it would land in the new one's seat
      if (state.seats.some((other) => other.unanswered?.length)) return void ctx.reply("An advisor is still answering - press Make it so again in a moment.");
      // A ruler keeps their advisor bot's chat from one game to the next; the first seats go to the first bots
      state.seats = [
        ...Array.from({ length: draft.humans }, (_, botIndex) => ({ ...blankSeat(), bot: botIndex, chatId: seatOf(botIndex)?.chatId, rulerName: seatOf(botIndex)?.rulerName })),
        ...Array.from({ length: draft.agents ?? 0 }, (_, agentIndex) => ({ ...blankSeat(), kind: "agent" as const, model: AGENT_MODELS[agentIndex % AGENT_MODELS.length], effort: AGENT_EFFORT })),
      ];
      state.difficulty = draft.difficulty;
      state.wonders = draft.wonders ?? "all";
      state.workshop = false; // a new game is a real one: no out-of-character talk unless /workshop opens the door
      state.proclaimed = [];
      state.epicTold = false;
      state.endingDone = [];
      state.chapters = [];
      state.pictures = []; // the last world's paintings must not steer this one's
      state.pendingRound = undefined;
      state.mapSize = draft.size;
      state.mapType = draft.mapType ?? "Pangaea";
      state.aiCivs = draft.ai ?? AI_CIVS;
      state.phase = "setup";
      persist();
      await ctx.editMessageText(`So be it: a ${draft.size.toLowerCase()} world of ${MAP_TYPES[state.mapType ?? "Pangaea"]}, ${draft.humans} ruler${draft.humans === 1 ? "" : "s"}, ${state.aiCivs} rival peoples.`);
      for (const other of state.seats) await tell(other, "A new history is about to begin. Send /start to choose your people and assemble your court.");
      for (const wear of wearNames) void wear?.();
    });
  } else bot.command("newgame", (ctx) => ctx.reply("Only the ruler of the first seat may start a new game."));

  bot.on("message:text", async (ctx) => {
    if (seat().fallen) return ctx.reply(`${seat().civ} is no more, Majesty. Only the Chronicler writes of it now.`);
    if (state.phase === "passing" && seat().character) return clerk(ctx, ctx.message.text);
    if (state.phase === "passing") return ctx.reply("Time is passing, Majesty - I will report as soon as there is news.");
    // The floor: the clerk's once called, the advisor's once called back - by command or by name
    if (seat().clerk && (addressed(seat().clerk!.name, ctx.message.text) || addressed("clerk", ctx.message.text))) { seat().floor = "clerk"; persist(); return clerk(ctx, ctx.message.text); }
    if (seat().floor === "clerk" && seat().character && addressed(seat().character!.name, ctx.message.text)) { seat().floor = undefined; persist(); }
    else if (seat().floor === "clerk" && !seat().ready && !new RegExp(`\\s/(${LEAVE.join("|")})\\s*$`, "i").test(ctx.message.text)) return clerk(ctx, ctx.message.text);
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

  // Words the ruler sent just before a restart: answer them now, in order, as if nothing had happened
  const left = seatOf(index)?.unanswered ?? [];
  if (left.length && seat().chatId && state.phase !== "setup") {
    const chatId = seat().chatId!;
    log(`${seat().civ}: answering ${left.length} message(s) left unanswered by the restart`);
    const replyHere = { chat: { id: chatId }, reply: ((text: string) => bot.api.sendMessage(chatId, text)) as Context["reply"] } as Context;
    for (const waiting of left) audience(replyHere, waiting.text, waiting.thenGo, waiting);
  }

  bot.catch((error) => log(`advisor ${index + 1} error:`, error.message));
}

function setUpHerald() {
  const GREETING = "The Chronicler will set down every chapter of the world's history here. Send /stop to end it.";
  /** Puts this chat on the Chronicler's list. With greet, it says so even when the chat was already there: that line is the only sign it worked */
  const subscribe = async (ctx: Context, greet: boolean) => {
    if (!ctx.chat) return;
    if (!state.heraldChats.includes(ctx.chat.id)) {
      state.heraldChats.push(ctx.chat.id);
      persist();
      log("Herald now publishes to chat", ctx.chat.id);
      greet = true;
    }
    if (greet) await ctx.reply(GREETING).catch((error) => log("herald greeting failed:", error.message));
  };
  const unsubscribe = (chatId: number, why: string) => {
    if (!state.heraldChats.includes(chatId)) return;
    state.heraldChats = state.heraldChats.filter((id) => id !== chatId);
    persist();
    log(`Herald no longer publishes to chat ${chatId} (${why})`);
  };
  herald.command("start", (ctx) => subscribe(ctx, true));
  herald.command("stop", async (ctx) => {
    unsubscribe(ctx.chat.id, "/stop");
    await ctx.reply("The Chronicler will write here no more. Send /start to have the chronicle here again.");
  });
  herald.command("epic", async (ctx) => {
    await subscribe(ctx, false);
    await ctx.replyWithChatAction("typing").catch(() => {});
    // A finished game's epic is told for its ending, as it was when the game closed; a game still running is a story so far
    const game = await host.state();
    await sendEpic(gameOver(game, await standing()) ? endingOf(game) : "A reader has asked for the story so far.").catch((error) => log("epic failed:", error.message));
  });
  // Added to a group (or unblocked in a private chat) the Chronicler subscribes and says so; removed (or blocked), it stops writing there
  herald.on("my_chat_member", async (ctx) => {
    const member = ctx.myChatMember.new_chat_member;
    const present = ["member", "administrator", "creator"].includes(member.status) || (member.status === "restricted" && member.is_member);
    if (present) await subscribe(ctx, true);
    else unsubscribe(ctx.chat.id, member.status === "kicked" ? "removed or blocked" : "removed");
  });
  // Any other word: a chat not on the list is told how to join it. Nothing subscribes by accident, so /stop stays stopped
  herald.on("message", async (ctx) => {
    if (!state.heraldChats.includes(ctx.chat.id)) await ctx.reply("Send /start to have the Chronicler set down the world's history here.").catch(() => {});
  });
  // The one voice all rulers read is the Chronicler; the bot carries that name (renames are rationed by Telegram, so only once)
  if (state.heraldName !== "The Chronicler")
    void herald.api.setMyName("The Chronicler").then(() => { state.heraldName = "The Chronicler"; persist(); }).catch((error) => log("renaming the Chronicler failed:", error.message));
  herald.catch((error) => log("herald error:", error.message));
}

/** After a restart: letters and chapters that were written but never sent go out now, and an age a restart cut short is taken up again */
async function recover() {
  const resent = new Set<Seat>();
  for (const seat of state.seats)
    for (const annal of seat.annals ?? [])
      if (annal.undelivered) {
        await tell(seat, [annal.heading, annal.story, annal.course, annal.question].filter(Boolean).join("\n\n"));
        annal.undelivered = undefined;
        resent.add(seat);
      }
  for (const chapter of state.chapters ?? [])
    if (chapter.undelivered) {
      await broadcastHerald(chapter.text);
      chapter.undelivered = undefined;
    }
  persist();
  if (!diedPassing) return;
  // Died while the age was being played: it is played on, as if the courts had just risen
  if (state.pendingRound && !state.pendingRound.urgent) {
    log("Taking up the age a restart cut short");
    return maybeStartRound();
  }
  // Died while the letters were being written or sent: the courts are in session again, and a ruler whose letter never came is told so
  for (const seat of await standing()) {
    if (!seat.ready) continue;
    seat.ready = false;
    if (!resent.has(seat) && seat.kind !== "agent") await tell(seat, "My letter for these years was lost on the road, Majesty - the realm ran on your standing wishes meanwhile. Ask me anything of these years, and /onward when you are ready.");
  }
  persist();
}

await ensureGame();
// The host's orders and the tools must agree before any advisor is served them: a drift stops the bot here, not an order later
await loadSchema();
advisors.forEach(setUpAdvisor);
setUpHerald();
await recover().catch((error) => log("recovering from the restart failed:", error));
// A game that ended with its closing words untold (a stall, a restart, a failed epic) has them told now, once, for its real ending
void host.state().then(async (game) => {
  if (state.epicTold || !gameOver(game, await standing())) return;
  log("The game is over and its ending was never told: telling it now");
  await tellTheEnding(game);
}).catch((error) => log("telling the ending at startup failed:", error.message));
// Dev feed, start of session: the settings everything below runs with
const devChat = Number(process.env.DEV_CHAT_ID) || state.heraldChats.find((id) => id > 0); // a private chat, never the players' group
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
