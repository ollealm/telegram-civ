// The saved-world half of the checks (smoke.mts is the other: every lever once on a new world). Each case starts its own host on a copy of a fixture
// (data/fixtures, see its INDEX.md), plants a failure where it needs one (RULER_FAULT), gives orders, plays turns, and asserts on replies, briefings,
// chancery lines, public events and exit codes - the reproductions the fixes of 2026-10-03 were proven on, kept.
// Run:  npx tsx harness/regress.mts [case ...]        (all cases when none named; e.g. F1 W2)
// REGRESS_PORT (default 8772; never 8765 or 8790), FIXTURES_DIR (default ../data/fixtures), HOST_SH (default ../host.sh). Sequential; about a minute on this machine (each host answers in a few seconds).

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The orchestrator's modules the cases import keep their state in a scratch file, never the live game's (store.ts defaults to it)
process.env.RULER_STATE_FILE ??= join(mkdtempSync(join(tmpdir(), "regress-state-")), "orchestrator.json");
const PORT = Number(process.env.REGRESS_PORT ?? 8772);
if (PORT === 8765 || PORT === 8790) throw new Error("REGRESS_PORT must not be a live or league host's port");
const FIXTURES = resolve(process.env.FIXTURES_DIR ?? "../data/fixtures");
const HOST_SH = resolve(process.env.HOST_SH ?? "../host.sh");
const BASE = `http://127.0.0.1:${PORT}`;
// Every orchestrator module a case imports talks to the case's own host, never the live one (host.ts reads this once, at its first import)
process.env.RULER_HOST_URL = BASE;
// No case paints: one that reaches a painter (W51's dismissal) gets no picture unless the case stands in for the painter, and no image is ever asked of a
// provider (images.ts reads this once)
process.env.IMAGES = "off";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail.slice(0, 300) : ""}`);
};

type Host = { dir: string; proc: ChildProcess; exited: Promise<number | null>; log: string };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  // A request that never answers fails its case in five minutes instead of holding the whole run (once a full run waited on an idle host, 2026-10-04)
  const response = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(300_000) });
  const text = await response.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: response.status, json };
}
const get = (path: string) => call("GET", path);
const post = (path: string, body: unknown = {}) => call("POST", path, body);
const civ = (name: string) => encodeURIComponent(name);
const logOf = async (name: string, since: number) => ((await get(`/log?civ=${civ(name)}&since=${since}`)).json as { turn: number; text: string }[]);
const orders = (name: string, body: unknown) => post(`/orders?civ=${civ(name)}`, body);

async function portFree() { for (let i = 0; i < 60; i++) { try { await fetch(BASE + "/state"); await sleep(500); } catch { return; } } throw new Error(`port ${PORT} stays busy`); }

/** A save edited before the host loads it (base64 of gzipped JSON), for a case that needs a state no league left behind */
type SaveEdit = (game: any) => void;
function editSave(dir: string, edit: SaveEdit) {
  const file = join(dir, "save.unciv");
  const game = JSON.parse(gunzipSync(Buffer.from(readFileSync(file, "utf8"), "base64")).toString("utf8"));
  edit(game);
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(game))).toString("base64"));
}

/** A host on a fresh copy of the fixture (or on the given directory, for a restart), with RULER_FAULT when the case plants one */
async function start(fixture: string, fault = "", dir?: string, edit?: SaveEdit): Promise<Host> {
  await portFree();
  const at = dir ?? mkdtempSync(join(tmpdir(), `regress-${fixture}-`));
  if (!dir) cpSync(join(FIXTURES, fixture), at, { recursive: true });
  if (edit) editSave(at, edit);
  const log = join(at, "host-run.log");
  const out = openSync(log, "a");
  const proc = spawn("/bin/zsh", [HOST_SH, at, String(PORT)], { env: { ...process.env, RULER_FAULT: fault }, stdio: ["ignore", out, out] });
  const exited = new Promise<number | null>((done) => proc.on("exit", (code) => done(code)));
  for (let i = 0; i < 120; i++) { try { if ((await fetch(BASE + "/state")).ok) return { dir: at, proc, exited, log }; } catch { /* not up yet */ } await sleep(1000); }
  proc.kill("SIGTERM");
  throw new Error(`host on ${fixture} did not answer within two minutes (see ${log})`);
}
async function stop(host: Host) { if (host.proc.exitCode === null) { host.proc.kill("SIGTERM"); await Promise.race([host.exited, sleep(10000)]); } }
const selfChecks = (host: Host) => existsSync(join(host.dir, "selfcheck.log")) ? readFileSync(join(host.dir, "selfcheck.log"), "utf8").trim().split("\n").filter(Boolean) : [];
const hostLog = (host: Host) => readFileSync(host.log, "utf8");

/** Each case: its own host(s), its own assertions; a case that throws is a FAIL, and the next still runs */
const CASES: Record<string, () => Promise<void>> = {
  // ---- planted failures: the guards of the robustness pair ----
  async F1() { // a turn the engine fails partway: reload, the operator told (never a court), 503, exit 3; restarted, the world is the turn before
    const host = await start("run22-t234-greece", "engine:Greece");
    const first = await post("/advance", { turns: 1 });
    check("F1 the failed turn answers 500 'could not be played'", first.status === 500 && /could not be played/.test(JSON.stringify(first.json)), JSON.stringify(first.json));
    const second = await post("/advance", { turns: 1 }).catch(() => ({ status: 0, json: "gone" }));
    check("F1 a second advance before the exit is refused (503) or finds the host gone", second.status === 503 || second.status === 0, `${second.status}`);
    const code = await Promise.race([host.exited, sleep(10000).then(() => "still running")]);
    check("F1 the host exits with code 3", code === 3, `${code}`);
    const again = await start("run22-t234-greece", "", host.dir);
    check("F1 restarted, the world is at turn 234", (await get("/state")).json.turn === 234);
    // The operator's word stays with the operator: the self-check log has it, no court's chancery does (Run 32, T169: it read as news of the realm)
    check("F1 no court was told the operator's word", (await Promise.all(["Greece", "Inca", "Japan"].map((name) => logOf(name, 233)))).every((lines) => !lines.some((line) => /could not be played/.test(line.text))));
    check("F1 the self-check log has it", readFileSync(join(host.dir, "selfcheck.log"), "utf8").includes("the turn could not be played"));
    await stop(again);
  },
  async F2() { // one court's bookkeeping fails: its line says so, the others' are whole, the turns are saved and backed up
    const host = await start("run22-t234-greece", "chancery:Greece");
    const a = await post("/advance", { turns: 1 }), b = await post("/advance", { turns: 1 });
    check("F2 both turns play", a.status === 200 && b.status === 200, `${a.status} ${b.status}`);
    check("F2 Greece's chancery says its account could not be finished", (await logOf("Greece", 234)).some((line) => /could not be finished/.test(line.text)));
    check("F2 another court's turn is told", (await logOf("Inca", 234)).some((line) => line.turn === 235));
    check("F2 both turns are backed up", ["turn-0235", "turn-0236"].every((name) => existsSync(join(host.dir, "backups", name))));
    await stop(host);
  },
  async F3() { // an order item that throws: under failed, the rest done, the standing order saved
    const host = await start("run22-t234-greece", "order");
    const reply = await orders("Greece", { goldReserve: 777, cityFocus: [{ city: "Athens", focus: "Gold" }, { city: "Sparta", focus: "Science" }] });
    check("F3 the failing item is under failed", (reply.json.failed ?? []).some((line: string) => /RULER_FAULT/.test(line)), JSON.stringify(reply.json.failed));
    check("F3 the next item went on", (reply.json.done ?? []).some((line: string) => /Sparta/.test(line)), JSON.stringify(reply.json.done));
    check("F3 the standing order is saved", JSON.parse(readFileSync(join(host.dir, "host.json"), "utf8")).orders.Greece.goldReserve === 777);
    await stop(host);
  },
  async F4() { // a hook that throws inside the engine's turn: the engine's default, the turn goes on, the self-check counts it
    const host = await start("run20-t279-barbarians", "hook");
    const a = await post("/advance", { turns: 1 });
    check("F4 the turn plays", a.status === 200 && a.json.turn === 280, `${a.status}`);
    check("F4 the fallback is in selfcheck.log", selfChecks(host).some((line) => /\thook\t/.test(line)), selfChecks(host).slice(0, 2).join(" | "));
    check("F4 the next turn plays", (await post("/advance", { turns: 1 })).status === 200);
    await stop(host);
  },
  async F5() { // a unit the officials cannot move: that unit's turn, never the turn
    const host = await start("run22-t234-greece", "move");
    const a = await post("/advance", { turns: 1 });
    const told = (await Promise.all(["Greece", "Inca", "Japan", "Iroquois", "The Ottomans", "Babylon"].map((name) => logOf(name, 234)))).flat();
    check("F5 the turn plays", a.status === 200);
    check("F5 one unit 'could not be moved this turn'", told.some((line) => /could not be moved this turn/.test(line.text)));
    await stop(host);
  },
  async F5b() { // a routine that recurses without end on a unit: that unit's turn, never the turn (Run 32 stopped at T169 on one)
    const host = await start("run22-t234-greece", "overflow:move");
    const a = await post("/advance", { turns: 1 });
    const told = (await Promise.all(["Greece", "Inca", "Japan", "Iroquois", "The Ottomans", "Babylon"].map((name) => logOf(name, 234)))).flat();
    check("F5b the turn plays", a.status === 200, JSON.stringify(a.json).slice(0, 200));
    check("F5b one unit 'could not be moved this turn'", told.some((line) => /could not be moved this turn/.test(line.text)));
    await stop(host);
  },
  async F6() { // the trail, the world's events and the vote steps fail: each skipped, the save still reached
    const host = await start("run22-t234-greece", "trail,events,vote");
    const a = await post("/advance", { turns: 1 });
    check("F6 the turn plays and is saved", a.status === 200 && existsSync(join(host.dir, "backups", "turn-0235")));
    check("F6 each failed step is printed", ["the trail", "the world's events", "the world's vote"].every((step) => hostLog(host).includes(`Bookkeeping step failed (${step})`)));
    await stop(host);
  },

  // ---- saved worlds: the fixes as they were proven ----
  async W1() { // Greece declares on Inca under attack: the garrison stays, the swept deals named, the allies told, the events two lines
    const host = await start("run22-t234-greece");
    const reply = await orders("Greece", { mayDeclareWar: true, declareWar: ["Inca"], posture: { warAim: "Cuzco", stance: "attack", reserve: 3 } });
    check("W1 the declaration names the agreement paid and lost", (reply.json.done ?? []).some((line: string) => /paid and now lost/.test(line)), JSON.stringify(reply.json.done).slice(0, 200));
    for (const turn of [235, 236]) {
      await post("/advance", { turns: 1 });
      const units = (await get(`/briefing?civ=Greece`)).json.units as string[];
      check(`W1 T${turn}: the garrison #69 is still in Sparta`, units.some((line) => /#69 at \(7,6\), in Sparta/.test(line)), units.find((line) => /#69/.test(line)) ?? "gone");
    }
    const told = await logOf("Greece", 234);
    check("W1 the engine's 'from Inca has ended' lines are not told beside ours", !told.some((line) => /from Inca has ended/.test(line.text)), told.filter((line) => /has ended/.test(line.text)).map((line) => line.text).join(" | "));
    const events = ((await get("/events")).json as { turn: number; text: string }[]).filter((event) => event.turn === 235);
    check("W1 the world's events: one declaration, one line of joins", events.some((event) => event.text === "Greece declared war on Inca.") && events.filter((event) => /joined the war/.test(event.text)).length === 1, events.map((event) => event.text).join(" | "));
    await stop(host);
  },
  async W1b() { // raid with a reserve: no siege, the garrison stays
    const host = await start("run22-t234-greece");
    await orders("Greece", { mayDeclareWar: true, declareWar: ["Inca"], posture: { warAim: "Cuzco", stance: "raid", reserve: 3 } });
    await post("/advance", { turns: 3 });
    const units = (await get(`/briefing?civ=Greece`)).json.units as string[];
    check("W1b raid: the garrison #69 is still in Sparta after three turns", units.some((line) => /#69 at \(7,6\), in Sparta/.test(line)));
    await stop(host);
  },
  async W2() { // Persia declares on England: Polynesia drawn in by its pact, told so; the joins folded
    const host = await start("run23-t236-persia");
    await orders("Persia", { mayDeclareWar: true, declareWar: ["England"] });
    const turn = await post("/advance", { turns: 1, wake: true });
    check("W2 drawnIn names Polynesia at England's side", JSON.stringify(turn.json.drawnIn ?? []).includes("Polynesia") && JSON.stringify(turn.json.drawnIn).includes("England"), JSON.stringify(turn.json.drawnIn));
    const events = ((await get("/events")).json as { text: string }[]).map((event) => event.text);
    check("W2 the event: Polynesia came in by its pact", events.some((text) => /Polynesia came in at England's side by its pact/.test(text)));
    const persia = await logOf("Persia", 236);
    check("W2 Persia's joins are folded into one line per foe", persia.filter((line) => /have joined us in the war against England/.test(line.text)).length === 1 && !persia.some((line) => /^Quebec City has joined/.test(line.text)));
    check("W2 Polynesia's chancery: joined England by its pact, in our words", (await logOf("Polynesia", 236)).some((line) => /^We joined England in the war against Persia, as our Defensive Pact with England binds us\. No peace can be made before (?:AD \d+|\d+ BC)\.$/.test(line.text)));
    await stop(host);
  },
  async W3() { // faith above the reserve; a free technology to the goal
    const host = await start("run23-t241-persia");
    await post(`/grant?civ=Persia`, { faith: 5000 });
    await orders("Persia", { faithReserve: 4000, research: ["Lasers"] });
    await post(`/grant?civ=Persia`, { freeTechs: 1 });
    await post("/advance", { turns: 1 });
    const religion = (await get(`/briefing?civ=Persia`)).json.religion;
    const stored = typeof religion === "object" ? religion.faithStored : Number(/faith (\d+) stored/.exec(religion)?.[1]);
    check("W3 the officials left the reserve", stored >= 4000, `${stored}`);
    check("W3 the free technology went to the goal", (await logOf("Persia", 241)).some((line) => /A free technology: Lasers/.test(line.text)));
    await stop(host);
  },
  async W4() { // a marriage by order: the city joins, the world hears it, nothing "destroyed"
    const host = await start("run21-t294-austria");
    await post("/advance", { turns: 3 });
    const reply = await orders("Austria", { marry: ["Manila"] });
    check("W4 Manila joined by marriage", (reply.json.done ?? []).some((line: string) => /joined us by marriage/.test(line)), JSON.stringify(reply.json).slice(0, 300));
    const events = ((await get("/events")).json as { text: string }[]).map((event) => event.text);
    check("W4 the world's event", events.includes("Manila joined Austria by marriage into its ruling family."));
    const next = await post("/advance", { turns: 1, wake: true });
    check("W4 no court woken by a city-state 'destroyed'", !JSON.stringify(next.json.wake ?? {}).includes("destroyed"));
    await stop(host);
  },
  async W5() { // the vote: the United Nations raised again by Egypt sets one countdown for every power, a pledged vote is cast, the tally is told once
    // The fixture's own countdown carries Run 19's desync (the fix applies when the UN is built): the UN is taken down and put back in Thebes' queue, finished
    const host = await start("run19-t230-un", "", undefined, (game) => {
      for (const civ of game.civilizations) { delete civ.flagsCountdown?.TurnsTillNextDiplomaticVote; delete civ.flagsCountdown?.ShouldResetDiplomaticVotes;
        for (const city of civ.cities ?? []) { const built = city.cityConstructions; if (!built.builtBuildings?.includes("United Nations")) continue;
          built.builtBuildings = built.builtBuildings.filter((name: string) => name !== "United Nations");
          built.constructionQueue = ["United Nations", ...(built.constructionQueue ?? []).filter((name: string) => name !== "United Nations")];
          (built.inProgressConstructions ??= {})["United Nations"] = 99999; } }
      game.diplomaticVictoryVotesCast = {};
    });
    const courts = ["China", "Byzantium", "Siam", "Egypt", "The Ottomans", "India"];
    await post("/advance", { turns: 1 });
    const lines = await Promise.all(courts.map(async (name) => (await get(`/briefing?civ=${civ(name)}`)).json.victory?.diplomatic?.unitedNations as string));
    const countdowns = lines.map((line) => /next vote in (?:AD \d+|\d+ BC), (?:a year|\d+ years) from now|votes now/.exec(line ?? "")?.[0]);
    check("W5 every court reads the same countdown after the UN is built", new Set(countdowns).size === 1 && countdowns[0] !== undefined, countdowns.join(" | "));
    await orders("India", { worldVote: "Egypt" });
    for (let i = 0; i < 11; i++) await post("/advance", { turns: 1 });
    check("W5 India's vote went to Egypt by its pledge", (await logOf("India", 231)).some((line) => /our vote went to Egypt/.test(line.text)));
    const counted = await Promise.all(courts.map(async (name) => (await logOf(name, 231)).filter((line) => /The world's vote for its leader was counted/.test(line.text)).length));
    check("W5 every court hears the tally once", counted.every((count) => count === 1), counted.join(","));
    await stop(host);
  },
  async W6() { // war at sea and on land in the world's words: no hit-point arithmetic, no "An enemy", no raw templates
    const host = await start("run20-t279-barbarians");
    await post("/advance", { turns: 3 });
    const all = (await Promise.all(["France", "Spain", "Inca", "Songhai", "Rome"].map((name) => logOf(name, 279)))).flat();
    check("W6 no '(-N HP)' in any chancery line", !all.some((line) => /\(-\d+ HP\)/.test(line.text)));
    check("W6 no engine 'An enemy ...' line", !all.some((line) => /^An enemy /.test(line.text)));
    check("W6 no brackets or braces", !all.some((line) => /[[\]{}]/.test(line.text)));
    await stop(host);
  },
  async W7() { // the war estimate: enemies first, each city with how we stand with its power
    const host = await start("run21-t300-war");
    const cities = (await get(`/briefing?civ=Aztecs`)).json.warEstimate?.citiesWeHaveSeen as { ourRelation: string }[];
    const firstPeace = cities.findIndex((city) => city.ourRelation !== "at war"), lastWar = cities.map((city) => city.ourRelation).lastIndexOf("at war");
    check("W7 enemy cities first", cities[0]?.ourRelation === "at war" && (firstPeace === -1 || firstPeace > lastWar), cities.slice(0, 4).map((city) => city.ourRelation).join(","));
    await stop(host);
  },
  async W8() { // a fallen realm has no briefing; a won game plays no more
    const host = await start("run23-t245-won");
    check("W8 a fallen realm's briefing is 410", (await get(`/briefing?civ=Iroquois`)).status === 410);
    check("W8 a won game refuses to advance (409)", (await post("/advance", { turns: 1 })).status === 409);
    await stop(host);
  },
  async W9() { // mid-game briefing size and the one-line sections
    const host = await start("t100-world");
    for (const name of ["Greece", "Babylon", "Japan", "Inca", "Iroquois", "The Ottomans"]) {
      const brief = (await get(`/briefing?civ=${civ(name)}`)).json;
      const size = JSON.stringify(brief).length;
      // 16,000 until the mood block (2026-11-08): about 1.25 KB at every sign, the size the researcher's report gave for Olle's yes, less the warnings it shortened
      check(`W9 ${name}: briefing at most 16.5 KB, without score, goldBreakdown or victory.note`, size <= 16500 && !("score" in brief) && !("goldBreakdown" in brief) && !("note" in (brief.victory ?? {})), `${size}`);
      check(`W9 ${name}: the spaceship and the vote are one line before they matter`, typeof brief.spaceship === "string" && Object.keys(brief.victory?.diplomatic ?? {}).join() === "unitedNations");
    }
    await stop(host);
  },
  async W9b() { // late-game briefing size
    const host = await start("run22-t234-greece");
    for (const name of ["Greece", "Babylon", "Japan"]) {
      const size = JSON.stringify((await get(`/briefing?civ=${civ(name)}`)).json).length;
      check(`W9b ${name}: late briefing at most 31 KB (30 before the mood block)`, size <= 31000, `${size}`);
    }
    await stop(host);
  },
  async W11() { // the war leave, held by the host: refused without it in every form, taken with the ruler's word at an audience, kept as standing
    const host = await start("run22-t234-greece");
    const without = await orders("Greece", { mayDeclareWar: false, declareWar: ["Inca"], personality: { DeclareWar: 5, Science: 7 } });
    check("W11 no leave: the declaration is refused in the host's words", (without.json.failed ?? []).some((line: string) => /War on Inca was not declared: war is the ruler's alone to declare/.test(line)), JSON.stringify(without.json.failed));
    check("W11 the DeclareWar weight is the court's to set: war is never the officials' (Act.War)", without.json.orders?.personality?.DeclareWar === 5 && without.json.orders?.personality?.Science === 7, JSON.stringify(without.json.orders?.personality));
    const offered = (await get(`/options?civ=Greece`)).json.diplomacy?.with?.flatMap((power: { weCanOffer?: string[] }) => power.weCanOffer ?? []) ?? [];
    const atAudience = (await get(`/options?civ=Greece&audience=1`)).json.diplomacy?.with?.flatMap((power: { weCanOffer?: string[] }) => power.weCanOffer ?? []) ?? [];
    check("W11 no leave: no call to war among what we can offer; at an audience there are", !offered.some((item: string) => /declaration of war/.test(item)) && atAudience.some((item: string) => /declaration of war/.test(item)), `${offered.length} / ${atAudience.length}`);
    const audience = await orders("Greece", { withRulersWord: true, declareWar: ["Inca"] });
    check("W11 the ruler's word at an audience declares it", (audience.json.done ?? []).some((line: string) => /Declared war on Inca/.test(line)), JSON.stringify(audience.json.failed));
    check("W11 the audience's word is not kept as standing", JSON.parse(readFileSync(join(host.dir, "host.json"), "utf8")).orders.Greece.mayDeclareWar === false);
    await stop(host);
  },
  async W12() { // one near-victory source: a power a step from victory is named beside the walls, as in the deals; two steps away it is not
    const steps = async (edit?: SaveEdit) => {
      const host = await start("run22-t234-greece", "", undefined, edit);
      const named = (await get(`/options?civ=Japan`)).json.warEstimate?.aStepFromVictory as string[] | undefined;
      await stop(host);
      return named;
    };
    const before = await steps();
    check("W12 Greece at 4 of 6 parts is not named", !before?.some((fact) => /Greece/.test(fact)), JSON.stringify(before));
    const after = await steps((game) => { game.civilizations.find((c: any) => c.civName === "Greece").victoryManager.currentsSpaceshipParts["SS Engine"] = 1; });
    check("W12 Greece at 5 of 6 parts is named in the war estimate", after?.some((fact) => /Greece has 5 of 6 parts/.test(fact)) === true, JSON.stringify(after));
  },
  async W17() { // the Section table: religion latched through a prophet's birth and a restart; no empty keys; the engineless war estimate folded
    const host = await start("t100-world");
    const religion = async () => (await get(`/briefing?civ=Greece`)).json.religion;
    check("W17 Greece's religion is in full at T100 (145 faith)", typeof (await religion()) === "object");
    await post("/advance", { turns: 4 });
    const after = await religion();
    check("W17 a prophet's birth took the faith below 100, and religion stays in full", typeof after === "object" && after.faithStored < 100, JSON.stringify(after).slice(0, 80));
    await stop(host);
    const again = await start("t100-world", "", host.dir);
    check("W17 the latch is kept over a restart", typeof (await religion()) === "object");
    const empties: string[] = [];
    const keep = new Set(["warnings", "units", "cities", "log", "peaceOffers", "tradeOffers", "demands", "threats", "citySites", "knownCivs", "strategicResources", "policies", "researchQueue", "buildQueue", "canDeclareWarOn", "researchableNow"]);
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`));
      else if (node && typeof node === "object") for (const [key, value] of Object.entries(node)) {
        if (value === null || value === false || ((Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value as object).length === 0) && !keep.has(key))) empties.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    };
    for (const name of ["Greece", "Babylon"]) { walk((await get(`/briefing?civ=${name}`)).json, `${name}.briefing`); walk((await get(`/options?civ=${name}`)).json, `${name}.options`); }
    check("W17 no null, false or empty key in a briefing or options", empties.length === 0, empties.slice(0, 5).join(", "));
    await stop(again);
    const late = await start("run22-t234-greece");
    const estimate = (await get(`/options?civ=Greece`)).json.warEstimate;
    check("W17 an engineless court's war estimate says so once, and no city carries a verdict", typeof estimate?.withoutEngines === "string" && (estimate.citiesWeHaveSeen as any[]).every((city) => !("verdict" in city)) && JSON.stringify(estimate).length < 6000, `${JSON.stringify(estimate).length}`);
    await stop(late);
  },
  async W18() { // one spending floor around the officials' whole turn: the gold and faith reserves hold, the floor is put back, nothing goes unaccounted
    const persia = await start("run23-t241-persia");
    await post(`/grant?civ=Persia`, { faith: 5000 });
    await orders("Persia", { faithReserve: 4000 });
    await post("/advance", { turns: 3 });
    const religion = (await get(`/briefing?civ=Persia`)).json.religion;
    const faith = typeof religion === "object" ? religion.faithStored : Number(/faith (\d+) stored/.exec(religion)?.[1]);
    check("W18 the faith reserve holds, and the officials spent above it", faith >= 4000 && (await logOf("Persia", 241)).some((line) => /^The officials spent \d+ faith/.test(line.text)), `${faith}`);
    check("W18 no faith self-check", !selfChecks(persia).some((line) => /\tfaith\t/.test(line)), selfChecks(persia).slice(0, 2).join(" | "));
    await stop(persia);
    // The Aztecs at war re-arm on their own every turn (14 lines in the five turns before the fixture): a reserve above the treasury leaves them nothing
    const aztecs = await start("run21-t300-war");
    const before = (await get(`/briefing?civ=Aztecs`)).json.gold as number;
    await orders("Aztecs", { goldReserve: before + 5000 });
    await post("/advance", { turns: 3 });
    const gold = (await get(`/briefing?civ=Aztecs`)).json.gold as number;
    const spent = (await logOf("Aztecs", 300)).filter((line) => /^The officials spent \d+ gold/.test(line.text) && line.turn > 300);
    check("W18 under a reserve above the treasury the officials spend no gold in three turns of war, and the treasury is whole after", spent.length === 0 && gold > before, `${before} -> ${gold}; ${spent.map((line) => line.text.slice(0, 60)).join(" | ")}`);
    check("W18 no gold self-check", !selfChecks(aztecs).some((line) => /\tgold\t/.test(line)), selfChecks(aztecs).slice(0, 2).join(" | "));
    await stop(aztecs);
  },
  async W19() { // one table for the officials' acts: the old orders read into it, the binding acts refused and never done, the routine ones kept, a closed one opened
    const host = await start("run21-t300-war");
    const courts = ["Aztecs", "Japan", "Arabia", "Songhai", "Austria", "Denmark"];
    const table = (await get(`/briefing?civ=Aztecs`)).json.standingOrders?.officials;
    check("W19 a host.json from before reads into the table: friendship and re-arming at peace closed, the rest open, the binding acts named", table?.mayNot?.includes("Declaration of Friendship") && table?.may?.includes("luxuries") && /calls to war/.test(table?.neverTheirs ?? ""), JSON.stringify(table));
    const fixed = await orders("Aztecs", { officials: { "calls to war": true } });
    check("W19 a binding act cannot be opened", fixed.status === 400 && /never the officials'/.test(JSON.stringify(fixed.json)), JSON.stringify(fixed.json).slice(0, 160));
    const unknown = await orders("Aztecs", { officials: { tea: true } });
    check("W19 an unknown kind is refused with the list", unknown.status === 400 && /luxuries/.test(JSON.stringify(unknown.json)), JSON.stringify(unknown.json).slice(0, 120));
    await orders("Japan", { officials: { "Declaration of Friendship": true } });
    check("W19 a closed kind is opened by order", (await get(`/briefing?civ=Japan`)).json.standingOrders?.officials?.may?.includes("Declaration of Friendship"));
    await post("/advance", { turns: 6 });
    const all = (await Promise.all(courts.map((name) => logOf(name, 300)))).flat().filter((line) => line.turn > 300);
    const binding = all.filter((line) => /^The officials proposed (a deal to \w[^:]*: we give nothing; they give a declaration of war|a Defensive Pact)/.test(line.text));
    const friendships = (await Promise.all(courts.filter((name) => name !== "Japan").map((name) => logOf(name, 300)))).flat().filter((line) => line.turn > 300 && /^The officials proposed a Declaration of Friendship/.test(line.text));
    check("W19 in six turns of war no officials' call to war, pact or (unopened) friendship", binding.length === 0 && friendships.length === 0, [...binding, ...friendships].map((line) => line.text.slice(0, 90)).join(" | "));
    const routine = all.filter((line) => /^The officials (proposed a deal|spent \d+ gold)/.test(line.text));
    check("W19 the routine acts go on", routine.length > 0, `${routine.length} lines`);
    await stop(host);
  },
  async W20() { // one desk clock and declared memories: a warning that woke an advisor wakes no one again after a restart; offers lapse on the one clock
    const host = await start("run21-t300-war");
    const courts = ["Aztecs", "Japan", "Arabia", "Songhai", "Austria", "Denmark"];
    const first = ((await post("/advance", { turns: 1 })).json.wake ?? {}) as Record<string, string[]>;
    const saved = JSON.parse(readFileSync(join(host.dir, "host.json"), "utf8"));
    check("W20 warningsWoken and shipRaids are kept in host.json", "warningsWoken" in saved && "shipRaids" in saved && Object.keys(saved.warningsWoken).length > 0, Object.keys(saved).join(","));
    await stop(host);
    const again = await start("run21-t300-war", "", host.dir);
    const second = ((await post("/advance", { turns: 1 })).json.wake ?? {}) as Record<string, string[]>;
    const warning = /no defender|unhappy|treasury|no military/i;
    const repeated = Object.entries(second).flatMap(([civ, reasons]) => reasons.filter((reason) => warning.test(reason) && (first[civ] ?? []).includes(reason)).map((reason) => `${civ}: ${reason}`));
    const kept = JSON.parse(readFileSync(join(host.dir, "host.json"), "utf8")).warningsWoken as Record<string, string[]>;
    const lost = Object.entries(saved.warningsWoken as Record<string, string[]>).flatMap(([civ, keys]) => keys.filter((key) => !(kept[civ] ?? []).includes(key)));
    check("W20 after a restart the warnings that woke an advisor are remembered, and wake no one again", lost.length === 0 && repeated.length === 0, [...lost, ...repeated].slice(0, 3).join(" | "));
    await stop(again);
    // An offer planted on a court's desk and left unanswered (run 21's war ends at T305, so a world at peace): Greece offers the Inca 20 gold for nothing
    const peace = await start("run22-t234-greece");
    const proposed = await orders("Greece", { trade: [{ with: "Inca", give: [{ item: "Gold", amount: 20 }] }] });
    await post("/advance", { turns: 1 });
    const waiting = ((await get(`/briefing?civ=Inca`)).json.tradeOffers ?? []) as string[];
    check("W20 an offer on the desk says when it lapses in the one wording", waiting.some((line) => /^Greece: .*Gold x20.*\((waits until (?:AD \d+|\d+ BC), (?:a year|\d+ years) from now|lapses in (?:AD \d+|\d+ BC), (?:a year|\d+ years) from now); answerOffers accept or refuse\)/.test(line)), `${JSON.stringify(proposed.json.done)}; ${waiting.join(" | ")}`);
    // An advance stops early when a court is woken: played on to eight turns after the offer was entered
    const entered = (await get("/state")).json.turn as number;
    for (let i = 0; i < 20 && (await get("/state")).json.turn < entered + 8; i++) await post("/advance", { turns: entered + 8 - (await get("/state")).json.turn });
    const lapsed = (await logOf("Inca", 234)).filter((line) => /^Greece's offer .*Gold x20.* went unanswered and lapsed as refused/.test(line.text));
    const still = ((await get(`/briefing?civ=Inca`)).json.tradeOffers ?? []) as string[];
    check("W20 left unanswered eight turns, it lapses as refused and leaves the desk", lapsed.length === 1 && lapsed[0].turn === entered + 8 && !still.some((line) => /^Greece: .*Gold x20/.test(line)), `${lapsed.map((line) => `T${line.turn} ${line.text.slice(0, 80)}`).join(" | ")}; entered T${entered}; still ${still.length}`);
    await stop(peace);
  },
  async W21() { // the cadence told over the API, and a refusal that says the wait the engine set
    const host = await start("run22-t234-greece");
    await post("/advance", { turns: 2, ageTurns: 6, lookInTurns: 2 });
    const turn = (await get("/state")).json.turn as number;
    const log = (await get(`/briefing?civ=Greece`)).json.log as string[];
    // The briefing stamps its log lines with the year; each is found in the raw log, which keeps its turn
    const raw = await logOf("Greece", 0);
    const earliest = Math.min(...log.map((line) => raw.find((entry) => line.endsWith(`: ${entry.text}`))?.turn ?? turn));
    check("W21 the briefing's log reaches back one age as told (6 turns), not the old 12", earliest >= turn - 6 && earliest <= turn - 4, `T${earliest} at T${turn}`);
    check("W21 the cadence is kept in host.json", JSON.stringify(JSON.parse(readFileSync(join(host.dir, "host.json"), "utf8")).cadence) === JSON.stringify({ ageTurns: 6, lookInTurns: 2 }));
    await orders("Greece", { trade: [{ with: "Inca", give: [{ item: "Gold", amount: 20 }] }] });
    const refused = await orders("Inca", { answerOffers: [{ power: "Greece", answer: "refuse", terms: "we give nothing; they give Gold x20" }] });
    check("W21 a refusal of terms the engine holds no wait on says so, and claims no turns", (refused.json.done ?? []).some((line: string) => /Refused Greece's offer: .*Their officials may offer them again when they choose/.test(line)), JSON.stringify(Object.fromEntries(Object.entries(refused.json).filter(([key]) => key !== "orders"))).slice(0, 500));
    await stop(host);
  },
  async W22() { // the host's lists and the tools agree (GET /schema), as the bot and the league check at startup; a drift is caught
    const host = await start("t100-world");
    process.env.RULER_HOST_URL = BASE;
    const { schemaProblems, listingProblems } = await import("../src/agents.ts");
    const schema = (await get("/schema")).json;
    check("W22 the host publishes its lists", schema.orderFields?.standing?.includes("officials") && schema.officials?.never?.includes("war") && schema.unitActions?.includes("garrison"), JSON.stringify(schema).slice(0, 160));
    const problems = schemaProblems(schema);
    check("W22 the tools offer every field the host takes, and say every word", problems.length === 0, problems.join("; "));
    const drifted = schemaProblems({ ...schema, orderFields: { ...schema.orderFields, immediate: [...schema.orderFields.immediate, "annexWorld"] }, stances: [...schema.stances, "skirmish"] });
    const listing = await listingProblems(schema);
    check("W22 the realm server lists every tool it serves (tools/list, in memory, no model)", listing.length === 0, listing.join("; "));
    check("W22 an empty list from the host is caught before any tool is built", schemaProblems({ ...schema, stances: [] }).some((line: string) => /stances is empty/.test(line)));
    check("W22 a field or a word the tools do not know is caught", drifted.some((line: string) => /annexWorld/.test(line)) && drifted.some((line: string) => /skirmish/.test(line)), drifted.join("; "));
    await stop(host);
  },
  async W23() { // one real session, one cheap call: it starts with the realm tools (a record-shaped field once emptied every session's tools, 2026-10-04)
    const host = await start("t100-world");
    process.env.RULER_HOST_URL = BASE;
    const { runStructured } = await import("../src/agents.ts");
    const { z } = await import("zod");
    const reply = await runStructured("regress", process.env.REGRESS_MODEL ?? "claude-haiku-4-5-20251001", "Answer at once.", "Reply with ok true.", z.object({ ok: z.boolean() }), { seat: { civ: "Greece", kind: "agent" } as never })
      .then((out: unknown) => JSON.stringify(out), (error: Error) => `failed: ${error.message}`);
    check("W23 a session for a realm starts with its tools (the call refuses one without get_briefing)", !reply.startsWith("failed"), reply);
    await stop(host);
  },
  async W24() { // a queue holds what is not yet unlocked: a Temple behind its Shrine and a Musketman before Gunpowder wait and start when they can; the half-built item left out is named
    const host = await start("t100-world");
    const kyoto = async () => ((await get(`/briefing?civ=Japan`)).json.cities as any[]).find((city) => city.name === "Kyoto");
    const queued = await orders("Japan", { queue: [{ city: "Kyoto", items: ["Shrine", "Temple", "Musketman"] }] });
    const said = JSON.stringify(queued.json.done ?? []) + JSON.stringify(queued.json.failed ?? []);
    check("W24 a Temple behind its Shrine is accepted, waiting, with no engine text", /waiting, each to go to the front of the queue once it can be built - ahead of whatever is building then: Temple/.test(said) && !/Requires a/.test(said), said.slice(0, 240));
    check("W24 an item before its technology waits, the technology named", /Musketman \(it needs Gunpowder first\)/.test(said));
    check("W24 the half-built item the new queue leaves out is named, its work kept", /The half-built Market is left out of it; its work is kept/.test(said));
    // A condition that means never in this world (espionage is off) refuses the item; it does not wait for ever
    const never = await orders("Japan", { build: [{ city: "Osaka", item: "Constabulary" }] });
    check("W24 an item this world never allows is refused, not left waiting", (never.json.failed ?? []).some((line: string) => /cannot build Constabulary/.test(line)) && !JSON.stringify(never.json.done ?? []).includes("waits"), JSON.stringify(never.json.failed ?? never.json.done));
    await post(`/grant?civ=Japan`, { gold: 500 });
    await orders("Japan", { purchase: [{ city: "Kyoto", item: "Shrine" }] });
    await post("/advance", { turns: 1 });
    const afterShrine = await kyoto();
    check("W24 the Shrine bought, the Temple starts", afterShrine.buildQueue[0] === "Temple" && (afterShrine.waiting ?? []).every((line: string) => !/^Temple/.test(line)), JSON.stringify([afterShrine.buildQueue, afterShrine.waiting]));
    await orders("Japan", { research: ["Gunpowder"] });
    await post(`/grant?civ=Japan`, { freeTechs: 6 });
    await post("/advance", { turns: 1 });
    const afterTech = await kyoto();
    check("W24 Gunpowder learned, the Musketman starts and is told", afterTech.buildQueue.includes("Musketman") && !afterTech.waiting && (await logOf("Japan", 100)).some((line) => /Musketman, which waited in Kyoto's queue, can now be built/.test(line.text)), JSON.stringify([afterTech.buildQueue, afterTech.waiting]));
    await stop(host);
  },
  async W25() { // a peace made by order between two courts is told to the world, and the city-states' peaces that follow are one line
    const host = await start("run22-t234-greece");
    await orders("Greece", { mayDeclareWar: true, declareWar: ["Inca"] });
    for (let i = 0; i < 15 && (await get("/state")).json.turn < 245; i++) await post("/advance", { turns: 245 - (await get("/state")).json.turn });
    await orders("Inca", { peace: ["Greece"] });
    const made = await orders("Greece", { peace: ["Inca"] });
    await post("/advance", { turns: 1 });
    const events = ((await get("/events")).json as { turn: number; text: string }[]).filter((event) => event.turn >= 245 && /made peace/.test(event.text));
    check("W25 the peace made by order is a public event", (made.json.done ?? []).some((line: string) => /Peace made with Inca/.test(line)) && events.some((event) => /Greece/.test(event.text) && /Inca/.test(event.text)), events.map((event) => event.text).join(" | "));
    check("W25 the city-states' peaces are one line per power", events.filter((event) => /^Inca and /.test(event.text) && !/Greece/.test(event.text)).length <= 1, events.map((event) => event.text).join(" | "));
    await stop(host);
  },
  async W26() { // the race view: every road in play, every known power's standing on it, ours first, the shut branches said; no turns to a victory
    const host = await start("run22-t234-greece");
    const race = (await get(`/briefing?civ=Greece`)).json.victory?.race;
    check("W26 every road in play has a line per known power, ours first", ["Scientific", "Cultural", "Domination"].every((road) => race?.[road]?.[0]?.startsWith("us: ") || race?.[road]?.some((line: string) => line.startsWith("us: "))) && race?.Scientific?.length === 6, JSON.stringify(race).slice(0, 200));
    check("W26 the branches shut to us for good are said", race?.Cultural?.some((line: string) => /shut to us for good: .*Piety/.test(line)), JSON.stringify(race?.Cultural));
    check("W26 the original capitals by holder", race?.Domination?.some((line: string) => /^us: 1 of the 6 original capitals - Athens/.test(line)), JSON.stringify(race?.Domination));
    check("W26 no estimate of turns to a victory", !/turns? (to|until|left)/.test(JSON.stringify(race)));
    await stop(host);
  },
  async W27() { // a host going by sea lands out of reach: England's crossing to Munich lost no land unit at sea (every one died embarked, Run 32); once
    // ashore on Munich's landmass a unit walks on - it neither puts to sea again (the pathfinder's hop along the coast) nor holds at its landing for good
    // Munich's landmass, from the fixture's own map: land tiles joined to the city by land (the engine's hex neighbours)
    const map = JSON.parse(gunzipSync(Buffer.from(readFileSync(join(FIXTURES, "run32-t117-munich", "save.unciv"), "utf8"), "base64")).toString("utf8")).tileMap.tileList as any[];
    const land = new Set(map.filter((tile) => !["Ocean", "Coast", "Lakes"].includes(tile.baseTerrain)).map((tile) => `${tile.position?.x ?? 0},${tile.position?.y ?? 0}`));
    const landmass = new Set(["-1,3"]);
    for (const queue = ["-1,3"]; queue.length; ) {
      const [x, y] = queue.pop()!.split(",").map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) { const key = `${x + dx},${y + dy}`; if (land.has(key) && !landmass.has(key)) { landmass.add(key); queue.push(key); } }
    }
    const host = await start("run32-t117-munich");
    // Each land unit's place, turn by turn: where it stood and whether at sea
    const seen = new Map<string, { turn: number; at: string; sea: boolean }[]>();
    for (let i = 0; i < 20 && (await get("/state")).json.turn < 131; i++) {
      for (const line of (await get(`/briefing?civ=England`)).json.units as string[]) {
        const unit = /^(Pikeman|Trebuchet|Longbowman|Catapult|Swordsman|Spearman|Knight|Crossbowman|Longswordsman) (#\d+) at \((-?\d+),(-?\d+)\)/.exec(line);
        if (unit) seen.set(unit[2], [...(seen.get(unit[2]) ?? []), { turn: (await get("/state")).json.turn, at: `${unit[3]},${unit[4]}`, sea: / at sea/.test(line) }]);
      }
      await post("/advance", { turns: 1 });
    }
    // Whose land a tile was on a turn, from that turn's backup: a third realm's borders closing expel a unit to the nearest water - the engine's doing
    // (Japan's open borders with England ended at T125 and put two landed units back to sea), not the landing's
    const ownerOn = (turn: number, at: string) => {
      const game = JSON.parse(gunzipSync(Buffer.from(readFileSync(join(host.dir, "backups", `turn-${String(turn).padStart(4, "0")}`, "save.unciv"), "utf8"), "base64")).toString("utf8"));
      const [x, y] = at.split(",").map(Number);
      return (game.civilizations as any[]).find((civ) => (civ.cities ?? []).some((city: any) => (city.tiles ?? []).some((tile: any) => (tile.x ?? 0) === x && (tile.y ?? 0) === y)))?.civName as string | undefined;
    };
    const backToSea = [...seen.entries()].flatMap(([id, places]) => places.filter((place, index) => index > 0 && place.sea && !places[index - 1].sea && landmass.has(places[index - 1].at))
      .filter((place) => [undefined, "Germany"].includes(ownerOn(place.turn - 1, places[places.indexOf(place) - 1].at))).map((place) => `${id} T${place.turn}`));
    check("W27 a unit ashore on Munich's landmass does not put to sea again", backToSea.length === 0, backToSea.join(", "));
    // Not checked: that a landed unit walks on. Whether one lands on Munich's landmass at all is one course of a chaotic game, which a change to the host's
    // own startup alone has been seen to turn (one unused Regex in RulerHost's init, the notifications pass, 2026-10-05); the two above hold on every course
    const lost = (await logOf("England", 117)).filter((line) => /^Our (Pikeman|Trebuchet|Longbowman|Catapult|Swordsman|Spearman|Knight)[^.]* was lost in action (at the harbour of|in the waters)/.test(line.text));
    check("W27 no land unit of England's host lost at sea", lost.length === 0, lost.map((line) => `T${line.turn} ${line.text.slice(0, 90)}`).join(" | "));
    const strikes = (await logOf("England", 117)).filter((line) => /struck Munich/.test(line.text));
    // At T119-120 only the Triremes reached Munich: their blows are the ships', not a landed host's
    check("W27 ships' strikes are said as the ships'", strikes.some((line) => /^Our ships struck Munich/.test(line.text)) && !strikes.some((line) => line.turn <= 120 && /^Our host struck Munich/.test(line.text)), strikes.map((line) => `T${line.turn} ${line.text.slice(0, 50)}`).join(" | "));
    await stop(host);
  },
  async W28() { // the landings recursed without end and stopped Run 32 at T169; the posture says where the host at sea is bound, and a host holding at sea is said once
    const host = await start("run32-t168-siam");
    const turns: unknown[] = [];
    for (let i = 0; i < 4; i++) turns.push((await post("/advance", { turns: 1 })).json);
    check("W28 four turns from T168 play without a failed turn", turns.every((turn: any) => !turn?.error) && (await get("/state")).json.turn === 172, JSON.stringify(turns.find((turn: any) => turn?.error) ?? {}).slice(0, 200));
    const siam = await logOf("Siam", 168);
    check("W28 no turn failed in Siam's log", !siam.some((line) => /could not be played/.test(line.text)));
    const posture = (await get(`/briefing?civ=Siam`)).json.standingOrders?.posture;
    check("W28 the posture says where the host at sea is bound", Array.isArray(posture?.hostAtSea) && posture.hostAtSea.some((line: string) => /crossing to (its|their) landing at .*, against Hamburg \(at sea since (?:AD \d+|\d+ BC)\)|waiting out of reach off .*, against Hamburg: every shore near it lies under .* \(at sea since (?:AD \d+|\d+ BC)\)|holding at sea out of reach: no shore near Hamburg .* \(at sea since (?:AD \d+|\d+ BC)\)/.test(line)), JSON.stringify(posture?.hostAtSea ?? posture).slice(0, 300));
    const holding = siam.filter((line) => /^Our host holds at sea out of reach: no shore near Hamburg/.test(line.text)).map((line) => line.turn);
    check("W28 a host holding at sea is said when it begins, not every turn", holding.every((turn, index) => index === 0 || turn - holding[index - 1] > 1), holding.join(", "));
    await stop(host);
  },
  async W29() { // the world's news with its facts: a project completed, a golden age with its cause and gifts - to the world once, to the courts in our words
    const host = await start("run21-t300-war", "", undefined, (game) => {
      const civ = (name: string) => game.civilizations.find((c: any) => c.civName === name);
      civ("Denmark").goldenAges.storedHappiness = 1000000; // a golden age next turn, of the people's contentment
      const city = civ("Aztecs").cities.find((c: any) => c.name === "Tenochtitlan");
      city.cityConstructions.constructionQueue = ["Manhattan Project"];
      city.cityConstructions.inProgressConstructions = { ...city.cityConstructions.inProgressConstructions, "Manhattan Project": 100000 };
    });
    await post("/advance", { turns: 1 });
    const events = ((await get("/events?since=300")).json as { text: string }[]).map((event) => event.text);
    check("W29 the world hears the project and what it opens", events.some((text) => /^Aztecs completed the Manhattan Project in Tenochtitlan: the age of atomic arms begins\.$/.test(text)), events.filter((text) => /Manhattan/.test(text)).join(" | "));
    const japan = await logOf("Japan", 300);
    check("W29 another court hears it in our words, not the engine's", japan.some((line) => /completed the Manhattan Project.*: the age of atomic arms begins\.$/.test(line.text)) && !japan.some((line) => /has completed Manhattan Project/.test(line.text)), japan.filter((line) => /Manhattan/.test(line.text)).map((line) => line.text).join(" | "));
    const denmark = await logOf("Denmark", 300);
    check("W29 the golden age is told with its cause, length and gifts", denmark.some((line) => /^We entered a Golden Age, until (?:AD \d+|\d+ BC), born of the people's contentment: a fifth more production and culture in every city/.test(line.text)) && !denmark.some((line) => /entered a Golden Age!$/.test(line.text)), denmark.filter((line) => /Golden Age/.test(line.text)).map((line) => line.text).join(" | "));
    const everyone = (await Promise.all(["Aztecs", "Japan", "Arabia", "Songhai", "Austria", "Denmark"].map((name) => logOf(name, 300)))).flat();
    const twice = (await Promise.all(["Aztecs", "Japan", "Arabia", "Songhai", "Austria", "Denmark"].map(async (name) => {
      const news = (await logOf(name, 300)).filter((line) => /Manhattan|Golden Age/.test(line.text));
      return news.filter((line, index) => news.findIndex((other) => other.text === line.text && other.turn === line.turn) !== index).map((line) => `${name}: ${line.text}`);
    }))).flat();
    check("W29 no court hears this news twice in the turn", twice.length === 0, twice.slice(0, 3).join(" | "));
    await stop(host);
  },
  async W30() { // a war declared on a ruled court: its line says who came in with the attacker and at its own side, and those joins are not told again; a denouncement
    const host = await start("run23-t236-persia");
    await orders("Persia", { mayDeclareWar: true, declareWar: ["Polynesia"] });
    await orders("Iroquois", { denounce: ["Polynesia"] });
    await post("/advance", { turns: 1 });
    const polynesia = await logOf("Polynesia", 236);
    const events = ((await get("/events?since=235")).json as { text: string }[]).map((event) => event.text);
    check("W30 a denouncement: the world once, the denounced in our words", events.filter((text) => text === "Iroquois denounced Polynesia.").length === 1 && polynesia.filter((line) => /denounced us/.test(line.text)).map((line) => line.text).join() === "Iroquois has denounced us.",
      events.filter((text) => /denounce/.test(text)).join(" | ") + " / " + polynesia.filter((line) => /denounce/.test(line.text)).map((line) => line.text).join(" | "));
    const declared = polynesia.find((line) => /^Persia has declared war on us/.test(line.text));
    check("W30 the struck court's line names the war and its minimum", !!declared && /No peace can be made before (?:AD \d+|\d+ BC)\.$/.test(declared.text), declared?.text);
    check("W30 the joins it names are not told again", !polynesia.some((line) => /has joined|have joined/.test(line.text) && declared && line.text.split(" ")[0] && declared.text.includes(line.text.split(" ")[0])), polynesia.filter((line) => /joined/.test(line.text)).map((line) => line.text).join(" | "));
    await stop(host);
  },
  async W31() { // an original capital held by a city-state: the race view names it as one, and the counts hold (Quebec City took Tokyo in Run 32; Kyoto is planted here)
    const host = await start("run32-t189-osaka", "", undefined, (game) => {
      const civ = (name: string) => game.civilizations.find((c: any) => c.civName === name);
      const japan = civ("Japan"), quebec = civ("Quebec City");
      const kyoto = japan.cities.find((c: any) => c.name === "Kyoto");
      japan.cities = japan.cities.filter((c: any) => c !== kyoto);
      quebec.cities.push(kyoto);
    });
    const race = (await get(`/briefing?civ=England`)).json.victory?.race?.Domination as string[] | undefined;
    check("W31 the city-state holding a capital is named as one", !!race?.some((line) => /^the city-state of Quebec City: 1 of the 4 original capitals - Kyoto \(Japan's\)/.test(line)), JSON.stringify(race));
    check("W31 the counts hold: four capitals, each told once", (race ?? []).flatMap((line) => line.replace(/^.*?original capitals - /, "").split(/, | and /)).filter((part) => /^(London|Kyoto|Berlin|Sukhothai)/.test(part)).length === 4, JSON.stringify(race));
    await stop(host);
  },
  async W32() { // a soldier ashore at war does not embark within an enemy warship's reach, whatever routine moves it (Run 32: seven sunk off their own coasts)
    // Japan's Frigate stands at (3,12), off York; two English Pikemen on the coast are sent across the water past it
    const host = await start("run32-t189-osaka");
    await orders("England", { units: [{ unit: 275, action: "move", x: 4, y: 10 }, { unit: 291, action: "move", x: 4, y: 10 }] });
    await post("/advance", { turns: 1 });
    const units = (await get(`/briefing?civ=England`)).json.units as string[];
    const sent = units.filter((line) => /^Pikeman #(275|291) /.test(line));
    check("W32 neither soldier put to sea within the Frigate's reach", sent.length === 2 && sent.every((line) => !/ at sea/.test(line)), sent.join(" | "));
    await stop(host);
  },
  async W33() { // no shore out of reach off Osaka: the host waits out of reach off the least perilous shore, said once, and the posture says under whose guns and what would open a landing
    const host = await start("run32-t189-osaka");
    await orders("England", { posture: { warAim: "Osaka", stance: "attack", reserve: 3 } });
    for (let i = 0; i < 3; i++) await post("/advance", { turns: 1 });
    const england = await logOf("England", 189);
    const waits = england.filter((line) => /^Our host waits out of reach off .+: no shore near Osaka lies out of reach of .+, and it will not land under them\. Ships to clear that shore, or a weaker aim, would open a landing\.$/.test(line.text)).map((line) => line.turn);
    check("W33 the wait is said when it begins, not every turn", waits.length >= 1 && waits.every((turn, index) => index === 0 || turn - waits[index - 1] > 1), waits.join(", "));
    const posture = (await get(`/briefing?civ=England`)).json.standingOrders?.posture;
    check("W33 the posture says where it waits, under whose guns, and what would open a landing", Array.isArray(posture?.hostAtSea) && posture.hostAtSea.some((line: string) => /waiting out of reach off .+, against Osaka: every shore near it lies under .+ - ships to clear that shore, or a weaker aim, would open a landing/.test(line)), JSON.stringify(posture?.hostAtSea ?? posture).slice(0, 300));
    check("W33 no article inside a possessive (\"Japan's a Frigate\")", !JSON.stringify(posture?.hostAtSea ?? []).includes("'s a ") && !england.some((line) => /'s an? [A-Z]/.test(line.text) && /waits/.test(line.text)));
    await stop(host);
  },
  async W34() { // a ruler's order the embark rule closes is refused in words that say why, naming whose reach it is
    // Two more Japanese Frigates are put off England's coasts, so every way across the water to Japan's island starts within some ship's reach
    const host = await start("run32-t189-osaka", "", undefined, (game) => {
      const tile = (x: number, y: number) => game.tileMap.tileList.find((t: any) => (t.position?.x ?? 0) === x && (t.position?.y ?? 0) === y);
      for (const [x, y] of [[-4, 4], [1, 12]]) {
        game.lastUnitId += 1;
        tile(x, y).militaryUnit = { owner: "Japan", originalOwner: "Japan", name: "Frigate", id: game.lastUnitId, currentMovement: 0 };
      }
    });
    const reply = await orders("England", { units: [{ unit: 275, action: "move", x: 4, y: 10 }] });
    const refusal = JSON.stringify(reply.json.failed ?? []);
    check("W34 the order is refused for the reason, the reach named", /cannot reach .*: it would have to put to sea within reach of Japan's .*Frigate/.test(refusal), refusal.slice(0, 300) + " / " + JSON.stringify(reply.json.done ?? []).slice(0, 200));
    await stop(host);
  },
  async W35() { // a defending host does not sit at sea: no soldier stays embarked on one water tile three turns running (England's off York stayed for good, Run 32)
    const host = await start("run32-t189-osaka"); // the court had just set defend
    const seen = new Map<string, string[]>();
    for (let i = 0; i < 7; i++) {
      for (const line of (await get(`/briefing?civ=England`)).json.units as string[]) {
        const unit = /^([A-Z][\w' ]+?) (#\d+) at \((-?\d+),(-?\d+)\)/.exec(line);
        if (unit && / at sea/.test(line) && !/Great|Work|Caravel|Frigate|Galleass|Trireme|Ship|Privateer|Ironclad/.test(unit[1])) seen.set(unit[2], [...(seen.get(unit[2]) ?? []), `${i}:${unit[3]},${unit[4]}`]);
      }
      await post("/advance", { turns: 1 });
    }
    const stuck = [...seen.entries()].filter(([, places]) => places.some((place, index) => {
      const [turn, at] = place.split(":");
      return [1, 2].every((k) => places.includes(`${Number(turn) + k}:${at}`));
    })).map(([id, places]) => `${id} ${places.join(" ")}`);
    check("W35 no soldier sits embarked on one water tile three turns running under defend", stuck.length === 0, stuck.join(" | "));
    await stop(host);
  },
  async W36() { // an accepted peace holds: Japan's one-sided offer (sent with the trade order) is signed on both sides, the gold comes our way, and the court is told only what is so
    const host = await start("run32-t216-peace");
    const status = async () => ((await get(`/briefing?civ=England`)).json.knownCivs as any[]).find((known) => known.civ === "Japan")?.status;
    const gold = async () => (await get(`/briefing?civ=England`)).json.gold as number;
    const before = await gold();
    const reply = await orders("England", { peace: ["Japan"] });
    check("W36 the peace order is answered as made", JSON.stringify(reply.json.done ?? []).includes("Peace made with Japan"), JSON.stringify(reply.json).slice(0, 300));
    check("W36 England and Japan are at peace once it is accepted", (await status()) === "peace", `${await status()}`);
    check("W36 Japan's 150 gold came to England", (await gold()) - before === 150, `${before} -> ${await gold()}`);
    await post("/advance", { turns: 1 });
    check("W36 the world hears the peace", ((await get("/events?since=216")).json as { text: string }[]).some((event) => event.text === "England and Japan have made peace."));
    check("W36 still at peace after the turn", (await status()) === "peace", `${await status()}`);
    await stop(host);
  },
  async W37() { // a sovereign's proclamation is speech to the world: a public event at once, heard in every other court's log, not in the speaker's own
    const host = await start("run21-t300-war");
    const said = await post(`/proclaim?civ=Aztecs`, { words: "The sun does not set on the Mexica.", by: "Itzcoatl, the Speaker" });
    check("W37 the host takes it", said.status === 200, JSON.stringify(said.json));
    const events = ((await get("/events?since=300")).json as { text: string }[]).map((event) => event.text);
    check("W37 the world hears it at once", events.includes("Itzcoatl, the Speaker, sovereign of Aztecs, proclaimed: \u201cThe sun does not set on the Mexica.\u201d"), events.slice(-3).join(" | "));
    check("W37 another court hears it in its log", (await logOf("Japan", 300)).some((line) => line.text === "Proclaimed by Aztecs' sovereign, Itzcoatl, the Speaker: \u201cThe sun does not set on the Mexica.\u201d"));
    check("W37 the speaker's own log does not repeat it", !(await logOf("Aztecs", 300)).some((line) => /Proclaimed by/.test(line.text)));
    // The sovereign's own tool posts it, at once, and speaks once an age
    process.env.RULER_HOST_URL = BASE;
    const { callRealmTool } = await import("../src/agents.ts");
    const schema = (await get("/schema")).json;
    const seat = { civ: "Japan", kind: "agent", character: { name: "Ieyasu", title: "the Shogun" }, journal: [] } as any;
    const first = await callRealmTool(seat, { sideTools: ["proclaim"] } as any, schema, "proclaim", { words: "Japan keeps its word." });
    const again = await callRealmTool(seat, { sideTools: ["proclaim"] } as any, schema, "proclaim", { words: "And keeps it twice." });
    const after = ((await get("/events?since=300")).json as { text: string }[]).map((event) => event.text);
    check("W37 the sovereign's proclaim tool posts it as a public event", /heralds have it/.test(first) && after.includes("Ieyasu, the Shogun, sovereign of Japan, proclaimed: \u201cJapan keeps its word.\u201d"), first + " / " + after.slice(-2).join(" | "));
    check("W37 once an age: the second is not posted", /spoken once this age/.test(again) && !after.some((text) => /keeps it twice/.test(text)), again);
    await stop(host);
  },
  async W38() { // a ruled civ's warship does not end its turn under the shore's guns unless it strikes (five English ships died at Osaka's and Munich's shores, Run 32)
    // An English Frigate is put in Osaka's harbour, full of movement: it may strike from out of reach, or from there only if it can move on after; it must
    // not end the turn within Osaka's guns
    const host = await start("run32-t189-osaka", "", undefined, (game) => {
      const tile = game.tileMap.tileList.find((t: any) => (t.position?.x ?? 0) === 2 && (t.position?.y ?? 0) === 13);
      game.lastUnitId += 1;
      tile.militaryUnit = { owner: "England", originalOwner: "England", name: "Frigate", id: game.lastUnitId, currentMovement: 5 };
      // Osaka's walls broken: the strike the automation reaches for, which left ships under the guns in the league
      game.civilizations.find((c: any) => c.civName === "Japan").cities.find((c: any) => c.name === "Osaka").health = 40;
    });
    const id = (await get(`/briefing?civ=England`)).json.units.find((line: string) => /^Frigate #\d+ at \(2,13\)/.test(line))?.match(/#(\d+)/)?.[1];
    await orders("England", { posture: { warAim: "Osaka", stance: "attack", reserve: 3 } }); // the court had set defend: the fleet goes home under it
    await post("/advance", { turns: 1 });
    const line = ((await get(`/briefing?civ=England`)).json.units as string[]).find((unit) => unit.startsWith(`Frigate #${id} `));
    const at = line && /at \((-?\d+),(-?\d+)\)/.exec(line);
    const hex = (x: number, y: number) => { const dx = x - 2, dy = y - 14; return Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dx - dy)); };
    check("W38 the Frigate is not left within Osaka's guns", !!id && (!line || (!!at && hex(Number(at[1]), Number(at[2])) > 2)), line ?? `#${id} gone`);
    await stop(host);
  },
  async W39() { // a round of peace is one line per great power, each peace told once, and city-states at peace with one another are no news (Run 32, T245: thirteen lines)
    const host = await start("run23-t236-persia");
    await orders("Persia", { mayDeclareWar: true, declareWar: ["Polynesia"] });
    for (let i = 0; i < 15 && (await get("/state")).json.turn < 247; i++) await post("/advance", { turns: 247 - (await get("/state")).json.turn });
    await orders("Persia", { peace: ["Polynesia"] });
    await orders("Polynesia", { peace: ["Persia"] });
    await post("/advance", { turns: 1 });
    const majors = new Set(((await get("/state")).json.majorCivs as { civ: string }[]).map((civ) => civ.civ));
    const peace = ((await get("/events?since=246")).json as { text: string }[]).map((event) => event.text).filter((text) => /made peace/.test(text));
    const subjects = peace.map((text) => /^(.+?)( and | made peace)/.exec(text)?.[1] ?? text);
    check("W39 the peace round is told", peace.some((text) => /Persia/.test(text) && /Polynesia/.test(text)), peace.join(" | "));
    check("W39 one line per great power: none named in two", [...majors].every((power) => peace.filter((text) => text.includes(power)).length <= 1) && subjects.every((subject) => majors.has(subject)), peace.join(" | "));
    check("W39 no city-state-with-city-state peace", !peace.some((text) => { const m = /^(.+?) and (.+?) have made peace\.$/.exec(text); return !!m && !majors.has(m[1]) && !majors.has(m[2]); }), peace.join(" | "));
    await stop(host);
  },
  async W40() { // a call's dollars from its tokens and the price table (prices.ts), against figures worked by hand; no host. The SDK priced Sonnet 5.5 ~2x and Haiku 5.5 ~40x
    const { priceUsd, priceSdkCall, codexTokens, sdkTokens } = await import("../src/prices.ts");
    const near = (got: number | null, want: number) => got !== null && Math.abs(got - want) < 1e-9;
    const block = { input: 1_000, cacheWrite5m: 2_000, cacheWrite1h: 10_000, cacheRead: 50_000, output: 3_000 };
    // 1,000 x $4 + 2,000 x $5 + 10,000 x $8 + 50,000 x $0.20 + 3,000 x $20, per million
    check("W40 Opus 5.5: $0.164", near(priceUsd("claude-opus-5-5", [block]), 0.164), String(priceUsd("claude-opus-5-5", [block])));
    // x $2, $2.50, $4, $0.10, $10
    check("W40 Sonnet 5.5: $0.082", near(priceUsd("claude-sonnet-5-5", [block]), 0.082), String(priceUsd("claude-sonnet-5-5", [block])));
    // a 63,000-token prompt: x $0.10, $0.125, $0.20, $0.01, $0.50
    check("W40 Haiku 5.5 under 100k: $0.00435", near(priceUsd("claude-haiku-5-5", [block]), 0.00435), String(priceUsd("claude-haiku-5-5", [block])));
    // a 106,000-token prompt: 1,000 x $0.50 + 10,000 x $1 + 95,000 x $0.05 + 3,000 x $2.50
    const long = { input: 1_000, cacheWrite5m: 0, cacheWrite1h: 10_000, cacheRead: 95_000, output: 3_000 };
    check("W40 Haiku 5.5 over 100k: $0.02275", near(priceUsd("claude-haiku-5-5", [long]), 0.02275), String(priceUsd("claude-haiku-5-5", [long])));
    // The tier is each request's own prompt: two 60,000-token requests stay under it (2 x $0.0034), one of 120,000 is over it ($0.034), and tokens
    // known only as a sum never reach it
    const half = { input: 1_000, cacheWrite5m: 0, cacheWrite1h: 9_000, cacheRead: 50_000, output: 2_000 };
    const whole = { input: 2_000, cacheWrite5m: 0, cacheWrite1h: 18_000, cacheRead: 100_000, output: 4_000 };
    check("W40 Haiku 5.5: the tier is per request", near(priceUsd("claude-haiku-5-5", [half, half]), 0.0068) && near(priceUsd("claude-haiku-5-5", [whole]), 0.034) && near(priceUsd("claude-haiku-5-5", [], whole), 0.0068),
      `${priceUsd("claude-haiku-5-5", [half, half])} / ${priceUsd("claude-haiku-5-5", [whole])} / ${priceUsd("claude-haiku-5-5", [], whole)}`);
    // A Codex turn as its usage event gives it: input 400,000 with 350,000 cached, output 20,000 with 8,000 of it reasoning (inside output_tokens);
    // 50,000 x $2 + 350,000 x $0.10 + 20,000 x $10 - the short-context rates, as a turn is a sum of requests
    const sol = priceUsd("gpt-6.1-sol", [], codexTokens({ inputTokens: 400_000, cachedInputTokens: 350_000, cacheWriteTokens: 0, outputTokens: 20_000 }));
    check("W40 gpt-6.1-sol, API-equivalent: $0.335", near(sol, 0.335), String(sol));
    // An unknown model: null, and said once however often it is priced
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
    try {
      const unknown = [priceUsd("claude-regress-9", [block]), priceUsd("claude-regress-9", [block])];
      check("W40 a model not in the table prices as null, said once", unknown.every((each) => each === null) && warnings.filter((line) => /claude-regress-9/.test(line)).length === 1, warnings.join(" | "));
      // A whole SDK call as Agent SDK 0.3.280 gave it (a Haiku 5.5 tool loop of four requests, 2026-10-07): the requests from the stream's events, the
      // SDK's side call on Haiku 4.5 from modelUsage. 8 x $0.10 + 223 x $0.20 + 14,784 x $0.01 + 151 x $0.50 = $0.00026874; 911 x $1 + 12 x $5 = $0.000971
      const usage = (input: number, write1h: number, read: number, output: number) =>
        sdkTokens({ input_tokens: input, cache_creation_input_tokens: write1h, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write1h }, output_tokens: output });
      const requests = [usage(2, 0, 3631, 69), usage(2, 99, 3631, 32), usage(2, 62, 3730, 32), usage(2, 62, 3792, 18)].map((tokens) => ({ model: "claude-haiku-5-5", tokens }));
      const result = { input_tokens: 8, cache_creation_input_tokens: 223, cache_read_input_tokens: 14784, output_tokens: 151, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 223 } };
      const modelUsage = {
        "claude-haiku-4-5-20251001": { inputTokens: 911, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.000971, costBasis: "list" },
        // The SDK's own figure at Opus 5.5 rates, its basis "unknown": 8 x $4 + 223 x $8 + 14,784 x $0.20 + 151 x $20
        "claude-haiku-5-5": { inputTokens: 8, outputTokens: 151, cacheReadInputTokens: 14784, cacheCreationInputTokens: 223, costUSD: 0.0077928, costBasis: "unknown" },
      };
      const call = priceSdkCall(requests, result, modelUsage);
      check("W40 an SDK call: each request priced, the side call too: $0.00123974", near(call, 0.00123974), String(call));
      // A request whose events were missed is still counted, from modelUsage's totals, its writes at the lifetime the result gives
      const missed = priceSdkCall(requests.slice(0, 3), result, modelUsage);
      check("W40 a request missing from the events is priced from the totals", near(missed, 0.00123974), String(missed));
      priceSdkCall(requests, result, modelUsage);
      check("W40 the SDK's guess at Haiku 5.5 is said once, the right Haiku 4.5 figure not at all",
        warnings.filter((line) => /claude-haiku-5-5: the SDK says/.test(line)).length === 1 && !warnings.some((line) => /claude-haiku-4-5/.test(line)), warnings.join(" | "));
    } finally {
      console.warn = warn;
    }
  },
  async W41() { // Run 36 at T310: the mood's parts below zero only; "its own" Apollo; "knows X: yes/no"; the victory in every court's log; the officials sell no building
    const courts = ["Iroquois", "India", "England", "Persia", "Siam", "Egypt", "Russia", "The Maya", "Carthage", "The Ottomans", "Austria", "Greece"];
    const hydro = ["India", "Egypt", "The Ottomans", "Austria"];
    const host = await start("run36-t310", "", undefined, (game) => {
      const civ = (name: string) => game.civilizations.find((c: any) => c.civName === name);
      // Siam's own Apollo Program and Egypt's last part (its Engine) both finish this turn: the world hears the one, every court the end
      const satchanalai = civ("Siam").cities.find((c: any) => c.name === "Si Satchanalai").cityConstructions;
      satchanalai.inProgressConstructions = { ...satchanalai.inProgressConstructions, "Apollo Program": 100000 };
      const thebes = civ("Egypt").cities.find((c: any) => c.name === "Thebes").cityConstructions;
      thebes.inProgressConstructions = { ...thebes.inProgressConstructions, "SS Engine": 100000 };
      // A Hydro Plant in every city of four powers with their Apollo Program: their Aluminum runs short, and the engine's officials sell one to free it
      for (const name of hydro) for (const city of civ(name).cities) if (!city.cityConstructions.builtBuildings.includes("Hydro Plant")) city.cityConstructions.builtBuildings.push("Hydro Plant");
    });
    const briefings = Object.fromEntries(await Promise.all(courts.map(async (name) => [name, (await get(`/briefing?civ=${civ(name)}`)).json])));
    // The mood block (2026-11-08): at every sign, its parts summing to the figure exactly; below zero the warning is its first sentence, the rest in the block
    const parts = new Set(["base", "cities", "citizens", "luxuries", "buildings", "policies", "faith", "cityStates", "naturalWonders", "other"]);
    const moods = courts.map((name) => ({ name, happiness: briefings[name].happiness as number, mood: briefings[name].mood as Record<string, any> | undefined }));
    check("W41 the mood block at every sign, happinessBreakdown gone", moods.some((m) => m.happiness < 0) && moods.some((m) => m.happiness > 2) && moods.every((m) => !!m.mood && briefings[m.name].happinessBreakdown === undefined),
      moods.map((m) => `${m.name} ${m.happiness} ${m.mood ? "mood" : "-"}`).join(", "));
    const sums = moods.map((m) => ({ ...m, sum: Object.values(m.mood!.parts as Record<string, number>).reduce((a, b) => a + b, 0) }));
    check("W41 the parts are the kinds and sum to the mood exactly", sums.every((m) => Object.keys(m.mood!.parts).every((key) => parts.has(key)) && m.sum === m.happiness), sums.map((m) => `${m.name} ${m.happiness} = ${m.sum} ${JSON.stringify(m.mood!.parts)}`).join(" | "));
    const unhappy = moods.filter((m) => m.happiness < 0).map((m) => (briefings[m.name].warnings as string[]).find((w) => /people are unhappy/.test(w)) ?? "");
    check("W41 below zero the warning is its first sentence alone", unhappy.length > 0 && unhappy.every((w) => /^The people are unhappy \(-\d+\): (every city's growth is cut by three quarters|no city grows at all) while the mood is below zero, and production suffers - farming for food does little until the mood is mended\.$/.test(w)), unhappy.map((w) => w.slice(0, 200)).join(" | "));
    // The rivals' ships are the race view's lines since 2026-10-10 (spaceship.others said the same, and is gone)
    const others = courts.flatMap((name) => ((briefings[name].victory?.race?.Scientific ?? []) as string[]).filter((line) => !line.startsWith("us: ")));
    check("W41 the rivals' ships name the learning each lacks, never 'not yet known to them'", others.some((line) => /it has yet to learn [^;]+ \(for the SS [A-Za-z ]+\)/.test(line)) && !others.some((line) => /known to them/.test(line)) &&
      courts.every((name) => briefings[name].spaceship?.others === undefined), others.slice(0, 2).join(" | "));
    check("W41 a rival's Apollo Program is its own", others.some((line) => /its own Apollo Program/.test(line)) && courts.every((name) => !briefings[name].spaceship?.note || /^Each power builds its own Apollo Program before its parts/.test(briefings[name].spaceship.note)));
    const before = readFileSync(join(host.dir, "save.unciv"), "utf8");
    await post("/advance", { turns: 1 });
    const events = ((await get("/events?since=309")).json as { text: string }[]).map((event) => event.text);
    check("W41 the world hears Siam's Apollo Program as its own", events.some((text) => /^Siam completed its own Apollo Program in Si Satchanalai: its race for the stars begins\.$/.test(text)), events.filter((text) => /Apollo/.test(text)).join(" | "));
    check("W41 another court hears it as Siam's own", (await logOf("Persia", 309)).some((line) => /^Siam completed its own Apollo Program in Si Satchanalai: its race for the stars begins\.$/.test(line.text)));
    const winner = (await get("/state")).json.winner as string | undefined;
    const told = await Promise.all(courts.map(async (name) => ({ name, lines: (await logOf(name, 309)).filter((line) => /won a Scientific victory/.test(line.text)) })));
    check("W41 the victory is in every court's own log, once", winner === "Egypt" && told.every((court) => court.lines.length === 1 && (court.name === "Egypt" ? /^We have won a Scientific victory: the spaceship is complete and has launched\. The game is over\.$/ : /^Egypt has won a Scientific victory: its spaceship is complete and has launched\. The game is over\.$/).test(court.lines[0].text)),
      `${winner}; ` + told.filter((court) => court.lines.length !== 1).map((court) => `${court.name}: ${court.lines.length}`).join(", ") + " " + (told[5]?.lines[0]?.text ?? ""));
    const hydroCount = (saved: string) => { const game = JSON.parse(gunzipSync(Buffer.from(saved, "base64")).toString("utf8"));
      return hydro.map((name) => game.civilizations.find((c: any) => c.civName === name).cities.filter((c: any) => c.cityConstructions.builtBuildings.includes("Hydro Plant")).length).join(","); };
    const sold = (await Promise.all(hydro.map((name) => logOf(name, 309)))).flat().filter((line) => /sold the/.test(line.text));
    check("W41 the officials sell no building, Aluminum short or not", hydroCount(before) === hydroCount(readFileSync(join(host.dir, "save.unciv"), "utf8")) && sold.length === 0, `${hydroCount(before)} -> ${hydroCount(readFileSync(join(host.dir, "save.unciv"), "utf8"))}; ${sold.map((line) => line.text).join(" | ")}`);
    await stop(host);
  },
  async W42() { // Run 36 at T300: settlers with no site come ashore on our land and stay; the renewals ordered in a turn are one line; a refused proposal is told once
    const host = await start("run36-t300");
    // The renewals Siam has not yet ordered, ordered at once: one line for them all
    const ending = ((await get(`/briefing?civ=Siam`)).json.dealsLedger?.endingSoon ?? []) as string[];
    const renew = ending.filter((line) => /order renew/.test(line)).map((line) => ({ power: line.slice(0, line.indexOf(": ")), terms: line.slice(line.indexOf(": ") + 2, line.indexOf(" - ")) }));
    await orders("Siam", { renew });
    const renewLines = (await logOf("Siam", 299)).filter((line) => /to be offered again, on the same terms/.test(line.text));
    check("W42 the renewals ordered in a turn are told in one line", renew.length >= 2 && renewLines.length === 1 && new RegExp(`^By your order: ${renew.length} deals are to be offered again`).test(renewLines[0].text), `${renew.length} ordered; ${renewLines.length} lines: ${renewLines[0]?.text.slice(0, 160)}`);
    const settlers = { Greece: [737], Persia: [633, 639], "The Maya": [654, 661] } as Record<string, number[]>;
    const where: Record<string, string[]> = {};
    for (let turn = 0; turn < 8; turn++) {
      for (const [name, ids] of Object.entries(settlers)) {
        const warnings = (await get(`/briefing?civ=${civ(name)}`)).json.warnings as string[];
        for (const id of ids) (where[`${name} #${id}`] ??= []).push(warnings.find((w) => w.startsWith(`Settler #${id} `))?.match(/It (waits|stands)/)?.[1] ?? "gone or ordered");
      }
      await post("/advance", { turns: 1 });
    }
    const back = Object.entries(where).filter(([, seen]) => seen.includes("waits") && seen.slice(seen.indexOf("waits")).includes("stands"));
    check("W42 a settler with no site, once ashore, never goes back to sea", back.length === 0, back.map(([unit, seen]) => `${unit}: ${seen.join(" ")}`).join(" | "));
    check("W42 the settlers near home are ashore within eight turns", ["Greece #737", "The Maya #661", "The Maya #654"].every((unit) => where[unit]?.at(-1) === "waits"), Object.entries(where).map(([unit, seen]) => `${unit}: ${seen.join(" ")}`).join(" | "));
    const ashoreLines = (await Promise.all(Object.keys(settlers).map((name) => logOf(name, 299)))).flat().filter((line) => /comes ashore/.test(line.text));
    const told = ashoreLines.map((line) => /#(\d+)/.exec(line.text)?.[1]);
    check("W42 coming ashore is told once a settler", told.length >= 3 && new Set(told).size === told.length, ashoreLines.map((line) => line.text).slice(0, 3).join(" | "));
    // The officials' refused proposals: terms refused once by a power are not told as proposed or refused again
    const courts = ["Iroquois", "India", "England", "Persia", "Siam", "Egypt", "Russia", "The Maya", "Carthage", "The Ottomans", "Austria", "Greece"];
    const repeats = (await Promise.all(courts.map(async (name) => {
      const lines = (await logOf(name, 299)).map((line) => line.text);
      const refused = lines.map((text) => /^The officials' proposal to (.+?) \((.+)\) was refused/.exec(text)).filter(Boolean).map((m) => `${m![1]}: ${m![2]}`);
      return refused.filter((key, index) => refused.indexOf(key) !== index).map((key) => `${name} -> ${key}`);
    }))).flat();
    check("W42 a refused proposal of the officials is told refused once", repeats.length === 0, repeats.slice(0, 3).join(" | "));
    const perTurn = (await Promise.all(courts.map(async (name) => {
      const counts = new Map<string, number>();
      for (const line of await logOf(name, 299)) if (/ended and (was|were each) offered again/.test(line.text)) counts.set(`${name} T${line.turn}`, (counts.get(`${name} T${line.turn}`) ?? 0) + 1);
      return [...counts].filter(([, n]) => n > 1).map(([key, n]) => `${key}: ${n}`);
    }))).flat();
    check("W42 the renewals sent in a turn are one line", perTurn.length === 0, perTurn.slice(0, 3).join(" | "));
    await stop(host);
  },
  async W43() { // the order ledger (standingOrders.awaiting, .sinceLastLookIn): what waits on an outcome and what became of the orders, in the log's words, not twice
    const host = await start("run36-t300");
    const given = await orders("Greece", { queue: [{ city: "Sparta", items: ["Nuclear Plant", "Science"] }, { city: "Corinth", items: ["Flying Carpet Factory"] }],
      trade: [{ with: "Siam", give: [{ item: "Gold", amount: 30 }] }], units: [{ unit: 737, action: "move", x: 20, y: 11 }] });
    await post("/advance", { turns: 1 });
    const briefing = (await get(`/briefing?civ=Greece&since=299`)).json;
    const ledger = briefing.standingOrders ?? {};
    const awaiting = (ledger.awaiting ?? []) as string[];
    const since = (ledger.sinceLastLookIn ?? {}) as Record<string, string[]>;
    check("W43 awaiting: the proposal and who answers it", awaiting.some((line) => /^Our proposal to Siam \(we give Gold x30; they give nothing\): Siam is an advised court/.test(line)), awaiting.join(" | "));
    check("W43 awaiting: a march under way, whither and since when", awaiting.some((line) => /^Settler #737 is on its way to .+, marching since (?:AD \d+|\d+ BC)/.test(line)) || briefing.units.some((unit: string) => /^Settler #737 .* in Athens/.test(unit)), awaiting.join(" | "));
    check("W43 awaiting: an item waiting for its tech, with why", awaiting.some((line) => /^Nuclear Plant waits in Sparta's queue: it needs Nuclear Fission/.test(line)));
    check("W43 awaiting: the renewals set to go out", awaiting.some((line) => /is to be offered again when it ends\.$/.test(line)));
    check("W43 refused: what set_orders turned back, with its year", (given.json.failed as string[]).length === 1 && (since.refused ?? []).some((line) => /^(?:AD \d+|\d+ BC): Unknown building or unit Flying Carpet Factory/.test(line)), JSON.stringify(since.refused));
    check("W43 carried out: the order's own line", (since.carriedOut ?? []).some((line) => /^(?:AD \d+|\d+ BC): By your order: Sparta's queue is now Science/.test(line)), JSON.stringify(since.carriedOut));
    const all = [...awaiting, ...Object.values(since).flat()];
    check("W43 the ledger's lines are not in the log a second time", !(briefing.log as string[]).some((line) => all.includes(line)));
    check("W43 no unit number in prose: units by name and #id only", !all.some((line) => /\b(unit|number|no\.) ?#?\d+/i.test(line)), all.find((line) => /\b(unit|number|no\.) ?#?\d+/i.test(line)));
    // A later briefing with no window of its own reaches back one look-in only
    await post("/advance", { turns: 6 });
    const later = (await get(`/briefing?civ=Greece`)).json.standingOrders?.sinceLastLookIn?.refused ?? [];
    check("W43 the since list is capped at the look-in window", !later.some((line: string) => /^T301:/.test(line)), JSON.stringify(later));
    await stop(host);
  },
  async W44() { // the race view says what is under way (2026-10-10): a rival's line carries what it lacks, its last step and how long ago, what is under way and where;
    // a part added, a branch of policy completed and the United Nations built are public events the courts that know the power hear; no turns to come, ever
    const host = await start("run36-t300", "", undefined, (game) => {
      const civ = (name: string) => game.civilizations.find((c: any) => c.civName === name);
      const city = (power: string, name: string) => civ(power).cities.find((c: any) => c.name === name).cityConstructions;
      // Persia's Booster in its capital finishes this turn, to be added to its ship
      const persepolis = city("Persia", "Persepolis");
      persepolis.inProgressConstructions = { ...persepolis.inProgressConstructions, "SS Booster": 100000 };
      // Siam is one policy short of Tradition again, with the culture to adopt it and the order to
      const siam = civ("Siam").policies;
      siam.adoptedPolicies = siam.adoptedPolicies.filter((p: string) => p !== "Monarchy" && p !== "Tradition Complete");
      siam.numberOfAdoptedPolicies -= 1;
      siam.storedCulture = 0;
      // Egypt builds the United Nations this turn; Austria has it under way in Vienna
      for (const name of ["Egypt", "Austria"]) civ(name).tech.techsResearched.push("Globalization");
      const thebes = city("Egypt", "Thebes");
      thebes.constructionQueue = ["United Nations", ...thebes.constructionQueue];
      thebes.inProgressConstructions = { ...thebes.inProgressConstructions, "United Nations": 100000 };
      const vienna = city("Austria", "Vienna");
      vienna.constructionQueue = ["United Nations", ...vienna.constructionQueue];
    });
    // Culture for that one policy and no more, so the step is the order's: read from the briefing, planted on a restart
    const needed = (await get(`/briefing?civ=Siam`)).json.culture?.neededForNextPolicy as number;
    await stop(host);
    const again = await start("run36-t300", "", host.dir, (game) => { game.civilizations.find((c: any) => c.civName === "Siam").policies.storedCulture = needed; });
    const race = async (name: string) => (await get(`/briefing?civ=${civ(name)}`)).json.victory?.race as Record<string, string[]>;
    const lineOf = (view: Record<string, string[]>, road: string, power: string) => view?.[road]?.find((line) => line.startsWith(`${power}: `)) ?? "";
    const before = await race("Egypt");
    check("W44 a rival's parts still to add and the learning it lacks for them", /^India: 4 of 6 spaceship parts; still to add to its ship: an SS Engine and an SS Stasis Chamber; it has yet to learn Particle Physics \(for the SS Engine\) and Nanotechnology \(for the SS Stasis Chamber\)/.test(lineOf(before, "Scientific", "India")), lineOf(before, "Scientific", "India"));
    check("W44 parts under way, and where", /; SS Boosters are under way in Persepolis, Susa and Tarsus$/.test(lineOf(before, "Scientific", "Persia")), lineOf(before, "Scientific", "Persia"));
    check("W44 the last step and how long ago, from the events recorded", /; it completed its own Apollo Program in (?:AD \d+|\d+ BC), (?:a year|\d+ years) ago;/.test(lineOf(before, "Scientific", "Persia")));
    check("W44 a rival's own Apollo Program under way", /; its own Apollo Program is under way in Utique$/.test(lineOf(before, "Scientific", "Carthage")), lineOf(before, "Scientific", "Carthage"));
    // Egypt's five parts were added before the parts were told: no older step stands in for the last one
    check("W44 no last step the standing does not match", !/ ago|this turn|last turn/.test(lineOf(await race("Persia"), "Scientific", "Egypt")), lineOf(await race("Persia"), "Scientific", "Egypt"));
    check("W44 the branches still to complete", /^India: 4 of 5 branches of policy complete; 1 more branch of policy to complete, then the Utopia Project$/.test(lineOf(before, "Cultural", "India")), lineOf(before, "Cultural", "India"));
    check("W44 the United Nations under way before it stands", (before.Diplomatic ?? []).includes("Austria: the United Nations is under way in Vienna"), JSON.stringify(before.Diplomatic));
    await orders("Siam", { policyBranches: ["Tradition"] });
    await post("/advance", { turns: 1 });
    const events = ((await get("/events?since=300")).json as { text: string }[]).map((event) => event.text);
    const un = events.find((text) => /^Egypt completed the wonder United Nations in Thebes/.test(text)) ?? "";
    check("W44 the United Nations built: the wonder's line says the vote it brings", /: the vote for world leader begins\.$/.test(un), un);
    const branch = "Siam completed the branch of policy Tradition: 3 of the 5 a cultural victory asks.";
    check("W44 a branch of policy completed is a public event", events.includes(branch), events.filter((text) => /^Siam/.test(text)).join(" | "));
    check("W44 a court that knows the power hears it, its own court as ours", (await logOf("Egypt", 300)).some((line) => line.text === branch) && (await logOf("Siam", 300)).some((line) => line.text === "We completed the branch of policy Tradition: 3 of the 5 a cultural victory asks."));
    const after = await race("Egypt");
    check("W44 the step's age in the race line", /; it completed the branch of policy Tradition this year$/.test(lineOf(after, "Cultural", "Siam")), lineOf(after, "Cultural", "Siam"));
    check("W44 the holder of the United Nations: votes short and its last step", /^us: \d+ of \d+ votes, in the city-states allied$/.test(lineOf(after, "Diplomatic", "us")) &&
      /^Egypt: \d+ of \d+ votes, in the city-states allied; \d+ votes? short; it completed the United Nations this year$/.test(lineOf(await race("Persia"), "Diplomatic", "Egypt")), lineOf(await race("Persia"), "Diplomatic", "Egypt"));
    await post("/advance", { turns: 2 });
    const added = ((await get("/events?since=300")).json as { text: string }[]).map((event) => event.text).find((text) => /^Persia added /.test(text)) ?? "";
    check("W44 a part added to a spaceship is a public event, with the count", /^Persia added an SS Booster to its spaceship in Persepolis: 1 of 6 parts\.$/.test(added), added);
    check("W44 its own court hears it as ours", (await logOf("Persia", 300)).some((line) => line.text === "We added an SS Booster to our spaceship in Persepolis: 1 of 6 parts."));
    check("W44 the part's step in the race line", /; it added an SS Booster to its spaceship (this year|in (?:AD \d+|\d+ BC), (?:a year|\d+ years) ago)/.test(lineOf(await race("Egypt"), "Scientific", "Persia")), lineOf(await race("Egypt"), "Scientific", "Persia"));
    // Invariants over every court's race view: no turns to come, no stage word, no engine token
    const views = await Promise.all(["Egypt", "Persia", "Siam", "Carthage", "Greece", "Austria"].map(race));
    const text = views.flatMap((view) => Object.values(view ?? {}).flat()).join("\n");
    const banned = /turns? (to|until|left|more)|\bin \d+ turns?|nearly|almost|soon|\[|\d+ turns?\b(?! ago)/;
    check("W44 no turns to come, no stage word, no bracket", !banned.test(text), (text.match(new RegExp(`.{60}(${banned.source}).{20}`)) ?? [""])[0]);
    await stop(again);
  },
  async W45() { // the officials free no resource from a unit the court bought this turn (Carthage's Rocket Artillery, Run 40); a 20th turn's backup is kept for good
    const host = await start("run36-t300");
    // India has 3 Aluminum and none in use: two Rocket Artillery bought leave it one, and the officials free Aluminum for the spaceship below two
    const bought = await orders("India", { purchase: [{ city: "Delhi", item: "Rocket Artillery" }, { city: "Mumbai", item: "Rocket Artillery" }] });
    const ids = ((bought.json.done ?? []) as string[]).map((line) => /Rocket Artillery #(\d+)/.exec(line)?.[1]).filter(Boolean);
    // Backups planted from long ago, T21 to T99: past the rolling dozen once T301 is played, all but every 20th turn's go
    for (let turn = 21; turn <= 99; turn++) mkdirSync(join(host.dir, "backups", `turn-${String(turn).padStart(4, "0")}`), { recursive: true });
    await post("/advance", { turns: 1 });
    const units = (await get(`/briefing?civ=India`)).json.units as string[];
    const freed = (await logOf("India", 300)).filter((line) => line.turn === 301 && /disbanded by the officials to free its Aluminum/.test(line.text));
    check("W45 a unit bought this turn is not disbanded to free its resource", ids.length === 2 && ids.every((id) => units.some((unit) => unit.startsWith(`Rocket Artillery #${id} `))) && freed.length === 0,
      `${ids.join(",")}; ${freed.map((line) => line.text).join(" | ")}`);
    const kept = ["turn-0040", "turn-0060", "turn-0080"].every((name) => existsSync(join(host.dir, "backups", name)));
    const pruned = ["turn-0021", "turn-0041", "turn-0059", "turn-0081"].every((name) => !existsSync(join(host.dir, "backups", name)));
    check("W45 every 20th turn's backup survives the rolling dozen; the others go", kept && pruned && existsSync(join(host.dir, "backups", "turn-0301")));
    await stop(host);
  },
  async W46() { // an acknowledged warning stays folded, first clause, every look-in while its condition stands, whatever its figures and names do
    // (Spain's starvation, Run 42; a weak defender swapped for another as weak brought the line back in full, Runs 20 and 29). Planted on Japan at T100:
    // Tokyo at 30 people with nothing stored starves for turns on end; Kyoto is held by a Scout, later swapped for a Catapult, both weak
    const plantDefender = (name: string) => (game: any) => {
      const kyoto = game.tileMap.tileList.find((tile: any) => (tile.position?.x ?? 0) === 11 && (tile.position?.y ?? 0) === 2);
      game.lastUnitId += 1;
      kyoto.militaryUnit = { owner: "Japan", originalOwner: "Japan", name, id: game.lastUnitId, currentMovement: 2 };
    };
    const host = await start("t100-world", "", undefined, (game) => {
      const tokyo = game.civilizations.find((civ: any) => civ.civName === "Japan").cities.find((city: any) => city.name === "Tokyo");
      tokyo.population.population = 30;
      tokyo.population.foodStored = 0;
      plantDefender("Scout")(game);
    });
    const briefing = async () => (await get(`/briefing?civ=Japan`)).json as { warnings: string[]; warningsAcknowledged?: string[] | null; cities: { name: string; foodSurplus: number }[] };
    const first = await briefing();
    check("W46 the planted warnings stand in full", first.warnings.includes("Tokyo is starving.") && first.warnings.some((line) => line.startsWith("Kyoto is only held by a Scout")), first.warnings.join(" | "));
    const acknowledged = await orders("Japan", { acknowledge: ["Tokyo is starving", "Kyoto is only held by a Scout"] });
    check("W46 both are acknowledged", acknowledged.status === 200 && (acknowledged.json.done as string[]).filter((line) => line.startsWith("Acknowledged: ")).length === 2, JSON.stringify(acknowledged.json.done ?? acknowledged.json));
    // The soldier holding Kyoto changes for another as weak: the city is still weakly held, so the line stays folded, naming the soldier there now
    await stop(host);
    const again = await start("t100-world", "", host.dir, plantDefender("Catapult"));
    const swapped = await briefing();
    check("W46 a weak defender swapped for another stays folded, its first clause as it reads now", (swapped.warningsAcknowledged ?? []).includes("Kyoto is only held by a Catapult") && !swapped.warnings.some((line) => line.startsWith("Kyoto is only held by")),
      `${swapped.warnings.join(" | ")} || ${(swapped.warningsAcknowledged ?? []).join(" | ")}`);
    // Two turns played: while Tokyo still starves its line is folded at every look-in, and never in full
    for (const turn of [1, 2]) {
      await post("/advance", { turns: 1 });
      const now = await briefing();
      const tokyo = now.cities.find((city) => city.name === "Tokyo");
      check(`W46 Tokyo still starves after ${turn} turn${turn === 1 ? "" : "s"}`, (tokyo?.foodSurplus ?? 0) < 0, `${tokyo?.foodSurplus}`);
      check(`W46 its acknowledged line is still folded after ${turn} turn${turn === 1 ? "" : "s"}`, (now.warningsAcknowledged ?? []).includes("Tokyo is starving") && !now.warnings.some((line) => line.startsWith("Tokyo is starving")),
        `${now.warnings.join(" | ")} || ${(now.warningsAcknowledged ?? []).join(" | ")}`);
    }
    await stop(again);
  },
  async W48() { // the painted maps' styles: one distinct, non-empty style block for each of the eight ages, atlas and campaign, never mosaic; Future painted as Information
    const { cartography, MAP_AGES } = await import("../src/images.ts");
    const blocks = MAP_AGES.map((age) => cartography(`${age} era`));
    check("W48 a distinct style block for each of the eight ages", MAP_AGES.length === 8 && blocks.every((block) => block.length > 200) && new Set(blocks).size === 8, blocks.map((block) => block.length).join(","));
    const all = MAP_AGES.flatMap((age) => [cartography(`${age} era`), cartography(`${age} era`, "campaign")]);
    check("W48 no style block says mosaic", !all.some((block) => /mosaic/i.test(block)), all.find((block) => /mosaic/i.test(block))?.slice(0, 120));
    check("W48 an era the styles do not name is painted as Information", cartography("Future era") === cartography("Information era") && cartography("") === cartography("Information era"));
    const { existsSync } = await import("node:fs");
    const missing = MAP_AGES.flatMap((age) => ["atlas", "campaign"].map((kind) => `assets/map-styles/${age}-${kind}.jpg`)).filter((file) => !existsSync(file));
    check("W48 every age has its style references", missing.length === 0, missing.join(", "));
  },
  async W50() { // picture guide N (2026-11-03): a place as the years have left it - candidates from the whole game's events, the Chronicler's choice of one
    // or none, rare by guard - and the painted prompt with the place's wonders attached. No model is asked: a stand-in answers
    const host = await start("t100-world");
    const agents = await import("../src/agents.ts");
    const images = await import("../src/images.ts");
    const { state } = await import("../src/store.ts");
    const game = (await get("/state")).json as { year: string; turn: number; majorCivs: { civ: string; alive: boolean; era: string }[] };
    const events = (await get("/events?since=0")).json as { turn: number; year: string; text: string }[];
    const living = await Promise.all(game.majorCivs.filter((each) => each.alive).map(async (each) => ({ ...each, cities: ((await get(`/cities?civ=${civ(each.civ)}`)).json as { name: string }[]).map((city) => city.name) })));
    const word = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "u");
    const naming = (name: string) => events.filter((event) => word(name).test(event.text)).length;
    const saved = { pictures: state.pictures, wonders: state.paintedWonders };
    state.pictures = []; state.paintedWonders = [];
    const candidates = await agents.placeCandidates();
    check("W50 candidates: three events or more naming each, standing cities, most named first, six at most", candidates.length > 0 && candidates.length <= 6
      && candidates.every((place) => place.events.length >= 3 && place.events.every((event) => word(place.name).test(event.text)) && living.some((each) => each.civ === place.civ && each.cities.includes(place.name)))
      && candidates.every((place, at) => at === 0 || candidates[at - 1].events.length >= place.events.length), candidates.map((place) => `${place.name} (${place.civ}) ${place.events.length}`).join(", "));
    // A city named as its people (Babylon) counts the events that name the place, not those where the people act ("Babylon founded the city of Akkad")
    const peopleNamed = candidates.filter((place) => game.majorCivs.some((each) => each.civ === place.name));
    const acting = (place: { name: string }, text: string) => text.startsWith(`${place.name} `) && !new RegExp(` (?:of|in|at|to|from) ${place.name}(?![\\p{L}])`, "u").test(text);
    check("W50 a city named as a people counts only the events that name it as a place", peopleNamed.every((place) => !place.events.some((event) => acting(place, event.text))) && candidates.every((place) => naming(place.name) >= place.events.length),
      peopleNamed.map((place) => `${place.name}: ${place.events.length} of ${naming(place.name)} naming it`).join(", "));
    const top = candidates[0];
    state.paintedWonders = [{ wonder: "Colossus", civ: top.civ, place: top.name, year: "AD 90", description: "Oil painting. The Colossus at its harbour." },
      { wonder: "Petra", civ: top.civ, place: top.name, year: "AD 95", description: "Oil painting. Petra in its gorge." }];
    const calls: { systemPrompt: string; prompt: string }[] = [];
    let choice: string | null = top.name;
    const scene = { caption: "A title. A sentence.", description: "Oil painting, a bird's-eye view. The colossus over the place.", year: "AD 1" };
    agents.standInForModels((asked) => { calls.push(asked); return { text: "", data: { place: choice, why: "stand-in why", picture: choice ? scene : null } }; });
    const logged: string[] = [];
    const round = { fromTurn: game.turn - 12, turn: game.turn, fromYear: "AD 1", year: game.year, publicEvents: [], rankings: [] } as any;
    try {
      const chosen = await agents.placePictures(round, ["Going already. A sentence."], (...args) => logged.push(args.join(" ")));
      const call = calls.at(-1)!;
      check("W50 the chooser's instructions: the opening, the tested writer text and its Attila example", call.systemPrompt.startsWith("You are the Chronicler. Of the places below, is there one these years have left so changed")
        && call.systemPrompt.includes("Write two or three sentences an illustrator paints from: one picture of this place as these years have left it.") && call.systemPrompt.includes("Attila's Court in AD 1450, seen from high above the river"));
      const era = game.majorCivs.find((each) => each.civ === top.civ)!.era;
      check("W50 each candidate's block in the tested form: first line, its events, its wonders, the owner's age", candidates.every((place) => call.prompt.includes(`${place.name}, a city of ${place.civ}, as the years up to ${game.year} have left it. What happened there:\n- ${place.events[0].year}: ${place.events[0].text}`))
        && call.prompt.includes(`Its wonders as they were painted when finished:\n- Colossus (AD 90): Oil painting. The Colossus at its harbour.\n- Petra (AD 95): Oil painting. Petra in its gorge.\nThe people's age: ${top.civ}, the ${era}.`), call.prompt.slice(0, 400));
      check("W50 the captions already going are in the input", call.prompt.includes("Already going with this chapter (never the same subject):\n- Going already. A sentence."));
      check("W50 a chosen place: one picture for the chronicle, its prefix the heading, a break, the writer's caption the body, of the age's end, with the wonders its description names (Petra is left out)", chosen.length === 1 && chosen[0].for === "chronicle"
        && chosen[0].caption === `${top.name} as the years have left it, ${game.year}\n\nA title. A sentence.` && chosen[0].year === game.year && chosen[0].wonders.join() === "Colossus", JSON.stringify(chosen));
      choice = null;
      const none = await agents.placePictures(round, [], (...args) => logged.push(args.join(" ")));
      check("W50 none: no picture, the why in the log", none.length === 0 && logged.some((line) => /^no place picture this age .*: stand-in why$/.test(line)), logged.join(" | "));
      choice = "Atlantis";
      check("W50 a place that is no candidate counts as none", (await agents.placePictures(round, [])).length === 0);
      choice = top.name;
      state.pictures = [{ turn: 1, year: "AD 1", for: "chronicle", caption: `${top.name} as the years have left it, AD 1. Earlier.`, description: "" }];
      check("W50 a place pictured while the ledger remembers it is no candidate", !(await agents.placeCandidates()).some((place) => place.name === top.name));
      const before = calls.length;
      check("W50 in the victory's age, no call", (await agents.placePictures({ ...round, stoppedEarly: "Greece has won a Scientific victory" }, [])).length === 0 && calls.length === before);
    } finally { agents.standInForModels(undefined); state.pictures = saved.pictures; state.paintedWonders = saved.wonders; }
    check("W50 the painted prompt without attachments is unchanged", images.picturePrompt({ description: "A scene.", year: "AD 100" }) === "A scene.\n\nThe year is AD 100. No text or lettering. No real people.");
    const one = images.picturePrompt({ description: "Oil painting, a bird's-eye view. The place.", year: "AD 100" }, ["Colossus"]);
    check("W50 one wonder attached: the singular line, the medium lowercased", one === "Oil painting, a bird's-eye view. The place.\n\nThe attached picture shows the Colossus as first painted. Take only how it looks, not the style: this picture is oil painting, a bird's-eye view.\n\nThe year is AD 100. No text or lettering. No real people.", one);
    const two = images.picturePrompt({ description: "1962 Kodachrome snapshot: a harbour.", year: "AD 1962" }, ["Terracotta Army", "Taj Mahal"]);
    check("W50 two attached: the plural line, X and Y", two.includes("The attached pictures show the Terracotta Army and the Taj Mahal as first painted. Take only how they look, not the style: this picture is 1962 Kodachrome snapshot."), two);
    // The wonder event names its site with the lie of the land in brackets; the kept record's place is the bare city name, or no place picture ever finds its wonders
    // (the first sample run on run32-t216-peace: London's Djenne kept as "London (the capital, on the coast, ...)", "references: none kept")
    agents.standInForModels(() => ({ text: "", data: { wonder: "Great Library", description: "Oil painting. The library." } }));
    try {
      const kept = await agents.wonderPictures({ ...round, publicEvents: [{ turn: game.turn, year: game.year, text: `${top.civ} completed the wonder Great Library in ${top.name} (river, hills).` }] });
      check("W50 a kept wonder's place is the city's name alone, without the lie of the land the event adds", kept.length === 1 && kept[0].place === top.name, JSON.stringify(kept.map((each) => each.place)));
    } finally { agents.standInForModels(undefined); }
    const png = Buffer.from("not really a png");
    images.keepWonderPicture("The Great Library", png);
    const refs = images.wonderReferences(["The Great Library", "Petra"]);
    check("W50 a kept wonder picture comes back, an unknown one is null, and only kept ones are attached", images.wonderPicture("The Great Library")?.equals(png) === true && images.wonderPicture("Petra") === null
      && refs.shown.join() === "The Great Library" && refs.references[0]?.name === "The-Great-Library.png", JSON.stringify(refs.shown));
    await stop(host);
  },
  async W10() { // every proposal kind and demands barred: no officials' proposal or demand in ten turns; the faith reserve kept
    const host = await start("run22-t234-greece");
    const courts = ["Greece", "Inca", "Japan", "Iroquois", "The Ottomans", "Babylon"];
    for (const name of courts) await orders(name, { officials: { luxuries: false, "Open Borders": false, Embassy: false, "Research Agreement": false, demands: false }, faithReserve: 10000 });
    await post("/advance", { turns: 10 });
    const all = (await Promise.all(courts.map((name) => logOf(name, 234)))).flat();
    check("W10 no officials' proposal", !all.some((line) => /^The officials proposed/.test(line.text)), all.find((line) => /^The officials proposed/.test(line.text))?.text);
    check("W10 no officials' demand", !all.some((line) => /^The officials made a demand/.test(line.text)));
    check("W10 no officials' faith spent past a 10,000 reserve", !all.some((line) => /^The officials spent \d+ faith/.test(line.text)));
    check("W10 ten turns backed up", existsSync(join(host.dir, "backups", "turn-0244")));
    await stop(host);
  },
  async W14() { // never-build binds the officials' military choices in war: no barred unit queued in six turns of war (41 were, in 16, before the one gate - audit 2026-10-04)
    const host = await start("run21-t300-war");
    const courts = ["Aztecs", "Japan", "Arabia", "Songhai", "Austria", "Denmark"];
    for (const name of courts) await orders(name, { neverBuild: ["all military units"] });
    await post("/advance", { turns: 6 });
    const all = (await Promise.all(courts.map((name) => logOf(name, 300)))).flat();
    const queued = all.map((line) => /^The officials queued (.+?) in /.exec(line.text)?.[1]).filter((item): item is string => item !== undefined);
    const barred = queued.filter((item) => MILITARY_UNITS.has(item));
    check("W14 the officials still queue things", queued.length > 0, `${queued.length} queue lines`);
    check("W14 no barred military unit is queued by the officials", barred.length === 0, barred.join(", "));
    await stop(host);
  },
  async W15() { // a nuclear weapon: grounded under defend; launched under attack it is told whole, with its weight, to the attacker, the struck, every other court and the world
    // The fixture has none in the air: an Atomic Bomb of the Aztecs' is put in Tenochtitlan, five tiles from Arabia's Baghdad and its soldiers
    const host = await start("run21-t300-war", "", undefined, (game) => {
      const tile = game.tileMap.tileList.find((tile: any) => (tile.position?.x ?? 0) === 2 && (tile.position?.y ?? 0) === -9);
      game.lastUnitId += 1;
      (tile.airUnits ??= []).push({ owner: "Aztecs", originalOwner: "Aztecs", name: "Atomic Bomb", id: game.lastUnitId, currentMovement: 1 });
    });
    await post("/advance", { turns: 1 }); // the fixture's Aztecs stand on defend
    const units = (await get(`/briefing?civ=Aztecs`)).json.units as string[];
    check("W15 under defend the bomb stays on the ground", units.some((line) => /Atomic Bomb/.test(line)), units.find((line) => /Atomic Bomb/.test(line)) ?? "gone");
    await orders("Aztecs", { posture: { stance: "attack" } });
    await post("/advance", { turns: 2 });
    const aztecs = await logOf("Aztecs", 301), arabia = await logOf("Arabia", 301);
    const fell = aztecs.find((line) => /^Our Atomic Bomb fell on /.test(line.text));
    check("W15 under attack the bomb falls, and the Aztecs are told whole", fell !== undefined, fell?.text);
    check("W15 the struck are told by the attacker's name", arabia.some((line) => /^Aztecs' Atomic Bomb fell on /.test(line.text)), arabia.find((line) => /Atomic Bomb/.test(line.text))?.text);
    // The blow's weight: the people a city lost in words, the dead by whose they were, the first ever, the fallout - and no tile counted
    check("W15 the blow is told with its weight", !!fell && /lost (a few|a fifth|a quarter|a third|half|two thirds|three quarters|nearly all) of its people|was razed/.test(fell.text) && /the first atomic weapon the world has seen/.test(fell.text) && /poisoned for a generation/.test(fell.text) && !/tiles?\b/.test(fell.text), fell?.text);
    // Its dead are in the blow's line: only a unit under the ruler's own order keeps a loss line of its own; the spent bomb is the blow itself
    check("W15 the struck have no loss line for the blow's dead outside the ruler's orders", !arabia.some((line) => /lost in action .* Atomic Bomb/.test(line.text) && !/ under your /.test(line.text)), arabia.find((line) => /lost in action .* Atomic Bomb/.test(line.text) && !/ under your /.test(line.text))?.text);
    check("W15 the spent bomb has no line of its own", !aztecs.some((line) => /^Our Atomic Bomb was spent on its strike/.test(line.text)));
    const everyone = (await Promise.all(["Aztecs", "Japan", "Arabia", "Songhai", "Austria", "Denmark"].map((name) => logOf(name, 300)))).flat();
    // Every court hears of it in the world's words, and the world once per blow; the engine's own "A(n) ... has been detonated" notice is struck
    const japan = await logOf("Japan", 301);
    check("W15 a court the blow did not touch hears of it", japan.some((line) => /^Aztecs launched an Atomic Bomb /.test(line.text)), japan.find((line) => /Atomic Bomb/.test(line.text))?.text);
    check("W15 no engine A(n) in any court's log", !everyone.some((line) => /\bA\(n\)/.test(line.text)), everyone.find((line) => /\bA\(n\)/.test(line.text))?.text);
    const events = ((await get("/events?since=300")).json as { text: string }[]).filter((event) => /launched an Atomic Bomb/.test(event.text));
    check("W15 one public event per blow, the first named once", events.length >= 1 && events.length === aztecs.filter((line) => /^Our Atomic Bomb fell on /.test(line.text)).length && events.filter((event) => /first atomic weapon/.test(event.text)).length === 1, events.map((event) => event.text.slice(0, 80)).join(" | "));
    const age = (await get("/age?civ=Japan&from=300")).json.lines as string[];
    check("W15 the age's seen lines hold the blow", age.some((line) => /launched an Atomic Bomb/.test(line)));
    check("W15 no unit is gone from any roll with no reason, in three turns of war", !everyone.some((line) => /gone from our rolls/.test(line.text)), everyone.find((line) => /gone from our rolls/.test(line.text))?.text);
    await stop(host);
  },
  async W16() { // the pantheon within the faith reserve, and the beliefs the officials chose named
    const host = await start("t100-world");
    await post(`/grant?civ=Japan`, { faith: 500 });
    await orders("Japan", { faithReserve: 10000 });
    await post("/advance", { turns: 1 });
    check("W16 no pantheon past a 10,000 reserve", !(await logOf("Japan", 100)).some((line) => /pantheon/.test(line.text) && /^The officials/.test(line.text)));
    await orders("Japan", { faithReserve: 0 });
    await post("/advance", { turns: 1 });
    const japan = await logOf("Japan", 101);
    check("W16 the pantheon is founded once the reserve allows, its belief named", japan.some((line) => /^The officials founded our pantheon with the belief .+: /.test(line.text)), japan.find((line) => /pantheon/.test(line.text))?.text);
    check("W16 the faith it cost is told", japan.some((line) => /^The officials spent \d+ faith on a pantheon/.test(line.text)));
    check("W16 no faith self-check", !selfChecks(host).some((line) => /\tfaith\t/.test(line)), selfChecks(host).join(" | "));
    await stop(host);
  },
  async W47() { // the picture guide (2026-11-02): the code chooses no medium, every picture writer's input holds the people's age and its media,
    // an early era entry is a reconstruction, and a wonder is described by the Chronicler's own call, never the old template. No model is asked: a stand-in answers
    const { readdirSync } = await import("node:fs");
    const sources = readdirSync("src").filter((file) => file.endsWith(".ts")).map((file) => ({ file, text: readFileSync(join("src", file), "utf8") }));
    check("W47 no 'realistic oil painting' anywhere in the orchestrator's sources", !sources.some(({ text }) => /realistic oil painting/i.test(text)), sources.filter(({ text }) => /realistic oil painting/i.test(text)).map(({ file }) => file).join(", "));
    check("W47 the wonder template is gone", !sources.some(({ text }) => /takes their forms, materials and ornament|This is NOT the wonder of that name/.test(text)));
    const host = await start("t100-world");
    const agents = await import("../src/agents.ts");
    const { picturePrompt } = await import("../src/images.ts");
    const painted = picturePrompt({ description: "A scene.", year: "AD 100" });
    check("W47 the painted prompt adds the year and the guardrail, no medium", painted === "A scene.\n\nThe year is AD 100. No text or lettering. No real people.", painted);
    check("W47 an early age line gives the age's media, never a medium chosen for the picture (picture guide O)", agents.ageLine("Japan", "Classical era") === `The people's age: Japan, the Classical era. Media this age allows: ${agents.ALLOWED_MEDIA.Classical}.` && !/The medium for this picture/.test(agents.ageLine("Japan", "Classical era")), agents.ageLine("Japan", "Classical era"));
    check("W47 an untyped early picture gets the full media line", /Media this age allows: A finished history painting; a broad romantic landscape/.test(agents.ageLine("Japan", "Medieval era")));
    check("W47 a later age line gets its age's media", /Media this age allows: Oil painting, one of: oil on oak panel/.test(agents.ageLine("Japan", "Renaissance era")) && /Usually a photograph/.test(agents.ageLine("Japan", "Atomic era")));
    // Picture guide P (2026-11-05): period styles from the Medieval age on, foundings seen wide, the Modern ages photographed only once the decade could
    const media = agents.ALLOWED_MEDIA as Record<string, string>;
    check("W47 the Medieval age has its own line with no archaeological reconstruction, and Medieval, Renaissance and Industrial each differ from the early ages'", !/archaeological reconstruction/i.test(media.Medieval)
      && ["Medieval", "Renaissance", "Industrial"].every((age) => media[age] !== media.Ancient), media.Medieval);
    check("W47 no age's line offers a reconstruction for a founding", Object.values(media).every((line) => !/reconstruction[^.]*\bfounding/i.test(line)), media.Ancient);
    check("W47 the Medieval and Renaissance lines offer the people's own painters; the Industrial line does not", /own painters/.test(media.Medieval) && /own painters/.test(media.Renaissance) && !/own painters/.test(media.Industrial));
    const craft = readFileSync("src/agents.ts", "utf8").match(/const PICTURE_CRAFT = `([\s\S]*?)`;/)?.[1] ?? "";
    const [guidance, examples = ""] = craft.split("Examples of good descriptions:");
    check("W47 the picture craft sees a founding from a step back, and none of its examples is a founding", /A city founded is seen from a step back/.test(guidance) && !!examples.trim() && !/found/i.test(examples), examples.split("\n").filter((line) => /found/i.test(line)).join(" | "));
    // Picture brief Q (2026-11-05): from about 2005 "its people's own manner" was read as the people's old building (a stepped temple in 2005, yurts with solar mats in 2060)
    const foundingLine = guidance.split("\n").find((line) => line.startsWith("A city founded")) ?? "";
    check("W47 the founding line names a year before which the people's own manner applies, never every age", /\bbefore (?:AD \d+|\d+ BC), built in its people's own manner/.test(foundingLine) && (foundingLine.match(/own manner/g) ?? []).length === 1, foundingLine);
    check("W47 the Modern ages are photographed once the decade has a photograph", ["Modern", "Atomic", "Information", "Future"].every((age) => /once the decade has one/.test(media[age])));
    const game = (await get("/state")).json as { year: string; majorCivs: { civ: string; alive: boolean; era: string }[] };
    const civName = game.majorCivs.find((each) => each.alive)!.civ;
    const era = game.majorCivs.find((each) => each.civ === civName)!.era;
    const briefing = (await get(`/briefing?civ=${civ(civName)}`)).json;
    // Every call is answered by the stand-in with every field any writer asks for; its inputs are kept
    const calls: { role: string; systemPrompt: string; prompt: string; writer: string }[] = [];
    let writer = "";
    const scene = { caption: "A title. A sentence.", description: "Stand-in description of the picture.", year: game.year };
    agents.standInForModels((asked) => {
      calls.push({ ...asked, writer });
      return { text: "Stand-in reply.", data: { ...scene, image: scene, images: [scene], oddity: scene, why: "stand-in", wonder: "Great Library", summons: "", dispatch: "", door: "", road: "", agenda: [], question: "", journal: "", chapter: "A chapter." } };
    });
    const seat = { civ: civName, kind: "human", rulerName: "the ruler", chat: [], journal: [], annals: [] } as any;
    const round = { fromTurn: 88, turn: 100, fromYear: "AD 100", year: game.year, publicEvents: [{ turn: 99, year: game.year, text: `${civName} completed the wonder Great Library in Their Capital (river, hills).` }], rankings: [] } as any;
    const writers: [string, () => Promise<unknown>][] = [
      ["letter", () => agents.advisorReport(seat, round, [], briefing)],
      ["urgent letter", () => agents.advisorUrgent(seat, "War is declared.", briefing)],
      ["audience (paint_decision)", () => agents.advisorReply(seat, "Let us build the library.", 12)],
      ["court painter", () => agents.describeDecision(seat)],
      ["chronicle", () => agents.heraldNewspaper(round, { earlier: [], lastChapters: [], proclamations: [], campaigns: [], cast: [] })],
      ["era entry", () => agents.eraScene(civName, era, game.year, [])],
      ["victory", () => agents.victoryScene(civName, "Scientific", era, game.year)],
      ["oddity", () => agents.oddityScene(round, [], [], [])],
    ];
    let wonders: { caption: string; description: string }[] = [];
    try {
      for (const [name, write] of writers) { writer = name; await write(); }
      writer = "wonder";
      wonders = await agents.wonderPictures(round);
    } finally { agents.standInForModels(undefined); }
    const named = [...writers.map(([name]) => name), "wonder"];
    const missing = named.filter((name) => !calls.some((each) => each.writer === name));
    check("W47 every picture writer was called", missing.length === 0, missing.join(", "));
    const hasAge = (prompt: string) => prompt.includes(`The people's age: ${civName}, the ${era}.`) || (prompt.includes("The peoples' ages") && new RegExp(`- ${era}: [^\\n]*${civName}`).test(prompt));
    check(`W47 the people's age (${civName}, ${era}) is in every picture writer's input`, calls.every((each) => hasAge(each.prompt)), calls.filter((each) => !hasAge(each.prompt)).map((each) => each.writer).join(", "));
    const hasMedia = (prompt: string) => /Media this age allows: /.test(prompt);
    check("W47 and the media it allows, from the table", calls.every((each) => hasMedia(each.prompt)), calls.filter((each) => !hasMedia(each.prompt)).map((each) => each.writer).join(", "));
    const entry = calls.find((each) => each.writer === "era entry")!;
    check(`W47 the era entry (${era}) gets its age's media like every picture, never a medium chosen for it`, entry.prompt.includes(`Media this age allows: ${agents.ALLOWED_MEDIA[era.replace(/ era$/, "")]}.`) && !entry.prompt.includes("The medium for this picture"));
    check("W47 no picture writer's input names a medium chosen for the picture", !calls.some((each) => each.prompt.includes("The medium for this picture:")), calls.filter((each) => each.prompt.includes("The medium for this picture:")).map((each) => each.writer).join(", "));
    check("W47 no writer's instructions or input say 'realistic oil painting'", !calls.some((each) => /realistic oil painting/i.test(each.systemPrompt + each.prompt)), calls.filter((each) => /realistic oil painting/i.test(each.systemPrompt + each.prompt)).map((each) => each.writer).join(", "));
    // (the audience's craft is in its paint_decision tool's description, not in these instructions)
    check("W47 the moments' writers get the one picture craft", calls.filter((each) => !["wonder", "audience (paint_decision)"].includes(each.writer)).every((each) => each.systemPrompt.includes("Write two or three sentences an illustrator paints from. Begin with the medium")));
    const wonderCall = calls.find((each) => each.writer === "wonder");
    check("W47 the wonder's own brief and its examples are in the Chronicler's call", !!wonderCall && wonderCall.systemPrompt.includes("Paint the famous wonder whole and recognisable by its shape at a glance") && wonderCall.systemPrompt.includes("Sweden's own pyramid, as vast as Giza, of grey granite") && wonderCall.prompt.includes("- Great Library, in Their Capital (river, hills)"), wonderCall?.prompt);
    check("W47 one call for the wonder, and its picture is described by that call", calls.filter((each) => each.writer === "wonder").length === 1 && wonders.length === 1 && wonders[0].description === scene.description && wonders[0].caption.startsWith("Great Library, completed by "), JSON.stringify(wonders));
    await stop(host);
  },
  async W49() { // the year stamp (2026-11-03, Olle: "fix the year as well"): a picture carries the year its moment is set in, as its writer named it - a chapter
    // picture of an 1878 founding says 1878, not the age's last year - and every picture writer is asked for that year; a writer that names none gets the year it was given
    const host = await start("t100-world");
    const agents = await import("../src/agents.ts");
    const { picturePrompt } = await import("../src/images.ts");
    const game = (await get("/state")).json as { year: string; majorCivs: { civ: string; alive: boolean; era: string }[] };
    const civName = game.majorCivs.find((each) => each.alive)!.civ;
    const era = game.majorCivs.find((each) => each.civ === civName)!.era;
    const briefing = (await get(`/briefing?civ=${civ(civName)}`)).json;
    const schemas: { writer: string; schema: Record<string, unknown> | undefined }[] = [];
    let writer = "";
    let named = "AD 712";
    const scene = () => ({ caption: "A title. A sentence.", description: "Stand-in description of the picture.", year: named });
    agents.standInForModels((asked) => {
      schemas.push({ writer, schema: asked.outputSchema });
      return { text: "Stand-in reply.", data: { ...scene(), image: scene(), images: [scene()], oddity: scene(), why: "stand-in", summons: "", dispatch: "", door: "", road: "", agenda: [], question: "", journal: "", chapter: "A chapter." } };
    });
    const seat = { civ: civName, kind: "human", rulerName: "the ruler", chat: [], journal: [], annals: [] } as any;
    const round = { fromTurn: 88, turn: 100, fromYear: "AD 100", year: game.year, publicEvents: [], rankings: [] } as any;
    const years: Record<string, string | undefined> = {};
    try {
      writer = "letter"; years.letter = (await agents.advisorReport(seat, round, [], briefing)).image?.year;
      writer = "urgent letter"; years.urgent = (await agents.advisorUrgent(seat, "War is declared.", briefing)).image?.year;
      writer = "court painter"; years.decision = (await agents.describeDecision(seat)).year;
      writer = "chronicle"; years.chronicle = (await agents.heraldNewspaper(round, { earlier: [], lastChapters: [], proclamations: [], campaigns: [], cast: [] })).images[0]?.year;
      writer = "era entry"; years.era = (await agents.eraScene(civName, era, game.year, [])).year;
      writer = "victory"; years.victory = (await agents.victoryScene(civName, "Scientific", era, game.year)).year;
      writer = "oddity"; years.oddity = (await agents.oddityScene(round, [], [], [])).oddity?.year;
    } finally { agents.standInForModels(undefined); }
    const asksYear = (schema: Record<string, unknown> | undefined) => JSON.stringify(schema ?? {}).includes('"year"');
    check("W49 every picture writer is asked for the year its moment is set in", schemas.length === 7 && schemas.every(({ schema }) => asksYear(schema)), schemas.filter(({ schema }) => !asksYear(schema)).map(({ writer }) => writer).join(", "));
    check(`W49 each writer's picture carries the year it named (${named}), not the age's last (${game.year})`, Object.values(years).every((year) => year === named), JSON.stringify(years));
    check("W49 the painted prompt stamps that year", picturePrompt(agents.dated({ description: "A scene.", year: named }, game.year)).includes(`The year is ${named}.`));
    check("W49 a writer that named no year gets the year it was given", agents.dated({ description: "A scene.", year: " " }, game.year).year === game.year && agents.dated({ description: "A scene." }, game.year).year === game.year);
    await stop(host);
  },
  async W52() { // the map's frontiers (map border tests, 2026-11-03): from Classical on, a firm land frontier per realm in a colour chosen from the game's pair,
    // city-states their own, no frontier for a far glimpse, a key; Ancient keeps its soft tint word for word; campaign arrows owe the frontiers nothing
    const host = await start("t100-world");
    const images = await import("../src/images.ts");
    const age = (await get(`/age?civ=Japan&from=90`)).json as any;
    const realms = age.realms as { name: string; cityState: boolean; outer: string; inner: string; cities: string[]; meets: string[] }[];
    check("W52 the host's realms: ours first, great powers before city-states, the game's colour pair, Kyoto Japan's", realms[0].name === "Japan" && realms[0].cities.includes("Kyoto")
      && realms.findIndex((each) => each.cityState) > realms.findLastIndex((each) => !each.cityState) && realms.every((each) => /^#[0-9a-f]{6}$/.test(each.outer) && /^#[0-9a-f]{6}$/.test(each.inner)), JSON.stringify(realms.map((each) => each.name)));
    check("W52 who meets whom on known land is told both ways", realms.every((each) => each.meets.every((other) => realms.find((r) => r.name === other)?.meets.includes(each.name))) && realms.some((each) => each.meets.length > 0));
    const pair = (name: string, outer: string, inner: string) => ({ name, cityState: false, outer, inner, cities: [], meets: [] });
    const chosen = images.frontierColours([pair("Carthage", "#cdcdcd", "#510089"), pair("India", "#0e7104", "#ffa347"), pair("Ethiopia", "#124216", "#ff3838"), pair("Korea", "#1b2160", "#ff0000"), pair("The Maya", "#c68d63", "#183f42")]);
    check("W52 the tested palette from the game's pairs: Carthage's pale grey gives way to its purple, Ethiopia's green (India's twin) to its red, the rest their outer", JSON.stringify([...chosen.values()]) === JSON.stringify(["#510089", "#0e7104", "#ff3838", "#1b2160", "#c68d63"]), JSON.stringify([...chosen]));
    const ancient = images.paintedMapPrompt("Japan", "Ancient era", "3000 BC", age), classical = images.paintedMapPrompt("Japan", "Classical era", "AD 100", age);
    const marching = { ...age, marches: [{ whose: "Japan", what: "a company", from: "Kyoto", to: "Argos", outcome: "took", size: 3, fell: 0, sea: false, told: "", fromXY: [0, 0], toXY: [1, 1], route: [] }], enemyMarches: [] };
    const campAncient = images.campaignMapPrompt("Japan", "Ancient era", marching), campLater = images.campaignMapPrompt("Japan", "Industrial era", marching);
    check("W52 Ancient keeps the soft tint as it was, atlas and campaign, and no frontier rule", ancient.includes('a small banner). Show each realm\'s territory with a soft tinted border in its colour. ') && campAncient.includes("a small banner); each realm's territory with a soft tinted border in its colour.\n")
      && !/COUNTRY FRONTIERS|frontier/i.test(ancient + campAncient));
    check("W52 from Classical on the soft tint is gone and the frontier rule is there, in the age's hand, atlas and campaign", !/soft tinted border/.test(classical + campLater) && classical.includes("COUNTRY FRONTIERS") && classical.includes("reed-pen") && campLater.includes("COUNTRY FRONTIERS") && campLater.includes("crisp printed boundary"));
    check("W52 each realm with its towns, its colour named and given, where its frontier runs, and the key", classical.includes(`Japan - ${realms[0].cities.slice(0, 5).join(", ")} - ${images.colourName(images.frontierColours(realms).get("Japan")!)} ${images.frontierColours(realms).get("Japan")}`) && classical.includes(`, its frontier only toward ${realms[0].meets[0]}`) && /A small quiet key/.test(classical) && classical.includes("small Roman capitals"));
    const cityStates = realms.filter((each) => each.cityState && !age.glimpses.includes(each.cities[0]));
    check("W52 the city-states each their own realm in the city-state ink, whatever their alliances", cityStates.length > 0 && cityStates.every((each) => classical.includes(each.name)) && /each its own small realm, its frontier in warm charcoal #4a4038 on its landward sides only, whatever its alliances/.test(classical));
    const island = images.frontiers("Classical era", "Japan", [{ ...pair("Japan", "#ffffff", "#b80000"), cities: ["Kyoto"] }, { ...pair("England", "#6d0200", "#ffffff"), cities: ["London"] }]);
    check("W52 a realm with no land frontier gets no line round its coasts; one by unclaimed land runs toward it", /England - London - [^;]*, with no frontier line at all: its edges are coast and the unknown/.test(island) && !/England[^;]*frontier only toward/.test(island)
      && /toward the unclaimed land beside it/.test(images.frontiers("Classical era", "Japan", [{ ...pair("Japan", "#ffffff", "#b80000"), open: true }])), island);
    check("W52 a realm known only in a glimpse gets an accent by its name and no frontier", age.glimpses.includes("Colombo") && /Known only from afar: Colombo warm charcoal #4a4038 - a small accent in that colour by the town's name, and no frontier\./.test(classical), classical.match(/Known only[^\n]*/)?.[0]);
    check("W52 coasts and the unknown get no frontier, labels never cover a town or a company", /stops at the shore/.test(classical) && /no closed ring round a realm's known edge or round a far glimpse/.test(classical) && /never over a town's name or a company/.test(classical));
    check("W52 campaign arrows cross the frontiers as marches.png has them, and stay distinct", /no frontier bends to it/.test(campLater) && /distinct from roads and rivers and from the campaign arrows/.test(campLater) && !/frontier/.test(campAncient));
    const painted = Buffer.from("a painted map");
    images.keepMap("Japan", painted);
    const back = images.keptMap("Japan");
    images.forgetMaps();
    check("W52 /map's kept map: the painted one comes back, none for a realm never painted, none after a new world", back?.equals(painted) === true && images.keptMap("Greece") === null && images.keptMap("Japan") === null);
    check("W52 one realm alone gets no key", !/A small quiet key/.test(images.frontiers("Classical era", "Japan", [realms[0]])));
    await stop(host);
  },
  async W53() { // the open court (2026-11-03, Olle: "So the court starts with an overview then the matters to handle"): the letter is summons, story and
    // longer view, and its agenda is written in the same call but kept back; the ruler's first word is answered with the agenda in the advisor's input, once
    const host = await start("t100-world");
    const agents = await import("../src/agents.ts");
    const { fileLetter, letterOf } = await import("../src/round.ts");
    const game = (await get("/state")).json as { year: string; majorCivs: { civ: string; alive: boolean }[] };
    const civName = game.majorCivs.find((each) => each.alive)!.civ;
    const briefing = (await get(`/briefing?civ=${civ(civName)}`)).json;
    const road = "Learning is our road: we lead Greece by three discoveries; the case for faith is Kyoto's shrines, but the Great Prophet went to Babylon.";
    const agenda = ["The lone warrior at Kyoto has nothing to do: I mean to walk him to the eastern hills, unless you want him home.", "I am proud of the harbour at Osaka and would like to talk about what it could become; only talk."];
    const asked: { role: string; systemPrompt: string; prompt: string; served?: string[] }[] = [];
    agents.standInForModels((call) => {
      asked.push(call);
      if (call.outputSchema) return { text: "", data: { summons: "AD 800 - come to court.", dispatch: "The story of the age.", door: "Shall I bring you what I have?", road: road, agenda, image: null, journal: "A journal line." } };
      return { text: "As you wish, Majesty." };
    });
    try {
      const seat = { civ: civName, kind: "human", rulerName: "the ruler", chat: [], journal: [], annals: [], will: "", character: { name: "Adiega", sheet: "A careful steward." } } as any;
      const round = { fromTurn: 88, turn: 100, fromYear: "AD 440", year: game.year, publicEvents: [], rankings: [] } as any;
      const dispatch = await agents.advisorReport(seat, round, [], briefing);
      const report = asked.find((each) => each.role === "report")!;
      check("W53 the letter writer is asked for the door, the road and the matters, and no longer view or question (the expert court)", /\ndoor - the letter's last paragraph/.test(report.systemPrompt) && /\nroad - your read of how this realm wins/.test(report.systemPrompt) && /the best case for the road you would not take/.test(report.systemPrompt)
        && /\nagenda - your matters after the road/.test(report.systemPrompt) && !/\n(question|strategy) - /.test(report.systemPrompt) && /A thing is said once across the dispatch, the road and the matters/.test(report.systemPrompt) && /The road and the matters are your own words/.test(report.systemPrompt));
      check("W53 the letter writer has what can be done now, and is told to look through it before the matters", /\n\nWhat can be done right now - every city's buildable items/.test(report.prompt) && /Before you write the matters, look through what can be done now \(below\) for what the ruler would not think to ask about/.test(report.systemPrompt));
      check("W53 the dispatch carries the door, the road and the matters, and no question", JSON.stringify(dispatch.agenda) === JSON.stringify(agenda) && dispatch.road === road && dispatch.door === "Shall I bring you what I have?" && dispatch.question === undefined);
      fileLetter(seat, dispatch, "AD 440 to AD 800");
      const sent = letterOf(dispatch);
      check("W53 the letter sent is heading, story and door: no road, no matters", sent === "AD 800 - come to court.\n\nThe story of the age.\n\nShall I bring you what I have?" && !sent.includes(road.slice(0, 30)) && !agenda.some((item) => sent.includes(item.slice(0, 30))), sent);
      check("W53 the annal keeps the road as its course and the matters; the seat holds both until the first word; the transcript's letter is story and door", JSON.stringify(seat.annals.at(-1).agenda) === JSON.stringify(agenda) && seat.annals.at(-1).course === road && JSON.stringify(seat.agenda) === JSON.stringify(agenda) && seat.road === road
        && seat.chat.at(-1).letter && seat.chat.at(-1).text === "The story of the age.\n\nShall I bring you what I have?");
      // The first word never closes the court (2026-11-04, Olle: "Let's only allow hard command closes after the first message?"): while the road and the matters
      // wait, dismiss_court is not served and a call to it cannot dismiss; only the ruler's /onward closes that audience
      const schema = (await get("/schema")).json as any;
      const unserved = await agents.callRealmTool(seat, { canRecordWill: true }, schema, "dismiss_court", {}).catch((error: Error) => error.message);
      check("W53 while the road and the matters wait, a dismiss_court call cannot dismiss the court", !seat.dismissed, unserved);
      // Brief commands (2026-11-05, data/briefs/brief-commands-2026-11-05.md): a brief asked before the first word is not that word - the road and the
      // matters wait on, out of its input - and it is served the read tools alone
      asked.length = 0;
      await agents.advisorBrief(seat, "cities", 12);
      const briefed = asked.find((each) => each.role === "advisor")!;
      check("W53 a brief before the first word leaves the road and the matters waiting and owes no orders; its input carries neither, nor the first-word rule", seat.road === road && JSON.stringify(seat.agenda) === JSON.stringify(agenda) && seat.ordersOwed === undefined
        && !briefed.prompt.includes("What you meant to bring to this audience") && !briefed.prompt.includes(road.slice(0, 30)) && !agenda.some((item) => briefed.prompt.includes(item.slice(0, 30))) && !briefed.systemPrompt.includes("but not in this reply to their first word")
        && briefed.prompt.includes("The ruler now says:\nThe ruler asks you for a brief on our cities - what each is for") && briefed.prompt.includes("the one thing you would change if it were yours alone. In a brief you set no orders and ask for no decision; where one waits, name it and leave it to the ruler to take up. What you are not sure of, look up before you write; say you do not know only what nothing you can reach would tell you.")
        && !/A brief changes nothing/.test(briefed.prompt), briefed.prompt.slice(-900));
      check("W53 a brief's rules have no closing, no dismissal and no loose ends: it ends on its last sentence, with no /onward", briefed.systemPrompt.includes("\n- A brief ends on its last sentence: no closing line and no /onward.\n")
        && !/The closing ends with the line|Time passes only when the ruler dismisses the court|Never among the loose ends/.test(briefed.systemPrompt), briefed.systemPrompt.slice(briefed.systemPrompt.indexOf("THE COURT'S FIXED RULES"), briefed.systemPrompt.indexOf("THE COURT'S FIXED RULES") + 700));
      asked.length = 0;
      await agents.advisorBrief({ ...seat, chat: [] }, "trade", 12);
      check("W53 a brief with nothing said yet is not told it is the ruler's first word", asked.find((each) => each.role === "advisor")!.prompt.includes("The audience so far:\n(nothing has been said yet)") && !asked.some((each) => each.prompt.includes("this is the ruler's first word to you")));
      check("W53 a brief is served the read tools alone", JSON.stringify(briefed.served) === JSON.stringify(["get_briefing", "get_options", "look_up", "get_log"]), JSON.stringify(briefed.served));
      check("W53 a sovereign is never asked a brief", await agents.advisorBrief({ ...seat, kind: "agent" }, "cities", 12).then(() => false, () => true));
      asked.length = 0;
      await agents.advisorReply(seat, "Go on.", 12);
      const first = asked.find((each) => each.role === "advisor")!;
      check("W53 the reply to the first word is served neither dismiss_court nor set_orders, and is told that only /onward ends this audience", !!first.served?.includes("record_rulers_will") && !first.served.includes("dismiss_court") && !first.served.includes("set_orders") && seat.ordersOwed === true
        && first.systemPrompt.includes('a thumbs-up to your closing) - but not in this reply to their first word: however it reads, the road and the matters come first, and only their /onward ends this audience. A word that answers a question of yours, names a loose end or a matter, or gives an order, a number or a choice is never a close, whatever its tone: only a word that says the audience is over counts. When you are unsure') && !first.systemPrompt.includes('call dismiss_court'), JSON.stringify(first.served));
      check("W53 the closing's fixed line offers a brief, and the old line is gone", first.systemPrompt.includes('- The closing ends with the line "Name any you want to raise, ask for a /brief, or /onward".')
        && !/Name any you want to raise; otherwise/.test(readFileSync("src/agents.ts", "utf8") + readFileSync("src/index.ts", "utf8")));
      check("W53 the ruler's first word puts the road and then the matters in the advisor's input, to be brought in their shape", first.prompt.includes("What you meant to bring to this audience, prepared before the ruler spoke. Their first word opens the audience, it does not close it: the road and the matters come before anything of yours is settled or the court closes.") && first.prompt.includes("Answer what the ruler said first; then bring all of it in this same reply")
        && first.prompt.includes("opening with the road, then the matters, each in a sentence or two in the flow of talk - what it is and what you will do about it, as your own intention, or that it is only talk - with no heading or list of their own, the case for one only where the ruler opened it; that their word can stop any of it goes unsaid.") && !first.prompt.includes("as lines") && first.prompt.includes(`the orders for it follow on their next word or their /onward. When their word changes nothing, bring it as prepared.\n\n${road}\n\n${agenda[0]}\n\n${agenda[1]}\n\n`)
        && !/The road:|The matters:|\n1\. /.test(first.prompt), first.prompt.slice(first.prompt.indexOf("What you meant"), first.prompt.indexOf("What you meant") + 1200));
      check("W53 the letter writer and the closing quote no wording to copy: summons, door and the standing sentence are described, not exemplified", /no more than a hint of what waits\.\n/.test(report.systemPrompt + report.prompt) && /Framed on this age, so that only it could have written the question, and answerable by a ruler who has never played this game\./.test(report.systemPrompt + report.prompt)
        && !/The court is called, AD 680|Adiega asks|Are you ready for the detailed matters|are the sense of it/.test(report.systemPrompt + report.prompt) && /say so in one plain sentence so the ruler can correct it/.test(first.systemPrompt) && !/I take it as standing/.test(first.systemPrompt));
      // Court form C (brief data/briefs/court-form-c-2026-11-04.md, round 5 of data/harness/court-form-research-2026-11-04/REPORT.md): the door asks for direction and takes no side; a word that
      // chooses nothing leaves the question open; no silence clause anywhere; the specifics are the advisor's, said as what it will do
      check("W53 the door asks the ruler for direction and takes no side", report.systemPrompt.includes("door - the letter's last paragraph, in your voice: in a line, where the course stands after these years - what we are set on and how it goes - and then a question to the ruler of how they want this age's situation handled or seen: hold the course, change it, press, wait, or the like.")
        && report.systemPrompt.includes("Specifics - a building, a deal, a city, a price - are matters, not the door. The door takes no side: your read and lean wait for the road. Never the words you used last time.")
        && report.systemPrompt.includes("kept back until the ruler's first word, when you bring it; your leans on the matters and what you would do about each wait with it, so the letter and its door take no side.") && !/naming what waits/.test(report.systemPrompt));
      check("W53 a word that chooses nothing leaves the letter's question open", first.prompt.includes("before anything of yours is settled or the court closes. A word that does not choose between what your letter asked leaves that question open: the course stands as it was before this audience, the question still waits for them, and nothing of yours goes down as their wish. Answer what the ruler said first"));
      check("W53 no silence clause: the road stands until another is taken, the matters are intentions, the specifics the advisor's to say what it will do", report.systemPrompt.includes("A road is theirs to take; until they take another, the course stands as it is.")
        && report.systemPrompt.includes("the matter and what you will do about it, as your own intention in plain words, with what follows from it in the same sentence - or that it is only talk. That the ruler's word can stop any of it is the court's standing rule and goes unsaid. What you put to the ruler is direction - a road, a strategy, a war, a standing rule; the specifics you decide, and say what you will do. A matter is a question to the ruler only when it is one of direction.")
        && ![report.systemPrompt, first.systemPrompt, first.prompt].some((text) => /says? nothing|goes ahead if|unless the ruler takes it up|say you have decided/.test(text)));
      check("W53 the loose ends are intentions too", first.systemPrompt.includes("numbered, one line each saying what you will do, as your own intention in the shape of the matters (") && !/unless the ruler takes it up/.test(readFileSync("src/agents.ts", "utf8")));
      check("W53 years, never turns: the letter writer and the audience say in years what the briefing counts in turns", [report.systemPrompt, first.systemPrompt].every((prompt) => prompt.includes("Time is years and seasons, never turns: the briefing gives what is coming as a year and as how long from now - say whichever reads better; places are cities")));
      // Envoys (2026-11-07, data/briefs/envoys-2026-11-07.md): the host takes the envoy order and set_orders offers it (schemaProblems would name either missing),
      // words go with a trade and with an answer, and the rule line is in the prompts of the audience and the letter
      const tools = readFileSync("src/agents.ts", "utf8");
      check("W53 set_orders serves words with a trade and with an answer, and the envoy order the host takes", schema.orderFields.immediate.includes("envoy") && agents.schemaProblems(schema).length === 0
        && /want: z\.array[^\n]*\n\s*words: z\.string\(\)\.optional\(\)/.test(tools) && /answerOffers: z\.array\(z\.object\(\{[^\n]*words: z\.string\(\)\.optional\(\)/.test(tools) && /envoy: z\.array\(z\.object\(\{ to: z\.string\(\), words: z\.string\(\)/.test(tools),
        JSON.stringify(agents.schemaProblems(schema)));
      check("W53 the rule line on words between courts is in the audience's prompt and the letter writer's", [first.systemPrompt, report.systemPrompt].every((prompt) => prompt.includes("Words may go with an offer or an answer, or alone by envoy, to another court; they reach that court's advisor as written, and nothing else does. A peace or a friendship carries none of its own: its words go by an envoy beside it.")));
      check("W53 the audience's rules count no turns: the age passes, and the look-ins are every few years", !/\b\d+ turns\b|turns pass|every few turns/.test(first.systemPrompt) && first.systemPrompt.includes("Then the next age passes while you govern by the recorded will and look in on the realm every few years."));
      check("W53 the advisor's reply clears them", seat.agenda === undefined && seat.road === undefined);
      // A brief between the first reply and the next word: the orders stay owed, and the brief is not told so
      asked.length = 0;
      await agents.advisorBrief(seat, "rivals", 12);
      const owedBrief = asked.find((each) => each.role === "advisor")!;
      check("W53 a brief while orders are owed leaves them owed and is not told to set them", seat.ordersOwed === true && !owedBrief.prompt.includes("its orders are not set yet") && JSON.stringify(owedBrief.served) === JSON.stringify(["get_briefing", "get_options", "look_up", "get_log"]));
      seat.chat.push({ from: "ruler", text: "Go on." }, { from: "advisor", text: "As you wish, Majesty." });
      asked.length = 0;
      await agents.advisorReply(seat, "And the harbour?", 12);
      const second = asked.find((each) => each.role === "advisor")!;
      check("W53 a second word does not carry them", !second.prompt.includes("What you meant to bring to this audience"));
      check("W53 the next word sets the orders the first reply told: it is served set_orders and told they are owed, and then they are not", !!second.served?.includes("set_orders")
        && second.prompt.includes("Your reply to the ruler's first word told them what you will do, and its orders are not set yet: set them in this reply, as you told them, with whatever the ruler's word now changes.\n\nThe ruler now says:\nAnd the harbour?") && seat.ordersOwed === undefined);
      // The dismissal gate (2026-11-07, data/briefs/dismissal-gate-2026-11-07.md): dismiss_court is the advisor's only once it has offered /onward in this
      // audience - a message of its own since the letter ending on the closing tail; a word that answers, names a loose end, orders or chooses is never a close
      const CLOSE_RULE = "A word that answers a question of yours, names a loose end or a matter, or gives an order, a number or a choice is never a close, whatever its tone: only a word that says the audience is over counts.";
      check("W53 the second word, before the advisor has offered /onward: dismiss_court is not served, a call cannot dismiss, and the rule says the court is not yet its to close", !second.served?.includes("dismiss_court")
        && second.systemPrompt.includes(`a thumbs-up to your closing). ${CLOSE_RULE} You have not offered /onward in this audience yet, so the court is not yours to close: when their message says so, give your closing and end with the /onward line for them to tap. When you are unsure`)
        && !second.systemPrompt.includes("call dismiss_court") && !second.systemPrompt.includes("Read it as a person would") && !second.systemPrompt.includes("not in this reply to their first word")
        && (await agents.callRealmTool(seat, { canRecordWill: true }, schema, "dismiss_court", {}).catch(() => {}), !seat.dismissed), JSON.stringify(second.served));
      seat.chat.push({ from: "ruler", text: "And the harbour?" }, { from: "advisor", text: "The harbour waits on the walls; both are set.\n\nName any you want to raise, ask for a /brief, or /onward" });
      asked.length = 0;
      await agents.advisorReply(seat, "Thank you, that is all for today.", 12);
      const third = asked.find((each) => each.role === "advisor")!;
      check("W53 once the advisor has offered /onward, plain words close the court again: dismiss_court is served, the rule tells it when, and the call dismisses", !!third.served?.includes("dismiss_court")
        && third.systemPrompt.includes(`a thumbs-up to your closing). ${CLOSE_RULE} When their message says so and nothing of yours is left open, set the orders, give your closing`) && !third.systemPrompt.includes("not yours to close")
        && (await agents.callRealmTool(seat, { canRecordWill: true }, schema, "dismiss_court", {}), seat.dismissed === true), JSON.stringify(third.served));
      check("W53 the dismiss_court tool says it is the advisor's only once /onward is offered, and only on a word that says the audience is over", readFileSync("src/agents.ts", "utf8").includes("Yours only once you have offered /onward in this audience. Call it once, after any orders are set and your closing is written, when the ruler's word says the audience is over and nothing of yours still needs their answer. A word that answers a question of yours, names a loose end or a matter, or gives an order, a number or a choice is never that, whatever its tone."));
      seat.dismissed = false;
      // A first word that came with /onward is the ruler's last: its orders are set in that same reply, and none are owed
      Object.assign(seat, { road, agenda });
      asked.length = 0;
      await agents.advisorReply(seat, "Go on.\n\n[The ruler added /onward]", 12, true);
      const lastWord = asked.find((each) => each.role === "advisor")!;
      check("W53 a first word with /onward is served set_orders (not dismiss_court), is not told the orders wait, and owes none", !!lastWord.served?.includes("set_orders") && !lastWord.served.includes("dismiss_court")
        && lastWord.prompt.includes("that their word can stop any of it goes unsaid. When their word changes nothing") && seat.ordersOwed === undefined, JSON.stringify(lastWord.served));
      const sovereign = { ...seat, kind: "agent" };
      check("W53 a sovereign is never served dismiss_court, the first word waiting or not", [{ ...sovereign, road, agenda }, sovereign].every((each) => !agents.servedTools(each, { canRecordWill: true, sideTools: ["proclaim"] }).includes("dismiss_court")));
      check("W53 the expert at the table, and the guard: only the ruler's words change the course", first.systemPrompt.includes("Be that for the ruler. At this table you are the one who knows the game, and the ruler sets the course") && first.systemPrompt.includes("Only their words change the realm's course: a word that takes no road leaves it as it stands."));
      check("W53 told once: a matter once an audience, the closing says what changed, the loose ends never relist a matter brought", /and a matter is told once: after that, only what has changed about it/.test(first.systemPrompt) && /say what this audience changed and what you now set in motion, not the whole course again/.test(first.systemPrompt) && !/the only place you sum up/.test(first.systemPrompt)
        && /nor a matter you brought: what the closing sets in motion is no loose end/.test(first.systemPrompt));
      check("W53 the character writer no longer holds the advisor back from the realm's course", !(await import("node:fs")).readFileSync("src/characters.ts", "utf8").includes("What the realm should become is the ruler's to say"));
      check("W53 the audience is a conversation, the letter has read: no broad question, the court rises when the ruler closes it", !/asked the broad question/.test(first.systemPrompt) && /a conversation and not a form/.test(first.systemPrompt) && /The reply that brings your matters brings them all at once/.test(first.systemPrompt) && /The court rises when the ruler closes it, not when your matters are done/.test(first.systemPrompt) && /They have read your letter/.test(first.systemPrompt));
      check("W53 the house rules: the letter opens the court, the matters come on the ruler's first word", /The court opens with the advisor's letter; on the ruler's first word the advisor brings its matters/.test(agents.HOUSE_RULES));
      const last = await agents.advisorReport(seat, round, [], briefing, "Greece has won a Scientific victory");
      check("W53 the last letter keeps no door, road or matters", Array.isArray(last.agenda) && last.agenda.length === 0 && last.road === "" && last.door === "");
    } finally {
      agents.standInForModels(undefined);
      await stop(host);
    }
  },
  async W54() { // a great person's ways lost for good (2026-11-05, the rulebook-silence samples): the rulebook gives a Great Prophet its holy site, founding and
    // enhancing only "if it hasn't used other actions yet", and the engine's check is that it has acted at all. A spent prophet's lines said nothing of them, and three
    // audiences promised its holy site. Planted on Japan at T100: a prophet that has spread the faith twice, on Kyoto's centre, and a fresh one on Tokyo's
    let spent = 0, fresh = 0;
    const host = await start("t100-world", "", undefined, (game) => {
      const prophet = (x: number, y: number, used?: Record<string, number>) => {
        const tile = game.tileMap.tileList.find((each: any) => (each.position?.x ?? 0) === x && (each.position?.y ?? 0) === y);
        game.lastUnitId += 1;
        tile.civilianUnit = { owner: "Japan", originalOwner: "Japan", name: "Great Prophet", id: game.lastUnitId, currentMovement: 2, ...(used && { abilityToTimesUsed: used }) };
        return game.lastUnitId;
      };
      // Faith enough that the briefing gives religion in full, where the prophets are listed
      game.civilizations.find((civ: any) => civ.civName === "Japan").religionManager.storedFaith = 200;
      spent = prophet(11, 2, { "Can Spread Religion": 2 });
      fresh = prophet(15, 7);
    });
    try {
      const briefing = (await get("/briefing?civ=Japan")).json as { religion?: { prophetsAndMissionaries?: string[] } };
      const lines = briefing.religion?.prophetsAndMissionaries ?? [];
      const spentLine = lines.find((line) => line.startsWith(`Great Prophet #${spent}:`)) ?? "";
      const freshLine = lines.find((line) => line.startsWith(`Great Prophet #${fresh}:`)) ?? "";
      check("W54 the spent prophet's religion line says its holy site, founding and enhancing are closed for good", /Raising a Holy site, founding a religion and enhancing a religion are closed to it for good/.test(spentLine), spentLine);
      check("W54 and names what it did: it has already spread the faith", /closed to it for good: it has already spread the faith/.test(spentLine), spentLine);
      check("W54 a fresh prophet's religion line has nothing closed, and its holy site and founding are offered", !!freshLine && !/closed to it for good/.test(freshLine) && /can found our religion/.test(freshLine) && /can raise a Holy site/.test(freshLine), freshLine);
      const refused = await orders("Japan", { units: [{ unit: spent, action: "use", ability: "improvement" }] });
      const refusal = JSON.stringify(refused.json);
      check("W54 an order to raise the spent prophet's holy site is refused with the reason", /has no 'improvement' to use \(raising a Holy site, founding a religion and enhancing a religion are closed to it for good: it has already spread the faith\)/.test(refusal), refusal.slice(0, 400));
      // A turn played: each is caught as a great person awaiting orders, its ways in the log
      const turn = (await get("/state")).json.turn as number;
      await post("/advance", { turns: 1 });
      const log = (await logOf("Japan", turn)).map((entry) => entry.text);
      const spentLog = log.find((line) => line.includes(`Great Prophet #${spent} `) && line.includes("awaits orders")) ?? "";
      const freshLog = log.find((line) => line.includes(`Great Prophet #${fresh} `) && line.includes("awaits orders")) ?? "";
      check("W54 the spent prophet's ways say the holy site is closed for good, never what tile it needs, and its religion needs only a city to spread to", /closed to it for good: it has already spread the faith/.test(spentLog) && !/needs an unimproved tile/.test(spentLog) && !/improvement/.test(spentLog)
        && /religion needs a city of another faith to spread it to;/.test(spentLog) && !/to found or enhance/.test(spentLog), spentLog);
      check("W54 a fresh prophet off a tile of its own still gets what its holy site needs", /improvement \(it raises a Holy site[^)]*\)\)? needs an unimproved tile of ours outside a city to stand on/.test(freshLog) && !/closed to it for good/.test(freshLog), freshLog);
    } finally { await stop(host); }
  },
  async W55() { // end years (2026-11-05, brief data/briefs/end-years-2026-11-05.md): every end the briefing states is a year and how long from now, through the
    // game's own calendar, so a span is right where a turn's length changes inside it (the advisor multiplied the current turn's length: "about nine centuries"
    // for a friendship that ended 640 years off). Planted on Spain at T123: a friendship ten turns long, across the calendar's change of pace near T130
    let partner = "";
    const host = await start("run20-t123-spain-swordsman", "", undefined, (game) => {
      const spain = game.civilizations.find((each: any) => each.civName === "Spain");
      const majors = new Set(game.civilizations.filter((each: any) => !each.cityStateType && !["Barbarians", "Spectator", "Spain"].includes(each.civName) && (each.cities ?? []).length).map((each: any) => each.civName));
      partner = Object.keys(spain.diplomacy).find((name) => majors.has(name))!;
      const other = game.civilizations.find((each: any) => each.civName === partner);
      for (const [manager] of [[spain.diplomacy[partner]], [other.diplomacy.Spain]]) manager.flagsCountdown = { ...(manager.flagsCountdown ?? {}), DeclarationOfFriendship: 10 };
    });
    try {
      const yearNumber = (year: string) => year.endsWith(" BC") ? -Number(year.slice(0, -3)) : Number(year.slice(3));
      const before = (await get("/state")).json as { turn: number; year: string };
      const briefing = (await get("/briefing?civ=Spain")).json as any;
      check("W55 the calendar line names no turn length and no quoted span", briefing.calendar === `Every date in this briefing is a year of the realm's calendar, with how long from now; it is now ${before.year}.`, briefing.calendar);
      const friendship = String(briefing.knownCivs?.find((each: any) => each.civ === partner)?.friendship ?? "");
      const told = /^in force until ((?:AD \d+|\d+ BC)), (\d+) years from now/.exec(friendship);
      check("W55 a friendship is told as a year and how long from now", !!told, friendship);
      const policy = String(briefing.culture?.nextPolicy ?? "");
      check("W55 the next policy is a year and how long from now, with no 'a turn' pair and no turn count", /^(about (?:AD \d+|\d+ BC), (?:a year|\d+ years) from now|now|never, while the realm makes no culture)$/.test(policy) && briefing.culture?.turnsToNextPolicy === undefined, JSON.stringify(briefing.culture));
      const builds = (briefing.cities ?? []).map((city: any) => city.doneAbout).filter((done: unknown) => done !== null && done !== undefined);
      check("W55 each city's build is done about a year, never a count of turns", builds.length > 0 && builds.every((done: string) => /^((?:AD \d+|\d+ BC), (?:a year|\d+ years) from now|ongoing .*)$/.test(done)) && !(briefing.cities ?? []).some((city: any) => "turnsLeft" in city), JSON.stringify(builds).slice(0, 300));
      check("W55 the log's stamps are years", (briefing.log ?? []).length > 0 && (briefing.log as string[]).every((line) => /^(?:AD \d+|\d+ BC): /.test(line)), (briefing.log ?? []).slice(0, 3).join(" | "));
      const options = (await get("/options?civ=Spain")).json as any;
      const ready = (options.researchableNow ?? []).map((each: any) => each.readyAbout);
      check("W55 research is ready about a year, never a count of turns", ready.length > 0 && ready.every((when: string) => /^((?:AD \d+|\d+ BC), (?:a year|\d+ years) from now|now|never, .*)$/.test(when)), JSON.stringify(ready).slice(0, 200));
      // The calendar ten turns on, as the game reaches it: the friendship's year, and a span the current turn's length would have got wrong
      await post("/advance", { turns: 1 });
      const next = (await get("/state")).json as { year: string };
      await post("/advance", { turns: 9 });
      const after = (await get("/state")).json as { year: string };
      const pace = yearNumber(next.year) - yearNumber(before.year);
      check("W55 the friendship's year is the calendar's year ten turns on, and the span its distance", told?.[1] === after.year && Number(told?.[2]) === yearNumber(after.year) - yearNumber(before.year), `${friendship} / the year ten turns on: ${after.year}`);
      check("W55 the turn's length changes inside that span (the case the multiplication got wrong)", yearNumber(after.year) - yearNumber(before.year) !== 10 * pace, `${before.year} -> ${next.year} -> ${after.year}`);
    } finally { await stop(host); }
  },
  async W56() { // envoys (2026-11-07, brief data/briefs/envoys-2026-11-07.md): words from one court to another, with an offer, with an answer, or alone. At AD 1916
    // Germany offered gold for a war on the Maya and only the terms reached the other courts. Planted on the run32-t216 world: Germany and England advised, and
    // Siam's court taken out of host.json, so Siam is a power with no advisor to read words
    const dir = mkdtempSync(join(tmpdir(), "regress-run32-t216-peace-"));
    cpSync(join(FIXTURES, "run32-t216-peace"), dir, { recursive: true });
    const hostJson = JSON.parse(readFileSync(join(dir, "host.json"), "utf8"));
    delete hostJson.orders.Siam;
    writeFileSync(join(dir, "host.json"), JSON.stringify(hostJson));
    const host = await start("run32-t216-peace", "", dir);
    try {
      const game = (await get("/state")).json as { turn: number; majorCivs: { civ: string; alive: boolean }[] };
      const known = ((await get("/briefing?civ=Germany")).json.knownCivs ?? []) as { civ: string }[];
      const unadvised = known.map((each) => each.civ).find((name) => !["England", "Germany", "Japan"].includes(name) && game.majorCivs.some((each) => each.civ === name && each.alive));
      // 0. A peace carries no words of its own: Japan's offer of peace waits on England's desk (the fixture's), and an envoy from Japan is named on its entry
      const peaceBefore = ((await get("/briefing?civ=England")).json.peaceOffers ?? []) as string[];
      await orders("Japan", { envoy: [{ to: "England", words: "We stop at the strait; the islands are enough." }] });
      const peaceAfter = ((await get("/briefing?civ=England")).json.peaceOffers ?? []) as string[];
      check("W56 an envoy beside a waiting peace is named on the peace offer's entry", peaceBefore.some((line) => line.startsWith("Japan offers")) && !peaceBefore.some((line) => /envoy/.test(line))
        && peaceAfter.some((line) => line.startsWith("Japan offers") && line.endsWith(" - an envoy from Japan's court waits beside it, with words (envoys)")), `${JSON.stringify(peaceBefore)} -> ${JSON.stringify(peaceAfter)}`);
      const OFFER = "Japan grows on the sea; a little gold now keeps our friendship warm.";
      const ANSWER = "We thank you, but England takes no gold it has not earned.";
      const ENVOY = "Should Japan reach for our coast, we will not sit still. Will you?";
      // 1. An offer with words: the reply says they go with it, and the waiting offer carries them verbatim in England's briefing
      const offered = await orders("Germany", { trade: [{ with: "England", give: [{ item: "Gold", amount: 10 }], words: OFFER }] });
      check("W56 an offer with words to an advised court: proposed, and the reply says the words go with it as written", (offered.json.done ?? []).some((line: string) => /^Proposed to England/.test(line) && line.includes("(Your words go with it to England's court, as you wrote them.)")), JSON.stringify(offered.json));
      const waiting = ((await get("/briefing?civ=England")).json.tradeOffers ?? []) as string[];
      check("W56 England's briefing carries the offer's words verbatim, marked as Germany's", waiting.some((line) => line.startsWith("Germany: ") && line.includes(`with words from Germany's court, as written: “${OFFER}”`)), JSON.stringify(waiting));
      check("W56 Germany's own log says the words went with the offer", (await logOf("Germany", game.turn)).some((line) => line.text.includes(`We proposed a trade to England`) && line.text.endsWith(`, with the words: “${OFFER}”`)));
      // 2. The bookkeeping enters it: the summons line carries the words, and it wakes England's advisor as an advised court's offer always has
      const first = (await post("/advance", { turns: 1, wake: true })).json as { wake?: Record<string, string[]> };
      const summons = (await logOf("England", game.turn)).find((line) => /^Germany \(an advised court\) offers a deal/.test(line.text));
      check("W56 the summons line carries the words", !!summons && summons.text.includes(`; with the words: “${OFFER}” It waits for your answer`), summons?.text);
      check("W56 and it wakes England's advisor, as an advised court's offer does", (first.wake?.England ?? []).some((line) => line.includes(OFFER)), JSON.stringify(first.wake?.England));
      // 3. A refusal with words: Germany's line on the answer carries them
      const refused = await orders("England", { answerOffers: [{ power: "Germany", answer: "refuse", terms: "we give nothing; they give Gold x10", words: ANSWER }] });
      check("W56 a refusal with words: refused, and the reply says the words go back", (refused.json.done ?? []).some((line: string) => /^Refused Germany's offer/.test(line) && line.includes("(Your words go with it to Germany's court, as you wrote them.)")), JSON.stringify(refused.json));
      const back = (await logOf("Germany", game.turn)).find((line) => /^Our proposal to England .* was refused/.test(line.text));
      check("W56 Germany's log line on the answer carries England's words", !!back && back.text.endsWith(`; with England's words: “${ANSWER}”`), back?.text);
      // 4. An envoy alone: in the briefing's envoys at once, told once in the log at the bookkeeping, no wake, and gone after the desk's wait
      const sent = await orders("England", { envoy: [{ to: "Germany", words: ENVOY }] });
      check("W56 an envoy alone is sent, and a second one the same year is refused", (sent.json.done ?? []).some((line: string) => /^An envoy carries your words to Germany's court/.test(line))
        && ((await orders("England", { envoy: [{ to: "Germany", words: "Again." }] })).json.failed ?? []).some((line: string) => /already left this year/.test(line)), JSON.stringify(sent.json));
      const fresh = ((await get("/briefing?civ=Germany")).json.envoys ?? []) as { from: string; words: string; sent: string; note: string }[];
      check("W56 the envoy waits in Germany's briefing with who sent it, when, and its words verbatim", fresh.length === 1 && fresh[0].from === "England" && fresh[0].words === ENVOY && /^(?:AD \d+|\d+ BC)$/.test(fresh[0].sent) && /just arrived/.test(fresh[0].note), JSON.stringify(fresh));
      const turn2 = (await post("/advance", { turns: 1, wake: true })).json as { wake?: Record<string, string[]> };
      const told = (await logOf("Germany", game.turn)).filter((line) => line.text.includes(ENVOY) && /^England's court sends word by envoy/.test(line.text));
      check("W56 the envoy is told in Germany's log once, in the sender's words", told.length === 1, JSON.stringify(told));
      check("W56 an envoy wakes no one mid-age: it is read at the next look-in", !JSON.stringify(turn2.wake ?? {}).includes(ENVOY), JSON.stringify(turn2.wake));
      // Kept across a restart, as the desk is
      await stop(host);
      const again = await start("run32-t216-peace", "", host.dir);
      try {
        const kept = ((await get("/briefing?civ=Germany")).json.envoys ?? []) as { words: string; note: string }[];
        check("W56 after a restart the envoy still waits, with its lapse dated", kept.length === 1 && kept[0].words === ENVOY && /stays in the briefing until (?:AD \d+|\d+ BC), /.test(kept[0].note), JSON.stringify(kept));
        // The desk's wait (DESK_WAITS, 8 turns) from the bookkeeping that told it; an advance may stop early on the world's news, so one turn at a time
        const arrived = told[0]?.turn ?? game.turn + 2;
        let at = (await get("/state")).json.turn as number;
        const stays: number[] = [];
        for (let step = 0; step < 14 && at < arrived + 9; step++) { if (((await get("/briefing?civ=Germany")).json.envoys ?? []).length) stays.push(at); await post("/advance", { turns: 1 }); at = (await get("/state")).json.turn; }
        const later = (await get("/briefing?civ=Germany")).json;
        check("W56 the envoy stays the desk's wait from its telling, then leaves the briefing, told no second time", Math.max(...stays) === arrived + 7 && (later.envoys ?? []).length === 0 && (await logOf("Germany", game.turn)).filter((line) => line.text.includes(ENVOY)).length === 1, JSON.stringify(later.envoys));
        // 5. Words to an unadvised power: the trade goes, the words are dropped and the reply says so; an envoy alone is refused
        if (unadvised) {
          const toAi = await orders("Germany", { trade: [{ with: unadvised, give: [{ item: "Gold", amount: 5 }], words: "For your trouble." }] });
          check("W56 words with an offer to an unadvised power: the offer goes, the reply says the words were not carried", (toAi.json.done ?? []).some((line: string) => line.startsWith(`Proposed to ${unadvised}`) && line.includes(`(${unadvised} has no advisor at court to read words: yours were not carried.)`)), JSON.stringify(toAi.json));
          const envoyAi = await orders("Germany", { envoy: [{ to: unadvised, words: "Hear us." }] });
          check("W56 an envoy to an unadvised power is refused with that reason", (envoyAi.json.failed ?? []).some((line: string) => line.includes(`${unadvised} has no advisor at court to read words: no envoy was sent`)), JSON.stringify(envoyAi.json));
        } else check("W56 the fixture has an unadvised power Germany has met", false, JSON.stringify(known));
        const long = await orders("Germany", { envoy: [{ to: "England", words: "x ".repeat(250) }] });
        check("W56 words past a line or two are refused, and no envoy goes", (long.json.failed ?? []).some((line: string) => /at most 400 characters/.test(line)) && ((await get("/briefing?civ=England")).json.envoys ?? []).length === 0, JSON.stringify(long.json));
        // 7. An answered offer's desk clock is forgotten at once, by the desk's own key (termsOf): since end-years the forget used the brief, whose dated end
        // never matched, and the clock stayed until the bookkeeping swept it
        const clocks = () => Object.keys(JSON.parse(readFileSync(join(dir, "host.json"), "utf8")).diplomacy?.dealOfferedOn ?? {}).filter((key) => key.startsWith("England<Germany: "));
        await orders("Germany", { trade: [{ with: "England", give: [{ item: "Gold per turn", amount: 1 }] }] });
        await post("/advance", { turns: 1 });
        const entered = clocks();
        const dated = (((await get("/briefing?civ=England")).json.tradeOffers ?? []) as string[]).find((line) => line.startsWith("Germany: ") && /Gold per turn/.test(line)) ?? "";
        const terms = dated.slice("Germany: ".length).replace(/ \((?:waits until|lapses in) .*$/, "");
        await orders("England", { answerOffers: [{ power: "Germany", answer: "refuse", terms }] });
        check("W56 an answered offer's desk clock is forgotten at once, though its terms carry a dated end", entered.length === 1 && / - until (?:AD \d+|\d+ BC)/.test(terms) && clocks().length === 0, `entered ${JSON.stringify(entered)}; terms ${terms}; after ${JSON.stringify(clocks())}`);
      } finally { await stop(again); }
    } finally { await stop(host); }
  },
  async W57() { // the emergency letter's age (2026-11-07, from the dismissal-gate brief's finding): at AD 1942 an urgent council's letter went out with the plain map,
    // because the emergency letter never asked for the age. It now carries the age so far, from the round's start to the stop, and the dispatch paints the
    // campaign map from it; a failed /age leaves the plain map and is logged. The round runs on the real host of t100-world, its first advance stopped by war news
    const host = await start("t100-world");
    const agents = await import("../src/agents.ts");
    const { state } = await import("../src/store.ts");
    const { playRound } = await import("../src/round.ts");
    const hostApi = (await import("../src/host.ts")).host as any;
    const realAdvance = hostApi.advance, realAge = hostApi.age;
    try {
      const game = (await get("/state")).json as { year: string; majorCivs: { civ: string; alive: boolean }[] };
      const [ours, other] = game.majorCivs.filter((each) => each.alive).map((each) => each.civ);
      agents.standInForModels((asked) => ({ text: "Stand-in.", data: { summons: "War, Majesty.", dispatch: "The enemy marches.", question: "Do we fight?", journal: "War came.", image: null } }));
      state.phase = "audience";
      state.pendingRound = undefined;
      state.seats = [{ civ: ours, bot: 0, chatId: 4242, rulerName: "the ruler", will: "", journal: [], chat: [], ready: true, character: { name: "Adiega", title: "Steward", sheet: "Careful." } } as any];
      // The first advance plays its turns and comes back stopped by war news, with the age not yet run out
      hostApi.advance = async (...args: unknown[]) => ({ ...(await realAdvance(...args)), stoppedEarly: `${other} has declared war on ${ours}!`, declaredBy: other });
      const run = async () => {
        const dispatched: any[] = [], logged: string[] = [];
        await playRound(state.seats, { working: (_seat, work) => work, dispatch: async (_seat, dispatch) => { dispatched.push(dispatch); }, notice: async () => {}, chronicle: async () => {}, log: (...args) => logged.push(args.join(" ")) });
        return { dispatched, logged };
      };
      const first = await run();
      const urgent = first.dispatched[0];
      check("W57 an urgent stop's letter carries the age so far, from the round's start", /^Emergency council/.test(urgent?.heading ?? "") && !!urgent?.age && Array.isArray(urgent.age.marches), JSON.stringify(urgent ? { heading: urgent.heading, age: urgent.age && Object.keys(urgent.age) } : first.logged.slice(-4)));
      check("W57 and the dispatch paints the campaign map from an age that came, the plain map only without one", /traced\.then\(\(png\) => \{ if \(!age\) log\(`\$\{seat\.civ\}: no age summary came with the letter; plain map painted`\); return png && age \? campaignMap\(seat\.civ, age, png\) : paintedMap\(seat\.civ\); \}\)/.test(readFileSync("src/index.ts", "utf8")));
      // A failed /age: the letter still goes, without an age, and the failure is logged
      state.phase = "audience"; state.pendingRound = undefined; state.seats[0].ready = true;
      hostApi.age = async () => { throw new Error("planted /age failure"); };
      const second = await run();
      check("W57 a failed /age: the emergency letter still goes, without an age, and the failure is logged", second.dispatched.length === 1 && second.dispatched[0].age === undefined && second.logged.some((line) => line.startsWith(`the age summary for ${ours} failed: planted /age failure`)), second.logged.filter((line) => /age summary/.test(line)).join(" | "));
    } finally {
      hostApi.advance = realAdvance; hostApi.age = realAge;
      state.pendingRound = undefined; state.ageStarts = undefined; state.phase = "audience"; // what the stopped rounds left, not for the next case
      agents.standInForModels(undefined);
      await stop(host);
    }
  },
  async W58() { // picture captions (2026-11-07, brief data/briefs/picture-captions-2026-11-07.md): every caption is a heading line, a blank line, then the body -
    // the set heading where the code sets one, the writer's own title otherwise; the age picture's sentence says the age, not the entry; and a face is taken
    // for the whole game (the Atomic airfield was painted twice, AD 1870 and AD 1938). On the real host of t100-world; no model is asked: a stand-in answers
    const host = await start("t100-world");
    const agents = await import("../src/agents.ts");
    const store = await import("../src/store.ts");
    const { host: api } = await import("../src/host.ts");
    const { state } = store;
    const game = (await get("/state")).json as { year: string; turn: number; majorCivs: { civ: string; alive: boolean; era: string }[] };
    const [ours, other] = game.majorCivs.filter((each) => each.alive).map((each) => each.civ);
    const saved = { pictures: state.pictures, ageStarts: state.ageStarts, hostState: api.state };
    const calls: { systemPrompt: string; prompt: string; outputSchema?: Record<string, unknown> }[] = [];
    let answer: unknown = {};
    agents.standInForModels((asked) => { calls.push(asked); return { text: "", data: answer }; });
    const logged: string[] = [];
    const log = (...args: unknown[]) => logged.push(args.join(" "));
    const round = { fromTurn: game.turn - 12, turn: game.turn, fromYear: "AD 1", year: game.year, rankings: [],
      publicEvents: [{ turn: game.turn, year: "AD 900", text: `${ours} entered the Renaissance era with the learning of Astronomy.` }] } as any;
    try {
      // The helpers: one mechanism, the break stored in the caption
      check("W58 a writer's caption: its first sentence the heading (no full stop), a break, then the rest", store.headed("The goat consul. A goat sat in the senate. It voted twice.") === "The goat consul\n\nA goat sat in the senate. It voted twice."
        && store.headed("A title alone") === "A title alone" && store.headed("Heading\n\nA body. Its second sentence.") === "Heading\n\nA body. Its second sentence." && store.captioned("Angkor Wat, completed by the Maya in AD 650") === "Angkor Wat, completed by the Maya in AD 650");
      check("W58 a caption on one line for the writers' lists: the break a full stop and a space", store.oneLine("The goat consul\n\nA goat sat in the senate.") === "The goat consul. A goat sat in the senate." && store.oneLine("Heading?\n\nBody.") === "Heading? Body.");
      check("W58 a note: after the body, or as the body under a heading alone", store.withNote("Angkor Wat, completed by the Maya in AD 650", "Its builders gain a free policy.") === "Angkor Wat, completed by the Maya in AD 650\n\nIts builders gain a free policy."
        && store.withNote("Heading\n\nBody", "Note.") === "Heading\n\nBody. Note." && store.withNote("Heading\n\nBody", "") === "Heading\n\nBody");
      // The age picture: the heading set, the sentence alone; an earlier age's picture of the same era, two ages back, is a taken face
      state.ageStarts = [game.turn - 24, game.turn - 12];
      const oldFace = { turn: 1, year: "AD 500", for: "chronicle", caption: `${other} enter the Renaissance era, AD 500. The printers. Presses ran all night.`, description: "Oil painting. A printing shop by the river." };
      const otherAge = { turn: 1, year: "AD 300", for: "chronicle", caption: `${other} enter the Medieval, AD 300\n\nThe monks copied.`, description: "Oil painting. A scriptorium." };
      state.pictures = [oldFace, otherAge];
      answer = { caption: "Counting houses opened on every quay, and the river carried ledgers as often as grain.", description: "Oil painting. A quay of counting houses.", year: "AD 905" };
      const aged = await agents.eraPictures(round, log);
      const eraCall = calls.at(-1)!;
      const block = eraCall.prompt.slice(eraCall.prompt.indexOf("Painted for other peoples entering the Renaissance era earlier in this game"), eraCall.prompt.indexOf("Pictures already painted in recent years"));
      check("W58 an age picture's caption: the heading set, without \"era\", a break, then the writer's sentence alone", aged.length === 1 && aged[0].caption === `${ours} enter the Renaissance, AD 900\n\nCounting houses opened on every quay, and the river carried ledgers as often as grain.`, JSON.stringify(aged));
      check("W58 an earlier age's picture of the same era is a taken face, on one line; another era's is not", block.includes(`- ${other} enter the Renaissance era, AD 500. The printers. Presses ran all night. - Oil painting. A printing shop by the river.`) && !block.includes("scriptorium")
        && !eraCall.prompt.slice(eraCall.prompt.indexOf("Pictures already painted in recent years")).includes("printing shop"), block);
      check("W58 the age's writer is told the heading names the entry, and not to restate the entry, the year or the learning; no title asked", /after a heading set for you that names who entered which age and when: write no title, only one sentence \(up to 25 words\) on what the age looked like in this place and what came of it there - never the entry into the age, its year, or the learning that opened it, again/.test(eraCall.systemPrompt)
        && !eraCall.systemPrompt.includes("a short title, a full stop") && /no title - never the entry into the age/.test(JSON.stringify(eraCall.outputSchema)), eraCall.systemPrompt.slice(-700));
      check("W59 no fixed list of faces: the writer is asked for one thing the age changed in daily life, and no face of the old lists is in the prompt (era-faces-list brief)", eraCall.systemPrompt.includes("Choose one face of the age, one thing it changed in daily life.")
        && !/the printing shop|the star-gazer's tower|the airfield|a temple's steps|the railway crowd|the computer hall|the castle walls going up|the factory floor/.test(eraCall.systemPrompt), eraCall.systemPrompt.slice(-900));
      // The tag still keeps an age from being painted twice: a caption with the break, and one from before it (with "era")
      for (const kept of [aged[0], { ...oldFace, caption: `${ours} enter the Renaissance era, AD 900. Old. Old sentence.` }]) {
        state.pictures = [kept];
        const before = calls.length;
        check(`W58 an age already painted is not painted again (${kept === aged[0] ? "the new caption" : "a caption from before"})`, (await agents.eraPictures(round, log)).length === 0 && calls.length === before);
      }
      // The victory: its title the heading, the Chronicler's sentence the body
      api.state = async () => ({ ...(await saved.hostState()), winner: ours, victoryType: "Scientific" });
      state.pictures = [];
      answer = { caption: "The world would remember the morning the sky was left behind.", description: "Photograph. A launch.", year: game.year };
      const won = await agents.victoryPictures({ ...round, stoppedEarly: `${ours} has won a Scientific victory` }, log);
      check("W58 the victory picture: its title the heading, a break, the sentence", won.length === 1 && won[0].caption === `${ours} wins the world: Scientific victory, ${game.year}\n\nThe world would remember the morning the sky was left behind.`, JSON.stringify(won));
      api.state = saved.hostState;
      // The oddity: the writer's first sentence the heading; the list it reads on one line; one painted before, in either form, is not painted again
      answer = { oddity: { caption: "The goat consul. A goat sat in the senate and voted twice.", description: "Etching. A goat on a bench.", year: game.year }, why: "stand-in" };
      const odd = await agents.oddityPictures(round, { campaigns: [], curiosities: [] }, [`${ours} enter the Renaissance, AD 900\n\nCounting houses opened.`], log);
      check("W58 an oddity: the writer's title the heading, a break, the sentence; the pictures going with the chapter on one line in its input", odd.length === 1 && odd[0].caption === "The goat consul\n\nA goat sat in the senate and voted twice." && odd[0].note === ""
        && calls.at(-1)!.prompt.includes(`Already going with this chapter (never the oddity):\n- ${ours} enter the Renaissance, AD 900. Counting houses opened.`), JSON.stringify(odd));
      for (const caption of [odd[0].caption, "The oddity of the age. The goat consul. A goat sat in the senate and voted twice."]) {
        state.pictures = [{ turn: 1, year: "AD 1", for: "chronicle", caption, description: "" }];
        check(`W58 an oddity painted before is not painted again (${caption.includes("\n") ? "the new caption" : "a caption from before"})`, (await agents.oddityPictures(round, { campaigns: [], curiosities: [] }, [], log)).length === 0 && logged.at(-1)?.startsWith("the Chronicler's oddity was painted before") === true, logged.at(-1));
      }
      // The lists the writers read: each caption on one line
      state.pictures = [{ turn: game.turn, year: game.year, for: "chronicle", caption: "The goat consul\n\nA goat sat in the senate.", description: "Etching." }];
      check("W58 the recent pictures list shows each caption on one line", store.recentPictures(["chronicle"]) === `${game.year}: The goat consul. A goat sat in the senate. - Etching.`, store.recentPictures(["chronicle"]));
      // The sends: the break goes as stored - the herald's with its note, the scene under the letter, the decision, the chapter's own images headed when made
      const index = readFileSync("src/index.ts", "utf8");
      check("W58 the herald sends the caption with its note through withNote; the chapter's images, the letter's scene and the decision (the painter's call or the fallback) are headed when made",
        /herald\.api\.sendPhoto\(chatId, new InputFile\(png!, "scene\.png"\), \{ caption: withNote\(picture\.caption, picture\.note\) \}\)/.test(index) && /\.\.\.image, caption: headed\(image\.caption\) \}/.test(index)
        && /caption: headed\(dispatch\.image\.caption\)/.test(index) && /const decided: Picture = \{ \.\.\.drawn, caption: headed\(drawn\.caption\) \};/.test(index));
    } finally { agents.standInForModels(undefined); state.pictures = saved.pictures; state.ageStarts = saved.ageStarts; api.state = saved.hostState; await stop(host); }
  },
  async W60() { // the mood block (2026-11-08, brief data/briefs/mood-block-2026-11-08.md): at every sign, its parts adding up to the figure; what a city founded
    // or taken would leave, against the engine itself (harness/mood-engine.jsh: addCity, puppetCity and annexCity on in-memory copies of the save); the last
    // copy of a luxury marked in ourLuxuries and in the trade options; the luxuries we lack as the powers offer them; the mood buildings, now or next; the warnings
    const host = await start("t100-world");
    const save = join(host.dir, "save.unciv");
    const brief = async (name: string) => (await get(`/briefing?civ=${civ(name)}`)).json;
    const [greece, babylon, iroquois] = [await brief("Greece"), await brief("Babylon"), await brief("Iroquois")];
    const fields = ["now", "parts", "aNewCity", "aTakenCity", "ourLuxuries", "luxuriesWeLack", "moodBuildings"];
    check("W60 the block at +6, -2 and +2, every field, right after happiness, and happinessBreakdown gone", [greece, babylon, iroquois].every((b) => fields.every((field) => b.mood?.[field] !== undefined) && b.happinessBreakdown === undefined
        && Object.keys(b).indexOf("mood") === Object.keys(b).indexOf("happiness") + 1) && greece.happiness === 6 && babylon.happiness === -2 && iroquois.happiness === 2,
      [greece, babylon, iroquois].map((b) => `${b.civ} ${b.happiness} ${Object.keys(b.mood ?? {}).join(",")}`).join(" | "));
    check("W60 the parts add up to the figure, with the city-states and natural wonders apart", [greece, babylon, iroquois].every((b) => Object.values(b.mood.parts as Record<string, number>).reduce((a, n) => a + n, 0) === b.happiness)
      && greece.mood.parts.cityStates === 3 && greece.mood.parts.naturalWonders === 1 && greece.mood.parts.other === undefined, JSON.stringify(greece.mood.parts));
    check("W60 now: the figure and the growth rule, either side of zero", greece.mood.now === "+6; below zero every city's growth is cut by three quarters, and at -10 none grows"
      && babylon.mood.now === "-2: below zero every city's growth is cut by three quarters, and production suffers; at -10 none grows", `${greece.mood.now} | ${babylon.mood.now}`);
    // The engine's own figures, for each realm and the three cities its block names
    const classpath = readFileSync(join(HOST_SH, "../data/classpath.txt"), "utf8").trim().split(":").filter((entry) => existsSync(entry)).join(":");
    const engine = (name: string, cities: string[]) => {
      const out = execFileSync("/opt/homebrew/opt/openjdk@21/bin/jshell", ["--class-path", classpath, resolve("harness/mood-engine.jsh")],
        { cwd: join(HOST_SH, "../unciv/android/assets"), env: { ...process.env, SAVE: save, CIV: name, CITIES: cities.join(",") }, encoding: "utf8", timeout: 120_000 });
      const value = (key: string) => Number(new RegExp(`^${key} (-?\\d+)`, "m").exec(out)?.[1]);
      return { now: value("now"), one: value("one"), two: value("two"), out,
        cities: Object.fromEntries(cities.map((city) => { const m = new RegExp(`^city ${city} puppet (-?\\d+) annexed (-?\\d+)`, "m").exec(out); return [city, m ? { puppet: Number(m[1]), annexed: Number(m[2]) } : undefined]; })) };
    };
    for (const b of [greece, babylon]) {
      const leaves = /one new city leaves ([+-]?\d+), two leave ([+-]?\d+)$/.exec(b.mood.aNewCity);
      const taken = [...(b.mood.aTakenCity as string).matchAll(/(?:: |; )([A-Z][\w' -]*?) \([^)]+\) ([+-]?\d+)(?: as a puppet,| and) ([+-]?\d+)/g)].map((m) => ({ city: m[1], puppet: Number(m[2]), annexed: Number(m[3]) }));
      const truth = engine(b.civ, taken.map((each) => each.city));
      check(`W60 ${b.civ}: what one and two new cities leave is what the engine's addCity leaves`, !!leaves && truth.now === b.happiness && Number(leaves[1]) === truth.one && Number(leaves[2]) === truth.two,
        `${b.mood.aNewCity.slice(-45)}; engine ${truth.now} -> ${truth.one}, ${truth.two}`);
      // The buildings the capture's roll takes included: the host plays the same seeded roll
      check(`W60 ${b.civ}: each of the three nearest cities, puppet and annexed, as the engine's puppetCity and annexCity leave it`, taken.length === 3 && taken.every((each) => {
          const real = truth.cities[each.city]; return !!real && each.puppet === real.puppet - truth.now && each.annexed === real.annexed - truth.now; }),
        `${JSON.stringify(taken)}; engine ${JSON.stringify(truth.cities)} from ${truth.now}`);
    }
    // The last copy: ours, one held, none traded in - marked where it is offered; a luxury with copies to spare is not
    const options = (await get(`/options?civ=Greece`)).json;
    const offered = (options.diplomacy.with as { weCanOffer: string[]; theyCanOffer: string[] }[]).flatMap((power) => power.weCanOffer);
    check("W60 ourLuxuries tells our own from the city-states', and marks each last copy", greece.mood.ourLuxuries === "Incense and Porcelain from city-states; Salt, Ivory, Sugar and Gems our own; Ivory, Sugar and Gems each the last copy: trading one away loses its +4", greece.mood.ourLuxuries);
    check("W60 weCanOffer marks a last copy, and not a luxury with copies to spare", offered.includes("Ivory (our last: trading it away loses its +4)") && offered.some((line) => /^Salt x\d+$/.test(line)) && !offered.some((line) => /^Salt.*our last/.test(line)),
      offered.filter((line) => /Ivory|Salt|Sugar|Gems/.test(line)).join(" | "));
    const theyOffer = new Set((options.diplomacy.with as { theyCanOffer: string[] }[]).flatMap((power) => power.theyCanOffer).map((line) => line.replace(/ x\d+$/, "")));
    const lacked = (greece.mood.luxuriesWeLack as string).replace(/^each \+4: /, "").split("; ").map((part) => part.split(" from ")[0]);
    check("W60 luxuriesWeLack: what each adds, then only luxuries a power we know offers, none of ours, each with who offers it", /^each \+4: [A-Z][\w ]+ from /.test(greece.mood.luxuriesWeLack)
      && lacked.length > 1 && lacked.every((name) => theyOffer.has(name) && !greece.mood.ourLuxuries.includes(name)), greece.mood.luxuriesWeLack);
    check("W60 moodBuildings: what can be raised now with its +N, and with none the next and the technology each waits for", greece.mood.moodBuildings === "Colosseum +2 (Argos)"
      && iroquois.mood.moodBuildings === "none to build now. Next: Notre Dame +10 (a wonder, once Physics is ours), Theatre +3 (in each city, once Printing Press is ours)", `${greece.mood.moodBuildings} | ${iroquois.mood.moodBuildings}`);
    // The warnings, shortened; an acknowledged one still folds to its first clause
    check("W60 the thin warning points at the block; the unhappy one is its first sentence", iroquois.warnings.includes("The people's mood is thin (+2): mood.aNewCity says what one more city would do.")
      && babylon.warnings.includes("The people are unhappy (-2): every city's growth is cut by three quarters while the mood is below zero, and production suffers - farming for food does little until the mood is mended."),
      [...iroquois.warnings, ...babylon.warnings].filter((line: string) => /mood|unhappy/.test(line)).join(" | "));
    const acknowledged = await orders("Iroquois", { acknowledge: ["The people's mood is thin"] });
    const folded = await brief("Iroquois");
    check("W60 an acknowledged thin warning folds to its first clause, as before", acknowledged.status === 200 && (folded.warningsAcknowledged ?? []).includes("The people's mood is thin (+2)") && !folded.warnings.some((line: string) => /mood is thin/.test(line)),
      JSON.stringify({ done: acknowledged.json.done, folded: folded.warningsAcknowledged }));
    await stop(host);
  },
  async W51() { // the court's close (2026-11-03): the whole bot runs here against a stand-in for Telegram and a stand-in advisor. A court the advisor
    // dismissed by its own call gets no loose-ends follow-up (a 600 BC list came after the closing, and the dismissal fired under it); a silent closing
    // pass tells the dismissal before it, the round waiting on the pass; a pass with a word for the ruler keeps the word first. Last: the bots poll on
    const host = await start("t100-world");
    const agents = await import("../src/agents.ts");
    const { state, remember } = await import("../src/store.ts");
    const { createServer } = await import("node:http");
    const game = (await get("/state")).json as { year: string; turn: number; majorCivs: { civ: string; alive: boolean }[] };
    const [ours, other] = game.majorCivs.filter((each) => each.alive).map((each) => each.civ);
    // The stand-in for Telegram, as probe-ending's: every message sent is kept, and an update waits for the advisor bot's next poll
    const sent: string[] = [];
    const markups: unknown[] = []; // each sent message's buttons, by its place in sent
    const menus: { command: string }[][] = [];
    const edits: { id: number; text: string; buttons: boolean }[] = [];
    const order: string[] = []; // every message and picture sent, in the order Telegram got them: a picture by its file name
    const actions: string[] = []; // messages sent, edits and typing, in the order Telegram got them (button taps, 2026-11-08)
    const queued: unknown[] = [];
    let updateId = 1;
    const telegram = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", async () => {
        const [, token, method] = (request.url ?? "").match(/^\/bot([^/]+)\/(\w+)/) ?? [];
        let params: Record<string, unknown> = {};
        try { params = body ? JSON.parse(body) : {}; } catch { /* a photo upload is multipart */ }
        const reply = (result: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ ok: true, result })); };
        if (method === "getMe") return reply({ id: Number(token.split(":")[0]), is_bot: true, first_name: `bot ${token}`, username: `bot_${token.split(":")[1]}` });
        if (method === "getUpdates") {
          if (token === "2:advisor" && queued.length) return reply(queued.splice(0));
          await sleep(200);
          return reply([]);
        }
        // As Telegram: a text past 4096 characters is refused whole
        if ((method === "sendMessage" || method === "editMessageText") && String(params.text ?? "").length > 4096) { response.statusCode = 400; response.setHeader("content-type", "application/json"); return response.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message is too long" })); }
        if (method === "sendMessage") { sent.push(String(params.text ?? "")); markups[sent.length - 1] = params.reply_markup; order.push(String(params.text ?? "")); }
        if (method === "sendPhoto") order.push(/;filename=([\w.-]+)\r\n/.exec(body)?.[1] ?? "a photo");
        if (method === "editMessageText") edits.push({ id: Number(params.message_id), text: String(params.text ?? ""), buttons: !!params.reply_markup });
        if (method === "sendMessage") actions.push(`send ${params.text}`);
        if (method === "editMessageText") actions.push(`edit ${params.message_id}${params.reply_markup ? " with buttons" : ""}: ${params.text}`);
        if (method === "editMessageReplyMarkup") actions.push(`buttons off ${params.message_id}`);
        if (method === "sendChatAction") actions.push("typing");
        if (method === "setMyCommands") menus.push(params.commands as { command: string }[]);
        if (method.startsWith("send")) return reply({ message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: Number(params.chat_id), type: "private" } });
        return reply(true);
      });
    });
    const tgPort = PORT + 1;
    await new Promise<void>((done) => telegram.listen(tgPort, "127.0.0.1", done));
    const say = (text: string) => queued.push({ update_id: updateId++, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private" }, from: { id: 7, is_bot: false, first_name: "Ruler" }, text,
      ...(text.startsWith("/") && { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] }) } });
    // A tap under a message: by default a bare one with no buttons kept; shownAt(i) is the message sent at sent[i], with its buttons, as Telegram hands it back
    const tap = (data: string, message: { id: number; text: string; markup?: unknown } = { id: 1, text: "Which brief, Majesty?" }) => queued.push({ update_id: updateId++, callback_query: { id: String(updateId), chat_instance: "1", data, from: { id: 7, is_bot: false, first_name: "Ruler" },
      message: { message_id: message.id, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private" }, text: message.text, ...(message.markup ? { reply_markup: message.markup } : {}) } } });
    const shownAt = (at: number) => ({ id: at + 1, text: sent[at], markup: markups[at] });
    const until = async (done: () => boolean, ms = 30_000) => { for (let waited = 0; !done() && waited < ms; waited += 100) await sleep(100); return done(); };
    const DISMISSED = "The court is dismissed. Until next time.";
    // Our seat, and another ruler's still in council, so that no round starts behind the dismissals
    const character = { name: "Adiega", title: "Steward", pronouns: "she/her", sheet: "A careful steward who says little." };
    state.phase = "audience";
    state.seats = [
      { civ: ours, bot: 0, chatId: 4242, rulerName: "the ruler", will: "", journal: [], chat: [], ready: false, character, clerk: { name: "Gisela", title: "Keeper of the Rolls", sheet: "Exact." } } as any,
      { civ: other, chatId: 4343, will: "", journal: [], chat: [], ready: false, character } as any,
    ];
    const seat = state.seats[0];
    // A letter that never went out before a restart: the bot sends it as it starts, with the briefs under it as under every letter
    seat.annals = [{ years: "AD 440 to AD 800", heading: "AD 800 - come to court.", story: "The story of the age.", door: "Do we hold the course?", undelivered: true }];
    const plant = (text: string, closing = false) => { seat.closing = closing || undefined; remember(seat, { from: "advisor", text }); };
    // The stand-in advisor: what a dismiss_court or loose_ends call would do, it does to the seat; each call notes what the ruler had been sent by then
    const calls: { said: string; sentBefore: number; ready: boolean; dismissedTold: boolean; served?: string[]; owedNote: boolean }[] = [];
    // The loose-ends follow-up's answer, set by each case: a list, "nothing is left loose" with no /onward of its own, or nothing at all
    let looseEnds = (): { text: string } => ({ text: "" });
    const briefs: { role: string; said: string; served?: string[]; actionsBefore?: number }[] = [];
    // /advisors (2026-11-07): the character writer's calls - the sheet shortened to a card, and the candidates drafted, each numbered - and a new advisor's greeting
    const shortenings: string[] = [];
    let drafted = 0;
    agents.standInForModels((asked) => {
      if (asked.role === "character") {
        if (/Shorten it to the card/.test(asked.systemPrompt)) { shortenings.push(asked.prompt); return { text: "", data: { pitch: "I count the grain and say little of it.", walk: "a keeper of granaries", manner: "sparing and exact" } }; }
        drafted++;
        return { text: "", data: { name: `Ninurta${drafted}`, title: "the Seer", pronouns: "he", pitch: `Pitch ${drafted}, in my own voice.`, sheet: `You are candidate ${drafted}.` } };
      }
      if (asked.role === "greeting") return { text: `I am candidate ${/You are candidate (\d+)/.exec(asked.systemPrompt)?.[1] ?? "?"}, at your service.` };
      if (asked.outputSchema) return { text: "", data: { caption: "The granary. Grain comes in.", description: "Oil painting. A granary.", year: game.year } }; // the decision's picture
      if (/asks you for a brief on/.test(asked.prompt)) { briefs.push({ role: asked.role, said: asked.prompt.slice(asked.prompt.lastIndexOf("The ruler asks you for a brief")), served: asked.served, actionsBefore: actions.length }); return { text: asked.role === "clerk" ? "Gisela, Keeper of the Rolls\nThe treasury holds 210 gold." : /a brief on our learning/.test(asked.prompt) ? "The academies lead the world.\n\nName any you want to raise, ask for a /brief, or /onward" : "The host is three spearmen and a catapult." }; }
      const said = asked.prompt.slice(asked.prompt.lastIndexOf("The ruler now says:"));
      calls.push({ said, sentBefore: sent.length, ready: seat.ready, dismissedTold: sent.includes(DISMISSED), served: asked.served, owedNote: asked.prompt.includes("its orders are not set yet") });
      // The closing-only guard's ask (2026-11-07): the closing proper, answering the ruler's words; for the doubt, with the loose ends; for the bare tail, without
      if (/only the closing line/.test(said)) {
        if (/Do as you see fit/.test(said)) return { text: "Then the granary goes up before the walls. Kyoto eats this winter, and the walls follow in spring." };
        if (/not sure they will accept/.test(said)) return { text: `Yes, then: the offer goes to the Maya this year. They may well refuse, being so much stronger, and we lose nothing by asking.\n\nLeft loose:\n1. Spare gold goes to the walls\n2. The idle Great Scientist settles in Kyoto's academy\n\nName any you want to raise, ask for a /brief, or /onward` };
        return { text: "The granary first, Majesty, then the walls. Kyoto eats before it arms." };
      }
      if (/The ruler now says:\n1$/.test(said)) return { text: "The spare gold, then: the walls want 120 and a market 90. Which shall it be, Majesty?" };
      if (/Tail alone/.test(said)) return { text: "Name any you want to raise, ask for a /brief, or /onward" };
      if (/not sure they will accept/.test(said)) { Object.assign(seat, { matters: [{ item: "Spare gold", lean: "goes to the walls" }, { item: "An idle Great Scientist", lean: "settles in Kyoto's academy" }], closing: true }); return { text: "Both loose ends are listed.\n\nName any you want to raise, ask for a /brief, or /onward" }; }
      if (/Do as you see fit/.test(said)) { seat.dismissed = true; return { text: "Very well." }; }
      if (/The ruler now says:\nGo on\.$/.test(said)) return { text: "Learning stays our road. I will send the warrior east and buy Kyoto its granary." };
      if (/Do it all/.test(said)) { seat.dismissed = true; return { text: "Walls and granary both, then. The gold goes to the walls first.\n\nName any you want to raise, ask for a /brief, or /onward" }; }
      if (/Sounds good, do that/.test(said)) { seat.dismissed = true; return { text: "Then the granary first and the walls after; Kyoto grows before it arms. The warrior stays home." }; }
      if (/Carry on then/.test(said)) return { text: "The granary first, then the walls. Anything else, or shall we go on? /onward" };
      if (/That will do/.test(said)) return { text: "Then the granary. Kyoto eats first.\n\n/onward" };
      if (/As you say/.test(said)) return { text: "As you say: the granary. The walls wait.\n/onward" };
      if (/So be it/.test(said)) return { text: "Walls it is. Kyoto waits for its granary.\n\nName any you want to raise, ask for a /brief, or /onward" };
      if (/Fine by me/.test(said)) { Object.assign(seat, { matters: [{ item: "Spare gold", lean: "goes to the walls" }], closing: true }); return { text: "The granary first.\n\nLeft loose:\n1. Spare gold goes to the walls\n\nName any you want to raise; otherwise\n/onward" }; }
      if (/without weighing the loose ends/.test(said)) return looseEnds();
      if (/dismisses the court without another word/.test(said)) return { text: /leaving the loose ends to you/.test(said) ? "Settled as listed." : "I went with the granary, for the winter." };
      return { text: "Granary or walls, Majesty?" };
    });
    Object.assign(process.env, { HERALD_BOT_TOKEN: "1:herald", ADVISOR_1_BOT_TOKEN: "2:advisor", TELEGRAM_API_ROOT: `http://127.0.0.1:${tgPort}`, PAINTED_MAPS: "off" });
    try {
      const bots = await import("../src/index.ts");
      await until(() => sent.includes("AD 800 - come to court.\n\nThe story of the age.\n\nDo we hold the course?"));
      // The letter ends on the door's question, with no buttons under it to divert from it (Olle, 2026-11-07): the one resent at a restart, and the round's own
      const letterAt = sent.indexOf("AD 800 - come to court.\n\nThe story of the age.\n\nDo we hold the course?");
      const source = readFileSync("src/index.ts", "utf8");
      check("W51 a letter arrives with no buttons - the one resent at a restart, and the round's own; only /brief posts the briefs' buttons", letterAt >= 0 && markups[letterAt] === undefined
        && /await bot\.api\.sendMessage\(chatId, post\.letter\)/.test(source) && source.match(/reply_markup: briefButtons\(\)/g)?.length === 1, JSON.stringify(markups[letterAt]));
      // A: closed with the /onward line and no list weighed: the follow-up is asked, once, and the ruler gets one message - the closing without its /onward,
      // then the list with its own (AD 1655: two messages in a row, each ending on /onward); the transcript keeps that one message, once, as the closing
      const asked = (from: number) => calls.slice(from).filter((each) => /without weighing the loose ends/.test(each.said)).length;
      const listed = "Two things I'd settle on my own once the court rises:\n1. The idle Great Scientist settles in Kyoto's academy\n2. Spare gold goes to the walls\n\nName any you want to raise, ask for a /brief, or /onward";
      looseEnds = () => { Object.assign(seat, { matters: [{ item: "An idle Great Scientist", lean: "settles in Kyoto's academy" }, { item: "Spare gold", lean: "goes to the walls" }], closing: true }); return { text: listed }; };
      plant("Granary or walls, Majesty?");
      const beforeA = { calls: calls.length, sent: sent.length };
      say("Carry on then.");
      await until(() => asked(beforeA.calls) > 0 && sent.length > beforeA.sent);
      await sleep(300);
      const one = `The granary first, then the walls. Anything else, or shall we go on?\n\n${listed}`;
      check("W51 a closing with no list weighed is asked once for the loose ends, and the ruler gets one message: the closing, then the list ending on its /onward", asked(beforeA.calls) === 1 && JSON.stringify(sent.slice(beforeA.sent)) === JSON.stringify([one])
        && sent.at(-1)!.endsWith("Name any you want to raise, ask for a /brief, or /onward") && sent.at(-1)!.match(/\/onward/g)!.length === 1, `asked ${asked(beforeA.calls)}; sent ${JSON.stringify(sent.slice(beforeA.sent))}`);
      check("W51 that one message is remembered once, as the advisor's closing, and the closing alone is not kept beside it", JSON.stringify(seat.chat.slice(-2)) === JSON.stringify([{ from: "ruler", text: "Carry on then." }, { from: "advisor", text: one, closing: true }])
        && !seat.chat.some((each: { text: string }) => each.text.startsWith("The granary first, then the walls. Anything else, or shall we go on? /onward")), JSON.stringify(seat.chat.slice(-3)));
      // A2: the follow-up finds nothing loose and gives no /onward of its own: the closing's goes back at the end
      looseEnds = () => { seat.matters = []; return { text: "Nothing is left loose." }; };
      seat.matters = undefined;
      const beforeA2 = { calls: calls.length, sent: sent.length };
      say("That will do.");
      await until(() => asked(beforeA2.calls) > 0 && sent.length > beforeA2.sent);
      await sleep(300);
      check("W51 nothing left loose and no /onward in the answer: one message, the closing's /onward put back at the end", JSON.stringify(sent.slice(beforeA2.sent)) === JSON.stringify(["Then the granary. Kyoto eats first.\n\nNothing is left loose.\n\n/onward"]), JSON.stringify(sent.slice(beforeA2.sent)));
      // A3: the follow-up comes back empty: the closing goes out as it was
      looseEnds = () => ({ text: "  " });
      seat.matters = undefined;
      const beforeA3 = { calls: calls.length, sent: sent.length };
      say("As you say.");
      await until(() => asked(beforeA3.calls) > 0 && sent.length > beforeA3.sent);
      await sleep(300);
      check("W51 an empty follow-up: the closing is sent as it was, once, and remembered once", JSON.stringify(sent.slice(beforeA3.sent)) === JSON.stringify(["As you say: the granary. The walls wait.\n/onward"]) && JSON.stringify(seat.chat.at(-1)) === JSON.stringify({ from: "advisor", text: "As you say: the granary. The walls wait.\n/onward" }),
        `${JSON.stringify(sent.slice(beforeA3.sent))}; ${JSON.stringify(seat.chat.at(-1))}`);
      // A4: a closing that weighed its loose ends itself is not asked: one message, unchanged
      seat.matters = undefined;
      const beforeA4 = { calls: calls.length, sent: sent.length };
      say("Fine by me.");
      await until(() => sent.length > beforeA4.sent);
      await sleep(300);
      check("W51 a closing that called loose_ends: no follow-up, one message unchanged", asked(beforeA4.calls) === 0 && JSON.stringify(sent.slice(beforeA4.sent)) === JSON.stringify(["The granary first.\n\nLeft loose:\n1. Spare gold goes to the walls\n\nName any you want to raise; otherwise\n/onward"]), JSON.stringify(sent.slice(beforeA4.sent)));
      // A5: a closing that ends on the fixed line, asked for its loose ends: the line ends the one message once, under the list
      looseEnds = () => { Object.assign(seat, { matters: [{ item: "Spare gold", lean: "goes to the walls" }], closing: true }); return { text: listed }; };
      seat.matters = undefined;
      const beforeA5 = { calls: calls.length, sent: sent.length };
      say("So be it.");
      await until(() => asked(beforeA5.calls) > 0 && sent.length > beforeA5.sent);
      await sleep(300);
      check("W51 a closing on the fixed line: one message, the closing, the list, and the fixed line once at the end", JSON.stringify(sent.slice(beforeA5.sent)) === JSON.stringify([`Walls it is. Kyoto waits for its granary.\n\n${listed}`])
        && sent.at(-1)!.split("Name any you want to raise").length === 2, JSON.stringify(sent.slice(beforeA5.sent)));
      // G1: a reply that is only the closing line is asked once for the closing proper (2026-11-07, data/briefs/closing-only-guard-2026-11-07.md; AD 1916:
      // "Both loose ends are listed." and the fixed line, the answer to the ruler's doubt gone into the plan). The closings above were never asked
      const guarded = (from: number) => calls.slice(from).filter((each) => /only the closing line/.test(each.said));
      check("W51 a closing with words of its own above its line is never asked for the closing", guarded(0).length === 0, guarded(0).map((each) => each.said.slice(0, 80)).join(" | "));
      looseEnds = () => { seat.matters = []; return { text: "Nothing is left loose." }; };
      seat.matters = undefined;
      const beforeG1 = { calls: calls.length, sent: sent.length };
      say("Tail alone, please.");
      await until(() => sent.length > beforeG1.sent);
      await sleep(300);
      const mended1 = `The granary first, Majesty, then the walls. Kyoto eats before it arms.\n\nNothing is left loose.\n\n${"Name any you want to raise, ask for a /brief, or /onward"}`;
      check("W51 a reply that is the closing line alone is asked once for the closing, in the court's voice with the ruler's words, and the loose ends follow on the mended reply: one message",
        guarded(beforeG1.calls).length === 1 && /They said:\nTail alone, please\./.test(guarded(beforeG1.calls)[0]?.said ?? "") && /This note is the court's, not the ruler's words/.test(guarded(beforeG1.calls)[0]?.said ?? "") && asked(beforeG1.calls) === 1
        && JSON.stringify(sent.slice(beforeG1.sent)) === JSON.stringify([mended1]) && JSON.stringify(seat.chat.slice(-2).map((each: { text: string }) => each.text)) === JSON.stringify(["Tail alone, please.", mended1]),
        `guarded ${guarded(beforeG1.calls).length}, asked ${asked(beforeG1.calls)}; sent ${JSON.stringify(sent.slice(beforeG1.sent))}; chat ${JSON.stringify(seat.chat.slice(-2))}`);
      seat.matters = undefined;
      const beforeG2 = { calls: calls.length, sent: sent.length };
      say("I say yes, but I'm not sure they will accept considering how much weaker they are.");
      await until(() => sent.length > beforeG2.sent);
      await sleep(300);
      const mended2 = `Yes, then: the offer goes to the Maya this year. They may well refuse, being so much stronger, and we lose nothing by asking.\n\nLeft loose:\n1. Spare gold goes to the walls\n2. The idle Great Scientist settles in Kyoto's academy\n\n${"Name any you want to raise, ask for a /brief, or /onward"}`;
      check("W51 \"Both loose ends are listed.\" over the closing line counts as nothing: asked once, the ruler gets the mended reply once, and it replaces the held one in the transcript",
        guarded(beforeG2.calls).length === 1 && asked(beforeG2.calls) === 0 && JSON.stringify(sent.slice(beforeG2.sent)) === JSON.stringify([mended2])
        && seat.chat.at(-1)?.text === mended2 && !seat.chat.some((each: { text: string }) => each.text.startsWith("Both loose ends are listed.")), `guarded ${guarded(beforeG2.calls).length}; sent ${JSON.stringify(sent.slice(beforeG2.sent))}`);
      // The dismissal gate (2026-11-07): "1" takes up loose end one of the closing just sent - the advisor has offered /onward, so dismiss_court is served,
      // but the word is no close: the court stays open and the loose end is talked over (seen: a court closed on the ruler's "1")
      const beforeG2b = { calls: calls.length, sent: sent.length };
      say("1");
      await until(() => sent.length > beforeG2b.sent);
      await sleep(300);
      check("W51 a ruler's \"1\" after a closing with loose ends leaves the court open: one reply, the loose end taken up, no dismissal", calls[beforeG2b.calls]?.served?.includes("dismiss_court") === true && !seat.ready && !seat.dismissed
        && JSON.stringify(sent.slice(beforeG2b.sent)) === JSON.stringify(["The spare gold, then: the walls want 120 and a market 90. Which shall it be, Majesty?"]), `served ${JSON.stringify(calls[beforeG2b.calls]?.served)}; sent ${JSON.stringify(sent.slice(beforeG2b.sent))}`);
      // H: brief commands (2026-11-05, data/briefs/brief-commands-2026-11-05.md). /brief posts the six as buttons, two rows of three; a tap asks the advisor,
      // read-only, and the ask and the brief join the transcript; a brief before the first word leaves the road and the matters waiting; mid-age the clerk answers
      // The menu (2026-11-07, data/briefs/menu-advisors-2026-11-07.md): set whole to these eight, in order - the age, the six briefs, the advisors
      const MENU = ["onward", "cities", "military", "science", "culture", "trade", "rivals", "advisors"];
      check("W51 Telegram's command menu is set whole to the eight, in order", menus.length === 1 && JSON.stringify(menus[0]?.map((each) => each.command)) === JSON.stringify(MENU)
        && menus[0]?.find((each) => each.command === "military")?.description === "A brief on the army and navy" && menus[0]?.find((each) => each.command === "advisors")?.description === "Your advisor, and others who would serve", JSON.stringify(menus));
      // Messages past Telegram's limit: Germany's will of 4319 characters left /will and /status sending nothing (2026-11-06). A will past the limit arrives
      // whole in more than one message, none past it, cut on a paragraph break; /status no longer carries the will
      const willParagraphs = Array.from({ length: 16 }, (_, at) => `My reading ${at + 1}: ${"the ruler wants the granaries kept full before any wall is raised, and the roads east kept open for trade. ".repeat(3).trim()}`);
      seat.will = willParagraphs.join("\n\n");
      const beforeL = sent.length;
      say("/will");
      await until(() => sent.length > beforeL + 1);
      await sleep(500);
      const willParts = sent.slice(beforeL);
      const lastOfFirst = willParts[0]?.split("\n\n").at(-1);
      check("W51 a will past 4096 characters: /will arrives whole in more than one message, none past the limit, cut on a paragraph break",
        seat.will.length > 4096 && willParts.length > 1 && willParts.every((part) => part.length <= 4096) && willParts.join("\n\n").endsWith(seat.will) && /^What Adiega has written down/.test(willParts[0])
        && willParagraphs.includes(lastOfFirst ?? "") && willParagraphs.includes(willParts[1]?.split("\n\n")[0] ?? ""), `${willParts.length} parts of ${willParts.map((part) => part.length).join(", ")}; first ends ${JSON.stringify(lastOfFirst?.slice(-60))}`);
      const beforeS = sent.length;
      say("/status");
      await until(() => sent.length > beforeS);
      await sleep(300);
      check("W51 /status arrives, one message: the year, no turn and no will", sent.length === beforeS + 1 && !sent[beforeS].includes("My reading") && !/will|turn/i.test(sent[beforeS]) && sent[beforeS].startsWith(`${game.year}. `), JSON.stringify(sent.slice(beforeS)));
      seat.will = "";
      const { partsOf, splitLongMessages } = await import("../src/longMessages.ts");
      // The clerk's answer is a draft edited as it grows; an answer past the limit is edited in as its first part, the rest sent after it with the buttons
      const { Bot: TestBot, InlineKeyboard: Keys } = await import("grammy");
      const editor = new TestBot("3:editor", { client: { apiRoot: `http://127.0.0.1:${tgPort}` } });
      splitLongMessages(editor);
      const beforeE2 = { sent: sent.length, edits: edits.length };
      await editor.api.editMessageText(4242, 77, willParagraphs.join("\n\n"), { reply_markup: new Keys().text("/advisor", "x") });
      const edited = edits.slice(beforeE2.edits), after = sent.slice(beforeE2.sent);
      check("W51 an edit past the limit: the draft is edited to the first part, the rest follows as a message with the buttons, nothing lost", edited.length === 1 && edited[0].id === 77 && !edited[0].buttons && after.length === 1 && !!markups[beforeE2.sent]
        && [edited[0]?.text, ...after].join("\n\n") === willParagraphs.join("\n\n") && [edited[0]?.text, ...after].every((part) => part.length <= 4096), `${JSON.stringify(edited.map((each) => each.text.length))}; sent ${after.map((part) => part.length)}`);
      const prose = Array.from({ length: 80 }, (_, at) => `Sentence ${at} runs on about the granary and the walls for a while.`).join(" ");
      const proseParts = partsOf(prose);
      check("W51 a text past the limit with no line break is cut at a sentence end, nothing lost", proseParts.length === 2 && proseParts.every((part) => part.length <= 4096) && proseParts[0].endsWith(".") && proseParts.join(" ") === prose,
        proseParts.map((part) => `${part.length}: ...${part.slice(-30)}`).join(" | "));
      seat.matters = undefined;
      const beforeH = sent.length;
      say("/brief");
      await until(() => sent.length > beforeH);
      const rows = (markups[beforeH] as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard;
      check("W51 /brief posts the six as buttons, two rows of three", JSON.stringify(rows?.map((row) => row.map((button) => button.callback_data))) === JSON.stringify([["brief:cities", "brief:military", "brief:science"], ["brief:culture", "brief:trade", "brief:rivals"]]), JSON.stringify(rows));
      const beforeH2 = { sent: sent.length, briefs: briefs.length, calls: calls.length, actions: actions.length };
      tap("brief:military", shownAt(beforeH));
      await until(() => sent.length > beforeH2.sent);
      await sleep(300);
      const military = briefs[beforeH2.briefs];
      // Button taps (2026-11-08, data/briefs/button-taps-2026-11-08.md): taken up, the message keeps its text, gains the label as its last line and loses its buttons
      const atTap = actions.slice(beforeH2.actions, military?.actionsBefore);
      check("W51 a brief tap: before the brief is written, the question is edited to its text with \"/military\" as the last line and no buttons, and typing is sent",
        atTap[0] === `edit ${beforeH + 1}: Which brief, Majesty?\n\n/military` && atTap.includes("typing") && !atTap.some((each) => each.startsWith("send")) && actions.slice(beforeH2.actions).includes("send The host is three spearmen and a catapult."), JSON.stringify(actions.slice(beforeH2.actions)));
      check("W51 a tap asks the advisor for that brief, read-only; the brief is sent once and starts no loose-ends pass", military?.role === "advisor" && /a brief on the host - its strength/.test(military.said) && JSON.stringify(military.served) === JSON.stringify(["get_briefing", "get_options", "look_up", "get_log"])
        && JSON.stringify(sent.slice(beforeH2.sent)) === JSON.stringify(["The host is three spearmen and a catapult."]) && calls.length === beforeH2.calls && !seat.ready, `${JSON.stringify(military)}; sent ${JSON.stringify(sent.slice(beforeH2.sent))}`);
      const beforeH2b = sent.length;
      say("/science");
      await until(() => sent.length > beforeH2b);
      check("W51 a brief that ends on the closing line has it taken off before it is sent and kept", sent.at(-1) === "The academies lead the world." && seat.chat.at(-1)?.text === "The academies lead the world.", JSON.stringify(sent.slice(beforeH2b)));
      seat.chat.splice(-2, 2); // the transcript check below is the military brief's
      check("W51 the ask and the brief join the transcript as the ruler's and the advisor's", JSON.stringify(seat.chat.slice(-2)) === JSON.stringify([{ from: "ruler", text: "/military" }, { from: "advisor", text: "The host is three spearmen and a catapult." }]), JSON.stringify(seat.chat.slice(-2)));
      Object.assign(seat, { road: "Learning stays our road.", agenda: ["The warrior walks east: I will send him."], ordersOwed: undefined });
      const beforeH3 = { sent: sent.length, briefs: briefs.length };
      say("/cities");
      await until(() => sent.length > beforeH3.sent);
      check("W51 a typed brief before the first word: the road and the matters still wait, no orders are owed", briefs[beforeH3.briefs]?.role === "advisor" && seat.road === "Learning stays our road." && seat.agenda?.length === 1 && seat.ordersOwed === undefined, JSON.stringify(briefs[beforeH3.briefs]));
      Object.assign(seat, { road: undefined, agenda: undefined });
      state.phase = "passing";
      const beforeH4 = { sent: sent.length, briefs: briefs.length };
      say("/trade");
      await until(() => sent.length > beforeH4.sent);
      check("W51 mid-age the clerk answers a brief, from the briefing, and the advisor is not called", briefs.slice(beforeH4.briefs).map((each) => each.role).join() === "clerk" && /from the briefing as it stands: the facts, no counsel - the advisor is governing/.test(briefs[beforeH4.briefs]?.said ?? "")
        && sent.at(-1) === "Gisela, Keeper of the Rolls\nThe treasury holds 210 gold." && seat.clerkChat?.at(-2)?.text === "/trade", `${JSON.stringify(briefs.slice(beforeH4.briefs))}; ${JSON.stringify(sent.slice(beforeH4.sent))}`);
      state.phase = "audience";
      // B: the advisor dismisses by its own call: no follow-up, the reply and then the dismissal
      seat.matters = undefined;
      const beforeB = { calls: calls.length, sent: sent.length };
      say("Sounds good, do that.");
      await until(() => sent.slice(beforeB.sent).includes(DISMISSED));
      const afterB = calls.slice(beforeB.calls).filter((each) => !/Sounds good/.test(each.said));
      check("W51 a court the advisor dismissed by its own call gets no follow-up: the closing, then the dismissal", afterB.length === 0 && JSON.stringify(sent.slice(beforeB.sent)) === JSON.stringify(["Then the granary first and the walls after; Kyoto grows before it arms. The warrior stays home.", DISMISSED]) && seat.ready,
        `calls after: ${afterB.map((each) => each.said.slice(20, 90)).join(" | ")}; sent: ${JSON.stringify(sent.slice(beforeB.sent))}`);
      // B2: dismissed by its own call under the fixed line: the whole line comes off, not the /onward alone
      Object.assign(seat, { ready: false, dismissed: false, matters: undefined });
      const beforeB2 = sent.length;
      say("Do it all.");
      await until(() => sent.slice(beforeB2).includes(DISMISSED));
      check("W51 a court the advisor dismissed under the fixed line: the closing goes out without that line, then the dismissal", JSON.stringify(sent.slice(beforeB2)) === JSON.stringify(["Walls and granary both, then. The gold goes to the walls first.", DISMISSED]), JSON.stringify(sent.slice(beforeB2)));
      // G3: a court the advisor dismissed on one short line still owes its closing: asked once, told to list nothing and give no /onward; then the dismissal
      Object.assign(seat, { ready: false, dismissed: false, matters: undefined });
      const beforeG3 = { calls: calls.length, sent: sent.length };
      say("Do as you see fit.");
      await until(() => sent.slice(beforeG3.sent).includes(DISMISSED));
      check("W51 a dismissal on one short line is asked once for the closing, with no list and no /onward: the mended closing, then the dismissal",
        guarded(beforeG3.calls).length === 1 && /You have closed the court: list no loose ends/.test(guarded(beforeG3.calls)[0]?.said ?? "")
        && JSON.stringify(sent.slice(beforeG3.sent)) === JSON.stringify(["Then the granary goes up before the walls. Kyoto eats this winter, and the walls follow in spring.", DISMISSED]), JSON.stringify(sent.slice(beforeG3.sent)));
      // C: a bare /onward under a closing with loose ends: the dismissal goes out before the silent pass, and the court rises only after it
      Object.assign(seat, { ready: false, dismissed: false, matters: [{ item: "An idle Great Scientist", lean: "settles in Kyoto's academy" }, { item: "Spare gold", lean: "goes to the walls" }] });
      plant("The granary first.\n\nLeft loose:\n1. An idle Great Scientist: he settles in Kyoto's academy\n2. Spare gold goes to the walls\n\nName any you want to raise; otherwise\n/onward", true);
      const beforeC = { calls: calls.length, sent: sent.length };
      say("/onward");
      await until(() => seat.ready);
      const pass = calls.slice(beforeC.calls).find((each) => /leaving the loose ends to you/.test(each.said));
      check("W51 a silent closing pass: the dismissal is told before it begins, and the court has not risen while it runs", !!pass && pass.dismissedTold && !pass.ready && pass.sentBefore === beforeC.sent + 1, JSON.stringify(pass));
      check("W51 the silent pass's answer is not sent, and the dismissal is told once", seat.ready && JSON.stringify(sent.slice(beforeC.sent)) === JSON.stringify([DISMISSED]), JSON.stringify(sent.slice(beforeC.sent)));
      // D: a bare /onward under an unanswered question: the advisor's word first, then the dismissal
      Object.assign(seat, { ready: false, dismissed: false, matters: undefined });
      plant("Granary or walls, Majesty?");
      const beforeD = sent.length;
      say("/onward");
      await until(() => seat.ready && sent.slice(beforeD).includes(DISMISSED));
      check("W51 a pass with a word for the ruler: the word, then the dismissal", JSON.stringify(sent.slice(beforeD)) === JSON.stringify(["I went with the granary, for the winter.", DISMISSED]), JSON.stringify(sent.slice(beforeD)));
      check("W51 no round started: the other ruler is still in council", state.phase === "audience" && !state.seats[1].ready);
      // E: a bare /onward straight after the letter (the open court, 2026-11-03): the matters were never asked for and the letter puts no question,
      // so no pass; the court rises, the agenda is cleared, and its defaults go to the journal for the look-ins
      Object.assign(seat, { ready: false, dismissed: false, matters: undefined, agenda: ["The lone warrior walks to the eastern hills, unless you want him home."] });
      (seat.annals ??= []).push({ years: "AD 440 to AD 800", story: "The story of the age, a question in it? Perhaps.", agenda: seat.agenda });
      remember(seat, { from: "advisor", text: "The story of the age, a question in it? Perhaps.", letter: true });
      const beforeE = { calls: calls.length, sent: sent.length };
      say("/onward");
      await until(() => seat.ready && sent.slice(beforeE.sent).includes(DISMISSED));
      check("W51 a bare /onward straight after the letter: dismissed, no closing pass, the agenda cleared and its defaults in the journal", calls.length === beforeE.calls && JSON.stringify(sent.slice(beforeE.sent)) === JSON.stringify([DISMISSED])
        && seat.agenda === undefined && /the ruler rose before hearing my matters; I do as I meant to with each: The lone warrior walks to the eastern hills/.test(seat.journal.at(-1) ?? ""), `calls ${calls.length - beforeE.calls}; sent ${JSON.stringify(sent.slice(beforeE.sent))}; journal ${seat.journal.at(-1)}`);
      // F: court form C - the reply to the first word tells what the advisor will do and is not served set_orders; the orders are owed, kept across a restart,
      // and a bare /onward under that reply, with no question in it and no loose ends, still gets the silent pass that sets them
      const letter = () => {
        Object.assign(seat, { ready: false, dismissed: false, matters: undefined, road: "Learning stays our road.", agenda: ["The warrior walks east: I will send him."] });
        seat.annals.push({ years: "AD 440 to AD 800", story: "Another age.", agenda: seat.agenda, course: seat.road });
        remember(seat, { from: "advisor", text: "Another age. Do we hold the course?", letter: true });
      };
      letter();
      const beforeF = { calls: calls.length, sent: sent.length };
      say("Go on.");
      await until(() => sent.slice(beforeF.sent).length > 0);
      const firstReply = calls[beforeF.calls];
      const kept = (JSON.parse(readFileSync(process.env.RULER_STATE_FILE!, "utf8")) as { seats: { civ: string; ordersOwed?: boolean }[] }).seats.find((each) => each.civ === ours);
      check("W51 the reply to the first word is not served set_orders, and the orders it told are owed - in the state file too, for a restart", !!firstReply && !firstReply.served?.includes("set_orders") && !firstReply.served.includes("dismiss_court") && seat.ordersOwed === true && kept?.ordersOwed === true && !seat.ready,
        `served ${JSON.stringify(firstReply?.served)}; owed ${seat.ordersOwed}; kept ${kept?.ordersOwed}`);
      say("/onward");
      await until(() => seat.ready);
      const owedPass = calls.slice(beforeF.calls + 1).find((each) => /dismisses the court without another word/.test(each.said));
      check("W51 a bare /onward after it: a silent pass is served set_orders and told to set the orders it told, then the court rises with none owed", !!owedPass?.served?.includes("set_orders") && /Set the orders for what you told them you will do in this audience/.test(owedPass.said) && owedPass.owedNote
        && JSON.stringify(sent.slice(beforeF.sent)) === JSON.stringify(["Learning stays our road. I will send the warrior east and buy Kyoto its granary.", DISMISSED]) && seat.ordersOwed === undefined, `${JSON.stringify(owedPass)}; sent ${JSON.stringify(sent.slice(beforeF.sent))}`);
      // G: a first word that comes with /onward is the ruler's last: that reply is served set_orders and owes nothing; the court rises on it
      letter();
      const beforeG = { calls: calls.length, sent: sent.length };
      say("Go on. /onward");
      await until(() => seat.ready && sent.slice(beforeG.sent).includes(DISMISSED));
      const lastWordReply = calls[beforeG.calls];
      check("W51 the guard asked three times in all - never for a brief, a short word mid-audience, the first word's reply or a silent pass", guarded(0).length === 3, guarded(0).map((each) => each.said.slice(0, 120)).join(" | "));
      check("W51 a first word with /onward: served set_orders, nothing owed, no pass, the court rises", !!lastWordReply?.served?.includes("set_orders") && calls.length === beforeG.calls + 1 && seat.ordersOwed === undefined && seat.ready,
        `served ${JSON.stringify(lastWordReply?.served)}; calls ${calls.length - beforeG.calls}; said ${lastWordReply?.said.slice(0, 120)}`);
      // /advisors (2026-11-07, data/briefs/menu-advisors-2026-11-07.md): in an open court, one message - the advisor's card, then three new candidates' cards -
      // and four buttons, "Take" each and "Keep" the advisor. An advisor chosen before the card was kept has the sheet shortened once, and kept
      Object.assign(seat, { ready: false, dismissed: false, closing: undefined });
      const advisorsMessage = async () => { const before = sent.length; say("/advisors"); await until(() => sent.length > before); await sleep(400); return { texts: sent.slice(before), markup: markups[before] as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined }; };
      const buttons = (markup?: { inline_keyboard: { text: string; callback_data: string }[][] }) => (markup?.inline_keyboard ?? []).flat().map((each) => each.text);
      const beforeV = { drafted, shortenings: shortenings.length };
      const shown = await advisorsMessage();
      const cards = (seat.candidates ?? []).map((each: { name: string; pitch: string; walk: string; manner: string }) => `${each.name}, the Seer (he)\n"${each.pitch}"\n${each.walk[0].toUpperCase()}${each.walk.slice(1)} - ${each.manner}.`);
      const advisorCard = 'Adiega, Steward (she/her)\n"I count the grain and say little of it."\nA keeper of granaries - sparing and exact.';
      check("W51 /advisors in an open court: one message, the advisor's card from the shortened sheet, then the three candidates' cards under the line that they would serve in her place",
        shown.texts.length === 1 && cards.length === 3 && drafted - beforeV.drafted === 3 && shortenings.length - beforeV.shortenings === 1
        && shown.texts[0] === `${advisorCard}\n\nThese three would serve in Adiega's place:\n\n${cards.join("\n\n")}`, JSON.stringify(shown.texts));
      check("W51 /advisors: four buttons - Take each of the three, then Keep the advisor", JSON.stringify(buttons(shown.markup)) === JSON.stringify([...seat.candidates!.map((each: { name: string }) => `Take ${each.name}`), "Keep Adiega"]), JSON.stringify(buttons(shown.markup)));
      const keptState = (JSON.parse(readFileSync(process.env.RULER_STATE_FILE!, "utf8")) as { seats: { civ: string; character?: { pitch?: string; walk?: string; manner?: string } }[] }).seats.find((each) => each.civ === ours);
      check("W51 the shortened card is kept on the character, in the state file too", seat.character.pitch === "I count the grain and say little of it." && keptState?.character?.walk === "a keeper of granaries" && keptState?.character?.manner === "sparing and exact", JSON.stringify(keptState?.character));
      const again = await advisorsMessage();
      check("W51 /advisors again: three new candidates, the sheet not shortened again", shortenings.length - beforeV.shortenings === 1 && drafted - beforeV.drafted === 6 && again.texts.length === 1 && again.texts[0].startsWith(advisorCard) && again.texts[0].includes("Ninurta6"), JSON.stringify(again.texts));
      const beforeK = sent.length;
      const beforeKa = actions.length;
      const againAt = sent.lastIndexOf(again.texts[0]);
      tap("advisors:keep", shownAt(againAt));
      await until(() => sent.length > beforeK);
      await sleep(300);
      check("W51 Keep: the card is edited with \"Keep Adiega\" as its last line and no buttons, then the one line", JSON.stringify(actions.slice(beforeKa)) === JSON.stringify([`edit ${againAt + 1}: ${again.texts[0]}\n\nKeep Adiega`, "send Adiega stays at your side."]), JSON.stringify(actions.slice(beforeKa)));
      check("W51 Keep: the advisor stays, the candidates are cleared, one line answers", seat.character.name === "Adiega" && seat.candidates === undefined && JSON.stringify(sent.slice(beforeK)) === JSON.stringify(["Adiega stays at your side."]), JSON.stringify(sent.slice(beforeK)));
      // Take: the existing replace path - the advisor goes to formerAdvisors, the will and the clerk stay, the greeting is sent and joins the transcript
      const third = await advisorsMessage();
      const thirdAt = sent.lastIndexOf(third.texts[0]);
      // A Take while time passes is only told to wait: the message keeps its buttons
      state.phase = "passing";
      const beforeW = { sent: sent.length, actions: actions.length };
      tap("advisors:take:1", shownAt(thirdAt));
      await until(() => sent.length > beforeW.sent);
      await sleep(300);
      state.phase = "audience";
      check("W51 a Take while time passes: the message is not edited, the wait line is sent, the candidates kept", JSON.stringify(actions.slice(beforeW.actions)) === JSON.stringify(["send Wait until time stops passing."]) && seat.candidates?.length === 3, JSON.stringify(actions.slice(beforeW.actions)));
      // But first a Take under the earlier message: it names one of that draw, and takes no one from this one
      const beforeOld = sent.length;
      const beforeOldA = actions.length;
      queued.push({ update_id: updateId++, callback_query: { id: String(updateId), chat_instance: "1", data: "advisors:take:0", from: { id: 7, is_bot: false, first_name: "Ruler" },
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: "private" }, text: again.texts[0], reply_markup: again.markup } } });
      await until(() => sent.length > beforeOld);
      check("W51 a Take under an earlier /advisors message takes no one from the later draw", seat.character.name === "Adiega" && seat.candidates?.length === 3 && JSON.stringify(sent.slice(beforeOld)) === JSON.stringify(["Those candidates have gone their way. Send /advisors to call others."]), JSON.stringify(sent.slice(beforeOld)));
      check("W51 a stale Take is finally refused: its message is edited with the label and no buttons, then the refusal", JSON.stringify(actions.slice(beforeOldA)) === JSON.stringify([`edit 1: ${again.texts[0]}\n\n${buttons(again.markup)[0]}`, "send Those candidates have gone their way. Send /advisors to call others."]), JSON.stringify(actions.slice(beforeOldA)));
      const taken = seat.candidates![1] as { name: string; pitch: string; walk?: string; manner?: string };
      const beforeT = { sent: sent.length, former: (seat.formerAdvisors ?? []).length, will: seat.will, clerk: JSON.stringify(seat.clerk), actions: actions.length };
      tap("advisors:take:1", shownAt(thirdAt));
      await until(() => sent.length > beforeT.sent && seat.character.name !== "Adiega");
      await sleep(400);
      const greeting = sent.slice(beforeT.sent).find((each) => each.includes("at your service"));
      check("W51 Take: the candidate replaces the advisor - formerAdvisors grows by one with Adiega, the will and the clerk kept, the card kept on the new character",
        seat.character.name === taken.name && (seat.formerAdvisors ?? []).length === beforeT.former + 1 && seat.formerAdvisors!.at(-1)!.name === "Adiega" && seat.will === beforeT.will && JSON.stringify(seat.clerk) === beforeT.clerk
        && seat.character.pitch === taken.pitch && seat.character.walk === taken.walk && seat.character.manner === taken.manner && seat.candidates === undefined, `${JSON.stringify(seat.character)}; former ${JSON.stringify(seat.formerAdvisors)}`);
      const tookAt = actions.slice(beforeT.actions);
      check("W51 Take: the card is edited with \"Take <name>\" as its last line and no buttons, before the greeting", tookAt[0] === `edit ${thirdAt + 1}: ${third.texts[0]}\n\nTake ${taken.name}` && tookAt.findIndex((each) => each.includes("at your service")) > 0, JSON.stringify(tookAt));
      check("W51 Take: the new advisor's greeting is sent and joins the transcript", !!greeting && greeting.startsWith(`I am candidate ${taken.name.slice("Ninurta".length)}, at your service.`) && seat.chat.some((each: { from: string; text: string }) => each.from === "advisor" && greeting.startsWith(each.text)) && !seat.ready, JSON.stringify(sent.slice(beforeT.sent)));
      const name = seat.character.name;
      const beforeStale = sent.length;
      tap("advisors:take:0");
      await until(() => sent.length > beforeStale);
      check("W51 a Take tapped after the candidates are gone changes nothing", seat.character.name === name && (seat.formerAdvisors ?? []).length === beforeT.former + 1 && JSON.stringify(sent.slice(beforeStale)) === JSON.stringify(["Those candidates have gone their way. Send /advisors to call others."]), JSON.stringify(sent.slice(beforeStale)));
      // Letter order (2026-11-08, data/briefs/letter-order-2026-11-08.md): the closing picture of the last audience, then the letter with its pictures. A
      // stand-in painter holds each closing picture until the case lets it go; the round's own loop sends each letter through deliverLetter
      const PNG = Buffer.from("png");
      const held: { resolve: (png: Buffer | null) => void; reject: (error: Error) => void }[] = [];
      bots.standInForPainter(() => new Promise<Buffer | null>((resolve, reject) => held.push({ resolve, reject })));
      const rise = async (word = "/onward") => {
        Object.assign(seat, { ready: false, dismissed: false, matters: undefined, decisionPicture: undefined });
        plant("Granary or walls, Majesty?");
        const paints = held.length;
        say(word);
        await until(() => seat.ready && held.length > paints);
        return held[paints];
      };
      const post = (text: string, scene: Promise<Buffer | null> = Promise.resolve(PNG)) => ({ seat, letter: text, caption: "A scene", scene, marches: Promise.resolve(PNG), painted: Promise.resolve(PNG) });
      const delivering = (letter: ReturnType<typeof post>) => ({ sending: bots.deliverLetter(letter) });
      try {
        // L1: an emergency council's letter, written while the dismissal's picture is still painting: nothing goes until the picture has been sent
        const closing1 = await rise();
        const beforeL1 = order.length;
        const war = await delivering(post("AD 900 - war with Russia."));
        await sleep(1500);
        const whileHeld = order.slice(beforeL1);
        closing1.resolve(PNG);
        await war.sending;
        check("W51 letter order: a letter written while the closing picture paints waits for it - nothing is sent until it is, then picture, letter, scene, marches, map",
          whileHeld.length === 0 && JSON.stringify(order.slice(beforeL1)) === JSON.stringify(["decision.png", "AD 900 - war with Russia.", "scene.png", "marches.png", "map.png"])
          && !/post\.urgent/.test(source) && /for \(const post of letters\) await deliverLetter\(post\);/.test(source), `while held ${JSON.stringify(whileHeld)}; then ${JSON.stringify(order.slice(beforeL1))}`);
        // L2: an ordinary letter with no closing picture in flight: sent once its scene is done, not before
        let sceneDone: (png: Buffer | null) => void = () => {};
        const beforeL2 = order.length;
        const calm = await delivering(post("AD 950 - come to court.", new Promise<Buffer | null>((resolve) => (sceneDone = resolve))));
        await sleep(1000);
        const whilePainting = order.slice(beforeL2);
        sceneDone(PNG);
        await calm.sending;
        check("W51 letter order: a letter waits for its own scene, then goes with its pictures straight after it", whilePainting.length === 0
          && JSON.stringify(order.slice(beforeL2)) === JSON.stringify(["AD 950 - come to court.", "scene.png", "marches.png", "map.png"]), `while painting ${JSON.stringify(whilePainting)}; then ${JSON.stringify(order.slice(beforeL2))}`);
        // L3: a court reopened and dismissed again before its first picture is done: the later picture is waited for, the earlier holds nothing and is dropped
        const earlier = await rise();
        const later = await rise();
        const beforeL3 = order.length;
        const again = await delivering(post("AD 1000 - come to court."));
        await sleep(1000);
        const whileLater = order.slice(beforeL3);
        later.resolve(PNG);
        await again.sending;
        const sentBeforeEarlier = order.slice(beforeL3);
        earlier.resolve(PNG);
        await sleep(1000);
        check("W51 letter order: overtaken by a second court, the later picture is waited for and the earlier holds nothing and is never sent",
          whileLater.length === 0 && JSON.stringify(sentBeforeEarlier) === JSON.stringify(["decision.png", "AD 1000 - come to court.", "scene.png", "marches.png", "map.png"])
          && JSON.stringify(order.slice(beforeL3)) === JSON.stringify(sentBeforeEarlier), `while later ${JSON.stringify(whileLater)}; before the earlier ${JSON.stringify(sentBeforeEarlier)}; after ${JSON.stringify(order.slice(beforeL3))}`);
        // L4: a closing picture that fails - the painter rejects, or paints nothing - holds no letter
        const failing = await rise();
        const beforeL4 = order.length;
        const afterFail = await delivering(post("AD 1050 - come to court."));
        failing.reject(new Error("the painter is down"));
        await afterFail.sending;
        const empty = await rise();
        const beforeL4b = order.length;
        const afterNull = await delivering(post("AD 1100 - come to court."));
        empty.resolve(null);
        await afterNull.sending;
        check("W51 letter order: a closing picture that fails or paints nothing holds no letter, and none is sent",
          JSON.stringify(order.slice(beforeL4, beforeL4b).filter((each) => !each.startsWith("I went with") && each !== DISMISSED)) === JSON.stringify(["AD 1050 - come to court.", "scene.png", "marches.png", "map.png"])
          && JSON.stringify(order.slice(beforeL4b)) === JSON.stringify(["AD 1100 - come to court.", "scene.png", "marches.png", "map.png"]), `${JSON.stringify(order.slice(beforeL4))}`);
      } finally {
        bots.standInForPainter(undefined);
        for (const each of held) each.resolve(null);
      }
      // While time passes: nothing is drafted
      state.phase = "passing";
      const beforeP = { sent: sent.length, drafted };
      say("/advisors");
      await until(() => sent.length > beforeP.sent);
      await sleep(300);
      state.phase = "audience";
      check("W51 /advisors while time passes: \"Wait until time stops passing.\", nothing drafted", JSON.stringify(sent.slice(beforeP.sent)) === JSON.stringify(["Wait until time stops passing."]) && drafted === beforeP.drafted, JSON.stringify(sent.slice(beforeP.sent)));
      // Setup's buttons, from /character's: dismissing the advisor (the people unset here, so the setup asks for one), the people, then a candidate
      const waitFor = async (starts: string) => { await until(() => sent.some((each, at) => each.startsWith(starts) && !!markups[at]), 60_000); return sent.findLastIndex((each, at) => each.startsWith(starts) && !!markups[at]); };
      Object.assign(seat, { ready: false, dismissed: false, candidates: undefined, setup: undefined, rerolled: undefined });
      say("/character");
      const characterAt = await waitFor(seat.character.name);
      seat.civ = undefined;
      const beforeN = actions.length;
      tap("advisor:new", shownAt(characterAt));
      const peoplesAt = await waitFor("Which people will you lead?");
      check("W51 /character's dismiss button: its message is edited with the label as its last line and no buttons, then the setup begins", actions[beforeN] === `edit ${characterAt + 1}: ${sent[characterAt]}\n\nDismiss them and send for candidates`
        && actions.slice(beforeN).filter((each) => each.startsWith("send")).map((each) => each.slice(5, 30)).join("|") === "A new history is about to|Which people will you lea", JSON.stringify(actions.slice(beforeN)));
      const beforeQ = actions.length;
      tap("people:?", shownAt(peoplesAt));
      const candidatesAt = await waitFor("Three have come to offer themselves");
      const chosenCiv = seat.civ;
      check("W51 setup's peoples: the message is edited with \"Let fate decide\" and no buttons before the people is told and the candidates come", actions[beforeQ] === `edit ${peoplesAt + 1}: ${sent[peoplesAt]}\n\nLet fate decide`
        && actions.slice(beforeQ).filter((each) => each.startsWith("send")).map((each) => each.slice(5)).join("|").startsWith(`${chosenCiv} it is`), JSON.stringify(actions.slice(beforeQ)).slice(0, 600));
      const firstCandidate = buttons(markups[candidatesAt] as never)[0];
      const beforeC2 = actions.length;
      tap("advisor:0", shownAt(candidatesAt));
      await until(() => actions.slice(beforeC2).some((each) => each.includes("at your service")), 60_000);
      check("W51 setup's candidates: the message is edited with the candidate's name and no buttons before the greeting", actions[beforeC2] === `edit ${candidatesAt + 1}: ${sent[candidatesAt]}\n\n${firstCandidate}`
        && seat.character.name === firstCandidate && seat.setup === undefined, JSON.stringify(actions.slice(beforeC2)).slice(0, 600));
      seat.civ = ours;
    } finally {
      agents.standInForModels(undefined);
      await stop(host);
    }
  },
};

/** The ruleset's military units by name, for the never-build case: Units.json with its comments and trailing commas struck */
const MILITARY_UNITS = new Set<string>((JSON.parse(readFileSync(resolve("../unciv/android/assets/jsons/Civ V - Gods & Kings/Units.json"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/mg, "").replace(/,(\s*[}\]])/g, "$1")) as { name: string; strength?: number; rangedStrength?: number }[])
  .filter((unit) => (unit.strength ?? 0) > 0 || (unit.rangedStrength ?? 0) > 0).map((unit) => unit.name));

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES);
const started = Date.now();
for (const name of wanted) {
  const run = CASES[name];
  if (!run) { check(`${name}: no such case`, false); continue; }
  try { await run(); } catch (error) { check(`${name} ran to the end`, false, String((error as Error).message)); }
}
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s${failed.length ? `; failed: ${failed.map((result) => result.name).join("; ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
