// Prints sample advisor candidates, to judge the feel of the character scheme. Usage: npx tsx --env-file=../.env harness/characters.mts Sweden Babylon
import { card, draftCandidates } from "../src/characters.ts";
const civs = process.argv.slice(2).length ? process.argv.slice(2) : ["Sweden"];
for (const civ of civs) {
  const candidates = await draftCandidates(civ, process.env.ADVISOR_MODEL ?? "claude-opus-5");
  console.log(`\n===== ${civ} =====`);
  for (const candidate of candidates) console.log(`\n${card(candidate)}\n\nSHEET: ${candidate.sheet}`);
}
process.exit(0);
