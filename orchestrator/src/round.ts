// One round of play, shared by the Telegram bots and the test harness:
// the advisors govern every few turns, time passes, then dispatches and the Chronicler's chapter go out.

import { advisorReport, governPass, heraldNewspaper, journalEntry } from "./agents.ts";
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
  dispatch: (seat: Seat, report: string) => Promise<void>;
  chronicle: (chapter: string) => Promise<void>;
  log: (...args: unknown[]) => void;
};

export async function playRound(seats: Seat[], io: RoundIO): Promise<RoundResult> {
  state.phase = "passing";
  persist();
  const notes = new Map(seats.map((seat) => [seat.civ, [] as string[]]));
  try {
    const fromTurn = (await host.state()).turn;
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
        const report = await io.working(seat, advisorReport(seat, finished, governLogs, briefing));
        seat.journal.push(journalEntry(finished, governLogs));
        remember(seat, { from: "advisor", text: report });
        await io.dispatch(seat, report);
      }),
      // Earlier chapters come from the host, so a restart does not make the Chronicler forget
      host
        .events()
        .then((all) => heraldNewspaper(finished, all.filter((event) => event.turn <= finished.fromTurn)))
        .then(io.chronicle),
    ]);
    return finished;
  } finally {
    for (const seat of state.seats) seat.ready = false;
    state.phase = "audience";
    persist();
  }
}
