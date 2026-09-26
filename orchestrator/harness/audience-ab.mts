// The same audience under two versions of the advisor's prompts: run once from each worktree, each against its own throwaway host.
//   RULER_HOST_URL=http://127.0.0.1:8790 RULER_STATE_FILE=<copy>/orchestrator.json npx tsx --env-file=<repo>/.env harness/audience-ab.mts old <out.md>
// The state file and the host's save are copies of the live game at a letter the ruler has not answered; nothing here reaches the live game.
// Every ruled seat hears the same scripted words; the output has each reply, the tools it used and what they carried.

import { appendFileSync, writeFileSync } from "node:fs";
import { advisorReply, onTrace, type Trace } from "../src/agents.ts";
import { persist, remember, state } from "../src/store.ts";

const [label, out] = process.argv.slice(2);
if (!label || !out) throw new Error("usage: audience-ab.mts <label> <out.md>");

// What a ruler might say to each letter: an answer to the broad question, a question that needs checking, a close in plain words
const SCRIPTS: Record<string, string[]> = {
  Denmark: ["All to the stars. Japan can wait.", "Can we buy more aluminium from anyone?", "Sounds good, do that."],
  Celts: ["Yes, buy it. Stand down the batteries at Moscow.", "What would you do with the rest of the gold?", "Good. Carry on."],
};

writeFileSync(out, "");
const say = (text: string) => { console.log(text); appendFileSync(out, text + "\n"); };
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
let traces: Trace[] = [];
onTrace((trace) => traces.push(trace));
/** What a tool call carried, short enough to read beside the reply */
const shown = (call: Trace["toolCalls"][number]) => {
  const input = call.input as Record<string, unknown>;
  if (call.name === "smaller_matters") return `smaller_matters: ${((input.matters as { matter: string; lean: string }[]) ?? []).map((m, i) => `${i + 1}. ${m.matter} -> ${m.lean}`).join(" | ") || "(none)"}`;
  if (call.name === "paint_decision") return `paint_decision: ${input.caption}`;
  if (call.name === "proclaim") return `proclaim: ${input.words}`;
  if (call.name === "set_orders") return `set_orders: ${JSON.stringify(input).slice(0, 400)}`;
  return call.name;
};

say(`# Audience A/B - ${label}\n`);
for (const [civ, script] of Object.entries(SCRIPTS)) {
  const seat = state.seats.find((candidate) => candidate.civ === civ);
  if (!seat) { say(`(no seat for ${civ})`); continue; }
  seat.dismissed = false;
  seat.matters = undefined;
  say(`## ${civ} - ${seat.character?.name ?? "advisor"}\n`);
  for (const message of script) {
    if (seat.dismissed) { say(`(the advisor dismissed the court; "${message}" not sent)\n`); break; }
    say(`**Ruler:** ${message}\n`);
    traces = [];
    const reply = await advisorReply(seat, message, 8);
    remember(seat, { from: "ruler", text: message });
    remember(seat, { from: "advisor", text: reply });
    persist();
    const calls = traces.flatMap((trace) => trace.toolCalls).filter((call) => !/^(get_|look_up)/.test(call.name));
    const cost = traces.reduce((sum, trace) => sum + trace.costUsd, 0);
    say(`**Advisor** (${words(reply)} words, $${cost.toFixed(2)}, looked up: ${traces.flatMap((trace) => trace.toolCalls).filter((call) => /^(get_|look_up)/.test(call.name)).map((call) => call.name).join(" ") || "nothing"}):\n\n${reply}\n`);
    if (calls.length) say(calls.map((call) => `- ${shown(call)}`).join("\n") + "\n");
  }
  say(`Dismissed by the advisor: ${seat.dismissed ? "yes" : "no"}\n`);
}
