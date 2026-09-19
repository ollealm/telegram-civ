// One round of play, shared by the Telegram bots and the test harness:
// the advisors govern every few turns, time passes, then dispatches and the Chronicler's chapter go out.

import { advisorReport, governPass, heraldNewspaper, type Dispatch } from "./agents.ts";
import { host, type RoundResult } from "./host.ts";
import { persist, remember, state, type Seat } from "./store.ts";

const TURNS_PER_ROUND = Number(process.env.TURNS_PER_ROUND ?? 12);
const EARLY_ROUND_TURNS = Number(process.env.EARLY_ROUND_TURNS ?? 24);
const EARLY_GAME_UNTIL_TURN = Number(process.env.EARLY_GAME_UNTIL_TURN ?? 48);
export const GOVERN_EVERY = Number(process.env.GOVERN_EVERY_TURNS ?? 4);

/** Turns in the round that starts at this turn - longer while the early game is slow */
export const roundLength = (turn: number) => (turn < EARLY_GAME_UNTIL_TURN ? EARLY_ROUND_TURNS : TURNS_PER_ROUND);

/** Where a round's words go: Telegram in play, the console in the harness */
export type RoundIO = {
  /** Wraps slow work for one seat, e.g. to show "typing…" */
  working: <T>(seat: Seat, work: Promise<T>) => Promise<T>;
  dispatch: (seat: Seat, dispatch: Dispatch) => Promise<void>;
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
  // What the rulers said aloud before this round began belongs to the chapter about it
  const proclaimed = seats.flatMap((seat) => seat.proclamations ?? []);
  for (const seat of seats) seat.proclamations = undefined;
  try {
    const opening = await host.state();
    const fromTurn = opening.turn;
    (state.proclaimed ??= []).push(...proclaimed.map((text) => ({ turn: fromTurn, year: opening.year, text })));
    const length = roundLength(fromTurn);
    io.log(`Round starting at turn ${fromTurn}, ${length} turns`);
    let round: RoundResult | undefined;
    // A council event (war, a lost city, victory) ends the round early
    for (let played = 0; played < length; ) {
      const step = Math.min(GOVERN_EVERY, length - played);
      const sinceTurn = fromTurn + played;
      await Promise.all(
        seats.map((seat) =>
          io
            .working(seat, governPass(seat, sinceTurn, step))
            .then((entry) => notes.get(seat.civ)!.push(`T${sinceTurn}: ${entry}`))
            .catch((error) => io.log(`govern pass for ${seat.civ} failed:`, error.message)),
        ),
      );
      const chunk = await host.advance(step);
      played = chunk.turn - fromTurn;
      round = { ...chunk, fromTurn, fromYear: round?.fromYear ?? chunk.fromYear, publicEvents: [...(round?.publicEvents ?? []), ...chunk.publicEvents] };
      io.log(`Advanced to turn ${chunk.turn}`, chunk.stoppedEarly ?? "");
      if (chunk.stoppedEarly || chunk.turn === sinceTurn) break;
    }
    if (!round) throw new Error("No turns were played");
    const finished = round;

    await Promise.all([
      ...seats.map(async (seat) => {
        const governLogs = notes.get(seat.civ)!;
        const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
        const dispatch = await io.working(seat, advisorReport(seat, finished, governLogs, briefing));
        seat.journal.push(`${finished.fromYear} to ${finished.year}: ${dispatch.journal}`);
        seat.choices = undefined;
        remember(seat, { from: "advisor", text: [dispatch.text, dispatch.strategy, dispatch.question].filter(Boolean).join("\n\n") });
        await io.dispatch(seat, dispatch);
      }),
      // Earlier chapters come from the host, so a restart does not make the Chronicler forget
      host
        .events()
        .then((all) => heraldNewspaper(finished, all.filter((event) => event.turn <= finished.fromTurn), proclaimed))
        .then((raw) => {
          const [chapter, imageLines = ""] = raw.split(/\n\s*IMAGES:\s*\n?/);
          const images = imageLines.split("\n").map((line) => line.replace(/^[-*\s]+/, "").split("|")).filter((parts) => parts.length >= 2)
            .map(([caption, ...rest]) => ({ caption: caption.trim(), description: rest.join("|").trim() })).slice(0, 2);
          return io.chronicle(chapter.trim(), images, finished);
        }),
    ]);
    return finished;
  } finally {
    for (const seat of state.seats) seat.ready = false;
    state.phase = "audience";
    persist();
  }
}
