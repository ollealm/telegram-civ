// The game's closing words, proven on a throwaway copy of a finished game: the whole orchestrator runs against the copy's host and a stand-in for Telegram.
//   npx tsx harness/probe-ending.mts      (PROBE_PORT for the host, default 8813; PROBE_TG_PORT for the stand-in, default 8814; PROBE_MODEL, default haiku)
// Run 1 gives every saga and the epic 3 seconds: they time out, the closing broadcast goes out once, and the game is not counted as told.
// Run 2 is a restart: the startup catch-up takes the ending up again, sends no second broadcast, tells every saga and the epic, and sets the flag.
// Then /epic on the finished game is told for its ending, not as "a reader has asked". Nothing reaches Telegram, and the live game is never touched.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.PROBE_ROOT ?? "..");
const LIVE = resolve(process.env.PROBE_LIVE ?? join(ROOT, "data/game"));
const PORT = Number(process.env.PROBE_PORT ?? 8813);
const TG_PORT = Number(process.env.PROBE_TG_PORT ?? 8814);
if ([PORT, TG_PORT].some((port) => port === 8765 || port === 8787 || (port >= 8785 && port <= 8799))) throw new Error("the probe's ports must not be the live host's or a league's");
const MODEL = process.env.PROBE_MODEL ?? "claude-haiku-4-5-20251001";

// A scratch root shaped like the checkout, as probe-live builds it
const scratch = mkdtempSync(join(tmpdir(), "probe-ending-"));
const root = join(scratch, "root"), data = join(scratch, "data"), assets = join(root, "unciv/android/assets");
mkdirSync(join(root, "data"), { recursive: true }); mkdirSync(assets, { recursive: true }); mkdirSync(data, { recursive: true });
copyFileSync(join(ROOT, "host.sh"), join(root, "host.sh"));
copyFileSync(join(ROOT, "data/classpath.txt"), join(root, "data/classpath.txt"));
for (const entry of readdirSync(join(ROOT, "unciv/android/assets"))) if (entry !== "SaveFiles") symlinkSync(join(ROOT, "unciv/android/assets", entry), join(assets, entry));
for (const file of ["save.unciv", "host.json", "orchestrator.json"]) if (existsSync(join(LIVE, file))) copyFileSync(join(LIVE, file), join(data, file));
const stateFile = join(data, "orchestrator.json");
// The copy's ending is untold, as if the game had just closed
const copied = JSON.parse(readFileSync(stateFile, "utf8"));
copied.epicTold = false;
copied.endingDone = [];
copied.phase = "audience";
writeFileSync(stateFile, JSON.stringify(copied));

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail.slice(0, 300) : ""}`); };

// The stand-in for Telegram: every call answers ok, every message sent is kept, and an update can be queued for a bot's next poll
const sent: { token: string; method: string; chat: number; text: string }[] = [];
const queued = new Map<string, unknown[]>();
let updateId = 1;
const telegram = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", async () => {
    const [, token, method] = (request.url ?? "").match(/^\/bot([^/]+)\/(\w+)/) ?? [];
    let params: Record<string, unknown> = {};
    try { params = body ? JSON.parse(body) : {}; } catch { /* a photo upload is multipart: its caption is not needed */ }
    const reply = (result: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: Number(token.split(":")[0]), is_bot: true, first_name: `bot ${token}`, username: `bot_${token.split(":")[1]}` });
    if (method === "getUpdates") {
      const waiting = queued.get(token) ?? [];
      if (waiting.length) { queued.set(token, []); return reply(waiting); }
      await new Promise((done) => setTimeout(done, 500));
      return reply([]);
    }
    if (method.startsWith("send")) {
      sent.push({ token, method, chat: Number(params.chat_id), text: String(params.text ?? params.caption ?? "") });
      return reply({ message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(params.chat_id), type: "private" } });
    }
    return reply(true);
  });
});
await new Promise<void>((done) => telegram.listen(TG_PORT, "127.0.0.1", done));

const host = spawn("/bin/zsh", [join(root, "host.sh"), data, String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
const children: ChildProcess[] = [host];
process.on("exit", () => { for (const child of children) if (child.exitCode === null) child.kill("SIGTERM"); });

const HERALD = "1:herald";
/** The whole orchestrator on the copy; resolves when its log shows [until], or after [ms] */
async function orchestrator(env: Record<string, string>, until: RegExp, ms: number) {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: resolve("."),
    env: { ...process.env, ...env, RULER_HOST_URL: `http://127.0.0.1:${PORT}`, RULER_STATE_FILE: stateFile, TELEGRAM_API_ROOT: `http://127.0.0.1:${TG_PORT}`,
      HERALD_BOT_TOKEN: HERALD, ADVISOR_1_BOT_TOKEN: "2:advisor", IMAGES: "off", HERALD_MODEL: MODEL, DEV_FEED: "off" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  const seen = new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), ms);
    const read = (chunk: Buffer) => { output += chunk; process.stdout.write(`    | ${chunk.toString().trimEnd().replace(/\n/g, "\n    | ")}\n`); if (until.test(output)) { clearTimeout(timer); done(true); } };
    child.stdout!.on("data", read); child.stderr!.on("data", read);
  });
  return { child, seen, log: () => output };
}
const stop = async (child: ChildProcess) => { child.kill("SIGTERM"); await new Promise((done) => child.once("exit", done)); };
const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
const closings = () => sent.filter((message) => message.text.startsWith("The game is over:"));

