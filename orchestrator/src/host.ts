// Client for the headless Unciv RulerHost JSON API

const HOST = process.env.RULER_HOST_URL ?? "http://127.0.0.1:8765";

export class HostError extends Error {}

/** A host that is being restarted answers nothing for half a minute; every request waits that out rather than fail the advisor mid-sentence.
 *  Only a refused connection is tried again - the request never reached the host - so an advance or an order is never carried out twice;
 *  and a host that takes the connection but never answers fails the request after two minutes rather than hold the round for ever. */
async function reach(url: string, init?: RequestInit): Promise<Response> {
  const until = Date.now() + Number(process.env.HOST_WAIT_MS ?? 90_000);
  for (;;) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(Number(process.env.HOST_TIMEOUT_MS ?? 120_000)) });
    } catch (error) {
      const refused = (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
      if (!refused || Date.now() >= until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await reach(HOST + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok) throw new HostError(json.error ?? `${response.status} on ${path}`);
  return json as T;
}

const civQuery = (civ: string) => `?civ=${encodeURIComponent(civ)}`;

export type GameState = {
  running: boolean;
  turn: number;
  year: string;
  ruled: string[];
  /** The shape of the world, by the engine's map type */
  mapType?: string;
  /** The ways this game can be won, as it was set up */
  victoryTypes?: string[];
  majorCivs: { civ: string; alive: boolean; era?: string }[];
  winner: string | null;
  victoryType: string | null;
};

export type PublicEvent = { turn: number; year: string; text: string };

export type AgeSummary = {
  from: number; to: number; fromYear: string; toYear: string;
  /** Our campaigns: the few forces that went somewhere together, as the campaign map draws them - the weightiest first */
  marches: Campaign[];
  /** Losses no campaign already tells */
  lost: { what: string; where: string; /** the place with its word before it: "at the walls of Tokyo", "in the country south of Novgorod" */ at: string; xy: [number, number] }[];
  /** The enemy's campaigns we could see */
  enemyMarches: Campaign[];
  enemyLost: { whose: string; what: string; where: string; at: string }[];
  citiesTaken: { city: string; by: string; year: string }[];
  exploration: { tilesSeen: number; mostly: string; direction?: string; farthest?: number; naturalWonders: string[]; citiesFound: string[] } | null;
  explorers: { what: string; reached: string }[];
  met: string[];
  /** The companies in sight now, as the map's badges show them (none inside a city, no aircraft) */
  inSight: { whose: string; what: string; where: string; at: string; sea: boolean }[];
  /** Cities that stand in a patch of known country apart from the rest of the known world */
  glimpses?: string[];
  /** The same, told in sentences */
  lines: string[];
  /** Candidates for the Chronicler's oddity of the age: the world's own lines, and ours (they begin "Our"); empty most ages */
  curiosities?: string[];
};

/** A force's march in an age. outcome: took the city it marched on, broken there (half or more fell), turned back, or still out */
export type Campaign = {
  whose: string; what: string; from: string; to: string; outcome: "took" | "broken" | "back" | "out"; size: number; fell: number; sea: boolean;
  /** The campaign in one sentence */
  told: string;
  fromXY: [number, number]; toXY: [number, number]; route: [number, number][];
};

/** One war of an emergency council, as the host saw it declared: who drew the sword, on whom, and who was pulled in by a pact; a war the host only
 *  found at war (no declaration seen) has null for both powers and its bare fact in news */
export type CouncilWar = { declaredBy: string | null; target: string | null; drawnIn: { civ: string; with: string }[]; news: string };

export type RoundResult = {
  fromTurn: number;
  fromYear: string;
  turn: number;
  year: string;
  stoppedEarly: string | null;
  /** The power that declared the first war of the council that stopped the round (a ruled realm's own order among them), if the host saw it declared */
  declaredBy?: string | null;
  /** The power it declared on */
  target?: string | null;
  /** The pact partners pulled into that war, each with the partner whose pact drew it in */
  drawnIn?: CouncilWar["drawnIn"];
  /** Every war of the council, the first of them repeated in the three fields above */
  wars?: CouncilWar[];
  /** civ -> what just happened that its advisor should see before the next scheduled look-in */
  wake?: Record<string, string[]>;
  publicEvents: PublicEvent[];
  rankings: { civ: string; score: number; cities: number }[];
};

/** The host's lists (GET /schema): an order's fields by kind, the officials' acts by default, and the words each field takes */
export type HostSchema = {
  orderFields: { standing: string[]; immediate: string[]; orchestrator: string[] };
  officials: { open: string[]; closed: string[]; never: string[] };
  unitActions: string[]; abilities: string[]; stances: string[]; cityActions: string[]; cityFocus: string[];
};

export type Orders = {
  /** The war leave, held by the host and checked there for every way of declaring war: a sovereign's always, an advisor's by the ruler's plain word */
  mayDeclareWar?: boolean;
  /** This call is made at a ruler's audience: the ruler's own word is the leave for it */
  withRulersWord?: boolean;
  personality?: Record<string, number | undefined>;
  research?: string[];
  policyBranches?: string[];
  neverBuild?: string[];
  /** Standing: the court's word on its officials' acts, by kind - true opens one, false bars it, null restores its default */
  officials?: Record<string, boolean | null | undefined>;
  goldReserve?: number | null;
  /** Standing: faith the officials leave untouched */
  faithReserve?: number | null;
  /** Standing: the great power our vote for world leader is pledged to; null withdraws it (we abstain) */
  worldVote?: string | null;
  /** Immediate: re-arm these units now (unit numbers), or "all" */
  rearm?: (number | "all")[];
  queue?: { city: string; items: string[] }[];
  build?: { city: string; item: string }[];
  purchase?: { city: string; item: string; with?: "gold" | "faith" }[];
  declareWar?: string[];
  /** Immediate: marry into these city-states' ruling families (a people with the ability only) */
  marry?: string[];
  /** Immediate: denounce these great powers, for 30 turns */
  denounce?: string[];
  /** Immediate: pledge to protect these city-states / withdraw the pledge */
  protect?: string[];
  endProtection?: string[];
  units?: { unit: number; action: string; x?: number; y?: number; city?: string }[];
  trade?: { with: string; give?: { item: string; amount?: number }[]; want?: { item: string; amount?: number }[] }[];
  peace?: string[];
  answerOffers?: { power: string; answer: "accept" | "refuse"; terms?: string }[];
  answerDemands?: { power: string; answer: "agree" | "refuse" }[];
  /** Immediate: a deal in force proposed again, on the same terms, the turn it ends - once */
  renew?: { power: string; terms?: string }[];
  /** Standing until each clears: warnings weighed and let stand, folded into warningsAcknowledged */
  acknowledge?: string[];
  friendship?: string[];
  gift?: { cityState: string; gold: number }[];
  cityFocus?: { city: string; focus: string }[];
};

/** BRIEFING_OMIT: briefing fields left out, for the leagues' removal tests - comma-separated top-level names ("techsKnown", "militaryNote")
 *  and dotted paths into objects or lists of objects ("cities.buildings", "knownCivs.theirAttitude", "victory.cultural"). Two names thin the unit list
 *  instead: "units.automatedWorkers" and "units.automatedSoldiers" keep a count of those lines in place of the lines. Empty: the briefing whole */
const OMIT = (process.env.BRIEFING_OMIT ?? "").split(",").map((path) => path.trim()).filter(Boolean);
function omitFromBriefing(briefing: Record<string, unknown>): Record<string, unknown> {
  if (!OMIT.length || typeof briefing !== "object" || briefing === null) return briefing;
  const drop = (node: unknown, path: string[]): void => {
    if (Array.isArray(node)) { for (const item of node) drop(item, path); return; }
    if (typeof node !== "object" || node === null) return;
    const [head, ...rest] = path;
    if (!rest.length) delete (node as Record<string, unknown>)[head];
    else drop((node as Record<string, unknown>)[head], rest);
  };
  for (const path of OMIT) {
    const thin = /^units\.automated(Workers|Soldiers)$/.exec(path);
    if (thin && Array.isArray(briefing.units)) {
      const civilian = (line: string) => /^(Worker|Work Boats|Great |Settler|Missionary|Inquisitor|Prophet)/.test(line);
      // By the state, not the line's end: a wounded unit's line ends in its health (", 12 hp")
      const pick = (line: unknown) => typeof line === "string" && /, automated(, \d+ hp)?$/.test(line) && (thin[1] === "Workers" ? /^Worker /.test(line) : !civilian(line));
      const dropped = (briefing.units as unknown[]).filter(pick).length;
      briefing.units = [...(briefing.units as unknown[]).filter((line) => !pick(line)), ...(dropped ? [`(${dropped} automated ${thin[1].toLowerCase()} not listed)`] : [])];
      continue;
    }
    drop(briefing, path.split("."));
  }
  return briefing;
}

export const host = {
  state: () => call<GameState>("GET", "/state"),
  /** victoryTypes: the ruleset's victory names (Scientific, Cultural, Domination, Diplomatic, Time); left out, every one but Time */
  newGame: (setup: { ruled: string[]; others: string[]; noWonders?: string[]; mapSize?: string; mapType?: string; cityStates?: number; difficulty?: string; victoryTypes?: string[] }) =>
    call<GameState>("POST", "/new", setup),
  /** cadence: the turns of this age and between look-ins - the host's windows (the briefing's log, "a look-in away") follow them */
  advance: (turns: number, wake = false, cadence?: { ageTurns: number; lookInTurns: number }) => call<RoundResult>("POST", "/advance", { turns, wake, ...cadence }),
  lookup: (civ: string, name: string) => call<Record<string, unknown>>("GET", `/lookup${civQuery(civ)}&name=${encodeURIComponent(name)}`),
  briefing: (civ: string, logSince?: number) =>
    call<Record<string, unknown>>("GET", "/briefing" + civQuery(civ) + (logSince === undefined ? "" : `&since=${logSince}`)).then(omitFromBriefing),
  /** audience: asked at a ruler's audience, where the ruler's own word is the war leave (calls to war are then among what we can offer) */
  options: (civ: string, audience = false) => call<Record<string, unknown>>("GET", "/options" + civQuery(civ) + (audience ? "&audience=1" : "")),
  /** The standing orders as the host holds them */
  standing: (civ: string) => call<Record<string, unknown>>("GET", "/orders" + civQuery(civ)),
  /** The lists an order is checked against: the tools list the same */
  schema: () => call<HostSchema>("GET", "/schema"),
  nations: () => call<{ name: string; leader: string }[]>("GET", "/nations"),
  events: () => call<PublicEvent[]>("GET", "/events"),
  /** A sovereign's proclamation: a public event at once, and a line in every other court's log ([by]: the speaker, "Ieyasu, the Shogun") */
  proclaim: (civ: string, words: string, by?: string) => call<{ proclaimed: string; turn: number }>("POST", "/proclaim" + civQuery(civ), { words, by }),
  /** Any people's cities with their lie of the land, largest first - a painter's anchor */
  cities: (civ: string) => call<{ name: string; capital: boolean; size: number; land: string }[]>("GET", `/cities${civQuery(civ)}`),
  /** What the realm's people did since a turn: marches, losses, what the scouts and ships found, whom it met - in the world's words */
  age: (civ: string, from: number) => call<AgeSummary>("GET", `/age${civQuery(civ)}&from=${from}`),
  /** campaign: the atlas with the age's campaigns since that turn drawn as broad arrows, and the cities taken. trace: every unit's march traced exactly, and where units fell */
  map: async (civ: string, style: "atlas" | "reference" | "campaign" | "trace" = "atlas", since?: number, until?: number) => {
    const response = await reach(`${HOST}/map.png${civQuery(civ)}&style=${style}${since === undefined ? "" : `&since=${since}`}${until === undefined ? "" : `&until=${until}`}`);
    if (!response.ok) throw new Error(`map: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return Buffer.from(await response.arrayBuffer());
  },
  /** Draw names, borders and units onto a repaint of the reference map */
  mapOverlay: async (civ: string, repaint: Buffer) => {
    const response = await reach(`${HOST}/map/overlay${civQuery(civ)}`, { method: "POST", body: new Uint8Array(repaint) });
    if (!response.ok) throw new HostError(`overlay ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  log: (civ: string, since: number, sinceYear?: number, until?: number) => call<{ turn: number; text: string }[]>("GET", `/log${civQuery(civ)}&since=${since}${sinceYear === undefined ? "" : `&sinceYear=${sinceYear}`}${until === undefined ? "" : `&until=${until}`}`),
  setOrders: (civ: string, orders: Orders) =>
    call<{ orders: Orders; done: string[]; failed: string[]; researchQueue: string[]; gold: number }>("POST", "/orders" + civQuery(civ), orders),
};
