// Client for the headless Unciv RulerHost JSON API

const HOST = process.env.RULER_HOST_URL ?? "http://127.0.0.1:8765";

export class HostError extends Error {}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(HOST + path, {
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

export type RoundResult = {
  fromTurn: number;
  fromYear: string;
  turn: number;
  year: string;
  stoppedEarly: string | null;
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
  /** campaign: the atlas with every march since that turn traced on it, and where units fell and cities were taken */
  map: async (civ: string, style: "atlas" | "reference" | "campaign" = "atlas", since?: number) =>
    Buffer.from(await (await fetch(`${HOST}/map.png${civQuery(civ)}&style=${style}${since === undefined ? "" : `&since=${since}`}`)).arrayBuffer()),
  /** Draw names, borders and units onto a repaint of the reference map */
  mapOverlay: async (civ: string, repaint: Buffer) => {
    const response = await fetch(`${HOST}/map/overlay${civQuery(civ)}`, { method: "POST", body: new Uint8Array(repaint) });
    if (!response.ok) throw new HostError(`overlay ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  log: (civ: string, since: number) => call<{ turn: number; text: string }[]>("GET", `/log${civQuery(civ)}&since=${since}`),
  setOrders: (civ: string, orders: Orders) =>
    call<{ orders: Orders; done: string[]; failed: string[]; researchQueue: string[]; gold: number }>("POST", "/orders" + civQuery(civ), orders),
};
