// Telegram front: one advisor bot per seat, one herald bot for the world newspaper

import { Bot, InputFile, type Context } from "grammy";
import { advisorReply, advisorReport, governPass, heraldNewspaper, journalEntry } from "./agents.ts";
import { host, type PublicEvent, type RoundResult } from "./host.ts";
import { persist, remember, state, type Seat } from "./store.ts";

const TURNS_PER_ROUND = Number(process.env.TURNS_PER_ROUND ?? 12);
const EARLY_ROUND_TURNS = Number(process.env.EARLY_ROUND_TURNS ?? 24);
const EARLY_GAME_UNTIL_TURN = Number(process.env.EARLY_GAME_UNTIL_TURN ?? 48);
const GOVERN_EVERY = Number(process.env.GOVERN_EVERY_TURNS ?? 4);
/** Turns in the round that starts at this turn - longer while the early game is slow */
const roundLength = (turn: number) => (turn < EARLY_GAME_UNTIL_TURN ? EARLY_ROUND_TURNS : TURNS_PER_ROUND);
const RULED_CIVS = (process.env.RULED_CIVS ?? "Rome,Greece").split(",").map((civ) => civ.trim());
const OTHER_CIVS = (process.env.OTHER_CIVS ?? "Egypt,China").split(",").map((civ) => civ.trim());

const advisorTokens = Object.keys(process.env)
  .filter((key) => /^ADVISOR_\d+_BOT_TOKEN$/.test(key))
  .sort()
  .map((key) => process.env[key]!);
if (!process.env.HERALD_BOT_TOKEN || advisorTokens.length === 0) throw new Error("Bot tokens missing - see .env");
if (advisorTokens.length > RULED_CIVS.length) throw new Error("More advisor bots than RULED_CIVS");

const herald = new Bot(process.env.HERALD_BOT_TOKEN);
const advisors = advisorTokens.map((token) => new Bot(token));
const pastHeadlines: PublicEvent[] = [];

const log = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);

