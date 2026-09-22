// One round of play, shared by the Telegram bots and the test harness:
// the advisors govern every few turns, time passes, then dispatches and the Chronicler's chapter go out.

import { advisorReport, advisorUrgent, governPass, heraldBulletin, heraldNewspaper, splitPicture, type Dispatch } from "./agents.ts";
import { host, type RoundResult } from "./host.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { persist, remember, state, type Seat } from "./store.ts";

const WISHES = join(process.env.RULER_STATE_FILE ? join(process.env.RULER_STATE_FILE, "..") : "../data/game", "wished-to-ask.md");

const TURNS_PER_ROUND = Number(process.env.TURNS_PER_ROUND ?? 12);
const EARLY_ROUND_TURNS = Number(process.env.EARLY_ROUND_TURNS ?? 24);
const EARLY_GAME_UNTIL_TURN = Number(process.env.EARLY_GAME_UNTIL_TURN ?? 24);
export const GOVERN_EVERY = Number(process.env.GOVERN_EVERY_TURNS ?? 4);

/** Turns in the round that starts at this turn - longer while the early game is slow */
export const roundLength = (turn: number) => (turn < EARLY_GAME_UNTIL_TURN ? EARLY_ROUND_TURNS : TURNS_PER_ROUND);

/** Where a round's words go: Telegram in play, the console in the harness */
export type RoundIO = {
  /** Wraps slow work for one seat, e.g. to show "typing…" */
  working: <T>(seat: Seat, work: Promise<T>) => Promise<T>;
  dispatch: (seat: Seat, dispatch: Dispatch, round: RoundResult) => Promise<void>;
  /** A two-line note to a ruler whom the urgent news does not concern */
  notice: (seat: Seat, text: string) => Promise<void>;
  chronicle: (chapter: string, images: { caption: string; description: string }[], round: RoundResult) => Promise<void>;
  log: (...args: unknown[]) => void;
};

