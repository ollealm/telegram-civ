// Orchestrator state, persisted as one JSON file next to the game save

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FILE = resolve(process.env.RULER_STATE_FILE ?? "../data/game/orchestrator.json");

export type ChatMessage = { from: "ruler" | "advisor"; text: string; /** an advisor's closing: its question marks are the matters' invitations, not a question left open */ closing?: boolean; /** the dispatch that opens an audience */ letter?: boolean };

/** Who the advisor is this game - made from the ruler's answers in the setup round, stable until /newgame */
export type Character = {
  name: string;
  /** Their station, as it follows the name ("the Lawspeaker") */
  title?: string;
  /** she | he - fixed at creation so every portrait, letter and saga agrees */
  pronouns?: string;
  /** Who they are and how they speak. Voice and background only: nothing in it bends their judgement. */
  sheet: string;
};

/** One age of a reign as it was lived: the advisor's telling, the fork put to the ruler, what the ruler said and what was settled. The saga is written from these. */
export type Annal = { years: string; heading?: string; story: string; course?: string; question?: string; rulerSaid?: string[]; settled?: string; urgent?: boolean;
  /** Written but not yet sent: a restart in between sends it at startup rather than let the advisor believe the ruler read it */
  undelivered?: boolean };

export type Seat = {
  civ: string;
  /** Which advisor bot speaks for this seat (its place in ADVISOR_n_BOT_TOKEN order); a sovereign's realm has none */
  bot?: number;
  /** Advisors who served before the present one, for the saga */
  formerAdvisors?: { name: string; title?: string; pronouns?: string; until: string }[];
  /** The keeper of the rolls: answers questions of fact while time passes (and on /clerk). One per realm per game. */
  clerk?: { name: string; title: string; sheet: string; pronouns?: string };
  /** The smaller matters the advisor would settle alone once the court rises, offered at the closing for the ruler to take up or leave */
  matters?: { matter: string; lean: string; opening?: string }[];
  /** Set by the smaller_matters tool while the reply is being written; remember() turns it into closedAt once that reply is stored */
  closing?: boolean;
  /** Who has the floor in the audience: the clerk, once called with /clerk or by name, until the advisor is called back with /advisor or by name; unset = the advisor */
  floor?: "clerk";
  /** The last few exchanges with the clerk */
  clerkChat?: { from: "ruler" | "clerk"; text: string }[];
  /** Things said to the clerk that sounded like orders: handed to the advisor at the next dispatch */
  forCouncil?: string[];
  /** The ruler's messages waiting for an answer, oldest first - kept until the reply is sent, so a restart answers them rather than swallow them */
  unanswered?: { text: string; thenGo: boolean }[];
  /** The picture of what the current audience decided, painted when the court is dismissed */
  decisionPicture?: { turn: number; year: string; caption: string; description: string };
  annals?: Annal[];
  /** Where the realm stood among its rivals at the last dispatch, as the chancery reckoned it */
  standing?: string;
  /** agent: a realm with no human ruler - the advisor rules alone, under the same limits (it acts every few turns) */
  kind?: "human" | "agent";
  /** The model this seat's advisor runs on, when not the default */
  model?: string;
  /** Reasoning effort for every call made for this seat; overrides the per-role setting */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Telegram chat bound to this seat - the first person to message the advisor bot */
  chatId?: number;
  rulerName?: string;
  /** The ruler's wishes in the advisor's words; the steward plays each round by this */
  will: string;
  /** The advisor's own operating plan: what it intends and why. Governing may update it; the will it may not. */
  plan?: string;
  character?: Character;
  /** Advisors to choose from during setup, and whether the ruler has already sent for a second three */
  candidates?: { name: string; title: string; pitch: string; sheet: string; pronouns?: string }[];
  rerolled?: boolean;
  /** War is the ruler's alone unless they have said, in plain words, that the advisor may declare it */
  mayDeclareWar?: boolean;
  /** A ruler's court starts with the officials barred from proposing Defensive Pacts (a pact can drag the realm into a war): set once, then the advisor's to change */
  pactsBarredOnce?: boolean;
  /** ...and from calling other powers into our wars ("calls to war"), likewise: set once, then the advisor's to change */
  callsToWarBarredOnce?: boolean;
  /** The turn this seat last read the chancery log - at a look-in, or at a ruler's audience: the next look-in reads on from there, across rounds */
  lookedAt?: number;
  /** Setup round in progress: the answers given so far */
  setup?: string[];
  /** The realm has been destroyed; its ruler has been told */
  fallen?: boolean;
  /** The ruler's own words made public this round, for the Chronicler */
  proclamations?: string[];
  /** Rolling campaign memory, one short entry per round */
  journal: string[];
  chat: ChatMessage[];
  ready: boolean;
  /** Set by the advisor's dismiss_court tool when the ruler says to proceed in plain words */
  dismissed?: boolean;
};

