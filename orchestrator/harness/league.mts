// A world with no humans: advisor-ruled realms on different models play a whole game against each other.
// Needs its own host:  ../host.sh /tmp/league-data 8767
// Run:  RULER_HOST_URL=http://127.0.0.1:8767 RULER_STATE_FILE=/tmp/league-data/state.json IMAGES=off \
//       npx tsx harness/league.mts claude-opus-5,claude-sonnet-5:low [maxTurns=300] [gameAiCivs=0] [mapSize=Small] [wonders=all|advised]
// Each seat is model[:effort]; effort (low | medium | high | xhigh | max) applies to every call made for that seat.
// wonders=advised leaves the world's wonders to the sovereigns: the game's own peoples raise none.
// LEAGUE_CHARACTERS=harness/league-characters.json: every seat plays one of a few fixed sovereigns (by the game's leader name) instead of a
//   freshly drafted one, handed out in turn within each model:effort, so each condition plays the same characters.
// LEAGUE_REFLECT_EFFORT: the effort of the closing reviews and interviews - a level (default high, so answers compare across seats)
//   or "own" to hear each seat at the effort it played at.
// LEAGUE_RESUME=1 (with the same LEAGUE_TAG, host and state file) carries on a league that paused or stopped, into the same result files.
//   A spent token limit pauses a league at once (exit 4) before the game moves on; harness/league-loop.sh resumes it by itself.
// LEAGUE_TAG=run1 keeps the result files of leagues started in the same minute apart (harness/league-batch.sh sets it).
// Results: ../data/harness/league-<date>.csv (score per realm per round), the Chronicler's chapters and a closing epic on the console,
// then playtest reviews and interviews of every sovereign.

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { chroniclerEpic, onTrace, playtestReview } from "../src/agents.ts";
import { draftSovereign } from "../src/characters.ts";
import { host } from "../src/host.ts";
import { playRound } from "../src/round.ts";
import { persist, state, type Seat } from "../src/store.ts";
import { interviewAll } from "./interview.mts";

const seatSpecs = (process.argv[2] ?? "claude-opus-5,claude-sonnet-5").split(",").map((spec) => {
  const [model, effort] = spec.split(":");
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error(`Unknown effort "${effort}" in ${spec}`);
  return { model, effort: effort as Seat["effort"] };
});
const maxTurns = Number(process.argv[3] ?? 300);
const gameAi = Number(process.argv[4] ?? 0);
const mapSize = process.argv[5] ?? "Small";
const wonders = process.argv[6] ?? "all";
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

// Every order that failed, and every call that errored, for the bug hunt afterwards
const tag = process.env.LEAGUE_TAG ? `-${process.env.LEAGUE_TAG}` : "";
const resuming = !!process.env.LEAGUE_RESUME;
if (resuming && !tag) throw new Error("LEAGUE_RESUME needs the LEAGUE_TAG of the league to carry on");
mkdirSync("../data/harness", { recursive: true });
const earlier = resuming ? readdirSync("../data/harness").filter((name) => name.startsWith("league-") && name.endsWith(`${tag}.csv`)).sort().at(-1) : undefined;
if (resuming && !earlier) throw new Error(`LEAGUE_RESUME: no earlier results for league${tag}`);
const stamp = earlier ? earlier.slice("league-".length, -".csv".length) : new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + tag;
const problems = `../data/harness/league-${stamp}-problems.jsonl`;
// A seat as the results name it: model, and effort when one is set
const labelOf = (civ?: string) => {
  const seat = state.seats.find((candidate) => candidate.civ === civ);
  return seat ? [seat.model, seat.effort].filter(Boolean).join(":") : "game AI";
};

// A league must not play on without its sovereigns: a spent session limit or a lost connection makes every look-in fail,
// and the round carries on regardless, so the game plays itself out and the results look complete. Stop instead.
const FAILURES_TO_STOP = 3;
const failuresInARow = new Map<string, number>();
function lookIn(civ: string | undefined, reached: boolean, why = "") {
  if (!civ) return;
  if (reached) return void failuresInARow.set(civ, 0);
  const count = (failuresInARow.get(civ) ?? 0) + 1;
  failuresInARow.set(civ, count);
  if (count < FAILURES_TO_STOP) return;
  say(`ABORTED: ${civ}'s sovereign could not be reached ${count} times running (${why.slice(0, 120)}). Stopping rather than let the game play itself.`);
  process.exit(3);
}

