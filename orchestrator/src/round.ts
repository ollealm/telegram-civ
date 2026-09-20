// One round of play, shared by the Telegram bots and the test harness:
// the advisors govern every few turns, time passes, then dispatches and the Chronicler's chapter go out.

import { advisorReport, advisorUrgent, governPass, heraldBulletin, heraldNewspaper, sovereignCouncil, type Dispatch } from "./agents.ts";
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
      const due = scheduled ? seats : seats.filter((seat) => woken[seat.civ]);
      await Promise.all(
        due.map((seat) =>
          io
            .working(seat, governPass(seat, lookedAt.get(seat.civ)!, GOVERN_EVERY, woken[seat.civ]))
            .then((entry) => { notes.get(seat.civ)!.push(`T${now}: ${entry}`); lookedAt.set(seat.civ, now); })
            .catch((error) => io.log(`govern pass for ${seat.civ} failed:`, error.message)),
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
      const concerned = seats.filter((seat) => news.startsWith(seat.civ) && seat.kind !== "agent"); // an agent realm deals with its own crises at its next look-in
      state.pendingRound = { fromTurn, fromYear: finished.fromYear, remaining, publicEvents: finished.publicEvents };
      await Promise.all([
        ...concerned.map(async (seat) => {
          const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
          const dispatch = await io.working(seat, advisorUrgent(seat, news, briefing));
          notes.get(seat.civ)!.push(dispatch.journal);
          remember(seat, { from: "advisor", text: [dispatch.text, dispatch.question].filter(Boolean).join("\n\n") });
          await io.dispatch(seat, dispatch);
        }),
        ...seats.filter((seat) => !concerned.includes(seat) && seat.kind !== "agent").map((seat) => io.notice(seat, `News from abroad has stopped the clocks: ${news}. Our realm is untouched; I carry on as we agreed, and time resumes once the rulers concerned have held council.`)),
        heraldBulletin(news, finished.publicEvents.slice(-8)).then((bulletin) => io.chronicle(bulletin, [], finished)),
      ]);
      urgentFor = concerned;
      return finished;
    }

    await Promise.all([
      ...seats.map(async (seat) => {
        const governLogs = notes.get(seat.civ)!;
        const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
        if (seat.kind === "agent") {
          const entry = await sovereignCouncil(seat, finished, governLogs, briefing).catch((error) => `(council failed: ${error.message})`);
          seat.journal.push(`${finished.fromYear} to ${finished.year}: ${entry}`);
          return;
        }
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
    // After urgent news only the rulers concerned are waited for; everyone else stays dismissed
    for (const seat of state.seats) seat.ready = urgentFor !== undefined && !urgentFor.includes(seat);
    state.phase = "audience";
    persist();
  }
}