try {
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/state`)).ok) break; } catch { /* not up yet */ } await new Promise((done) => setTimeout(done, 1000)); }
  const game = await (await fetch(`http://127.0.0.1:${PORT}/state`)).json();
  check("the copy is a finished game", !!game.winner, `winner ${game.winner}, turn ${game.turn}`);

  // Run 1: the sagas and the epic cannot finish in time
  const first = await orchestrator({ CLOSING_TIMEOUT_MS: "3000" }, /ending: not yet told/, 240_000);
  check("run 1: the epic's failure is logged as a step", await first.seen);
  await stop(first.child);
  check("run 1: the game is not counted as told", !state().epicTold, `epicTold ${state().epicTold}`);
  check("run 1: the closing broadcast went out", closings().length > 0, `${closings().length} closing messages`);
  check("run 1: each saga's failure is logged", /ending: saga of \w+ failed: saga agent timed out/.test(first.log()));
  const broadcastCount = closings().length;

  // Run 2: a restart takes the ending up again
  const second = await orchestrator({}, /ending: (told|not yet told)/, 900_000);
  await second.seen;
  check("run 2: the startup catch-up took the ending up", /its ending was never told: telling it now/.test(second.log()));
  check("run 2: the epic was told", /ending: epic done/.test(second.log()));
  check("run 2: the game is counted as told", state().epicTold === true);
  check("run 2: no second closing broadcast", closings().length === broadcastCount, `${closings().length} against ${broadcastCount}`);
  const sagas = [...new Set(sent.filter((message) => message.text.includes("THE SAGA OF ")).map((message) => message.text.match(/THE SAGA OF ([A-Z ]+?)( UNDER|\n)/)?.[1]))];
  const standing = game.majorCivs.filter((civ: { alive: boolean; civ: string }) => civ.alive && state().seats.some((seat: { civ: string }) => seat.civ === civ.civ)).map((civ: { civ: string }) => civ.civ.toUpperCase());
  check("run 2: every standing seat's saga was sent", standing.every((civ: string) => sagas.includes(civ)), `sagas ${sagas.join(", ")}; standing ${standing.join(", ")}`);
  check("run 2: the epic reached the Chronicler's chats", sent.some((message) => message.token === HERALD && message.text.startsWith("THE EPIC OF THE WORLD")));
  check("run 2: the epic was told for the real ending", /the epic, told for: .* has won a \w+ victory/.test(second.log()));

  // /epic on the finished game
  const chat = state().heraldChats[0];
  queued.set(HERALD, [{ update_id: updateId++, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: chat, type: chat > 0 ? "private" : "group" }, from: { id: 7, is_bot: false, first_name: "Reader" }, text: "/epic", entities: [{ type: "bot_command", offset: 0, length: 5 }] } }]);
  const asked = second.log().length;
  for (let i = 0; i < 600 && !/the epic, told for/.test(second.log().slice(asked)); i++) await new Promise((done) => setTimeout(done, 1000));
  const occasion = second.log().slice(asked).match(/the epic, told for: (.*)/)?.[1] ?? "";
  check("/epic on a finished game is told for its ending", /has won a \w+ victory/.test(occasion) && !/A reader has asked/.test(occasion), occasion);
  await stop(second.child);
} catch (error) {
  check("the probe ran", false, String(error));
} finally {
  telegram.close();
  host.kill("SIGTERM");
}
const failed = results.filter((result) => !result.ok);
console.log(`\nprobe-ending: ${results.length - failed.length} of ${results.length} passed; scratch ${scratch}`);
process.exit(failed.length ? 1 : 0);