/** A picture that was asked for: who saw it ("chronicle" for the whole world, else the civ) and what it showed */
export type Picture = { turn: number; year: string; for: string; caption: string; description: string };

export type Usage = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };

export type State = {
  /** The realms at the table: each ruler's seat bound to its advisor bot, and the sovereigns', which have none */
  seats: Seat[];
  heraldChats: number[];
  /** The players' group, where the rulers and the Chronicler read together: learned when an advisor bot is added to it (the latest group wins) */
  groupChat?: number;
  /** The advisor bots that are members of that group, by bot index: only these post there */
  groupBots?: number[];
  usage: Record<string, Usage>;
  /** Every ruler's proclamation so far, for the Chronicler's epic */
  proclaimed?: { turn: number; year: string; text: string }[];
  /** The Chronicler's chapters as they were published - the world epic is written from these */
  chapters?: { years: string; text: string; undelivered?: boolean }[];
  /** The name the world-history bot currently shows */
  heraldName?: string;
  /** The name each advisor bot currently shows, by bot - it belongs to the bot, which keeps it between games */
  botNames?: Record<number, string>;
  /** The closing epic has been told: the game is over */
  epicTold?: boolean;
  /** Pictures painted lately, so that nobody is shown the same scene twice */
  pictures?: Picture[];
  /** The age being played, kept on disk as it goes: after urgent news (urgent) the rest of it is played once the councils have risen; after a restart, the rest of it is played on.
   *  Cleared once every turn of it is played. remaining is an older file's way of saying where it ends. */
  pendingRound?: {
    fromTurn: number; fromYear: string; untilTurn?: number; remaining?: number;
    publicEvents: { turn: number; year: string; text: string }[];
    /** The advisors' look-in notes so far, by civ - the letters are written from them */
    notes?: Record<string, string[]>;
    /** What the rulers proclaimed before the age began, for its chapter */
    proclaimed?: string[];
    urgent?: boolean;
  };
  /** audience: rulers talk with their advisors; passing: a round is being played */
  phase: "setup" | "audience" | "passing";
  /** Chosen with /newgame; the world is made once every ruler has picked a people */
  mapSize?: string;
  /** The shape of the world (the engine's map type); Pangaea when unset */
  mapType?: string;
  /** Set once the first realm reaches the late-game age: ages are shorter from then on, for the rest of the game */
  lateGame?: boolean;
  /** The turns an age has now, once a late-game age has been reached (LATE_AGES); only ever shortens */
  lateRound?: number;
  /** The turn each age began at, in order: what "this age and the one before" means for memories kept by age */
  ageStarts?: number[];
  aiCivs?: number;
  difficulty?: string;
  /** Who may raise world wonders: everyone, only the rulers' realms, or every realm with an advisor (rulers' and agents') */
  wonders?: "all" | "rulers" | "advised";
  /** The workshop door: when open, a ruler may ask the advisor or clerk to speak out of character (for testing). Closed in a real game. */
  workshop?: boolean;
};

