// Sample chapters for reading before a change to the Chronicler goes live: a league picked up mid-game, played on for a few ages with the
// sovereigns' look-ins (proclaim included), each age's chapter written as the game writes it.
// Needs its own host on a COPY of a league backup (save.unciv and host.json of one turn, ideally the first turn of an age):
//   ../host.sh /tmp/chron-data 8768
// Run:  RULER_HOST_URL=http://127.0.0.1:8768 RULER_STATE_FILE=/tmp/chron-data/state.json IMAGES=off HERALD_MODEL=claude-opus-5-5 HERALD_EFFORT=high \
//       npx tsx harness/chronicle-samples.mts ../data/league-run20/state.json [ages=2]
// The league's state.json is read, never written: the sovereigns, their characters and the Chronicler's chapters are taken as they stood when the
// backup's age began (later chapters, journal entries and proclamations are cut) into RULER_STATE_FILE, which this run then plays on.
// Results: ../data/harness/chronicle-samples-<stamp>.md - per age the chapter, what was said in the courts and halls, and the Chronicler's whole input.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { host } from "../src/host.ts";

const source = process.argv[2];
const ages = Number(process.argv[3] ?? 2);
if (!source || !process.env.RULER_STATE_FILE) throw new Error("Usage: RULER_STATE_FILE=<scratch state> ... chronicle-samples.mts <league state.json> [ages]");
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// The league as it stood when the backup's age began: the store reads RULER_STATE_FILE when it loads, so it is written before the store is imported
const startTurn = (await host.state()).turn;
const league = JSON.parse(readFileSync(source, "utf8"));
const kept = (league.ageStarts ?? []).filter((turn: number) => turn < startTurn).length;
const trimmed = {
  ...league,
  ageStarts: (league.ageStarts ?? []).slice(0, kept),
  chapters: (league.chapters ?? []).slice(0, kept).map((chapter: { years: string; text: string }) => ({ ...chapter, undelivered: false })),
  proclaimed: (league.proclaimed ?? []).filter((entry: { turn: number }) => entry.turn < startTurn),
  pendingRound: undefined,
  phase: "audience",
  usage: {},
  seats: league.seats.map((seat: { journal?: string[] }) => ({ ...seat, journal: (seat.journal ?? []).slice(0, kept), proclamations: undefined, lookedAt: startTurn })),
};
writeFileSync(process.env.RULER_STATE_FILE, JSON.stringify(trimmed, null, 1));

const { onTrace } = await import("../src/agents.ts");
const { playRound } = await import("../src/round.ts");
const { state } = await import("../src/store.ts");

mkdirSync("../data/harness", { recursive: true });
const out = `../data/harness/chronicle-samples-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
writeFileSync(out, `# Chronicle samples\n\nFrom ${source}, picked up at turn ${startTurn} after ${kept} chapters; ${ages} ages played on. Sovereigns: ${state.seats.map((seat) => `${seat.civ} (${seat.character?.name}, ${seat.model}${seat.effort ? `:${seat.effort}` : ""})`).join(", ")}. Chronicler: ${process.env.HERALD_MODEL ?? "the default model"}${process.env.HERALD_EFFORT ? `, ${process.env.HERALD_EFFORT} effort` : ""}.\n\n## The chapter before these\n\n${state.chapters?.at(-1)?.text ?? "(none)"}\n\n`);

// The Chronicler's input as sent, and each sovereign's proclaim as given (refusals included)
let heraldInput: { systemPrompt: string; prompt: string } | undefined;
const said: string[] = [];
onTrace((trace) => {
  if (trace.role === "herald" && trace.prompt.startsWith("The years ")) heraldInput = { systemPrompt: trace.systemPrompt, prompt: trace.prompt };
  for (const call of trace.toolCalls.filter((each) => /proclaim/.test(each.name)))
    said.push(`${trace.civ}: ${(call.input as { words?: string }).words} -> ${/already/.test(call.result ?? "") ? "refused (spoken already this age)" : "carried"}`);
});

let systemShown = false;
for (let age = 1; age <= ages; age++) {
  said.length = 0;
  let chapterText = "";
  const round = await playRound(state.seats, {
    working: (_, work) => work,
    dispatch: async () => {},
    notice: async () => {},
    chronicle: async (chapter) => { chapterText = chapter; },
    log: say,
  });
  say(`Age ${age}: ${round.fromYear} to ${round.year}\n${chapterText}\n`);
  appendFileSync(out, `## Age ${age}: ${round.fromYear} to ${round.year}\n\n### The chapter\n\n${chapterText}\n\n### Said by the sovereigns at their look-ins\n\n${said.map((line) => `- ${line}`).join("\n") || "(nobody proclaimed)"}\n\n### The Chronicler's input\n\n\`\`\`\n${heraldInput?.prompt ?? "(not captured)"}\n\`\`\`\n\n`);
  if (!systemShown && heraldInput) {
    appendFileSync(out, `### The Chronicler's instructions (the same each age)\n\n\`\`\`\n${heraldInput.systemPrompt}\n\`\`\`\n\n`);
    systemShown = true;
  }
  if (round.stoppedEarly && /has won/.test(round.stoppedEarly)) break;
}
const spent = Object.values(state.usage).reduce((sum, usage) => sum + usage.costUsd, 0);
appendFileSync(out, `Spent: $${spent.toFixed(2)}\n`);
say("samples:", out, `spent $${spent.toFixed(2)}`);