// A spent token limit is a pause, not a failure: stop at once, before the game moves on, keeping what the realms have done so far
const LIMIT_SPENT = /hit your (?:session|usage|weekly) limit|usage limit|rate.?limit|\b429\b/i;
function pauseIfLimited(civ: string | undefined, why: string) {
  if (!LIMIT_SPENT.test(why)) return;
  persist();
  say(`PAUSED: the token limit is spent (${civ}: ${why.slice(0, 100)}). The game waits at turn ${gameTurn}; resume with LEAGUE_RESUME=1 and LEAGUE_TAG${tag.replace("-", "=")}.`);
  process.exit(4);
}

// Every look-in: was it scheduled or a wake-up, did it change anything, what did it cost - to judge whether the fixed look-in earns its keep
const passes = `../data/harness/league-${stamp}-passes.csv`;
if (!resuming) appendFileSync(passes, "turn,civ,model,trigger,orderCalls,changedNothing,costUsd,seconds\n");
// The game turn a look-in happened at, read off the round's own log lines
let gameTurn = 0;
onTrace((trace) => {
  if (trace.role === "govern") {
    // Orders only: a look-in that just rewrote its plan changed nothing in the realm
    const orderCalls = trace.toolCalls.filter((call) => /set_orders/.test(call.name)).length;
    appendFileSync(passes, [gameTurn, trace.civ, labelOf(trace.civ), /sent for ahead/.test(trace.systemPrompt) ? "wake" : "scheduled", orderCalls, /^nothing to change/i.test(trace.reply.trim()) ? 1 : 0, trace.costUsd.toFixed(3), Math.round(trace.ms / 1000)].join(",") + "\n");
    // Every real call costs something; an error that comes back as a reply (a spent session limit) costs nothing
    const unreached = trace.costUsd === 0 || trace.reply.startsWith("(failed") || /session limit|could not be reached/i.test(trace.reply);
    if (unreached) pauseIfLimited(trace.civ, trace.reply);
    lookIn(trace.civ, !unreached, trace.reply);
  }
  for (const call of trace.toolCalls) {
    const result = call.result ?? "";
    if (/\\"failed\\":\[\\"|is_error|isError|\\"error\\"/.test(result))
      appendFileSync(problems, JSON.stringify({ civ: trace.civ, model: labelOf(trace.civ), role: trace.role, tool: call.name, input: call.input, result: result.slice(0, 1200) }) + "\n");
  }
  if (trace.reply.startsWith("(failed")) appendFileSync(problems, JSON.stringify({ civ: trace.civ, model: labelOf(trace.civ), role: trace.role, failed: trace.reply }) + "\n");
});
// A look-in that throws (a lost connection) never reaches the trace; the round logs it instead
const log = (...args: unknown[]) => {
  const turn = typeof args[0] === "string" ? /^(?:Advanced to turn|Round (?:starting|resuming) at turn) (\d+)/.exec(args[0]) : null;
  if (turn) gameTurn = Number(turn[1]);
  const failed = typeof args[0] === "string" ? /^govern pass for (.+) failed:/.exec(args[0]) : null;
  if (failed) pauseIfLimited(failed[1], String(args[1] ?? ""));
  if (failed) lookIn(failed[1], false, String(args[1] ?? ""));
  say(...args);
};

if (resuming) {
  // The seats, their journals and the world are all where the league left them
  if (!state.seats.length) throw new Error("LEAGUE_RESUME: the state file holds no seats");
  gameTurn = (await host.state()).turn;
  say(`Resuming league${tag} at turn ${gameTurn}: ${state.seats.map((seat) => `${seat.civ} (${labelOf(seat.civ)})`).join(", ")}`);
} else {
  const peoples = await host.nations();
  const nations = peoples.map((nation) => nation.name).sort(() => Math.random() - 0.5);
  state.seats = seatSpecs.map(({ model, effort }, index): Seat => ({ civ: nations[index], kind: "agent", model, ...(effort && { effort }), will: "", journal: [], chat: [], ready: false }));
  // Fixed sovereigns take the character out of the comparison: a drafted one differs in ambition and is written by the seat's own model
  const fixedSheets = process.env.LEAGUE_CHARACTERS ? (JSON.parse(readFileSync(process.env.LEAGUE_CHARACTERS, "utf8")) as { sheet: string }[]) : undefined;
  const handedOut = new Map<string, number>();
  for (const seat of state.seats) {
    if (fixedSheets) {
      const turn = handedOut.get(labelOf(seat.civ)) ?? 0;
      handedOut.set(labelOf(seat.civ), turn + 1);
      const leader = peoples.find((people) => people.name === seat.civ)?.leader ?? seat.civ;
      seat.character = { name: leader, sheet: fixedSheets[turn % fixedSheets.length].sheet };
      say(`${seat.civ}: ${leader} on ${labelOf(seat.civ)}, fixed character ${(turn % fixedSheets.length) + 1}`);
      continue;
    }
    const { name, title, pronouns, sheet } = await draftSovereign(seat.civ, seat.model!);
    seat.character = { name, title, pronouns, sheet };
    say(`${seat.civ}: ${name} on ${labelOf(seat.civ)}`);
  }
  const others = nations.slice(seatSpecs.length, seatSpecs.length + gameAi);
  await host.newGame({ ruled: state.seats.map((seat) => seat.civ), others, noWonders: wonders === "advised" ? others : [], mapSize, cityStates: 4 });
  persist();
}

// Reviews and interviews think equally hard for every seat, whatever effort it played at, so their answers can be compared -
// unless LEAGUE_REFLECT_EFFORT=own, which hears each seat as it played
const reflectEffort = process.env.LEAGUE_REFLECT_EFFORT ?? "high";
if (reflectEffort !== "own" && !["low", "medium", "high", "xhigh", "max"].includes(reflectEffort)) throw new Error(`Unknown LEAGUE_REFLECT_EFFORT "${reflectEffort}"`);
const REFLECT_EFFORT = reflectEffort === "own" ? undefined : (reflectEffort as Seat["effort"]);

const csv = `../data/harness/league-${stamp}.csv`;
if (!resuming) appendFileSync(csv, "turn,year,civ,model,score,cities,rank,costUsd\n");

for (;;) {
  const round = await playRound(state.seats, {
    working: (_, work) => work,
    dispatch: async () => {},
    notice: async () => {},
    chronicle: async (chapter) => say(`\n${chapter}\n`),
    log,
  });
  const spent = Object.values(state.usage).reduce((sum, usage) => sum + usage.costUsd, 0);
  round.rankings.forEach((row, index) => appendFileSync(csv, [round.turn, round.year, row.civ, labelOf(row.civ), row.score, row.cities, index + 1, spent.toFixed(2)].join(",") + "\n"));
  say(`standings at ${round.year}: ${round.rankings.map((row) => `${row.civ} (${labelOf(row.civ)}) ${row.score}`).join(", ")}; spent $${spent.toFixed(2)}`);
  const game = await host.state();
  if (game.winner || round.turn >= maxTurns || game.majorCivs.filter((civ) => civ.alive).length < 2) {
    say(game.winner ? `${game.winner} (${labelOf(game.winner)}) won a ${game.victoryType} victory` : "The league ends here.");
    const standings = game.majorCivs.map((civ) => `${civ.civ}: ${civ.alive ? "stands" : "has fallen"}`).join("\n");
    say("\n" + (await chroniclerEpic(await host.events(), standings, "This history has reached its end.")).text);
    for (const seat of state.seats) {
      const review = await playtestReview(REFLECT_EFFORT ? { ...seat, effort: REFLECT_EFFORT } : seat).catch((error) => `(review failed: ${error.message})`);
      say(`\n=== PLAYTEST REVIEW: ${seat.civ} (${labelOf(seat.civ)}, ${seat.character?.name}) ===\n${review}\n`);
      appendFileSync(`../data/harness/league-${stamp}-reviews.md`, `## ${seat.civ} - ${labelOf(seat.civ)} - ${seat.character?.name}\n\nWill:\n${seat.will}\n\nPlan:\n${seat.plan ?? ""}\n\nJournal:\n${seat.journal.join("\n")}\n\nReview:\n${review}\n\n`);
    }
    // The world is still live at the end, so the sovereigns may check their briefing before they answer
    // Tell them how it ended: the interview comes after the last turn, and the briefing alone may not say that the game is over
    const ending = game.winner
      ? `The game is over: ${game.winner} won a ${game.victoryType} victory in ${round.year} (turn ${round.turn}); no more turns will be played.`
      : `The game is over: the league was stopped in ${round.year} (turn ${round.turn}) with no winner; no more turns will be played.`;
    await interviewAll(state.seats, `../data/harness/league-${stamp}-interviews.md`, true, REFLECT_EFFORT, ending);
    break;
  }
}
say("results:", csv, "usage:", JSON.stringify(state.usage));
