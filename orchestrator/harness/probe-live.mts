// Post-merge probe: one real govern look-in on a throwaway copy of the live game, so a merge that breaks a session shows before a league or a ruler does.
// Run after every merge:  npx tsx harness/probe-live.mts [civ]      (PROBE_MODEL, default haiku; PROBE_PORT, default 8768 - never 8765)
// It asserts, with no model judgement: the session got its realm tools, the briefing parsed, and set_orders answered without an exception. It prints what a
// reviewer should look at: the refusals block the look-in was shown, the policyBranches the briefing shows against those the court ordered, and any
// set_orders the look-in made. The live game is never touched: its save, host.json and orchestrator.json are copied to a scratch directory, the host runs
// there from a scratch copy of the assets folder (the host writes a "SaveFiles" copy beside its assets), and the orchestrator's state is the copy's.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.PROBE_ROOT ?? "..");               // the checkout whose built classes and host.sh are probed
const LIVE = resolve(process.env.PROBE_LIVE ?? join(ROOT, "data/game"));
const PORT = Number(process.env.PROBE_PORT ?? 8768);
if (PORT === 8765 || (PORT >= 8785 && PORT <= 8799)) throw new Error("PROBE_PORT must not be the live host's or a league's port");
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4-5-20251001";

// A scratch root shaped like the checkout: host.sh and the classpath copied, the assets folder linked entry by entry - all but SaveFiles
const scratch = mkdtempSync(join(tmpdir(), "probe-live-"));
const root = join(scratch, "root"), data = join(scratch, "data"), assets = join(root, "unciv/android/assets");
mkdirSync(join(root, "data"), { recursive: true }); mkdirSync(assets, { recursive: true }); mkdirSync(data, { recursive: true });
copyFileSync(join(ROOT, "host.sh"), join(root, "host.sh"));
copyFileSync(join(ROOT, "data/classpath.txt"), join(root, "data/classpath.txt"));
for (const entry of readdirSync(join(ROOT, "unciv/android/assets"))) if (entry !== "SaveFiles") symlinkSync(join(ROOT, "unciv/android/assets", entry), join(assets, entry));
for (const file of ["save.unciv", "host.json", "orchestrator.json"]) if (existsSync(join(LIVE, file))) copyFileSync(join(LIVE, file), join(data, file));

const host = spawn("/bin/zsh", [join(root, "host.sh"), data, String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
let hostErr = ""; host.stderr.on("data", (chunk) => (hostErr += chunk));
const stop = () => { if (host.exitCode === null) host.kill("SIGTERM"); };
process.on("exit", stop);

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail.slice(0, 300) : ""}`); };

try {
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 120; i++) { try { if ((await fetch(base + "/state")).ok) break; } catch { /* not up yet */ } await new Promise((done) => setTimeout(done, 1000)); }
  // The orchestrator's modules read these as they load: the copy's host and the copy's state, never the live ones
  process.env.RULER_HOST_URL = base;
  process.env.RULER_STATE_FILE = join(data, "orchestrator.json");
  process.env.GOVERN_MODEL = MODEL;
  const { governPass, onTrace, loadSchema } = await import("../src/agents.ts");
  const { refusalsForPrompt } = await import("../src/refusals.ts");
  const { host: client } = await import("../src/host.ts");
  const { state } = await import("../src/store.ts");

  const game = await client.state();
  const seat = state.seats.find((each) => each.civ === process.argv[2]) ?? state.seats.find((each) => game.ruled.includes(each.civ));
  if (!seat) throw new Error(`no seat of the copied game is ruled by the host (${state.seats.map((each) => each.civ).join(", ")})`);
  seat.model = MODEL; // on the copy only: the probe's look-in runs on the cheap model whatever the seat plays
  console.log(`Probing ${seat.civ} (${seat.kind === "agent" ? "a sovereign" : "an advised court"}) at turn ${game.turn}, ${MODEL}, on a copy of ${LIVE}`);

  // The startup check the bot runs: the host's lists against the tools, and the realm server's own tool list
  const schema = await loadSchema().then(() => "", (error: Error) => error.message);
  check("the host's orders and the tools agree, and the realm server lists every tool", schema === "", schema);

  const briefing = await client.briefing(seat.civ).catch((error: Error) => ({ error: error.message }));
  check("the briefing parses", typeof briefing === "object" && (briefing as { civ?: string }).civ === seat.civ, JSON.stringify(briefing).slice(0, 200));

  // What a reviewer reads: the policies the court ordered against those the briefing still shows as wished (an opened branch once vanished, Run 30)
  const hostJson = JSON.parse(await (await import("node:fs/promises")).readFile(join(data, "host.json"), "utf8"));
  console.log(`policyBranches ordered: ${JSON.stringify(hostJson.orders?.[seat.civ]?.policyBranches ?? [])}`);
  console.log(`policyBranches shown:   ${JSON.stringify((briefing as { standingOrders?: { policyBranches?: string[] } }).standingOrders?.policyBranches ?? [])}`);
  const refused = refusalsForPrompt(seat);
  console.log(refused ? `refusals shown to the look-in:\n${refused}` : "refusals shown to the look-in: none");

  // One real look-in: the session refuses to run without its tools (call() checks the init), so its finishing is the proof
  let trace: { toolCalls: { name: string; input: unknown; result?: string }[]; costUsd: number } | undefined;
  onTrace((each) => { if (each.role === "govern") trace = each; });
  const look = await governPass(seat, game.turn - 4, 4).then(() => "", (error: Error) => error.message);
  check("a real look-in ran with its realm tools", look === "" && trace !== undefined, look || `${trace?.toolCalls.length ?? 0} tool calls, $${trace?.costUsd?.toFixed(3)}`);
  for (const call of trace?.toolCalls.filter((each) => each.name.endsWith("set_orders")) ?? [])
    console.log(`the look-in's set_orders: ${JSON.stringify(call.input).slice(0, 300)}\n  answered: ${(call.result ?? "").slice(0, 400)}`);

  // set_orders answered on the copy whatever the model chose: an order that changes nothing, through the client every tool uses
  const answer = await client.setOrders(seat.civ, { acknowledge: [] }).then((reply) => JSON.stringify(reply), (error: Error) => `exception: ${error.message}`);
  check("set_orders answers without an exception", !answer.startsWith("exception") && answer.includes("\"orders\""), answer.slice(0, 200));
} catch (error) {
  check("the probe ran to the end", false, (error as Error).message);
} finally {
  stop();
}
if (/Exception|Error/.test(hostErr)) console.log(`host stderr (first lines):\n${hostErr.split("\n").filter((line) => /Exception|Error|SELFCHECK/.test(line)).slice(0, 8).join("\n")}`);
const failed = results.filter((result) => !result.ok);
writeFileSync(join(scratch, "probe.json"), JSON.stringify(results, null, 1));
console.log(`\n${results.length - failed.length} of ${results.length} probe checks passed (scratch: ${scratch})`);
process.exit(failed.length ? 1 : 0);
