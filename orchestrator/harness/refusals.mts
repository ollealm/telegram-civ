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
check("a repeated refusal stays and counts look-ins running", seat.refused?.find((each) => each.text.includes("Hotel"))?.seen === 2);
check("a refusal not repeated is dropped", !seat.refused?.some((each) => each.text.includes("Gravity")));

// An audience between look-ins, then look-in 3: the purchase again with other figures
noteRefusals(seat, ["Cannot buy Musketman in York: it costs 355 gold, we have 90.5"]);
check("an audience's refusal shows at the next look-in", refusalsForPrompt(seat).includes("- Cannot buy Musketman in York: it costs 355 gold, we have 90.5\n"));
noteRefusals(seat, ["Cannot buy Musketman in York: it costs 355 gold, we have 90.5"]);
endLookIn(seat);
check("figures do not make a new refusal; the latest wording is kept", JSON.stringify(seat.refused) === JSON.stringify([{ text: "Cannot buy Musketman in York: it costs 355 gold, we have 90.5", seen: 2 }]), JSON.stringify(seat.refused));
check("the Hotel, not tried at look-in 3, is dropped", !refusalsForPrompt(seat).includes("Hotel"));
const third = refusalsForPrompt(seat);
console.log(`--- prompt block after look-in 3 ---\n${third}---`);
check("a count shows from two look-ins running", third.includes("(2 look-ins running)"));

// Look-in 4: nothing refused
endLookIn(seat);
check("a look-in with no refusals leaves nothing", seat.refused === undefined && seat.refusing === undefined && refusalsForPrompt(seat) === "");

console.log(failures ? `FAIL: ${failures} check(s)` : "PASS: all checks");
process.exit(failures ? 1 : 0);