const empty = (): State => ({ seats: [], heraldChats: [], usage: {}, phase: "audience" });

export const state: State = existsSync(FILE) ? { ...empty(), ...JSON.parse(readFileSync(FILE, "utf8")) } : empty();
/** The last run died while time was passing: the round, or the delivery of its letters, is taken up again at startup */
export const diedPassing = state.phase === "passing";
if (diedPassing) state.phase = "audience";
// A seat was once bound to a bot by its place in the list; a state file from then gets the binding written out
state.seats.forEach((seat, index) => {
  const legacy = seat as Seat & { botName?: string };
  if (seat.kind !== "agent" && seat.bot === undefined) seat.bot = index;
  if (legacy.botName !== undefined) {
    (state.botNames ??= {})[seat.bot ?? index] = legacy.botName; // a sovereign's seat held the name of the bot at its place, too
    delete legacy.botName;
  }
});
delete (state as { roundInProgress?: unknown }).roundInProgress; // an older version's round guard, long unused
for (const seat of state.seats) {
  const legacy = seat as Seat & { unanswered?: unknown; choices?: unknown };
  if (legacy.unanswered && !Array.isArray(legacy.unanswered)) seat.unanswered = [legacy.unanswered as { text: string; thenGo: boolean }]; // one message, as an older version kept it
  delete legacy.choices; // buttons for the ways forward, never offered
}

export function persist() {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify(state, null, 2));
  renameSync(FILE + ".tmp", FILE);
}

export function addUsage(role: string, usage: Omit<Usage, "calls">) {
  const total = (state.usage[role] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
  total.calls++;
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.costUsd += usage.costUsd;
  persist();
}

/** Until a letter has been stored with its mark, the chat is kept by count as it always was */
const CHAT_MEMORY = 16;
/** A runaway audience cannot flood the prompt */
const CHAT_CEILING = 40;

/** The chat the advisor is shown is the audience in progress - from the letter that opened it - and, before that, only its own last closing:
 *  what it promised last time. Older talk lives on in the will record, the plan, the journal and the letters, each with its own rule */
export function remember(seat: Seat, message: ChatMessage) {
  if (message.from === "advisor" && seat.closing) { message.closing = true; seat.closing = undefined; } // the reply that listed the smaller matters
  seat.chat.push(message);
  const opened = seat.chat.findLastIndex((entry) => entry.letter);
  if (opened >= 0) {
    const lastClosing = seat.chat.slice(0, opened).findLastIndex((entry) => entry.closing);
    seat.chat = [...(lastClosing >= 0 ? [seat.chat[lastClosing]] : []), ...seat.chat.slice(opened)];
  } else if (seat.chat.length > CHAT_MEMORY) seat.chat.splice(0, seat.chat.length - CHAT_MEMORY);
  if (seat.chat.length > CHAT_CEILING) seat.chat.splice(0, seat.chat.length - CHAT_CEILING);
  persist();
}

const PICTURE_MEMORY = 60;

export function recordPicture(picture: Picture) {
  (state.pictures ??= []).push(picture);
  if (state.pictures.length > PICTURE_MEMORY) state.pictures.splice(0, state.pictures.length - PICTURE_MEMORY);
  persist();
}

/** A picture that never arrived was never seen */
export function forgetPicture(picture: Picture) {
  state.pictures = (state.pictures ?? []).filter((other) => other !== picture);
  persist();
}

/** What these viewers have been shown in this age and the one before, for whoever describes the next picture (the last eight until two ages are on record) */
export const recentPictures = (viewers: string[]) => {
  const since = state.ageStarts?.at(-2);
  const shown = (state.pictures ?? []).filter((picture) => viewers.includes(picture.for));
  return (since === undefined ? shown.slice(-8) : shown.filter((picture) => picture.turn >= since))
    .map((picture) => `${picture.year}: ${picture.caption} - ${picture.description.slice(0, 180)}`).join("\n") || "(none yet)";
};
