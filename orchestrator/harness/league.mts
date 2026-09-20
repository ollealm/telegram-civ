// A world with no humans: advisor-ruled realms on different models play a whole game against each other.
// Needs its own host:  ../host.sh /tmp/league-data 8767
// Run:  RULER_HOST_URL=http://127.0.0.1:8767 RULER_STATE_FILE=/tmp/league-data/state.json IMAGES=off \
//       npx tsx harness/league.mts claude-opus-5,claude-sonnet-5 [maxTurns=300] [gameAiCivs=0] [mapSize=Small]
// Results: ../data/harness/league-<date>.csv (score per realm per round), the Chronicler's chapters and a closing epic on the console.

import { appendFileSync, mkdirSync } from "node:fs";
import { chroniclerEpic, createCharacter } from "../src/agents.ts";
import { host } from "../src/host.ts";
import { playRound } from "../src/round.ts";
import { persist, state, type Seat } from "../src/store.ts";

const models = (process.argv[2] ?? "claude-opus-5,claude-sonnet-5").split(",");
const maxTurns = Number(process.argv[3] ?? 300);
const gameAi = Number(process.argv[4] ?? 0);
const mapSize = process.argv[5] ?? "Small";
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

const nations = (await host.nations()).map((nation) => nation.name).sort(() => Math.random() - 0.5);
state.seats = models.map((model, index): Seat => ({ civ: nations[index], kind: "agent", model, will: "", journal: [], chat: [], ready: false }));
for (const seat of state.seats) {
  seat.character = { ...(await createCharacter(seat, [{ question: "What kind of sovereign rules this people?", answer: "Someone unexpected, with a clear ambition of their own" }])), autonomy: "bold" };
  say(`${seat.civ}: ${seat.character.name} on ${seat.model}`);
}
await host.newGame({ ruled: state.seats.map((seat) => seat.civ), others: nations.slice(models.length, models.length + gameAi), mapSize, cityStates: 4 });
persist();

mkdirSync("../data/harness", { recursive: true });
const csv = `../data/harness/league-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`;
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
    say("\n" + (await chroniclerEpic(await host.events(), standings, "The age of the league has closed.")));
    break;
  }
}
say("results:", csv, "usage:", JSON.stringify(state.usage));
