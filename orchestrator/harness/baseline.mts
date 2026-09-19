// Tripwire, not a target: how do ruled civs fare with no LLM at all? A full-advisor run far below this means a bug
// or a keyhole, not bad play. Usage: RULER_HOST_URL=http://127.0.0.1:8766 npx tsx harness/baseline.mts [games] [turns]

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { host } from "../src/host.ts";

const games = Number(process.argv[2] ?? 5);
const turns = Number(process.argv[3] ?? 80);
const FILE = "../data/harness/baseline.csv";
mkdirSync("../data/harness", { recursive: true });
if (!existsSync(FILE)) appendFileSync(FILE, "date,mode,turns,civ,score,cities,rank,happiness,science\n");

const modes = {
  neutral: {},
  builder: { Science: 8, Expansion: 8, Production: 7, Military: 4 },
} as const;

for (const [mode, personality] of Object.entries(modes)) {
  const scores: number[] = [];
  for (let game = 0; game < games; game++) {
    await host.newGame({ ruled: ["Rome", "Greece"], others: ["Egypt", "China"] });
    for (const civ of ["Rome", "Greece"]) await host.setOrders(civ, { personality });
    const result = await host.advance(turns);
    for (const civ of ["Rome", "Greece"]) {
      const briefing = (await host.briefing(civ).catch(() => null)) as Record<string, any> | null;
      const rank = result.rankings.findIndex((entry) => entry.civ === civ) + 1;
      const row = result.rankings.find((entry) => entry.civ === civ);
      scores.push(row?.score ?? 0);
      appendFileSync(FILE, [new Date().toISOString().slice(0, 10), mode, result.turn, civ, row?.score ?? 0, row?.cities ?? 0, rank || 4, briefing?.happiness ?? "", briefing?.perTurn?.science ?? ""].join(",") + "\n");
    }
  }
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  console.log(`${mode}: mean score ${mean.toFixed(0)} at turn ${turns} over ${games} games (min ${Math.min(...scores)}, max ${Math.max(...scores)})`);
}
