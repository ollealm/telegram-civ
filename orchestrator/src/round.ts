// One round of play, shared by the Telegram bots and the test harness:
// the advisors govern every few turns, time passes, then dispatches and the Chronicler's chapter go out.

import { advisorReport, advisorUrgent, governPass, heraldNewspaper, type Dispatch } from "./agents.ts";
import { host, type RoundResult } from "./host.ts";
import { persist, remember, state, type Seat } from "./store.ts";

const TURNS_PER_ROUND = Number(process.env.TURNS_PER_ROUND ?? 12);
const EARLY_ROUND_TURNS = Number(process.env.EARLY_ROUND_TURNS ?? 24);
const EARLY_GAME_UNTIL_TURN = Number(process.env.EARLY_GAME_UNTIL_TURN ?? 24);
export const GOVERN_EVERY = Number(process.env.GOVERN_EVERY_TURNS ?? 4);

/** Turns in the round that starts at this turn - longer while the early game is slow */
/** Later in the game an age is shorter: more happens in a turn, and the ruler should be asked more often. LATE_AGES="Industrial:8,Information:4" -
 *  once any realm has reached an age named here, every age after it has that many turns, for the rest of the game */
const LATE_AGES = (process.env.LATE_AGES ?? "").split(",").map((entry) => entry.trim().split(":")).map(([era, turns]) => ({ era, turns: Number(turns) })).filter((entry) => entry.era && Number.isFinite(entry.turns) && entry.turns > 0); // empty: every age after the first is TURNS_PER_ROUND
const ERAS = ["Ancient", "Classical", "Medieval", "Renaissance", "Industrial", "Modern", "Atomic", "Information", "Future"];
const eraRank = (era?: string) => ERAS.findIndex((name) => era?.startsWith(name));
export const roundLength = (turn: number) => (turn < EARLY_GAME_UNTIL_TURN ? EARLY_ROUND_TURNS : state.lateRound ?? (state.lateGame ? 8 : TURNS_PER_ROUND));
/** Looked at when an age begins: the furthest realm's age sets the length of every age after it, and it never lengthens again */
export const noteLateGame = (majorCivs: { alive: boolean; era?: string }[]) => {
  const furthest = Math.max(...majorCivs.filter((civ) => civ.alive).map((civ) => eraRank(civ.era)));
  const reached = LATE_AGES.filter((entry) => furthest >= eraRank(entry.era)).map((entry) => entry.turns);
  if (!reached.length) return;
  const length = Math.min(...reached, state.lateRound ?? Infinity);
  if (length === state.lateRound) return;
  state.lateRound = length; state.lateGame = true;
  persist();
};

/** Turns that will pass when the court now sitting rises: the rest of an interrupted age, or a whole new one */
export const turnsAhead = (turn: number) => {
  const pending = state.pendingRound;
  return pending ? Math.max(0, (pending.untilTurn ?? turn + (pending.remaining ?? 0)) - turn) : roundLength(turn);
};

/** Where a round's words go: Telegram in play, the console in the harness */
export type RoundIO = {
  /** Wraps slow work for one seat, e.g. to show "typing…" */
  working: <T>(seat: Seat, work: Promise<T>) => Promise<T>;
  dispatch: (seat: Seat, dispatch: Dispatch, round: RoundResult) => Promise<void>;
  /** A two-line note to a ruler whom the urgent news does not concern */
  notice: (seat: Seat, text: string) => Promise<void>;
  /** seen: what the whole world could see of the age besides its events - the armies' marches, and the chancery's flagged curiosities for the oddity of the age */
  chronicle: (chapter: string, images: { caption: string; description: string }[], round: RoundResult, seen: { campaigns: string[]; curiosities: string[] }) => Promise<void>;
  log: (...args: unknown[]) => void;
};