/** Show "typing…" for as long as the work takes */
async function whileTyping<T>(bot: Bot, chatId: number, work: Promise<T>): Promise<T> {
  const tick = () => bot.api.sendChatAction(chatId, "typing").catch(() => {});
  tick();
  const timer = setInterval(tick, 4500);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

async function ensureGame() {
  const game = await host.state();
  const civs = RULED_CIVS.slice(0, advisors.length);
  if (!game.running) {
    await host.newGame({ ruled: civs, others: [...RULED_CIVS.slice(advisors.length), ...OTHER_CIVS] });
    log("Started a new game; ruled:", civs.join(", "));
  }
  civs.forEach((civ, index) => {
    const seat = state.seats[index];
    if (!seat || seat.civ !== civ) state.seats[index] = { civ, will: "", journal: [], chat: [], ready: false };
  });
  persist();
}

async function sendMap(bot: Bot, seat: Seat) {
  const png = await host.map(seat.civ);
  await bot.api.sendPhoto(seat.chatId!, new InputFile(png, "map.png"));
}

async function broadcastHerald(text: string) {
  for (const chatId of state.heraldChats) await herald.api.sendMessage(chatId, text).catch((error) => log("herald send failed", error.message));
}

async function playRound() {
  state.roundInProgress = true;
  const seated = state.seats.map((seat, index) => ({ seat, bot: advisors[index] })).filter(({ seat }) => seat.chatId);
  const governLogs = new Map(seated.map(({ seat }) => [seat.civ, [] as string[]]));
  try {
    const fromTurn = (await host.state()).turn;
    const length = roundLength(fromTurn);
    log(`Round starting at turn ${fromTurn}, ${length} turns`);
    let round: RoundResult | undefined;
    // The advisors govern every few turns, then time passes; a council event ends the round early
    for (let played = 0; played < length; ) {
      const step = Math.min(GOVERN_EVERY, length - played);
      const sinceTurn = fromTurn + played;
      await Promise.all(
        seated.map(({ seat, bot }) =>
          whileTyping(bot, seat.chatId!, governPass(seat, sinceTurn, step))
            .then((entry) => governLogs.get(seat.civ)!.push(`T${sinceTurn}: ${entry}`))
            .catch((error) => log(`govern pass for ${seat.civ} failed:`, error.message)),
        ),
      );
      const chunk = await host.advance(step);
      played = chunk.turn - fromTurn;
      round = { ...chunk, fromTurn, publicEvents: [...(round?.publicEvents ?? []), ...chunk.publicEvents] };
      log(`Advanced to turn ${chunk.turn}`, chunk.stoppedEarly ?? "");
      if (chunk.stoppedEarly || chunk.turn === sinceTurn) break;
    }
    if (!round) throw new Error("No turns were played");
    const finished = round;

    await Promise.all([
      ...seated.map(async ({ seat, bot }) => {
        const notes = governLogs.get(seat.civ)!;
        const briefing = await host.briefing(seat.civ).catch(() => ({ note: `${seat.civ} is no more.` }));
        const report = await whileTyping(bot, seat.chatId!, advisorReport(seat, finished, notes, briefing));
        seat.journal.push(journalEntry(finished, notes));
        remember(seat, { from: "advisor", text: report });
        await sendMap(bot, seat).catch((error) => log("map failed:", error.message));
        await bot.api.sendMessage(seat.chatId!, report);
      }),
      heraldNewspaper(finished, pastHeadlines).then(broadcastHerald),
    ]);
    pastHeadlines.push(...finished.publicEvents);

    const game = await host.state();
    if (game.winner) await broadcastHerald(`The game is over: ${game.winner} has won a ${game.victoryType} victory.`);
  } catch (error) {
    log("Round failed:", error);
    for (const { seat, bot } of seated)
      await bot.api.sendMessage(seat.chatId!, "Something went wrong while time was passing. Send /go to try again.").catch(() => {});
  } finally {
    for (const seat of state.seats) seat.ready = false;
    state.roundInProgress = false;
    persist();
  }
}

function usageSummary() {
  const rows = Object.entries(state.usage).map(
    ([role, usage]) =>
      `${role}: ${usage.calls} calls, ${Math.round(usage.inputTokens / 1000)}k in / ${Math.round(usage.outputTokens / 1000)}k out, $${usage.costUsd.toFixed(2)}`,
  );
  const total = Object.values(state.usage).reduce((sum, usage) => sum + usage.costUsd, 0);
  return rows.length ? `${rows.join("\n")}\nTotal: $${total.toFixed(2)} (API-price equivalent)` : "No usage yet.";
}

function setUpAdvisor(bot: Bot, index: number) {
  const seat = (): Seat => state.seats[index];
  let queue: Promise<unknown> = Promise.resolve();

  /** Only the first person to speak to this advisor becomes its ruler */
  const isRuler = (ctx: Context) => {
    if (ctx.chat?.type !== "private") return false;
    if (seat().chatId === undefined) {
      seat().chatId = ctx.chat.id;
      seat().rulerName = ctx.from?.first_name;
      persist();
      log(`${seat().civ} is now ruled by ${seat().rulerName}`);
    }
    return seat().chatId === ctx.chat.id;
  };

  bot.use(async (ctx, next) => {
    if (isRuler(ctx)) await next();
    else await ctx.reply(`${seat().civ} already has a ruler.`);
  });

  bot.command("start", (ctx) =>
    ctx.reply(
      `Your Majesty. I am your chief advisor; ${seat().civ} is yours to rule.\n\nTell me what you want for the realm - ask me anything, and we will make a plan. Everything you say to me is counsel or orders; time does not pass while we talk. When you are done, say so or send /go, and the years roll on until my next report. I check on the realm every few years while you are away.\n\n/status - where things stand\n/map - the map as we know it\n/usage - token use so far`,
    ),
  );

  const dismiss = async (reply: (text: string) => Promise<unknown>, silently = false) => {
    if (state.roundInProgress) return reply("Time is already passing, Majesty.");
    // Dismissed without answering the advisor's last question: silence is assent to what it recommended
    const last = seat().chat.at(-1);
    if (silently && last?.from === "advisor" && /\?/.test(last.text)) {
      const message = "[The ruler dismisses the court without another word. Take silence as assent to your last recommendation: apply it now, record any change to the will, and say in one or two sentences what you took as agreed. If you recommended nothing actionable, say only that you proceed as before.]";
      try {
        const answer = await whileTyping(bot, seat().chatId!, advisorReply(seat(), message, roundLength((await host.state()).turn)));
        remember(seat(), { from: "advisor", text: answer });
        await reply(answer);
      } catch (error) {
        log("closing pass failed:", error);
      }
    }
    seat().ready = true;
    seat().dismissed = false;
    persist();
    const waiting = state.seats.filter((other) => other.chatId && !other.ready).map((other) => other.civ);
    if (waiting.length) return reply(`The court is dismissed. Waiting for the ruler of ${waiting.join(", ")}.`);
    await reply("The court is dismissed. Time passes…");
    for (const other of state.seats)
      if (other !== seat() && other.chatId) await advisors[state.seats.indexOf(other)].api.sendMessage(other.chatId, "All rulers have dismissed their courts. Time passes…");
    void playRound();
  };

  bot.command("go", (ctx) => dismiss((text) => ctx.reply(text), true));

  bot.command("status", async (ctx) => {
    const game = await host.state();
    const ready = state.seats.filter((other) => other.chatId).map((other) => `${other.civ}: ${other.ready ? "ready" : "in audience"}`);
    await ctx.reply(`${game.year} (turn ${game.turn}). ${state.roundInProgress ? "Time is passing." : ready.join(", ")}\n\nYour recorded will:\n${seat().will || "(none yet)"}`);
  });

  bot.command("usage", (ctx) => ctx.reply(usageSummary()));

  bot.command("map", (ctx) => sendMap(bot, seat()).catch(() => ctx.reply("No map to show yet.")));

  // The first seat's ruler may start over: /newgame, then /newgame confirm
  bot.command("newgame", async (ctx) => {
    if (index !== 0) return ctx.reply("Only the ruler of the first seat may start a new game.");
    if (state.roundInProgress) return ctx.reply("Wait until time stops passing.");
    if (!/confirm/i.test(ctx.match)) return ctx.reply("This ends the current game for everyone. Send /newgame confirm to do it.");
    await host.newGame({ ruled: RULED_CIVS.slice(0, advisors.length), others: [...RULED_CIVS.slice(advisors.length), ...OTHER_CIVS] });
    for (const other of state.seats) Object.assign(other, { will: "", journal: [], chat: [], ready: false });
    pastHeadlines.length = 0;
    persist();
    for (const other of state.seats)
      if (other.chatId) await advisors[state.seats.indexOf(other)].api.sendMessage(other.chatId, `A new age begins. ${other.civ} is yours, Majesty - tell me what you want for it.`).catch(() => {});
    await broadcastHerald("A new world has been created. The Herald will report from turn one.");
  });

  bot.on("message:text", async (ctx) => {
    if (state.roundInProgress) return ctx.reply("Time is passing, Majesty - I will report as soon as there is news.");
    const message = ctx.message.text;
    const game = await host.state();
    // One audience at a time per seat, so replies stay in order
    queue = queue.then(async () => {
      try {
        const reply = await whileTyping(bot, ctx.chat.id, advisorReply(seat(), message, roundLength(game.turn)));
        remember(seat(), { from: "ruler", text: message });
        remember(seat(), { from: "advisor", text: reply });
        await ctx.reply(reply);
        if (seat().dismissed) await dismiss((text) => ctx.reply(text));
      } catch (error) {
        log("advisor failed:", error);
        await ctx.reply("Forgive me, Majesty, I lost my train of thought. Could you say that again?");
      }
    });
  });

  bot.catch((error) => log(`advisor ${index + 1} error:`, error.message));
}

function setUpHerald() {
  const subscribe = async (ctx: Context) => {
    if (!ctx.chat || state.heraldChats.includes(ctx.chat.id)) return;
    state.heraldChats.push(ctx.chat.id);
    persist();
    log("Herald now publishes to chat", ctx.chat.id);
    await ctx.reply("The Herald will deliver every edition of the world's news here.");
  };
  herald.on("my_chat_member", subscribe);
  herald.on("message", subscribe);
  herald.catch((error) => log("herald error:", error.message));
}

await ensureGame();
advisors.forEach(setUpAdvisor);
setUpHerald();
for (const bot of [herald, ...advisors]) void bot.start({ onStart: (me) => log(`@${me.username} is listening`) });
