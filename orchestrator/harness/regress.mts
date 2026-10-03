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
  const response = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  async W15() { // a nuclear weapon: grounded under defend; launched under attack it is told whole to the attacker and to the struck, and every unit killed has its line
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
    check("W15 each of Arabia's units killed has its line, the weapon the killer", arabia.some((line) => /lost in action .* Atomic Bomb/.test(line.text)), arabia.find((line) => /lost in action/.test(line.text))?.text);
    check("W15 the bomb's own end is told", aztecs.some((line) => /^Our Atomic Bomb was spent on its strike/.test(line.text)));
    const everyone = (await Promise.all(["Aztecs", "Japan", "Arabia", "Songhai", "Austria", "Denmark"].map((name) => logOf(name, 300)))).flat();
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
