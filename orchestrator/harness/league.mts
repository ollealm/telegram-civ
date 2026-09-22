// A world with no humans: advisor-ruled realms on different models play a whole game against each other.
// Needs its own host:  ../host.sh /tmp/league-data 8767
// Run:  RULER_HOST_URL=http://127.0.0.1:8767 RULER_STATE_FILE=/tmp/league-data/state.json IMAGES=off \
//       npx tsx harness/league.mts claude-opus-5,claude-sonnet-5:low [maxTurns=300] [gameAiCivs=0] [mapSize=Small] [wonders=all|advised]
// Each seat is model[:effort]; effort (low | medium | high | xhigh | max) applies to every call made for that seat.
// wonders=advised leaves the world's wonders to the sovereigns: the game's own peoples raise none.
// LEAGUE_TAG=run1 keeps the result files of leagues started in the same minute apart (harness/league-batch.sh sets it).
// Results: ../data/harness/league-<date>.csv (score per realm per round), the Chronicler's chapters and a closing epic on the console,
// then playtest reviews and interviews of every sovereign.

import { appendFileSync, mkdirSync } from "node:fs";
import { chroniclerEpic, onTrace, playtestReview } from "../src/agents.ts";
import { draftSovereign } from "../src/characters.ts";
import { host } from "../src/host.ts";
import { playRound } from "../src/round.ts";
import { persist, state, type Seat } from "../src/store.ts";
import { interviewAll } from "./interview.mts";

