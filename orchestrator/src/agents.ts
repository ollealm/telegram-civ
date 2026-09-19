// One advisor persona in three moments: the audience (chat), governing between audiences, and the dispatch.
// Plus the herald, who writes the world newspaper from public events only.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { host, type PublicEvent, type RoundResult } from "./host.ts";
import { addUsage, persist, type Seat } from "./store.ts";

const ADVISOR_MODEL = process.env.ADVISOR_MODEL ?? "claude-opus-5";
const HERALD_MODEL = process.env.HERALD_MODEL ?? ADVISOR_MODEL;
/** Governing passes are the bulk of the token use; set GOVERN_MODEL=claude-sonnet-5 to make them ~5x cheaper */
const GOVERN_MODEL = process.env.GOVERN_MODEL ?? ADVISOR_MODEL;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
});

/** Host errors go back to the model as tool errors so it can correct a bad name and retry */
const attempt = async (action: () => Promise<unknown>) => {
  try {
    return text(await action());
  } catch (error) {
    return { ...text(String(error instanceof Error ? error.message : error)), isError: true };
  }
};

const PERSONALITY_VALUES = ["Production", "Food", "Gold", "Science", "Culture", "Happiness", "Faith", "Military", "Aggressive", "DeclareWar", "Commerce", "Diplomacy", "Loyal", "Expansion"] as const;
const weight = z.number().min(0).max(10);
const PERSONALITY_HELP =
  "Weights 0-10 (5 neutral) that tilt everything the officials decide on their own - what cities build when their queue is empty, which tiles get worked, how many soldiers to keep. " +
  "Military = army size, Aggressive = attack vs defend, Expansion = eagerness to found cities, Diplomacy = courting city-states and friendships. " +
  "They are a bias, not a command: use queue/build/purchase for anything specific. DeclareWar stays 0 unless the ruler wants officials to start wars on their own.";

/** Game tools, scoped to one civ - an agent can never see or touch another realm */
function gameTools(seat: Seat, { canRecordWill }: { canRecordWill: boolean }) {
  const tools = [
    tool("get_briefing", "Current state of our realm: treasury, warnings, research, cities and their queues, units and where they are, threats in sight, known civs, the last 12 turns of the chancery log, standing orders.", {}, () =>
      attempt(() => host.briefing(seat.civ)),
    ),
    tool(
      "get_options",
      "What we can choose from right now: researchable techs and all future tech names, policy branches, what each city can build and buy (with turns and gold cost), who we could declare war on.",
      {},
      () => attempt(() => host.options(seat.civ)),
    ),
    tool(
      "get_log",
      "The chancery log: everything that happened to our realm turn by turn - what was built, lost, researched, what the officials changed on their own.",
      { sinceTurn: z.number().describe("Return entries after this turn") },
      ({ sinceTurn }) => attempt(() => host.log(seat.civ, sinceTurn)),
    ),
    tool(
      "set_orders",
      "Change the realm's orders; include only what should change. Standing orders (kept until changed): personality, research, policyBranches. Immediate: queue, build, purchase, declareWar. The reply confirms the resulting queues, research and gold.",
      {
        personality: z.object(Object.fromEntries(PERSONALITY_VALUES.map((name) => [name, weight]))).partial().optional().describe(PERSONALITY_HELP),
        research: z.array(z.string()).optional().describe("Technology goals in priority order; the path to each is researched automatically and the officials never deviate while a goal remains."),
        policyBranches: z.array(z.string()).optional().describe("Policy branches in the order to adopt and complete them."),
        neverBuild: z.array(z.string()).optional().describe("Standing: buildings and units the officials may never queue on their own (e.g. Barracks, Knight). Replaces the previous list. You can still order them yourself."),
        queue: z.array(z.object({ city: z.string(), items: z.array(z.string()) })).optional().describe("Replace a city's whole build queue, in order. Binding: the officials only add to it once it runs out."),
        build: z.array(z.object({ city: z.string(), item: z.string() })).optional().describe("Put one item at the front of a city's queue, keeping the rest."),
        purchase: z.array(z.object({ city: z.string(), item: z.string() })).optional().describe("Buy a unit or building outright with gold, delivered at once. See get_options for prices."),
        declareWar: z.array(z.string()).optional().describe("Civs to declare war on, immediately. Only on the ruler's explicit command."),
        units: z.array(z.object({
          unit: z.number().describe("Unit id from the briefing (#id)"),
          action: z.enum(["move", "settle", "garrison", "fortify", "hold", "explore", "use", "disband", "release"]).describe("move: go there then back to the officials; settle: go there and found a city (checked now - invalid sites are refused with a reason); garrison: go to a city and stay as its defender; fortify/hold: keep the spot; explore: hand a military unit to exploration; use: go there and use a great person's ability (trade mission at a city-state's city, academy/manufactory on our tile, hurry research/wonder/policy in a city); disband: dismiss the unit for good (saves upkeep); release: back to the officials. A newborn Great Person holds until you order it"),
          x: z.number().optional(), y: z.number().optional(),
          city: z.string().optional().describe("Target a city by name instead of x/y"),
        })).optional().describe("Orders to single units. A unit under orders is not touched by the officials until released or done."),
        trade: z.array(z.object({
          with: z.string(),
          give: z.array(z.object({ item: z.string(), amount: z.number().optional() })).optional(),
          want: z.array(z.object({ item: z.string(), amount: z.number().optional() })).optional(),
        })).optional().describe("Propose a trade to a major civ; see get_options.diplomacy for tradeable items. They answer on their turn."),
        peace: z.array(z.string()).optional().describe("Propose peace to civs we are at war with."),
        friendship: z.array(z.string()).optional().describe("Propose a declaration of friendship."),
        gift: z.array(z.object({ cityState: z.string(), gold: z.number() })).optional().describe("Give gold to a city-state for influence."),
        cityFocus: z.array(z.object({ city: z.string(), focus: z.enum(["NoFocus", "Food", "Production", "Gold", "Science", "Culture", "Happiness", "Faith", "GoldGrowth", "ProductionGrowth"]) })).optional().describe("What a city's citizens work its tiles for. NoFocus lets the officials balance."),
      },
      (orders) => attempt(() => host.setOrders(seat.civ, orders)),
    ),
  ];
  if (canRecordWill)
    tools.push(
      tool(
        "dismiss_court",
        "The ruler has clearly said to proceed, let time pass, or that they are done for now. Call this once, after any orders are set; it ends the audience exactly like the /go command.",
        {},
        async () => {
          seat.dismissed = true;
          persist();
          return text("The court will be dismissed when you finish speaking.");
        },
      ) as never,
      tool(
        "record_rulers_will",
        "Replace the record of the ruler's standing wishes - the text you govern by while the ruler is away. Only standing intent: goals, priorities, red lines, stance towards each neighbour, what to do if attacked. No history, no log, no numbers that go stale.",
        { will: z.string() },
        async ({ will }) => {
          seat.will = will;
          persist();
          return text("Recorded.");
        },
      ) as never,
    );
  return createSdkMcpServer({ name: "realm", version: "1.0.0", tools });
}

