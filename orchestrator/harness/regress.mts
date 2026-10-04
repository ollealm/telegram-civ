// The saved-world half of the checks (smoke.mts is the other: every lever once on a new world). Each case starts its own host on a copy of a fixture
// (data/fixtures, see its INDEX.md), plants a failure where it needs one (RULER_FAULT), gives orders, plays turns, and asserts on replies, briefings,
// chancery lines, public events and exit codes - the reproductions the fixes of 2026-10-03 were proven on, kept.
// Run:  npx tsx harness/regress.mts [case ...]        (all cases when none named; e.g. F1 W2)
// REGRESS_PORT (default 8772; never 8765 or 8790), FIXTURES_DIR (default ../data/fixtures), HOST_SH (default ../host.sh). Sequential; about a minute on this machine (each host answers in a few seconds).

import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
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
  async F1() { // a turn the engine fails partway: reload, every court told, 503, exit 3; restarted, the world is the turn before
    const host = await start("run22-t234-greece", "engine:Greece");
    const first = await post("/advance", { turns: 1 });
    check("F1 the failed turn answers 500 'could not be played'", first.status === 500 && /could not be played/.test(JSON.stringify(first.json)), JSON.stringify(first.json));
    const second = await post("/advance", { turns: 1 }).catch(() => ({ status: 0, json: "gone" }));
    check("F1 a second advance before the exit is refused (503) or finds the host gone", second.status === 503 || second.status === 0, `${second.status}`);
    const code = await Promise.race([host.exited, sleep(10000).then(() => "still running")]);
    check("F1 the host exits with code 3", code === 3, `${code}`);
    const again = await start("run22-t234-greece", "", host.dir);
    check("F1 restarted, the world is at turn 234", (await get("/state")).json.turn === 234);
    check("F1 every court was told", (await Promise.all(["Greece", "Inca", "Japan"].map((name) => logOf(name, 233)))).every((lines) => lines.some((line) => /The turn could not be played/.test(line.text))));
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
    check("W2 Polynesia's chancery: joined England", (await logOf("Polynesia", 236)).some((line) => /We have joined England in the war against Persia/.test(line.text)));
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
    const countdowns = lines.map((line) => /next vote in (\d+) turns?|votes this turn/.exec(line ?? "")?.[0]);
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
      check(`W9 ${name}: briefing at most 16 KB, without score, goldBreakdown or victory.note`, size <= 16000 && !("score" in brief) && !("goldBreakdown" in brief) && !("note" in (brief.victory ?? {})), `${size}`);
      check(`W9 ${name}: the spaceship and the vote are one line before they matter`, typeof brief.spaceship === "string" && Object.keys(brief.victory?.diplomatic ?? {}).join() === "unitedNations");
    }
    await stop(host);
  },
  async W9b() { // late-game briefing size
    const host = await start("run22-t234-greece");
    for (const name of ["Greece", "Babylon", "Japan"]) {
      const size = JSON.stringify((await get(`/briefing?civ=${civ(name)}`)).json).length;
      check(`W9b ${name}: late briefing at most 30 KB`, size <= 30000, `${size}`);
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
    check("W20 an offer on the desk says its turns in the one wording", waiting.some((line) => /^Greece: .*Gold x20.*\((waits \d+ more turns?|lapses at the next turn); answerOffers accept or refuse\)/.test(line)), `${JSON.stringify(proposed.json.done)}; ${waiting.join(" | ")}`);
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
    const earliest = Math.min(...log.map((line) => Number(/^T(\d+):/.exec(line)?.[1] ?? turn)));
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
    check("W25 the peace made by order is a public event", (made.json.done ?? []).some((line: string) => /Peace made with Inca/.test(line)) && events.some((event) => event.text === "Greece and Inca have made peace."), events.map((event) => event.text).join(" | "));
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
    const walkedOn = [...seen.entries()].filter(([, places]) => places.some((place, index) => index > 0 && !place.sea && landmass.has(place.at) && !places[index - 1].sea && landmass.has(places[index - 1].at) && place.at !== places[index - 1].at));
    check("W27 a unit landed on Munich's landmass walks on from its landing", walkedOn.length > 0, `${walkedOn.length} walked on`);
    const lost = (await logOf("England", 117)).filter((line) => /^Our (Pikeman|Trebuchet|Longbowman|Catapult|Swordsman|Spearman|Knight)[^.]* was lost in action (at the harbour of|in the waters)/.test(line.text));
    check("W27 no land unit of England's host lost at sea", lost.length === 0, lost.map((line) => `T${line.turn} ${line.text.slice(0, 90)}`).join(" | "));
    const strikes = (await logOf("England", 117)).filter((line) => /struck Munich/.test(line.text));
    // At T119-120 only the Triremes reached Munich: their blows are the ships', not a landed host's
    check("W27 ships' strikes are said as the ships'", strikes.some((line) => /^Our ships struck Munich/.test(line.text)) && !strikes.some((line) => line.turn <= 120 && /^Our host struck Munich/.test(line.text)), strikes.map((line) => `T${line.turn} ${line.text.slice(0, 50)}`).join(" | "));
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