export async function playRound(allSeats: Seat[], io: RoundIO): Promise<RoundResult> {
  // A fallen realm has no advisor left to govern or report
  const alive = new Set((await host.state()).majorCivs.filter((civ) => civ.alive).map((civ) => civ.civ));
  const seats = allSeats.filter((seat) => alive.has(seat.civ));
  state.phase = "passing";
  persist();
  const notes = new Map(seats.map((seat) => [seat.civ, [] as string[]]));
  let urgentFor: Seat[] | undefined;
  // What the rulers said aloud before this round began belongs to the chapter about it
  const proclaimed = seats.flatMap((seat) => seat.proclamations ?? []);
  for (const seat of seats) seat.proclamations = undefined;
  try {
    const opening = await host.state();
    // Resuming after urgent news: play what is left of the interrupted round, and report on the whole of it
    const pending = state.pendingRound;
    state.pendingRound = undefined;
    const fromTurn = pending?.fromTurn ?? opening.turn;
    (state.proclaimed ??= []).push(...proclaimed.map((text) => ({ turn: fromTurn, year: opening.year, text })));
    const length = pending ? opening.turn - pending.fromTurn + pending.remaining : roundLength(fromTurn);
    io.log(pending ? `Round resuming at turn ${opening.turn}, ${pending.remaining} turns left` : `Round starting at turn ${fromTurn}, ${length} turns`);
    let round: RoundResult | undefined;
    let carried = pending?.publicEvents ?? [];
    // A council event (war, a lost city, victory) ends the round early
    // Everyone looks in on schedule; in between, an advisor is sent for only when something happened in their realm
    let woken: Record<string, string[]> = {};
    const sentFor = new Set<string>();
    let lookedAt = new Map(seats.map((seat) => [seat.civ, fromTurn]));
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
              notes.get(seat.civ)!.push(`T${now}: ${entry}`);
              lookedAt.set(seat.civ, now);
              // Collected to learn whether advisors should ever be able to send for the ruler
              const wished = /WISHED TO ASK:\s*(.+)/.exec(entry)?.[1];
              if (wished) appendFileSync(WISHES, `- ${seat.civ}, turn ${now}: ${wished}\n`);
            })
            // A look-in that never happened must not read as a quiet one: the dispatch is written from these notes, and so is the journal
            .catch((error) => { io.log(`govern pass for ${seat.civ} failed:`, error.message); notes.get(seat.civ)!.push(`T${now}: (no look-in this year - the advisor could not be reached: ${String(error.message).slice(0, 80)}. The realm ran on the standing orders alone.)`); }),
        ),
      );
      const untilNextLookIn = GOVERN_EVERY - (played % GOVERN_EVERY);
      const chunk = await host.advance(Math.min(untilNextLookIn, length - played), true);
      played = chunk.turn - fromTurn;
      round = { ...chunk, fromTurn, fromYear: round?.fromYear ?? pending?.fromYear ?? chunk.fromYear, publicEvents: [...(round?.publicEvents ?? carried), ...chunk.publicEvents] };
      carried = [];
      // A wake-up that lands on a scheduled look-in anyway needs no pass of its own
      // ...and an advisor is sent for at most once between two look-ins; whatever else happens waits for the next one
      if (played % GOVERN_EVERY === 0) sentFor.clear();
      woken = played % GOVERN_EVERY === 0 || played >= length ? {}
        : Object.fromEntries(Object.entries(chunk.wake ?? {}).filter(([civ]) => seats.some((seat) => seat.civ === civ) && !sentFor.has(civ)));
      for (const civ of Object.keys(woken)) sentFor.add(civ);
      io.log(`Advanced to turn ${chunk.turn}`, chunk.stoppedEarly ?? "", Object.keys(woken).length ? `woke ${Object.keys(woken).join(", ")}` : "");
      if (chunk.stoppedEarly || chunk.turn === now) break;
    }
    if (!round) throw new Error("No turns were played");
    const finished = round;

    // Urgent news (not a victory): summon only the rulers it concerns, keep the rest of the round for afterwards
    const news = finished.stoppedEarly;
    const remaining = length - (finished.turn - fromTurn);
    if (news && !/has won/.test(news) && remaining > 0) {
      // Every ruler is called to the emergency council - the one it concerns to answer, the others to see whether they will join in, stand aside or change course
      const rulers = seats.filter((seat) => seat.kind !== "agent");
      state.pendingRound = { fromTurn, fromYear: finished.fromYear, remaining, publicEvents: finished.publicEvents };
      await Promise.all([
        ...rulers.map(async (seat) => {
          const concerned = news.startsWith(seat.civ);
          const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
          const dispatch = await io.working(seat, advisorUrgent(seat, news, briefing, concerned));
          // The ruler must see at a glance that this is not the regular audience: the age was cut short, and why
          dispatch.heading = `Emergency council, ${finished.year} - the age was interrupted: ${news.replace(/[.!]+$/, "")}.\nNot a full age has passed. The rest of it plays out once every court has risen.`;
          notes.get(seat.civ)!.push(dispatch.journal);
          (seat.annals ??= []).push({ years: finished.year, story: dispatch.text, question: dispatch.question, urgent: true });
          remember(seat, { from: "advisor", text: [dispatch.text, dispatch.question].filter(Boolean).join("\n\n") });
          await io.dispatch(seat, dispatch, finished);
        }),
        heraldBulletin(news, finished.publicEvents.slice(-8)).then((bulletin) => io.chronicle(bulletin, [], finished)),
      ]);
      urgentFor = rulers;
      return finished;
    }

    // One realm's failed letter must not cost the others theirs
    const settled = await Promise.allSettled([
      ...seats.map(async (seat) => {
        const governLogs = notes.get(seat.civ)!;
        const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
        if (seat.kind === "agent") {
          // An agent realm holds no council with itself: its journal is its own look-in notes, and it weighs the longer game at the first look-in of the next age
          const entry = governLogs.map((note) => note.replace(/^T\d+: /, "")).filter((note) => !/^nothing to change/i.test(note)).join(" ");
          seat.journal.push(`${finished.fromYear} to ${finished.year}: ${entry.length > 700 ? `${entry.slice(0, 700)}...` : entry || "A quiet age; nothing changed."}`);
          return;
        }
        const ending = finished.stoppedEarly && /has won/.test(finished.stoppedEarly) ? finished.stoppedEarly.replace(/[.!]+$/, "") : undefined;
        const dispatch = await io.working(seat, advisorReport(seat, finished, governLogs, briefing, ending));
        if (ending) dispatch.heading = `The game is over: ${ending}. This is your advisor's last letter; the saga of your reign follows.`;
        seat.journal.push(`${finished.fromYear} to ${finished.year}: ${dispatch.journal}`);
        seat.choices = undefined;
        (seat.annals ??= []).push({ years: `${finished.fromYear} to ${finished.year}`, story: dispatch.text, course: dispatch.strategy || undefined, question: dispatch.question });
        seat.forCouncil = undefined; // what was left with the clerk has now been answered
        remember(seat, { from: "advisor", text: [dispatch.text, dispatch.strategy, dispatch.question].filter(Boolean).join("\n\n") });
        await io.dispatch(seat, dispatch, finished);
      }),
      // Earlier chapters come from the host, so a restart does not make the Chronicler forget
      host
        .events()
        .then((all) => heraldNewspaper(finished, all.filter((event) => event.turn <= finished.fromTurn), proclaimed))
        .then((raw) => {
          // The chapter is everything before the first IMAGES:; the pictures are whichever block carries descriptions (a model sometimes lists captions first and the full lines after)
          const [chapter, ...blocks] = raw.split(/\n\s*IMAGES:\s*\n?/);
          const images = blocks.flatMap((block) => block.split("\n").map((line) => splitPicture(line.replace(/^[-*\s]+/, ""))).filter((picture): picture is { caption: string; description: string } => !!picture))
            .filter((picture, index, all) => all.findIndex((other) => other.caption === picture.caption) === index).slice(0, 2);
          (state.chapters ??= []).push({ years: `${finished.fromYear} to ${finished.year}`, text: chapter.trim() });
          return io.chronicle(chapter.trim(), images, finished);
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
