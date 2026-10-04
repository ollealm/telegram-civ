/**
 * A seat's refused orders, carried from one look-in to the next: each look-in is a fresh session, and without this it tries again what the last one was refused.
 * Information only - nothing here blocks or changes an order.
 *
 * The rule: every line set_orders sends back under "failed" (at a look-in or at an audience) is gathered in `refusing`. When a look-in ends, `refused` becomes
 * exactly what was gathered since the last look-in ended: a kept refusal that this look-in did not repeat is dropped, a repeated one counts one more look-in
 * running, a new one is kept from 1. Lines that differ only in their figures are one refusal; the latest wording is the one kept.
 */
export type Refusal = { text: string; /** Look-ins running at which it was refused */ seen: number };
type Holder = { refused?: Refusal[]; refusing?: string[] };

const key = (text: string) => text.replace(/\d+(?:\.\d+)?/g, "#");

/** Gathers the "failed" lines of one set_orders reply */
export const noteRefusals = (seat: Holder, failed: unknown) => {
  const lines = Array.isArray(failed) ? failed.filter((line): line is string => typeof line === "string") : [];
  if (!lines.length) return;
  const gathered = new Map((seat.refusing ?? []).map((text) => [key(text), text]));
  for (const text of lines) { gathered.delete(key(text)); gathered.set(key(text), text); }
  seat.refusing = [...gathered.values()];
};

/** At the end of a look-in: what it (and any audience since the last look-in) was refused becomes the kept list, and nothing else */
export const endLookIn = (seat: Holder) => {
  const before = new Map((seat.refused ?? []).map((refusal) => [key(refusal.text), refusal.seen]));
  const kept = (seat.refusing ?? []).map((text) => ({ text, seen: (before.get(key(text)) ?? 0) + 1 }));
  if (kept.length) seat.refused = kept; else delete seat.refused;
  delete seat.refusing;
};

/** The block for the next look-in's prompt: one line each, in the host's own words; empty when nothing was refused */
export const refusalsForPrompt = (seat: Holder) => {
  const lines = new Map((seat.refused ?? []).map((refusal) => [key(refusal.text), refusal]));
  for (const text of seat.refusing ?? []) lines.set(key(text), { text, seen: lines.get(key(text))?.seen ?? 1 });
  if (!lines.size) return "";
  return `set_orders turned these back lately, in the host's words:\n${[...lines.values()].map(({ text, seen }) => `- ${text}${seen > 1 ? ` (${seen} look-ins running)` : ""}`).join("\n")}\n\n`;
};