export async function playRound(allSeats: Seat[], io: RoundIO): Promise<RoundResult> {
  // Set before anything is awaited, so that a second dismissal arriving meanwhile finds time already passing
  state.phase = "passing";
  persist();
  let urgentFor: Seat[] | undefined;
  try {
    const opening = await host.state();
    noteLateGame(opening.majorCivs);
    // A fallen realm has no advisor left to govern or report
    const alive = new Set(opening.majorCivs.filter((civ) => civ.alive).map((civ) => civ.civ));
    const seats = allSeats.filter((seat) => alive.has(seat.civ));
    // Resuming after urgent news or a restart: play what is left of the interrupted round, and report on the whole of it
    const pending = state.pendingRound;
    const fromTurn = pending?.fromTurn ?? opening.turn;
    const untilTurn = pending ? pending.untilTurn ?? opening.turn + (pending.remaining ?? 0) : fromTurn + roundLength(fromTurn);
    const length = untilTurn - fromTurn;
    // What the rulers said aloud before this round began belongs to the chapter about it
    const spoken = seats.flatMap((seat) => seat.proclamations ?? []);
    for (const seat of seats) seat.proclamations = undefined;
    (state.proclaimed ??= []).push(...spoken.map((text) => ({ turn: fromTurn, year: opening.year, text })));
    const proclaimed = [...(pending?.proclaimed ?? []), ...spoken];
    const notes = new Map(seats.map((seat) => [seat.civ, [...(pending?.notes?.[seat.civ] ?? [])]]));
    // The age in progress is on disk from here until its letters are written: whatever stops it - urgent news, a failure, a restart - the rest is played on later
    if (state.ageStarts?.at(-1) !== fromTurn) (state.ageStarts ??= []).push(fromTurn); // an age resumed after a stop is the same age
    const progress: NonNullable<typeof state.pendingRound> = (state.pendingRound = { fromTurn, fromYear: pending?.fromYear ?? opening.year, untilTurn, publicEvents: pending?.publicEvents ?? [], notes: Object.fromEntries(notes), proclaimed });
    persist();
    io.log(pending ? `Round resuming at turn ${opening.turn}, ${untilTurn - opening.turn} turns left` : `Round starting at turn ${fromTurn}, ${length} turns`);
    let round: RoundResult | undefined;
    let carried = progress.publicEvents;
    // A council event (war, a lost city, victory) ends the round early
    // Everyone looks in on schedule; in between, an advisor is sent for only when something happened in their realm
    let woken: Record<string, string[]> = {};
    const sentFor = new Set<string>();
    let lookedAt = new Map(seats.map((seat) => [seat.civ, fromTurn]));
    const lookInFailures = new Map<string, number>();
    for (let played = opening.turn - fromTurn; played < length; ) {
      const now = fromTurn + played;
      const scheduled = Object.keys(woken).length === 0;
      const standing = (seat: Seat) => !round || round.rankings.some((rank) => rank.civ === seat.civ); // a realm that fell during this age has no one left to look in
      const due = (scheduled ? seats : seats.filter((seat) => woken[seat.civ])).filter(standing);
      await Promise.all(
        due.map((seat) =>
          io
            .working(seat, governPass(seat, lookedAt.get(seat.civ)!, GOVERN_EVERY, woken[seat.civ], seat.kind === "agent" && scheduled && played === 0))
            .then((entry) => {
              lookInFailures.set(seat.civ, 0);
              notes.get(seat.civ)!.push(`T${now}: ${entry}`);
              lookedAt.set(seat.civ, now);
            })
            // A look-in that never happened must not read as a quiet one: the dispatch is written from these notes, and so is the journal
            .catch((error) => {
              // Three unreachable look-ins running is not a hiccup: the round stops rather than play on without the advisor
              const failures = (lookInFailures.get(seat.civ) ?? 0) + 1;
              lookInFailures.set(seat.civ, failures);
              if (failures >= 3) throw new Error(`${seat.civ}'s advisor could not be reached three look-ins running (${error.message}); the age is halted so the realm does not run on unadvised`);
              io.log(`govern pass for ${seat.civ} failed:`, error.message); notes.get(seat.civ)!.push(`T${now}: (no look-in this year - the advisor could not be reached: ${String(error.message).slice(0, 80)}. The realm ran on the standing orders alone.)`); }),
        ),
      );
      const untilNextLookIn = GOVERN_EVERY - (played % GOVERN_EVERY);
      const chunk = await host.advance(Math.min(untilNextLookIn, length - played), true);
      played = chunk.turn - fromTurn;
      round = { ...chunk, fromTurn, fromYear: progress.fromYear, publicEvents: [...(round?.publicEvents ?? carried), ...chunk.publicEvents] };
      carried = [];
      progress.publicEvents = round.publicEvents;
      persist();
      // A wake-up that lands on a scheduled look-in anyway needs no pass of its own
      // ...and an advisor is sent for at most once between two look-ins; whatever else happens waits for the next one
      if (played % GOVERN_EVERY === 0) sentFor.clear();
      woken = played % GOVERN_EVERY === 0 || played >= length ? {}
        : Object.fromEntries(Object.entries(chunk.wake ?? {}).filter(([civ]) => seats.some((seat) => seat.civ === civ) && !sentFor.has(civ)));
      for (const civ of Object.keys(woken)) sentFor.add(civ);
      io.log(`Advanced to turn ${chunk.turn}`, chunk.stoppedEarly ?? "", Object.keys(woken).length ? `woke ${Object.keys(woken).join(", ")}` : "");
      if (chunk.stoppedEarly || chunk.turn === now) break;
    }
    // Every turn of it was played before a restart: nothing to advance, only the letters to write
    if (!round) round = { ...(await host.advance(0, true)), fromTurn, fromYear: progress.fromYear, publicEvents: carried };
    const finished = round;

    // Urgent news (not a victory): summon only the rulers it concerns, keep the rest of the round for afterwards
    const news = finished.stoppedEarly;
    const remaining = length - (finished.turn - fromTurn);
    if (news && !/has won/.test(news) && remaining > 0) {
      // Every ruler is called to the emergency council - the one it concerns to answer, the others to see whether they will join in, stand aside or change course
      const rulers = seats.filter((seat) => seat.kind !== "agent");
      progress.urgent = true;
      persist();
      // No chapter for a broken age: the Chronicler writes when the age is whole, and this news is carried into it
      // One ruler's failed letter must not cost the others theirs
      const summoned = await Promise.allSettled(
        rulers.map(async (seat) => {
          // A ruler whose own order began the war hears how it has begun, not that they were attacked; any other realm the news names was struck
          const part = finished.declaredBy === seat.civ ? "declarer" : news.includes(seat.civ) ? "struck" : "other";
          const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
          const dispatch = await io.working(seat, advisorUrgent(seat, news, briefing, part));
          // The ruler must see at a glance that this is not the regular audience, and may dismiss it with one tap
          dispatch.heading = `Emergency council, ${finished.year}: ${news.replace(/[.!]+$/, "")}.`;
          dispatch.question = [dispatch.question, "/onward"].filter(Boolean).join("\n\n");
          notes.get(seat.civ)!.push(dispatch.journal);
          (seat.annals ??= []).push({ years: finished.year, heading: dispatch.heading, story: dispatch.text, question: dispatch.question, urgent: true, undelivered: true });
          remember(seat, { from: "advisor", text: [dispatch.text, dispatch.question].filter(Boolean).join("\n\n"), letter: true });
          await io.dispatch(seat, dispatch, finished);
        }),
      );
      summoned.forEach((result, index) => {
        if (result.status !== "rejected") return;
        io.log(`emergency letter failed for ${rulers[index].civ}:`, result.reason?.message ?? result.reason);
        void io.notice(rulers[index], `The clocks have stopped, Majesty: ${news}. My letter on it was lost on the road - ask me what it means for us, and /onward when you are ready.`);
      });
      urgentFor = rulers;
      return finished;
    }

    // Every turn of the age is played: from here on a restart finds letters to deliver, not an age to resume
    state.pendingRound = undefined;
    persist();

    // One realm's failed letter must not cost the others theirs
    // What every realm's people did in the age, from the host: the letters are written from their own, the chapter from what the world could see of all of them
    const ages = new Map(await Promise.all(seats.map(async (seat) => [seat.civ, await host.age(seat.civ, finished.fromTurn).catch(() => undefined)] as const)));
    const campaigns = seats.flatMap((seat) => {
      const age = ages.get(seat.civ);
      if (!age) return [];
      return [
        ...age.marches.map((m) => `${seat.civ}: ${m.told}`),
        ...age.lost.map((l) => `${seat.civ} lost ${l.what} ${l.at}.`),
        // A ruled realm tells its own campaigns; the others' are told by those who saw them
        ...age.enemyMarches.filter((m) => !seats.some((other) => other.civ === m.whose)).map((m) => m.told),
        ...age.enemyLost.map((l) => `${l.whose} lost ${l.what} ${l.at}.`),
        ...age.citiesTaken.map((t) => `${t.city} fell to ${t.by} in ${t.year}.`),
        ...age.explorers.map((e) => `A ${seat.civ} ${e.what} was seen as far as ${e.reached}.`),
      ];
    }).filter((line, index, all) => all.indexOf(line) === index);
    // Candidates for the oddity of the age, from every realm: the world's lines once, a realm's own lines under its name
    const curiosities = seats.flatMap((seat) => (ages.get(seat.civ)?.curiosities ?? []).map((line) => (/^Our /.test(line) ? `${seat.civ}: ${line}` : line)))
      .filter((line, index, all) => all.indexOf(line) === index);
    const settled = await Promise.allSettled([
      ...seats.map(async (seat) => {
        const governLogs = notes.get(seat.civ)!;
        const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
        if (seat.kind === "agent") {
          // An agent realm holds no council with itself: its journal is its own look-in notes, and it weighs the longer game at the first look-in of the next age
          const entry = governLogs.map((note) => note.replace(/^T\d+: /, "")).filter((note) => !/^nothing to change/i.test(note)).join(" ");
          seat.journal.push(`${finished.fromYear} to ${finished.year}: ${entry.length > 1200 ? `...${entry.slice(-1200)}` : entry || "A quiet age; nothing changed."}`);
          return;
        }
        const ending = finished.stoppedEarly && /has won/.test(finished.stoppedEarly) ? finished.stoppedEarly.replace(/[.!]+$/, "") : undefined;
        // What the realm's people did in these years, from where every company stood: the half of the story the ledgers never held
        const age = ages.get(seat.civ);
        const dispatch = await io.working(seat, advisorReport(seat, finished, governLogs, briefing, ending, age?.lines ?? []));
        dispatch.age = age;
        // The letter opens with the advisor's own summons, so the ruler knows at a glance that a new court has begun and when - or, in the last letter, that the game is over
        dispatch.heading ||= ending ? `The game is over: ${ending}.` : `You are called to court, ${finished.year}.`;
        seat.journal.push(`${finished.fromYear} to ${finished.year}: ${dispatch.journal}`);
        (seat.annals ??= []).push({ years: `${finished.fromYear} to ${finished.year}`, heading: dispatch.heading, story: dispatch.text, course: dispatch.strategy || undefined, question: dispatch.question, undelivered: true });
        seat.forCouncil = undefined; // what was left with the clerk has now been answered
        remember(seat, { from: "advisor", text: [dispatch.text, dispatch.strategy, dispatch.question].filter(Boolean).join("\n\n"), letter: true });
        await io.dispatch(seat, dispatch, finished);
      }),
      // Earlier chapters come from the host, so a restart does not make the Chronicler forget
      host
        .events()
        .then((all) => heraldNewspaper(finished, all.filter((event) => event.turn <= finished.fromTurn), proclaimed, campaigns))
        .then(({ chapter, images }) => {
          (state.chapters ??= []).push({ years: `${finished.fromYear} to ${finished.year}`, text: chapter, undelivered: true });
          return io.chronicle(chapter, images, finished, { campaigns, curiosities });
        }),
    ]);
    settled.forEach((result, index) => {
      if (result.status !== "rejected") return;
      const seat = seats[index];
      io.log(`dispatch failed for ${seat?.civ ?? "the chronicle"}:`, result.reason?.message ?? result.reason);
      if (seat && seat.kind !== "agent") void io.notice(seat, `My letter for ${finished.fromYear} to ${finished.year} was lost on the road, Majesty - the realm ran on your standing wishes meanwhile. Ask me anything of these years, and /onward when you are ready.`);
    });
    return finished;
  } finally {
    // After urgent news only the rulers concerned are waited for; everyone else stays dismissed
    for (const seat of state.seats) seat.ready = urgentFor !== undefined && !urgentFor.includes(seat);
    state.phase = "audience";
    persist();
  }
}
