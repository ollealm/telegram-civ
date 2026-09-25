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
  majorCivs: { civ: string; alive: boolean }[];
  winner: string | null;
  victoryType: string | null;
};

export type PublicEvent = { turn: number; year: string; text: string };

export type AgeSummary = {
  from: number; to: number; fromYear: string; toYear: string;
  marches: { what: string; from: string; to: string; fromXY: [number, number]; toXY: [number, number] }[];
  lost: { what: string; where: string; xy: [number, number] }[];
  enemyMarches: { whose: string; what: string; from: string; to: string; fromXY: [number, number]; toXY: [number, number] }[];
  enemyLost: { whose: string; what: string; where: string }[];
  citiesTaken: { city: string; by: string; year: string }[];
  exploration: { tilesSeen: number; mostly: string; direction?: string; farthest?: number; naturalWonders: string[]; citiesFound: string[] } | null;
  explorers: { what: string; reached: string }[];
  met: string[];
  /** The same, told in sentences */
  lines: string[];
};

export type RoundResult = {
  fromTurn: number;
  fromYear: string;
  turn: number;
  year: string;
  stoppedEarly: string | null;
  /** The ruled realm whose own order began the war that stopped the round, if one did */
  declaredBy?: string | null;
  /** civ -> what just happened that its advisor should see before the next scheduled look-in */
  wake?: Record<string, string[]>;
  publicEvents: PublicEvent[];
  rankings: { civ: string; score: number; cities: number }[];
};

export type Orders = {
  personality?: Record<string, number | undefined>;
  research?: string[];
  policyBranches?: string[];
  neverBuild?: string[];
  goldReserve?: number | null;
  queue?: { city: string; items: string[] }[];
  build?: { city: string; item: string }[];
  purchase?: { city: string; item: string }[];
  declareWar?: string[];
  units?: { unit: number; action: string; x?: number; y?: number; city?: string }[];
  trade?: { with: string; give?: { item: string; amount?: number }[]; want?: { item: string; amount?: number }[] }[];
  peace?: string[];
  answerOffers?: { power: string; answer: "accept" | "refuse"; terms?: string }[];
  friendship?: string[];
  gift?: { cityState: string; gold: number }[];
  cityFocus?: { city: string; focus: string }[];
};

export const host = {
  state: () => call<GameState>("GET", "/state"),
  newGame: (setup: { ruled: string[]; others: string[]; noWonders?: string[]; mapSize?: string; cityStates?: number; difficulty?: string }) =>
    call<GameState>("POST", "/new", setup),
  advance: (turns: number, wake = false) => call<RoundResult>("POST", "/advance", { turns, wake }),
  lookup: (civ: string, name: string) => call<Record<string, unknown>>("GET", `/lookup${civQuery(civ)}&name=${encodeURIComponent(name)}`),
  briefing: (civ: string, logSince?: number) =>
    call<Record<string, unknown>>("GET", "/briefing" + civQuery(civ) + (logSince === undefined ? "" : `&since=${logSince}`)),
  options: (civ: string) => call<Record<string, unknown>>("GET", "/options" + civQuery(civ)),
  nations: () => call<{ name: string; leader: string }[]>("GET", "/nations"),
  events: () => call<PublicEvent[]>("GET", "/events"),
  /** Any people's cities with their lie of the land, largest first - a painter's anchor */
  cities: (civ: string) => call<{ name: string; capital: boolean; size: number; land: string }[]>("GET", `/cities${civQuery(civ)}`),
  /** What the realm's people did since a turn: marches, losses, what the scouts and ships found, whom it met - in the world's words */
  age: (civ: string, from: number) => call<AgeSummary>("GET", `/age${civQuery(civ)}&from=${from}`),
  /** campaign: the atlas with every march since that turn traced on it, and where units fell and cities were taken */
  map: async (civ: string, style: "atlas" | "reference" | "campaign" = "atlas", since?: number, until?: number) => {
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
  log: (civ: string, since: number, sinceYear?: number) => call<{ turn: number; text: string }[]>("GET", `/log${civQuery(civ)}&since=${since}${sinceYear === undefined ? "" : `&sinceYear=${sinceYear}`}`),
  setOrders: (civ: string, orders: Orders) =>
    call<{ orders: Orders; done: string[]; failed: string[]; researchQueue: string[]; gold: number }>("POST", "/orders" + civQuery(civ), orders),
};
