// A world with no humans: advisor-ruled realms on different models play a whole game against each other.
// Needs its own host:  ../host.sh /tmp/league-data 8767
// Run:  RULER_HOST_URL=http://127.0.0.1:8767 RULER_STATE_FILE=/tmp/league-data/state.json IMAGES=off \
//       npx tsx harness/league.mts claude-opus-5,claude-sonnet-5 [maxTurns=300] [gameAiCivs=0] [mapSize=Small] [wonders=all|advised]
// wonders=advised leaves the world's wonders to the sovereigns: the game's own peoples raise none.
// Results: ../data/harness/league-<date>.csv (score per realm per round), the Chronicler's chapters and a closing epic on the console.

import { appendFileSync, mkdirSync } from "node:fs";
import { chroniclerEpic, onTrace, playtestReview } from "../src/agents.ts";
import { draftSovereign } from "../src/characters.ts";
import { host } from "../src/host.ts";
import { playRound } from "../src/round.ts";
import { persist, state, type Seat } from "../src/store.ts";

const models = (process.argv[2] ?? "claude-opus-5,claude-sonnet-5").split(",");
const maxTurns = Number(process.argv[3] ?? 300);
const gameAi = Number(process.argv[4] ?? 0);
const mapSize = process.argv[5] ?? "Small";
const wonders = process.argv[6] ?? "all";
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// Every order that failed, and every call that errored, for the bug hunt afterwards
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
mkdirSync("../data/harness", { recursive: true });
const problems = `../data/harness/league-${stamp}-problems.jsonl`;
// Every look-in: was it scheduled or a wake-up, did it change anything, what did it cost - to judge whether the fixed look-in earns its keep
const passes = `../data/harness/league-${stamp}-passes.csv`;
appendFileSync(passes, "civ,model,trigger,orderCalls,changedNothing,costUsd,seconds\n");
onTrace((trace) => {
  if (trace.role === "govern") {
    // Orders only: a look-in that just rewrote its plan changed nothing in the realm
    const orderCalls = trace.toolCalls.filter((call) => /set_orders/.test(call.name)).length;
    appendFileSync(passes, [trace.civ, trace.model, /sent for ahead/.test(trace.systemPrompt) ? "wake" : "scheduled", orderCalls, /^nothing to change/i.test(trace.reply.trim()) ? 1 : 0, trace.costUsd.toFixed(3), Math.round(trace.ms / 1000)].join(",") + "\n");
  }
  for (const call of trace.toolCalls) {
    const result = call.result ?? "";
    if (/\\"failed\\":\[\\"|is_error|isError|\\"error\\"/.test(result))
      appendFileSync(problems, JSON.stringify({ civ: trace.civ, model: trace.model, role: trace.role, tool: call.name, input: call.input, result: result.slice(0, 1200) }) + "\n");
  }
  if (trace.reply.startsWith("(failed")) appendFileSync(problems, JSON.stringify({ civ: trace.civ, model: trace.model, role: trace.role, failed: trace.reply }) + "\n");
});

const nations = (await host.nations()).map((nation) => nation.name).sort(() => Math.random() - 0.5);
state.seats = models.map((model, index): Seat => ({ civ: nations[index], kind: "agent", model, will: "", journal: [], chat: [], ready: false }));
for (const seat of state.seats) {
  seat.character = await draftSovereign(seat.civ, seat.model!).then(({ name, title, sheet }) => ({ name, title, sheet }));
  say(`${seat.civ}: ${seat.character.name} on ${seat.model}`);
}
const others = nations.slice(models.length, models.length + gameAi);
await host.newGame({ ruled: state.seats.map((seat) => seat.civ), others, noWonders: wonders === "advised" ? others : [], mapSize, cityStates: 4 });
persist();

const csv = `../data/harness/league-${stamp}.csv`;
appendFileSync(csv, "turn,year,civ,model,score,cities,rank,costUsd\n");
const modelOf = (civ: string) => state.seats.find((seat) => seat.civ === civ)?.model ?? "game AI";

for (;;) {
  const round = await playRound(state.seats, {
    working: (_, work) => work,
    dispatch: async () => {},
    notice: async () => {},
    chronicle: async (chapter) => say(`\n${chapter}\n`),
    log: say,
  });
  const spent = Object.values(state.usage).reduce((sum, usage) => sum + usage.costUsd, 0);
  round.rankings.forEach((row, index) => appendFileSync(csv, [round.turn, round.year, row.civ, modelOf(row.civ), row.score, row.cities, index + 1, spent.toFixed(2)].join(",") + "\n"));
  say(`standings at ${round.year}: ${round.rankings.map((row) => `${row.civ} (${modelOf(row.civ)}) ${row.score}`).join(", ")}; spent $${spent.toFixed(2)}`);
  const game = await host.state();
  if (game.winner || round.turn >= maxTurns || game.majorCivs.filter((civ) => civ.alive).length < 2) {
    say(game.winner ? `${game.winner} (${modelOf(game.winner)}) won a ${game.victoryType} victory` : "The league ends here.");
    const standings = game.majorCivs.map((civ) => `${civ.civ}: ${civ.alive ? "stands" : "has fallen"}`).join("\n");
    say("\n" + (await chroniclerEpic(await host.events(), standings, "This history has reached its end.")));
    for (const seat of state.seats) {
      const review = await playtestReview(seat).catch((error) => `(review failed: ${error.message})`);
      say(`\n=== PLAYTEST REVIEW: ${seat.civ} (${seat.model}, ${seat.character?.name}) ===\n${review}\n`);
      appendFileSync(`../data/harness/league-${stamp}-reviews.md`, `## ${seat.civ} - ${seat.model} - ${seat.character?.name}\n\nWill:\n${seat.will}\n\nPlan:\n${seat.plan ?? ""}\n\nJournal:\n${seat.journal.join("\n")}\n\nReview:\n${review}\n\n`);
    }
    break;
  }
}
say("results:", csv, "usage:", JSON.stringify(state.usage));
