// Orchestrator state, persisted as one JSON file next to the game save

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const FILE = resolve(process.env.RULER_STATE_FILE ?? "../data/game/orchestrator.json");

export type ChatMessage = { from: "ruler" | "advisor"; text: string };

/** Who the advisor is this game - made from the ruler's answers in the setup round, stable until /newgame */
export type Character = {
  name: string;
  /** Their station, as it follows the name ("the Lawspeaker") */
  title?: string;
  /** Who they are and how they speak. Voice and background only: nothing in it bends their judgement. */
  sheet: string;
};

export type Seat = {
  civ: string;
  /** Where the realm stood among its rivals at the last dispatch, as the chancery reckoned it */
  standing?: string;
  /** agent: a realm with no human ruler - the advisor rules alone, under the same limits (it acts every few turns) */
  kind?: "human" | "agent";
  /** The model this seat's advisor runs on, when not the default */
  model?: string;
  /** Telegram chat bound to this seat - the first person to message the advisor bot */
  chatId?: number;
  rulerName?: string;
  /** The ruler's wishes in the advisor's words; the steward plays each round by this */
  will: string;
  /** The advisor's own operating plan: what it intends and why. Governing may update it; the will it may not. */
  plan?: string;
  character?: Character;
  /** Advisors to choose from during setup, and whether the ruler has already sent for a second three */
  candidates?: { name: string; title: string; pitch: string; sheet: string }[];
  rerolled?: boolean;
  /** War is the ruler's alone unless they have said, in plain words, that the advisor may declare it */
  mayDeclareWar?: boolean;
  /** Setup round in progress: the answers given so far */
  setup?: string[];
  /** The ways forward offered in the last dispatch; buttons refer to these by index */
  choices?: string[];
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
  /** One seat per advisor bot, in ADVISOR_n_BOT_TOKEN order */
  seats: Seat[];
  heraldChats: number[];
  usage: Record<string, Usage>;
  /** Every ruler's proclamation so far, for the Chronicler's epic */
  proclaimed?: { turn: number; year: string; text: string }[];
  /** The closing epic has been told: the game is over */
  epicTold?: boolean;
  /** Pictures painted lately, so that nobody is shown the same scene twice */
  pictures?: Picture[];
  /** A round interrupted by urgent news: what is left of it is played after the urgent audience */
  pendingRound?: { fromTurn: number; fromYear: string; remaining: number; publicEvents: { turn: number; year: string; text: string }[] };
  /** audience: rulers talk with their advisors; passing: a round is being played */
  phase: "setup" | "audience" | "passing";
  /** Chosen with /newgame; the world is made once every ruler has picked a people */
  mapSize?: string;
  aiCivs?: number;
  difficulty?: string;
};

const empty = (): State => ({ seats: [], heraldChats: [], usage: {}, phase: "audience" });

export const state: State = existsSync(FILE) ? { ...empty(), ...JSON.parse(readFileSync(FILE, "utf8")) } : empty();
if (state.phase === "passing") state.phase = "audience"; // a round cut short by a restart is simply played again

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

const CHAT_MEMORY = 16;

export function remember(seat: Seat, message: ChatMessage) {
  seat.chat.push(message);
  if (seat.chat.length > CHAT_MEMORY) seat.chat.splice(0, seat.chat.length - CHAT_MEMORY);
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

/** What these viewers have been shown lately, for whoever describes the next picture */
export const recentPictures = (viewers: string[], count = 8) =>
  (state.pictures ?? []).filter((picture) => viewers.includes(picture.for)).slice(-count)
    .map((picture) => `${picture.year}: ${picture.caption} - ${picture.description.slice(0, 180)}`).join("\n") || "(none yet)";