async function run(role: string, model: string, systemPrompt: string, prompt: string, seat?: Seat, canRecordWill = false) {
  async function* input() {
    yield { type: "user" as const, message: { role: "user" as const, content: prompt }, parent_tool_use_id: null, session_id: "" };
  }
  const toolNames = ["get_briefing", "get_options", "get_log", "set_orders", ...(canRecordWill ? ["record_rulers_will", "dismiss_court"] : [])];
  const stream = query({
    prompt: input() as never,
    options: {
      model,
      systemPrompt,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      // Use the CLI's own login even when launched from inside another Claude session
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|ANTHROPIC)/.test(key))),
      maxTurns: 15,
      ...(seat && {
        mcpServers: { realm: gameTools(seat, { canRecordWill }) },
        allowedTools: toolNames.map((name) => `mcp__realm__${name}`),
      }),
    },
  });
  for await (const message of stream) {
    if (process.env.RULER_DEBUG) console.log(`[${role}]`, JSON.stringify(message).slice(0, 600));
    if (message.type !== "result") continue;
    const usage = message.usage;
    addUsage(role, {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      costUsd: message.total_cost_usd ?? 0,
    });
    if (message.subtype === "success") return message.result.trim();
    throw new Error(`${role} agent failed: ${message.subtype}`);
  }
  throw new Error(`${role} agent returned nothing`);
}

const TELEGRAM_STYLE =
  "You write for a Telegram chat: plain text, short paragraphs, no markdown headers, tables or bullet walls. Never mention tools, JSON, APIs or that this is a game engine.";

const persona = (seat: Seat) => `You are the chief advisor to ${seat.rulerName ?? "the ruler"}, sovereign of ${seat.civ}, in a world of rival civilizations.

The ruler never governs directly. They say what they want; you make it happen through the realm's officials. The officials move units, work tiles, trade and fill empty build queues by themselves, tilted by the personality weights. You hold the real levers: research goals and policy order (binding), city build queues (binding once set), gold purchases, orders to single units (move, settle at a site, fortify, hold, explore), diplomacy (trades, peace, friendship, gifts to city-states) and war.
Units you do not order are run by the officials; a unit under your orders stays where you put it until you release it, so do not leave soldiers holding forever. Proposals to other civs are answered on their turn; a deal exists only when the log says it came into force and it shows under dealsInForce - never report one as done before that. When a proposal is judged likely to be refused, improve the terms instead of re-sending it. The map image the ruler sees uses the same (x,y) coordinates as the briefing.
Be candid: report failures and losses as they are, and read the chancery log before explaining what happened. Stay in character - loyal, concise, a little dry. ${TELEGRAM_STYLE}`;

const memory = (seat: Seat) =>
  `The ruler's standing will:\n${seat.will || "(nothing recorded yet)"}\n\nYour campaign journal (newest last):\n${seat.journal.slice(-8).join("\n") || "(the campaign has just begun)"}`;

