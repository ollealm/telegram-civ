// The same advisor, the same ruler, the same words - at two efforts. Run once per effort against its own throwaway host:
//   RULER_HOST_URL=http://127.0.0.1:8766 RULER_STATE_FILE=<copy>/state.json IMAGES=off npx tsx harness/effort-compare.mts Celts medium
// The state file is a copy of the live orchestrator.json; the host a copy of the live game. Nothing here reaches the live game.
// Output: ../data/harness/effort-<civ>-<effort>-<stamp>.md with every reply, its seconds, words and cost.

import { appendFileSync, mkdirSync } from "node:fs";
import { advisorReply, onTrace, type Trace } from "../src/agents.ts";
import { host } from "../src/host.ts";
import { playRound } from "../src/round.ts";
import { persist, remember, state, type Seat } from "../src/store.ts";

const civ = process.argv[2] ?? "Celts";
const effort = process.argv[3] as Seat["effort"];
if (!effort) throw new Error("effort missing");
const seat = state.seats.find((candidate) => candidate.civ === civ);
if (!seat) throw new Error(`no seat for ${civ}`);
seat.effort = effort;
seat.dismissed = false;
persist();

const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
mkdirSync("../data/harness", { recursive: true });
const out = `../data/harness/effort-${civ.toLowerCase()}-${effort}-${stamp}.md`;
const say = (text: string) => { console.log(text); appendFileSync(out, text + "\n"); };
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

// Every model call, as it lands: seconds, tokens out, cost, tool calls
const calls: { role: string; ms: number; out: number; usd: number; tools: string[]; reply: string }[] = [];
onTrace((trace: Trace) => calls.push({ role: trace.role, ms: trace.ms, out: trace.outputTokens, usd: trace.costUsd, tools: trace.toolCalls.map((call) => call.name.replace(/^mcp__realm__/, "")), reply: trace.reply }));
const line = (call: (typeof calls)[number]) => `${(call.ms / 1000).toFixed(1)}s, ${call.out} tokens out, $${call.usd.toFixed(3)}, ${words(call.reply)} words, tools: ${call.tools.join(" ") || "none"}`;

const game = await host.state();
say(`# ${civ} at effort ${effort} - ${seat.character?.name ?? "advisor"} on ${seat.model ?? process.env.ADVISOR_MODEL}, from turn ${game.turn} (${game.year})\n`);

// The audience: three messages a ruler might send at this point of the game, the last one a close
const messages = [
  "Give me the lay of the land. How are the towns doing, and where do we really stand with Japan?",
  "I don't want to wait a generation. Could we hit Satsuma sooner if we bought the catapults instead of building them? And what does Russia want for the salt?",
  "Alright, go with your plan, but get the salt deal done first. Carry on.",
];
say("## Audience\n");
for (const message of messages) {
  say(`**Ruler:** ${message}\n`);
  const before = calls.length;
  const started = Date.now();
  const reply = await advisorReply(seat, message, 12);
  remember(seat, { from: "ruler", text: message });
  remember(seat, { from: "advisor", text: reply });
  persist();
  const made = calls.slice(before);
  say(`**${seat.character?.name ?? "Advisor"}** (${((Date.now() - started) / 1000).toFixed(1)}s wall; ${made.map(line).join("; ")}):\n\n${reply}\n`);
}
say(`Dismissed by the advisor's own call: ${seat.dismissed ? "yes" : "no"}\n`);
seat.dismissed = false;
seat.ready = true;
persist();

// Then the years pass: the look-ins and the letter
say("## The age\n");
const started = Date.now();
await playRound([seat], {
  working: (_seat, work) => work,
  dispatch: async (_seat, dispatch) => {
    say(`### Letter (${((Date.now() - started) / 1000).toFixed(0)}s after the court rose)\n\n${[dispatch.heading, dispatch.text, dispatch.strategy, dispatch.question].filter(Boolean).join("\n\n")}\n`);
    say(`Journal line: ${dispatch.journal}\n`);
  },
  notice: async (_seat, text) => say(`(notice) ${text}`),
  chronicle: async (chapter) => say(`### Chronicle\n\n${chapter}\n`),
  log: (...args) => say(`(round) ${args.join(" ")}`),
});

say("## Every call\n");
say("| role | seconds | tokens out | cost | words | tools |\n|---|---|---|---|---|---|");
for (const call of calls) say(`| ${call.role} | ${(call.ms / 1000).toFixed(1)} | ${call.out} | $${call.usd.toFixed(3)} | ${words(call.reply)} | ${call.tools.join(" ") || "-"} |`);
const total = calls.reduce((sum, call) => sum + call.usd, 0);
say(`\nTotal: ${calls.length} calls, $${total.toFixed(2)}, ${(calls.reduce((sum, call) => sum + call.ms, 0) / 1000).toFixed(0)}s of model time.`);
console.log(`\nWritten to ${out}`);
