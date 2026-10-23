// Map samples for Olle's eye before a change to the painted maps goes live: one atlas and one campaign map per age, painted through the real
// paintedMap and campaignMap on one world with the era overridden - the age's look on the fixture's geography and campaigns.
// Needs its own host on a COPY of a fixture or a league backup with campaigns in it (never the live host):
//   cp -R ../data/fixtures/run32-t259-munich /tmp/maps && ../host.sh /tmp/maps 8816
// Run:  RULER_HOST_URL=http://127.0.0.1:8816 IMAGE_PROVIDER=codex npx tsx harness/map-samples.mts <civ> [ages back=1] [age ...]
// Results: ../data/harness/map-samples-<stamp>/ - <Age>-atlas.png, <Age>-campaign.png, the host's schematic and marches drawing, and index.md.
// Sixteen images at about 30k tokens each through Codex; they are painted three at a time.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host } from "../src/host.ts";
import { campaignMap, MAP_AGES, onImageLog, paintedMap } from "../src/images.ts";

const [civ, back = "1", ...only] = process.argv.slice(2);
if (!civ || !process.env.RULER_HOST_URL) throw new Error("Usage: RULER_HOST_URL=<scratch host> map-samples.mts <civ> [ages back=1] [age ...]");
if (/:8765\b/.test(process.env.RULER_HOST_URL)) throw new Error("never the live host");
const ages = only.length ? MAP_AGES.filter((age) => only.includes(age)) : [...MAP_AGES];
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);
onImageLog(say);

const game = await host.state();
const ageTurns = 12;
const fromTurn = Math.max(0, game.turn - ageTurns * Number(back));
const out = `../data/harness/map-samples-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
mkdirSync(out, { recursive: true });

// The world and its campaigns as the host gives them, once: every age paints the same
const age = await host.age(civ, fromTurn);
const schematic = await host.map(civ);
const marches = await host.map(civ, "campaign", fromTurn, game.turn);
writeFileSync(join(out, "schematic.png"), schematic);
writeFileSync(join(out, "marches.png"), marches);
say(`${civ} at turn ${game.turn}, campaigns since turn ${fromTurn}: ${age.marches.length} of ours, ${age.enemyMarches.length} of others; painting ${ages.length} ages`);

// The era is the one thing changed: every briefing the painters read names the age being sampled
const briefing = host.briefing;
let era = "";
host.briefing = async (name: string, logSince?: number) => ({ ...(await briefing(name, logSince)), era: `${era} era` });

const rows: string[] = [];
for (const name of ages) {
  era = name;
  // Both of an age at once, each read the era as it starts (the briefing is the first thing each awaits)
  const [atlas, campaign] = await Promise.all([paintedMap(civ), campaignMap(civ, age, marches)]);
  const failed = (png: Buffer, fallback: Buffer) => png.equals(fallback);
  writeFileSync(join(out, `${name}-atlas.png`), atlas);
  writeFileSync(join(out, `${name}-campaign.png`), campaign);
  rows.push(`| ${name} | ${failed(atlas, schematic) ? "FAILED (the schematic)" : `![](${name}-atlas.png)`} | ${failed(campaign, marches) ? "FAILED (the host's drawing)" : `![](${name}-campaign.png)`} |`);
  say(`${name} done`);
}
writeFileSync(join(out, "index.md"), `# Map samples: ${civ}, turn ${game.turn}\n\nOne atlas and one campaign map per age through paintedMap and campaignMap, the era overridden; campaigns since turn ${fromTurn} (${age.marches.length} of ours, ${age.enemyMarches.length} of others). The host's own drawings: [schematic](schematic.png), [marches](marches.png).\n\n| Age | Atlas | Campaign |\n|---|---|---|\n${rows.join("\n")}\n`);
say("samples:", out);