const transcript = (seat: Seat) =>
  seat.chat.map((message) => `${message.from === "ruler" ? "Ruler" : "You"}: ${message.text}`).join("\n\n");

export const advisorReply = (seat: Seat, message: string, turnsPerRound: number) =>
  run(
    "advisor",
    ADVISOR_MODEL,
    `${persona(seat)}

This is an audience. Answer questions from the briefing and the log; help the ruler form a plan; offer your own judgement and push back on unwise wishes - then obey. When the ruler decides something, act on it now with set_orders, and if their standing wishes changed, rewrite the record of the ruler's will (standing intent only - never copy history or the journal into it). Close by saying briefly what you changed. Declare war only on an explicit command.
Time passes only when the ruler dismisses the court - with /go, or by telling you to proceed, in which case you call dismiss_court after setting the orders. A "yes" to a question of yours is an order, not a dismissal. Then about ${turnsPerRound} turns pass (a few decades early on, years later), during which you govern by the recorded will and check on the realm every few turns. Speak of time in years and seasons, as people of the age would; turn numbers are for the chancery.`,
    `${memory(seat)}\n\nThe audience so far:\n${transcript(seat) || "(this is the ruler's first word to you)"}\n\nThe ruler now says:\n${message}`,
    seat,
    true,
  );

/** The advisor governing between audiences: a short pass every few turns, with the fresh briefing already in hand */
export const governPass = async (seat: Seat, sinceTurn: number, turnsAhead: number) =>
  run(
    "govern",
    GOVERN_MODEL,
    `${persona(seat)}

The ruler is away; you govern by their standing will. Below is the briefing as of now, with the log of what happened since turn ${sinceTurn}. Put things right for the next ${turnsAhead} turns: keep research and every build queue serving the will, act on every warning you can (weak garrisons, Great People awaiting orders, idle or stuck units), buy what is urgent, follow up on diplomacy. Change nothing that is already right. Be quick: call get_options only if you need names or prices, and set all orders in one set_orders call where you can. Never declare war unless the will explicitly commands war on that civ now.
Reply with only a 1-3 sentence log entry of what you found and ordered (it goes into your journal), or "Nothing to change".`,
    `${memory(seat)}\n\nBriefing:\n${JSON.stringify(await host.briefing(seat.civ, sinceTurn).catch(() => "(unavailable - use get_briefing)"))}`,
    seat,
  );

export const advisorReport = (seat: Seat, round: RoundResult, governLogs: string[], briefing: unknown) =>
  run(
    "report",
    ADVISOR_MODEL,
    `${persona(seat)}

You are writing your dispatch to the ruler covering ${round.fromYear} to ${round.year}. Speak in years, never turn numbers. Under 170 words: what happened, how the realm stands against its rivals, what worries you, and one question or recommendation. Be specific with names and numbers; do not list everything. No tools are needed - everything is below.`,
    `${memory(seat)}\n\nYour own notes while governing this round:\n${governLogs.join("\n") || "(none)"}\n\n${round.stoppedEarly ? `The round was cut short: ${round.stoppedEarly}\n\n` : ""}Briefing now:\n${JSON.stringify(briefing)}`,
  );

/** One journal line per round: whole sentences only, never cut mid-way */
export const journalEntry = (round: RoundResult, governLogs: string[]) => {
  const sentences = governLogs
    .filter((entry) => !/nothing to change/i.test(entry))
    .map((entry) => entry.replace(/^(T\d+:\s*)+/, "").replace(/\s+/g, " ").trim())
    .flatMap((entry) => entry.match(/[^.!?]+[.!?]+/g) ?? [entry]);
  let text = "";
  for (const sentence of sentences) {
    if (text.length + sentence.length > 420) break;
    text += sentence.trim() + " ";
  }
  return `T${round.fromTurn}-${round.turn}: ${text.trim() || "Nothing to change."}`;
};

export const heraldNewspaper = (round: RoundResult, earlier: PublicEvent[]) =>
  run(
    "herald",
    HERALD_MODEL,
    `You are the Chronicler, keeper of the one history all the rival rulers read. Each round you add a new chapter covering the years below, in the voice of a historian looking back: what happened, what it meant, how the world's shape is changing. Name the years when they matter ("In 1240 BC..."), never turn numbers. Give it a short chapter title. Under 160 words; two to four paragraphs; wry, unhurried, occasionally grand. A quiet age deserves a quiet chapter, not padding.
Report only the events listed - these are things the whole world could witness. Never speculate about any realm's plans, treasury, research or armies. ${TELEGRAM_STYLE}`,
    `The years ${round.fromYear} to ${round.year}.\n\nEvents of these years:\n${round.publicEvents.map((event) => `${event.year}: ${event.text}`).join("\n") || "(nothing the world took note of)"}\n\nThe standing of the great powers now, by score:\n${round.rankings.map((rank, index) => `${index + 1}. ${rank.civ} (${rank.cities} cities)`).join("\n")}\n\nEarlier chapters told of:\n${earlier.slice(-12).map((event) => `${event.year}: ${event.text}`).join("\n") || "(this is the first chapter)"}`,
  );
