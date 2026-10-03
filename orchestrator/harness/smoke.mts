// Per-lever smoke test, no LLM: every kind of order is given once on a throwaway game and its effect is
// checked in the game state - "the advisor stopped complaining" is not evidence, this is.
// Run against a separate host:  ../host.sh /tmp/harness-data 8766  then  RULER_HOST_URL=http://127.0.0.1:8766 npx tsx harness/smoke.mts

import { host, type Orders } from "../src/host.ts";

type Briefing = Record<string, any>;
const results: { lever: string; ok: boolean; detail: string }[] = [];
const check = (lever: string, ok: boolean, detail = "") => {
  results.push({ lever, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${lever}${detail ? "  - " + detail : ""}`);
};
const briefing = (civ: string) => host.briefing(civ) as Promise<Briefing>;
const order = (civ: string, orders: Orders) => host.setOrders(civ, orders);
const unitId = (line: string) => Number(/#(\d+)/.exec(line)![1]);

// An all-human world: two ruled civs, no AI majors
await host.newGame({ ruled: ["Rome", "Greece"], others: [], cityStates: 4 });
await host.advance(1);
let rome = await briefing("Rome");
check("all-human game starts", rome.cities.length === 1, `capital ${rome.cities[0]?.name}`);

// research: goal path at the head of the queue, already-known goals refused
let r = await order("Rome", { research: ["Agriculture", "Philosophy"] });
check("research: known goal flagged", r.failed.some((f) => f.includes("Already known")), r.failed.join("; "));
check("research: path set", r.researchQueue.length > 0 && r.researchQueue.at(-1) === "Philosophy", r.researchQueue.join(" > "));
const firstTech = r.researchQueue[0];

// policies + personality are standing
r = await order("Rome", { policyBranches: ["Tradition"], personality: { Science: 9 }, goldReserve: 100000 }); // the reserve keeps the officials out of the purse, so the money levers below have gold to work with
check("standing orders stored", (r.orders.policyBranches ?? [])[0] === "Tradition" && r.orders.personality?.Science === 9);

// queue: binding, exact
const options = (await host.options("Rome")) as Record<string, any>;
const buildable: string[] = options.buildable.Rome.map((entry: string) => entry.replace(/ \(.*/, ""));
const wanted = buildable.filter((name) => ["Warrior", "Monument", "Scout"].includes(name)).slice(0, 2);
r = await order("Rome", { queue: [{ city: "Rome", items: wanted }] });
rome = await briefing("Rome");
check("queue: replaced exactly", JSON.stringify(rome.cities[0].buildQueue) === JSON.stringify(wanted), rome.cities[0].buildQueue.join(", "));

// per-item failure does not block the rest
r = await order("Rome", { queue: [{ city: "Nowhere", items: ["Monument"] }], cityFocus: [{ city: "Rome", focus: "Production" }] });
rome = await briefing("Rome");
check("orders: bad item fails alone", r.failed.length === 1 && rome.cities[0].focus === "ProductionFocus", r.failed.join("; "));

// units: hold keeps a unit in place against the automation; settle on a bad site is refused with a reason
const warrior = rome.units.find((line: string) => line.startsWith("Warrior"));
if (warrior) {
  await order("Rome", { units: [{ unit: unitId(warrior), action: "hold" }] });
  const spot = /at (\([^)]*\))/.exec(warrior)![1];
  await host.advance(3);
  rome = await briefing("Rome");
  const now = rome.units.find((line: string) => line.includes(`#${unitId(warrior)} `));
  check("units: hold beats the automation", !!now && now.includes(spot) && now.includes("under orders"), now ?? "unit gone");
  r = await order("Rome", { units: [{ unit: unitId(warrior), action: "settle" }] });
  check("units: wrong unit type refused", r.failed.some((f) => f.includes("cannot found")), r.failed.join("; "));
  await order("Rome", { units: [{ unit: unitId(warrior), action: "release" }] });
} else check("units: hold beats the automation", false, "no warrior at start");

// binding queue survives turns; first tech gets researched; log records it
await host.advance(12);
rome = await briefing("Rome");
const log = (await host.log("Rome", 0)).map((entry) => entry.text).join("\n");
// a unit that has spent its movement this turn (the automation's always have) can still be given a march
const walker = rome.units.find((line: string) => /^(Warrior|Scout|Archer)/.test(line));
if (walker) {
  r = await order("Rome", { units: [{ unit: unitId(walker), action: "move", city: rome.cities[0].name }] });
  check("units: a spent unit can still be sent home", !r.failed.some((f) => f.includes("cannot reach")), [...r.done, ...r.failed].join("; "));
  await order("Rome", { units: [{ unit: unitId(walker), action: "release" }] });
} else check("units: a spent unit can still be sent home", false, "no soldier after 12 turns");
check("research: first step completed", log.includes(`Research of ${firstTech}`), firstTech);
check("queue: ordered items were built", wanted.every((name) => log.includes(`${name} has been built`) || rome.cities[0].buildQueue.includes(name)), wanted.join(", "));
check("log: no false idle-research alarm", !log.includes("run out of goals") && !log.includes("No research goal remains"));
check("policy: preferred branch adopted", rome.policies.includes("Tradition") || rome.culture.stored < rome.culture.neededForNextPolicy, rome.policies.join(", "));

// money levers need a treasury and neighbours: play on
await host.advance(45);
rome = await briefing("Rome");
for (let waited = 0; rome.gold < 250 && waited < 40; waited += 5) { await host.advance(5); rome = await briefing("Rome"); } // save up for a purchase
const opts = (await host.options("Rome")) as Record<string, any>;
const city = rome.cities[0].name;
const affordable = (opts.buildable[city] as string[])
  .map((entry) => ({ name: entry.replace(/ \(.*/, ""), price: Number(/buy (\d+) gold/.exec(entry)?.[1] ?? Infinity) }))
  .filter((item) => item.price <= rome.gold)
  .sort((a, b) => a.price - b.price)[0];
if (affordable) {
  r = await order("Rome", { purchase: [{ city, item: affordable.name }] });
  const after = await briefing("Rome");
  check("purchase: gold spent, item delivered", r.done.some((d) => d.startsWith("Bought")) && after.gold <= rome.gold - affordable.price + 1, `${affordable.name} for ${affordable.price}`);
  rome = after;
} else check("purchase: gold spent, item delivered", false, `nothing affordable with ${rome.gold} gold`);

r = await order("Rome", { purchase: [{ city, item: "No Such Thing" }] });
check("purchase: refusal gives the reason", r.failed.length === 1, r.failed[0]);

const cityState = rome.knownCivs.find((known: any) => known.cityState);
if (cityState && rome.gold >= 20) {
  const before = cityState.influence;
  r = await order("Rome", { gift: [{ cityState: cityState.civ, gold: 20 }] });
  const after = (await briefing("Rome")).knownCivs.find((known: any) => known.civ === cityState.civ);
  check("gift: influence went up", after.influence > before, `${cityState.civ} ${before} -> ${after.influence}`);
} else check("gift: influence went up", false, "no city-state met or no gold");

// trade direction: a gift of gold must move gold FROM us TO them (this is the check that catches a reversed trade)
const greeceKnown = rome.knownCivs.find((known: any) => known.civ === "Greece");
if (greeceKnown) {
  // both purses are fenced for the turn, so the only gold that moves is the gift
  await order("Rome", { goldReserve: 100000 });
  await order("Greece", { goldReserve: 100000 });
  rome = await briefing("Rome");
  const greeceBefore = await briefing("Greece");
  if (rome.gold >= 15) {
    r = await order("Rome", { trade: [{ with: "Greece", give: [{ item: "Gold", amount: 15 }] }] });
    // Greece is an advised court: the offer waits for its advisor, who takes it here
    const answered = await order("Greece", { answerOffers: [{ power: "Rome", answer: "accept", terms: "we give nothing; they give Gold x15" }] });
    if (answered.failed.length) console.log("answerOffers failed:", answered.failed.join(" "));
    await host.advance(1);
    const romeAfter = await briefing("Rome");
    const greeceAfter = await briefing("Greece");
    const romeDelta = romeAfter.gold - rome.gold - rome.perTurn.gold;
    const greeceDelta = greeceAfter.gold - greeceBefore.gold - greeceBefore.perTurn.gold;
    check("trade: gold moved from us to them", greeceDelta >= 10 && romeDelta < greeceDelta, `Rome ${romeDelta}, Greece ${greeceDelta}; ${r.done.join(" ")}`);
    const tradeLog = (await host.log("Rome", romeAfter.turn - 2)).map((entry) => entry.text).join("\n");
    check("trade: answer logged with terms", /Our proposal to Greece .* (was accepted|was refused|lapsed|counteroffer)/.test(tradeLog), tradeLog.split("\n").filter((l) => l.includes("proposal")).join(" | "));
  } else check("trade: gold moved from us to them", false, "no gold");
  r = await order("Rome", { trade: [{ with: "Greece", give: [{ item: "Gold", amount: 0 }] }] });
  check("trade: zero amount refused", r.failed.length === 1, r.failed[0]);
} else check("trade: gold moved from us to them", false, "Rome and Greece have not met after 60 turns");

const map = await host.map("Rome");
check("map: renders a PNG", map.length > 10000 && map.subarray(1, 4).toString() === "PNG", `${map.length} bytes`);

const spent = (await host.log("Rome", 0)).filter((entry) => entry.text.startsWith("The officials spent"));
check("gold reserve: officials kept out of the purse", spent.length === 0, spent.map((entry) => entry.text).join(" | "));

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} levers verified` + (failed.length ? `; FAILED: ${failed.map((f) => f.lever).join(", ")}` : ""));
process.exit(failed.length ? 1 : 0);