const seatSpecs = (process.argv[2] ?? "claude-opus-5,claude-sonnet-5").split(",").map((spec) => {
  const [model, effort] = spec.split(":");
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Unknown effort "${effort}" in ${spec}`);
  return { model, effort: effort as Seat["effort"] };
});
const maxTurns = Number(process.argv[3] ?? 300);
const gameAi = Number(process.argv[4] ?? 0);
const mapSize = process.argv[5] ?? "Small";
const wonders = process.argv[6] ?? "all";
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// Every order that failed, and every call that errored, for the bug hunt afterwards
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + (process.env.LEAGUE_TAG ? `-${process.env.LEAGUE_TAG}` : "");
mkdirSync("../data/harness", { recursive: true });
const problems = `../data/harness/league-${stamp}-problems.jsonl`;
// A seat as the results name it: model, and effort when one is set
const labelOf = (civ?: string) => {
  const seat = state.seats.find((candidate) => candidate.civ === civ);
  return seat ? [seat.model, seat.effort].filter(Boolean).join(":") : "game AI";
};

// A league must not play on without its sovereigns: a spent session limit or a lost connection makes every look-in fail,
// and the round carries on regardless, so the game plays itself out and the results look complete. Stop instead.
const FAILURES_TO_STOP = 3;
const failuresInARow = new Map<string, number>();
function lookIn(civ: string | undefined, reached: boolean, why = "") {
  if (!civ) return;
  if (reached) return void failuresInARow.set(civ, 0);
  const count = (failuresInARow.get(civ) ?? 0) + 1;
  failuresInARow.set(civ, count);
  if (count < FAILURES_TO_STOP) return;
  say(`ABORTED: ${civ}'s sovereign could not be reached ${count} times running (${why.slice(0, 120)}). Stopping rather than let the game play itself.`);
  process.exit(3);
}

// Every look-in: was it scheduled or a wake-up, did it change anything, what did it cost - to judge whether the fixed look-in earns its keep
const passes = `../data/harness/league-${stamp}-passes.csv`;
appendFileSync(passes, "civ,model,trigger,orderCalls,changedNothing,costUsd,seconds\n");
onTrace((trace) => {
  if (trace.role === "govern") {
    // Orders only: a look-in that just rewrote its plan changed nothing in the realm
    const orderCalls = trace.toolCalls.filter((call) => /set_orders/.test(call.name)).length;
    appendFileSync(passes, [trace.civ, labelOf(trace.civ), /sent for ahead/.test(trace.systemPrompt) ? "wake" : "scheduled", orderCalls, /^nothing to change/i.test(trace.reply.trim()) ? 1 : 0, trace.costUsd.toFixed(3), Math.round(trace.ms / 1000)].join(",") + "\n");
    // Every real call costs something; an error that comes back as a reply (a spent session limit) costs nothing
    const unreached = trace.costUsd === 0 || trace.reply.startsWith("(failed") || /session limit|could not be reached/i.test(trace.reply);
    lookIn(trace.civ, !unreached, trace.reply);
  }
  for (const call of trace.toolCalls) {
    const result = call.result ?? "";
    if (/\\"failed\\":\[\\"|is_error|isError|\\"error\\"/.test(result))
      appendFileSync(problems, JSON.stringify({ civ: trace.civ, model: labelOf(trace.civ), role: trace.role, tool: call.name, input: call.input, result: result.slice(0, 1200) }) + "\n");
  }
  if (trace.reply.startsWith("(failed")) appendFileSync(problems, JSON.stringify({ civ: trace.civ, model: labelOf(trace.civ), role: trace.role, failed: trace.reply }) + "\n");
});
// A look-in that throws (a lost connection) never reaches the trace; the round logs it instead
const log = (...args: unknown[]) => {
  const failed = typeof args[0] === "string" ? /^govern pass for (.+) failed:/.exec(args[0]) : null;
  if (failed) lookIn(failed[1], false, String(args[1] ?? ""));
  say(...args);
};

const nations = (await host.nations()).map((nation) => nation.name).sort(() => Math.random() - 0.5);
state.seats = seatSpecs.map(({ model, effort }, index): Seat => ({ civ: nations[index], kind: "agent", model, ...(effort && { effort }), will: "", journal: [], chat: [], ready: false }));
for (const seat of state.seats) {
  const { name, title, pronouns, sheet } = await draftSovereign(seat.civ, seat.model!);
  seat.character = { name, title, pronouns, sheet };
  say(`${seat.civ}: ${name} on ${labelOf(seat.civ)}`);
}
const others = nations.slice(seatSpecs.length, seatSpecs.length + gameAi);
await host.newGame({ ruled: state.seats.map((seat) => seat.civ), others, noWonders: wonders === "advised" ? others : [], mapSize, cityStates: 4 });
persist();

const csv = `../data/harness/league-${stamp}.csv`;
appendFileSync(csv, "turn,year,civ,model,score,cities,rank,costUsd\n");

for (;;) {
  const round = await playRound(state.seats, {
    working: (_, work) => work,
    dispatch: async () => {},
    notice: async () => {},
    chronicle: async (chapter) => say(`\n${chapter}\n`),
    log,
  });
  const spent = Object.values(state.usage).reduce((sum, usage) => sum + usage.costUsd, 0);
  round.rankings.forEach((row, index) => appendFileSync(csv, [round.turn, round.year, row.civ, labelOf(row.civ), row.score, row.cities, index + 1, spent.toFixed(2)].join(",") + "\n"));
  say(`standings at ${round.year}: ${round.rankings.map((row) => `${row.civ} (${labelOf(row.civ)}) ${row.score}`).join(", ")}; spent $${spent.toFixed(2)}`);
  const game = await host.state();
  if (game.winner || round.turn >= maxTurns || game.majorCivs.filter((civ) => civ.alive).length < 2) {
    say(game.winner ? `${game.winner} (${labelOf(game.winner)}) won a ${game.victoryType} victory` : "The league ends here.");
    const standings = game.majorCivs.map((civ) => `${civ.civ}: ${civ.alive ? "stands" : "has fallen"}`).join("\n");
    say("\n" + (await chroniclerEpic(await host.events(), standings, "This history has reached its end.")).text);
    for (const seat of state.seats) {
      const review = await playtestReview(seat).catch((error) => `(review failed: ${error.message})`);
      say(`\n=== PLAYTEST REVIEW: ${seat.civ} (${labelOf(seat.civ)}, ${seat.character?.name}) ===\n${review}\n`);
      appendFileSync(`../data/harness/league-${stamp}-reviews.md`, `## ${seat.civ} - ${labelOf(seat.civ)} - ${seat.character?.name}\n\nWill:\n${seat.will}\n\nPlan:\n${seat.plan ?? ""}\n\nJournal:\n${seat.journal.join("\n")}\n\nReview:\n${review}\n\n`);
    }
    // The world is still live at the end, so the sovereigns may check their briefing before they answer
    await interviewAll(state.seats, `../data/harness/league-${stamp}-interviews.md`);
    break;
  }
}
say("results:", csv, "usage:", JSON.stringify(state.usage));
