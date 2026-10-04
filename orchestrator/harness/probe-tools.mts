// Does a real session for a seat receive the realm tools? One call on the cheapest model, with the full order tools served (the prompt asks for one word, so none is used); prints the init tools and exits 1 if get_briefing is missing.
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// The call writes its usage to the orchestrator's state: a copy's, never the live file the running orchestrator writes too
const copy = join(mkdtempSync(join(tmpdir(), "probe-tools-")), "orchestrator.json");
copyFileSync(resolve(process.env.RULER_STATE_FILE ?? "../data/game/orchestrator.json"), copy);
process.env.RULER_STATE_FILE = copy;
const { run } = await import("../src/agents.ts");
const { state } = await import("../src/store.ts");
const seat = state.seats.find((s) => s.kind === "agent") ?? state.seats[0];
let tools: string[] = [];
const orig = console.log;
console.log = (...args: unknown[]) => { const s = args.map(String).join(" "); const m = /"tools":\[(.*?)\]/.exec(s); if (m) tools = m[1].split(",").map((t) => t.replace(/"/g, "")); orig(...args); };
process.env.RULER_DEBUG = "1";
await run("probe", "claude-haiku-4-5-20251001", "Answer with the single word: ready.", "Say ready.", { seat });
console.log = orig;
const ok = tools.some((t) => t.includes("mcp__realm__get_briefing"));
console.log(ok ? `PROBE OK: ${tools.filter((t) => t.startsWith("mcp__realm")).length} realm tools` : `PROBE FAILED: realm tools missing (${tools.length} tools)`);
process.exit(ok ? 0 : 1);
