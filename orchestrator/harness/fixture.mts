// Keep a saved world as a fixture: the day a reproduction is made, its save goes here before the league plays on (league backups keep only the last twelve
// turns - two crash saves were lost that way). The chancery is trimmed to its last twelve turns, the briefing's window; everything else is kept whole.
// Run:  npx tsx harness/fixture.mts <dir holding save.unciv and host.json> <name> "<what it reproduces>"
// FIXTURES_DIR (default ../data/fixtures) is where it goes; INDEX.md there gets the line. data/ is git-ignored but data/fixtures/INDEX.md is not.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const [source, name, what] = process.argv.slice(2);
if (!source || !name || !what) throw new Error('Usage: fixture.mts <dir with save.unciv and host.json> <name> "<what it reproduces>"');
const root = process.env.FIXTURES_DIR ?? "../data/fixtures";
const dir = join(root, name);
if (existsSync(dir)) throw new Error(`${dir} exists already`);
mkdirSync(dir, { recursive: true });

copyFileSync(join(source, "save.unciv"), join(dir, "save.unciv"));
for (const extra of ["state.json"]) if (existsSync(join(source, extra))) copyFileSync(join(source, extra), join(dir, extra));
const host = JSON.parse(readFileSync(join(source, "host.json"), "utf8"));
const turns = Object.values(host.chancery ?? {}).flatMap((lines) => (lines as { turn: number }[]).map((line) => line.turn));
const last = turns.length ? Math.max(...turns) : 0;
for (const civ of Object.keys(host.chancery ?? {})) host.chancery[civ] = (host.chancery[civ] as { turn: number }[]).filter((line) => line.turn > last - 12);
writeFileSync(join(dir, "host.json"), JSON.stringify(host));

const index = join(root, "INDEX.md");
if (!existsSync(index)) writeFileSync(index, "# Fixtures: saved worlds the fixes were proven on\n\nEach is save.unciv + host.json (chancery trimmed to its last 12 turns). Run one by hand on a copy: `cp -R data/fixtures/<name> /tmp/x && ./host.sh /tmp/x 8769`; the regression cases are in orchestrator/harness/regress.mts (`npx tsx harness/regress.mts [case...]`).\n\n| Fixture | Turn | What it reproduces |\n|---|---|---|\n");
const save = readFileSync(join(dir, "save.unciv"), "utf8");
const turn = /"turns":(\d+)/.exec(gunzipSync(Buffer.from(save, "base64")).toString("utf8"))?.[1] ?? "?";
appendFileSync(index, `| ${name} | ${turn} | ${what} |\n`);
console.log(`${dir}: save ${(save.length / 1024).toFixed(0)} KB, host.json trimmed to turns > ${last - 12}`);
