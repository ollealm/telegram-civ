// Checks src/refusals.ts with no host and no model: npx tsx harness/refusals.mts - prints PASS or FAIL per check, exits 1 on any FAIL
import { endLookIn, noteRefusals, refusalsForPrompt, type Refusal } from "../src/refusals.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
};
const seat: { refused?: Refusal[]; refusing?: string[] } = {};

// Look-in 1: two refusals, one of them twice
noteRefusals(seat, ["Unknown building or unit: Hotel", "Unknown technology: Theory of Gravity"]);
noteRefusals(seat, ["Unknown building or unit: Hotel"]);
noteRefusals(seat, undefined);
check("a refusal shows before its look-in ends", refusalsForPrompt(seat).includes("- Unknown building or unit: Hotel\n"));
endLookIn(seat);
check("kept once each after look-in 1, the latest refused last", JSON.stringify(seat.refused) === JSON.stringify([{ text: "Unknown technology: Theory of Gravity", seen: 1 }, { text: "Unknown building or unit: Hotel", seen: 1 }]), JSON.stringify(seat.refused));
const first = refusalsForPrompt(seat);
console.log(`--- prompt block after look-in 1 ---\n${first}---`);
check("prompt block lists both in the host's words", first.includes("- Unknown building or unit: Hotel\n") && first.includes("- Unknown technology: Theory of Gravity\n"));

// Look-in 2: Hotel again, a purchase refused with figures; Theory of Gravity not tried
noteRefusals(seat, ["Unknown building or unit: Hotel", "Cannot buy Musketman in York: it costs 340 gold, we have 120"]);
endLookIn(seat);
check("a repeated refusal stays and counts the look-ins", seat.refused?.find((each) => each.text.includes("Hotel"))?.seen === 2);
check("a refusal not repeated once stays (one quiet look-in)", seat.refused?.find((each) => each.text.includes("Gravity"))?.quiet === 1, JSON.stringify(seat.refused));
check("it still shows in the next prompt", refusalsForPrompt(seat).includes("- Unknown technology: Theory of Gravity\n"));

// An audience between look-ins, then look-in 3: the purchase again with other figures; Gravity and the Hotel not tried
noteRefusals(seat, ["Cannot buy Musketman in York: it costs 355 gold, we have 90.5"]);
check("an audience's refusal shows at the next look-in", refusalsForPrompt(seat).includes("- Cannot buy Musketman in York: it costs 355 gold, we have 90.5"));
noteRefusals(seat, ["Cannot buy Musketman in York: it costs 355 gold, we have 90.5"]);
endLookIn(seat);
check("figures do not make a new refusal; the latest wording is kept", seat.refused?.filter((each) => each.text.startsWith("Cannot buy Musketman")).map((each) => each.text).join() === "Cannot buy Musketman in York: it costs 355 gold, we have 90.5", JSON.stringify(seat.refused));
check("unrepeated at two look-ins running, a refusal is dropped (Gravity)", !seat.refused?.some((each) => each.text.includes("Gravity")), JSON.stringify(seat.refused));
check("the Hotel, quiet once, stays", seat.refused?.find((each) => each.text.includes("Hotel"))?.quiet === 1, JSON.stringify(seat.refused));
const third = refusalsForPrompt(seat);
console.log(`--- prompt block after look-in 3 ---\n${third}---`);
check("a count shows from the second look-in", third.includes("(at 2 look-ins)"));

// Look-ins 4 and 5: nothing refused - the Hotel goes at 4, the purchase at 5
endLookIn(seat);
check("the Hotel goes at its second quiet look-in", !seat.refused?.some((each) => each.text.includes("Hotel")) && seat.refused?.length === 1, JSON.stringify(seat.refused));
endLookIn(seat);
check("two quiet look-ins later nothing is left", seat.refused === undefined && seat.refusing === undefined && refusalsForPrompt(seat) === "");

console.log(failures ? `FAIL: ${failures} check(s)` : "PASS: all checks");
process.exit(failures ? 1 : 0);
