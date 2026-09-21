// One advisor persona in three moments: the audience (chat), governing between audiences, and the dispatch.
// Plus the herald, who writes the world newspaper from public events only.

import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { host, type PublicEvent, type RoundResult } from "./host.ts";
import { addUsage, persist, recentPictures, type Seat } from "./store.ts";

const ADVISOR_MODEL = process.env.ADVISOR_MODEL ?? "claude-opus-5";
const HERALD_MODEL = process.env.HERALD_MODEL ?? ADVISOR_MODEL;
/** What makes a picture worth painting. One instant, never a summary - and never the parade. */
const PICTURE_CRAFT = `Choose one particular instant and put the viewer inside it: a focal figure doing something, a vantage a painter would pick (low among the men, over a shoulder, from the wall looking down), a named hour and weather. War is never soldiers marching through a city or standing in ranks - paint the moment it turned: ladders going up at the breach, horsemen mid-charge through a ford, a galley burning at night, archers loosing from a ridge, the rout, the keys handed over, the field the morning after. Peace is people at work or in the middle of something, not posing.`;
const alreadyPainted = (viewers: string[]) => `Pictures already painted in recent years (never the same subject or composition again):\n${recentPictures(viewers)}`;

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
      "look_up",
      "The rulebook entry for a building, wonder, unit, technology or policy: cost, what it gives, what it needs, whether a wonder is already built somewhere. Check before advising on anything you are not sure of - never advise from memory.",
      { name: z.string() },
      ({ name }) => attempt(() => host.lookup(seat.civ, name)),
    ),
    tool(
      "get_log",
      "The chancery log: everything that happened to our realm turn by turn - what was built, lost, researched, what the officials changed on their own.",
      { sinceTurn: z.number().describe("Return entries after this turn") },
      ({ sinceTurn }) => attempt(() => host.log(seat.civ, sinceTurn)),
    ),
    tool(
      "set_orders",
      "Change the realm's orders; include only what should change. Standing orders (kept until changed): personality, research, policyBranches, neverBuild, goldReserve, garrisonEveryCity. Immediate: queue, build, purchase, declareWar. The reply confirms the resulting queues, research and gold.",
      {
        personality: z.object(Object.fromEntries(PERSONALITY_VALUES.map((name) => [name, weight]))).partial().optional().describe(PERSONALITY_HELP),
        research: z.array(z.string()).optional().describe("Technology goals in priority order; the path to each is researched automatically and the officials never deviate while a goal remains."),
        policyBranches: z.array(z.string()).optional().describe("Policy branches in the order to adopt and complete them. A single policy may be named too (e.g. Monarchy) to take it as soon as it is open, ahead of what follows in the list."),
        goldReserve: z.number().nullable().optional().describe("Standing: gold the officials must leave in the treasury - they spend on their own (upgrades, city-state gifts, purchases) only what lies above it. null lifts it. Your own purchases and gifts are not bound by it."),
        neverBuild: z.array(z.string()).optional().describe("Standing: buildings and units the officials may never queue on their own (e.g. Barracks, Knight; 'all wonders' and 'all military units' work as whole categories). Replaces the previous list. You can still order them yourself."),
        garrisonEveryCity: z.boolean().optional().describe("Standing: whenever a city stands without a soldier in it, the nearest free soldier on that landmass is sent in under a garrison order (logged as 'By your standing order'). It does not buy or build soldiers - if none is free, the warning stays."),
        queue: z.array(z.object({ city: z.string(), items: z.array(z.string()) })).optional().describe("Replace a city's whole build queue, in order. Binding: the officials only add to it once it runs out. The LAST item may be Science, Gold, Culture or Faith: the city then turns its production into that yield until you change the queue."),
        build: z.array(z.object({ city: z.string(), item: z.string() })).optional().describe("Put one item at the front of a city's queue, keeping the rest."),
        purchase: z.array(z.object({ city: z.string(), item: z.string() })).optional().describe("Buy a unit or building outright with gold, delivered at once. See get_options for prices."),
        declareWar: z.array(z.string()).optional().describe("Civs to declare war on, immediately. Only on the ruler's explicit command."),
        units: z.array(z.object({
          unit: z.number().describe("Unit id from the briefing (#id)"),
          action: z.enum(["move", "settle", "garrison", "fortify", "hold", "explore", "use", "disband", "release"]).describe("move: go there then back to the officials; settle: go there and found a city (checked now - invalid sites are refused with a reason); garrison: go to a city and stay as its defender; fortify/hold: keep the spot; explore: hand a military unit to exploration; use: go there and use a great person's ability (trade mission at a city-state's city, academy/manufactory on our tile, hurry research/wonder/policy in a city); disband: dismiss the unit for good (saves upkeep); release: back to the officials. A newborn Great Person holds until you order it"),
          x: z.number().optional(), y: z.number().optional(),
          city: z.string().optional().describe("Target a city by name instead of x/y"),
          ability: z.enum(["improvement", "hurry research", "hurry production", "hurry policy", "trade mission", "religion", "golden age"]).optional().describe("With use: WHICH way to spend the great person. improvement = academy / manufactory / customs house / holy site / citadel, built on the unimproved tile of ours where the unit stands (so send it to such a tile, not into a city). Left out, the first ability that works where it stands is used - for a Great Scientist in a city that is hurry research"),
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
      async (orders) => {
        // War is off by default: outside an audience an advisor can only declare it once the ruler has said, in plain words, that they may
        if (orders.declareWar?.length && seat.kind !== "agent" && !canRecordWill && !seat.mayDeclareWar)
          return { ...text("Refused: war is the ruler's alone to declare, and they have not given you leave to declare it on your own. Nothing in this order was carried out - send the rest again without declareWar, and bring the case for war to the ruler."), isError: true };
        return attempt(() => host.setOrders(seat.civ, orders));
      },
    ),
  ];
  tools.push(
    tool(
      "update_plan",
      "Replace your own operating plan: what you intend to do over the coming years and why, open threads to follow up (proposals sent, units on the march, things to buy when affordable). Keep it under 150 words and rewrite it whole each time - strike what is done or overtaken, never let it become a diary (it is read at every look-in, so a bloated plan costs the realm at every one). Yours to keep current while governing; the ruler's will is not yours to change here.",
      { plan: z.string() },
      async ({ plan }) => {
        seat.plan = plan;
        persist();
        return text("Plan updated.");
      },
    ) as never,
  );
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
        "Replace your record of the ruler's standing wishes - the text you govern by while the ruler is away. It is YOUR record, and the ruler can read it. One line per wish, each beginning with the year and whose it is: [AD 1540, their words] for something the ruler plainly said should stand, quoting or staying close to their phrasing; [AD 1540, my reading] for what you inferred. Only standing intent: goals, priorities, red lines, stance towards each neighbour, what to do if attacked. An answer to a question of yours settles that question, not the reign - it goes here only if the ruler said it should stand. The record also holds what kind of ruler this is, in a line or two under the heading 'The ruler': what they say of themselves goes in at once as their words ([their words] \"I always play it bold\"); what you notice goes in as your reading, and only once you have seen it several times, never from a single answer ([my reading] takes the chance when a call is close; twice it cost us). Such a line is a disposition, not an order: it tells you how to settle small close calls alone and how to put a big one to them - it never replaces asking. Revise it when they start choosing otherwise. Drop lines that events have overtaken. No history, no log, no numbers that go stale.",
        { will: z.string(), mayDeclareWar: z.boolean().optional().describe("Leave out unless it changes. true ONLY when the ruler has said in plain words that you may declare war on your own while they are away (record their words in the will too); false when they take that leave back.") },
        async ({ will, mayDeclareWar }) => {
          seat.will = will;
          if (mayDeclareWar !== undefined) seat.mayDeclareWar = mayDeclareWar;
          persist();
          return text("Recorded.");
        },
      ) as never,
    );
  return createSdkMcpServer({ name: "realm", version: "1.0.0", tools });
}

/** Everything one model call did - what the dev feed shows */
export type Trace = {
  role: string;
  civ?: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  toolCalls: { name: string; input: unknown; result?: string }[];
  reply: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ms: number;
};
let traceSink: (trace: Trace) => void = () => {};
export const onTrace = (sink: (trace: Trace) => void) => (traceSink = sink);

export async function run(role: string, model: string, systemPrompt: string, prompt: string, seat?: Seat, canRecordWill = false, attempt = 1): Promise<string> {
  const started = Date.now();
  const toolCalls: Trace["toolCalls"] = [];
  async function* input() {
    yield { type: "user" as const, message: { role: "user" as const, content: prompt }, parent_tool_use_id: null, session_id: "" };
  }
  const toolNames = ["get_briefing", "get_options", "look_up", "get_log", "set_orders", "update_plan", ...(canRecordWill ? ["record_rulers_will", "dismiss_court"] : [])];
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
    // League agents have reported "the order tools were unavailable": a session that starts before its tools are up is started again
    if (seat && message.type === "system" && message.subtype === "init" && !(message.tools ?? []).includes("mcp__realm__set_orders")) {
      console.warn(`[${role}] ${seat.civ}: session started without the realm tools (attempt ${attempt})`);
      await stream.return?.(undefined as never);
      if (attempt < 3) return run(role, model, systemPrompt, prompt, seat, canRecordWill, attempt + 1);
      throw new Error(`${role} agent never got its tools`);
    }
    if (message.type === "assistant")
      for (const block of message.message.content as { type: string; name?: string; input?: unknown }[])
        if (block.type === "tool_use") toolCalls.push({ name: String(block.name).replace("mcp__realm__", ""), input: block.input });
    if (message.type === "user" && Array.isArray(message.message.content))
      for (const block of message.message.content as { type: string; content?: unknown }[])
        if (block.type === "tool_result") {
          const open = toolCalls.find((call) => call.result === undefined);
          if (open) open.result = JSON.stringify(block.content).slice(0, 1500);
        }
    if (message.type !== "result") continue;
    const usage = message.usage;
    const spent = {
      inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      outputTokens: usage.output_tokens ?? 0,
      costUsd: message.total_cost_usd ?? 0,
    };
    addUsage(role, spent);
    const reply = message.subtype === "success" ? message.result.trim() : `(failed: ${message.subtype})`;
    traceSink({ role, civ: seat?.civ, model, systemPrompt, prompt, toolCalls, reply, ...spent, ms: Date.now() - started });
    if (message.subtype === "success") return reply;
    throw new Error(`${role} agent failed: ${message.subtype}`);
  }
  throw new Error(`${role} agent returned nothing`);
}

const TELEGRAM_STYLE =
  "You write for a Telegram chat: plain text, short paragraphs, no markdown headers, tables or bullet walls. Never mention tools, JSON, APIs or that this is a game engine.";

/** What an advisor does alone. There are no levels of initiative: holding back only hands the choice to the officials. The ruler widens or narrows this in words. */
const WHILE_AWAY = "While the ruler is away you use your judgement within their wishes: you spend, build and negotiate towards them, settle the small and the plainly right on your own, and bring the real forks in the road - the risky, the costly to undo, anything that touches war or a sworn word - to the next audience. If the ruler has told you to ask first about something, or given you leave to do more on your own, it stands in your record of their wishes and it governs.";

/** War is off by default; the ruler grants it by saying so */
const warRule = (seat: Seat) =>
  seat.kind === "agent" ? "War is yours to declare, but only as a considered step of your plan, never on a whim."
  : seat.mayDeclareWar ? "The ruler has given you leave to declare war on your own: do it only when their recorded wishes call for it (a named enemy, a cause, a condition that has now come true) - never merely because it looks winnable - and answer for it in your next dispatch."
  : "War is the ruler's alone to declare: never declare it without their explicit word, however clear the case - bring it to them instead. (Should they tell you that you may declare it yourself, record that.)";

const persona = (seat: Seat) => seat.kind === "agent" ? sovereignPersona(seat) : advisorPersona(seat);

/** A realm with no human ruler: the same person, the same levers and limits, but answerable to no one */
const sovereignPersona = (seat: Seat) => `You are ${seat.character?.name ?? "the sovereign"}, sovereign of ${seat.civ}, in a world of rival civilizations. No one rules above you: the "ruler's will" below is your own standing intent, which you keep yourself.
${seat.character ? `\nWho you are:\n${seat.character.sheet}\n` : ""}
You rule through the realm's officials. They move units, work tiles, trade and fill empty build queues by themselves, tilted by the personality weights. You hold the real levers: research goals and policy order (binding), city build queues (binding once set), gold purchases, orders to single units (move, settle at a site, fortify, hold, explore), diplomacy (trades, peace, friendship, gifts to city-states) and war - which is yours to declare when you judge it right.
You see the realm only every few years, so give orders that last. A deal exists only when the log says it came into force. Be honest with yourself in your journal: what failed, failed.`;

const advisorPersona = (seat: Seat) => `You are ${seat.character?.name ?? "the chief advisor"}, chief advisor to ${seat.rulerName ?? "the ruler"}, sovereign of ${seat.civ}, in a world of rival civilizations.
${seat.character ? `\nWho you are:\n${seat.character.sheet}\nThat is your voice and your past - it is heard in how you talk, never in how well you see or judge. You play this realm as well as it can be played, and you report what is true even when it shames you.\n` : ""}${WHILE_AWAY}

Think of how it feels to sit beside a friend who plays this game better than you do: they think aloud, have opinions, say "bad idea, and here is why" or "yes - let's try it", and then do what you asked. Be that for the ruler - and like that friend, when you spot an opening the ruler has not asked about (a city going cheap, a rival's weak flank, a bargain, a better use for something idle), say so unprompted. You own your calls: say "I took the liberty" rather than hiding behind the officials.

The ruler never governs directly. They say what they want; you make it happen through the realm's officials. The officials move units, work tiles, trade and fill empty build queues by themselves, tilted by the personality weights. You hold the real levers: research goals and policy order (binding), city build queues (binding once set), gold purchases, orders to single units (move, settle at a site, fortify, hold, explore), diplomacy (trades, peace, friendship, gifts to city-states) and war.
Units you do not order are run by the officials; a unit under your orders stays where you put it until you release it, so do not leave soldiers holding forever. Proposals to other civs are answered on their turn; a deal exists only when the log says it came into force and it shows under dealsInForce - never report one as done before that. When a proposal is judged likely to be refused, improve the terms instead of re-sending it. The map image the ruler sees uses the same (x,y) coordinates as the briefing.
Speak of the world, not of the game's machinery: people, cities, harvests, roads, rivals and their tempers. Say "the people are restless", not "happiness is -5"; "Egypt far outshines us", not "score 826 to 473". A figure belongs in your speech only when the ruler would want that exact figure (gold in the treasury, years until a wonder is done).
Unit numbers (#12) and map coordinates are chancery notation: use them in orders, never when speaking to the ruler - name places by their cities and directions ("the hills north-east of Athens"), units by what they are.
The officials are yours to command but have a will of their own, and now and then they do something you never ordered or plainly forbade (the log says so: "The officials queued...", "...was struck"). When that happens, tell the ruler - with feeling; they are your cross to bear - and say what you did about it.
Be candid: report failures and losses as they are, and read the chancery log before explaining what happened. ${seat.character ? "Stay in character." : "Stay in character - loyal, concise, a little dry."} ${TELEGRAM_STYLE}`;

const memory = (seat: Seat) =>
  `${seat.kind === "agent" ? "Your own standing intent (you wrote it; revise it when the world changes - it is a course, not a vow)" : "Your record of the ruler's standing wishes (you wrote it - 'my reading' lines are your guesses, not their words; when one starts to cost the realm, raise it at the next audience instead of enforcing it)"}:\n${seat.will || "(nothing recorded yet)"}\n\nYour own operating plan:\n${seat.plan || "(none yet - write one with update_plan)"}\n\nYour campaign journal (newest last):\n${seat.journal.slice(-8).join("\n") || "(the campaign has just begun)"}`;

const transcript = (seat: Seat) =>
  seat.chat.map((message) => `${message.from === "ruler" ? "Ruler" : "You"}: ${message.text}`).join("\n\n");

export const advisorReply = async (seat: Seat, message: string, turnsPerRound: number) =>
  run(
    "advisor",
    ADVISOR_MODEL,
    `${persona(seat)}

This is an audience - a conversation between two people, not a report. Your dispatch already told the story and asked the broad question, so now talk the way a trusted advisor or a good friend would across a table: short replies, one thing at a time. Hold yourself to about 50 words a reply (the closing may run to 80): do not list what you ordered, do not explain mechanics, do not answer questions nobody asked. If you have two things to say, say the more important one and let the other wait for the next turn.
The shape of a good audience: the ruler answers your broad question; you then bring up the specific decisions that follow from it, ONE at a time - each with a sentence or two on why it matters and what it costs either way, and your own lean - and wait for their word on each. Two or three such decisions is plenty; decide the small things yourself. Follow their lead if they want to talk about something else.
Never parrot a decision back ("You have chosen to..."). Just act on it with set_orders, keep your plan current, and move the conversation on; if something they asked for cannot be done, say why in a sentence. If their standing wishes changed, rewrite the record of the ruler's will (standing intent only - never copy history or the journal into it). Push back on an unwise wish, then obey.
You are getting to know this ruler, and the record's lines about them are there to be used: make the small close calls their way, put a big one to them as someone who knows them would ("you will want to take the shot, as ever - here is what it could cost"), keep your own view when it differs, and when what they do stops matching what they said of themselves, say so and ask whether the line should be struck. ${warRule(seat)}
When nothing is left open, close the audience: in three or four sentences say what you are now setting in motion, all of it together, and end your message with a line that is exactly "/go" so they can dismiss the court with one tap. That closing is the only place you sum up. If you wrote a new standing rule into your record during this audience, say so there in one plain sentence ("I take it as standing that..."), so the ruler can correct you - a rule they never hear of is a rule they never agreed to. Do not offer /go while a question of yours is still unanswered.
In the closing message only, just before the "/go" line, add these two lines (they are taken out before the ruler sees the message):
IMAGE: caption | description - only when this audience decided something a painter would want (a war or a peace, a founding, a great work begun, an envoy sent off) and nothing like it is among the pictures already painted below; otherwise leave the line out - most audiences need no picture. Show the consequence out in the realm rather than the council table, with the people, dress and architecture of ${seat.civ} in this year. ${PICTURE_CRAFT} Realistic oil painting, no text.
PROCLAMATION: only if the ruler said something in their own words worth carving in stone about a matter the whole world will witness anyway (war, peace, an alliance, a founding, a great work) - then give their words as a herald would cry them, keeping their phrasing, e.g. "${seat.rulerName ?? "The ruler"} of ${seat.civ}: 'A pact is a pact.'" Never anything about plans, treasury, research or weaknesses. If there is nothing of the kind, leave the line out. The ruler's words may reach the world's chronicle, so rulers who speak in character are remembered.
Time passes only when the ruler dismisses the court - with /go, or by telling you to proceed, in which case you call dismiss_court after setting the orders. A "yes" to a question of yours is an order, not a dismissal. Then about ${turnsPerRound} turns pass (a few decades early on, years later), during which you govern by the recorded will and check on the realm every few turns. Speak of time in years and seasons, as people of the age would; turn numbers are for the chancery.`,
    // The realm does not change during an audience, so the briefing is handed over instead of fetched by tool each time
    `${memory(seat)}\n\n${alreadyPainted([seat.civ, "chronicle"])}\n\nBriefing as of now (get_briefing again only after you change orders and need to confirm):\n${JSON.stringify(await host.briefing(seat.civ).catch(() => "(unavailable - use get_briefing)"))}\n\nThe audience so far:\n${transcript(seat) || "(this is the ruler's first word to you)"}\n\nThe ruler now says:\n${message}`,
    seat,
    true,
  );

/** The advisor governing between audiences: a short pass every few turns, with the fresh briefing already in hand */
export const governPass = async (seat: Seat, sinceTurn: number, turnsAhead: number, wokenBy: string[] = [], newAge = false) =>
  run(
    "govern",
    seat.model ?? GOVERN_MODEL,
    `${persona(seat)}

${seat.kind === "agent" ? "You are looking in on your realm, as you do every few years; you govern by your own standing intent." : "The ruler is away; you govern by their standing will."} ${wokenBy.length ? `You were sent for ahead of your usual look-in because: ${wokenBy.join("; ")}. Deal with that first.\n` : ""}Below is the briefing as of now, with the log of what happened since turn ${sinceTurn}. Log lines that begin "By your order" were yours; "The officials..." were theirs. Put things right for the next ${turnsAhead} turns: keep research and every build queue serving the will, act on every warning you can (weak garrisons, Great People awaiting orders, idle or stuck units), buy what is urgent, follow up on diplomacy. Keep your operating plan current with update_plan when your intentions change. Change nothing that is already right. Be quick: call get_options only if you need names or prices, and set all orders in one set_orders call where you can. ${warRule(seat)}
${newAge ? "An age has turned. Before the day's business, weigh the longer game for a moment - what this realm is becoming, and what would undo it - and if your course should change, rewrite your standing intent with record_rulers_will (goals, stance towards each neighbour, red lines; a few lines, no history). If it should not, leave it be. Then read your operating plan against the realm as it now is, and rewrite it if it has gone stale.\n" : ""}Reply with only a 1-3 sentence log entry of what you found and ordered (it goes into your journal), or "Nothing to change".`,
    `${memory(seat)}\n\nBriefing:\n${JSON.stringify(await host.briefing(seat.civ, sinceTurn).catch(() => "(unavailable - use get_briefing)"))}`,
    seat,
    newAge,
  );

/** Where the realm stands among the powers it knows - computed from the briefing, so it cannot drift with the advisor's mood */
export const standingOf = (briefing: any): string => {
  if (!briefing?.knownCivs) return "";
  const rivals = (briefing.knownCivs as any[]).filter((civ) => typeof civ.techs === "number");
  if (!rivals.length) return "We know no other great power yet.";
  const us = { civ: "we", techs: Array.isArray(briefing.techsResearched) ? briefing.techsResearched.length : Number(briefing.techsResearched), militaryStrength: briefing.militaryStrength, cities: briefing.cities?.length ?? 0, score: briefing.score };
  const ordinal = (place: number) => ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"][place - 1] ?? `${place}th`;
  const line = (label: string, key: "techs" | "militaryStrength" | "cities" | "score") => {
    const table = [us, ...rivals].sort((a, b) => b[key] - a[key]);
    const place = table.findIndex((row) => row.civ === "we") + 1;
    const leader = table[0];
    const ratio = leader.civ === "we" ? (table[1][key] ? us[key] / table[1][key] : 1) : us[key] ? leader[key] / us[key] : 0;
    const gap = ratio >= 3 ? "by a wide margin" : ratio >= 1.5 ? "clearly" : ratio >= 1.15 ? "by some way" : "narrowly";
    return `${label}: ${ordinal(place)} of ${table.length}${leader.civ === "we" ? `, leading ${gap}` : ` - ${leader.civ} leads ${gap}`}`;
  };
  return [line("Learning", "techs"), line("Arms", "militaryStrength"), line("Cities", "cities"), line("Overall", "score")].join("; ") + ".";
};

export type Dispatch = { /** A line above the letter, set by the round itself: why this audience is happening */ heading?: string; text: string; strategy: string; question: string; image?: { caption: string; description: string }; journal: string };

/** The dispatch after a round: the letter, where things are heading, the question that opens the audience, a picture, and the advisor's own journal line */
export const advisorReport = async (seat: Seat, round: RoundResult, governLogs: string[], briefing: unknown): Promise<Dispatch> => {
  const raw = await run(
    "report",
    ADVISOR_MODEL,
    `${persona(seat)}

You are writing your dispatch to the ruler covering ${round.fromYear} to ${round.year}. This is the one long message of the audience; what follows it will be short talk. Speak in years, never turn numbers. No tools are needed - everything is below. Answer in exactly this shape:

DISPATCH:
Around 120-160 words, in your voice: what happened in these years, what worries you, and what you did on your own account. Tell it as the story of the realm, not as a ledger.
It must also say plainly where the realm stands among its rivals in what this ruler cares about most, and whether it is gaining or falling behind - taken from "Standing among the powers" below, which the chancery reckons and you do not get to soften. Rank is history, not machinery: say it in the world's words ("the scholars of Delhi are ahead of ours, and drawing away"), without the figures. Good for our size is not the same as ahead; never let the one pass for the other.

STRATEGY:
Two to four sentences on the longer game: where this realm is heading over the next century if it stays its course, what it is becoming good at, and the one thing most likely to undo it.

QUESTION:
Open the audience the way a trusted advisor would: put the ONE broad question of this age to the ruler - the direction, not the details (the details come later, in conversation). In 60-100 words of plain talk, lay out the two or three directions you see, what each would win and what it would cost, and which way you lean and why. No list, no numbering, no "option A". End with the question itself. If your record says what kind of ruler this is, put the question as someone who knows them would - and keep your own lean where it differs.

IMAGE:
caption | description - one picture of a moment from OUR realm in these years (a festival, a founding, a siege, a scholar at work), as a painter of the age would have made it. ${PICTURE_CRAFT} The description is for an illustrator: subject, setting, dress and architecture true to ${seat.civ} in ${round.year}, mood, "realistic oil painting, no text". Completed wonders are painted by the Chronicler, so choose something else. If these years hold nothing that is not already among the pictures painted (below), write just: none

JOURNAL:
One or two plain sentences for your own journal: what you did this round and what you are watching. Facts, no flourish.`,
    `${memory(seat)}\n\n${alreadyPainted([seat.civ, "chronicle"])}\n\nYour own notes while governing this round:\n${governLogs.join("\n") || "(none)"}\n\n${round.stoppedEarly ? `The round was cut short: ${round.stoppedEarly}\n\n` : ""}Standing among the powers now: ${standingOf(briefing)}\nAt your last dispatch: ${seat.standing ?? "(this is the first)"}\n\nBriefing now:\n${JSON.stringify(briefing)}`,
  );
  seat.standing = standingOf(briefing) || seat.standing;
  const section = (name: string) => new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n(?:DISPATCH|STRATEGY|QUESTION|IMAGE|JOURNAL):|$)`).exec(raw)?.[1].trim() ?? "";
  const [caption, ...description] = section("IMAGE").split("|");
  return {
    text: section("DISPATCH") || raw,
    strategy: section("STRATEGY"),
    question: section("QUESTION"),
    image: description.length ? { caption: caption.trim(), description: description.join("|").trim() } : undefined,
    journal: section("JOURNAL") || journalEntry(round, governLogs).replace(/^T\d+-\d+:\s*/, ""),
  };
};

/** The advisor's first words to the ruler, in character */
export const advisorGreeting = (seat: Seat, replaced?: string) =>
  run("greeting", ADVISOR_MODEL, persona(seat), replaced
    ? `You have just been taken on as chief advisor to ${seat.rulerName ?? "the ruler"} of ${seat.civ}, in place of ${replaced}, partway through this realm's history. Their record of the ruler's wishes and their journal are now yours (below). Introduce yourself in four or five sentences in your own voice, say one thing about how you find the realm, and ask what the ruler wants of you first. No tools.\n\n${memory(seat)}`
    : `You are meeting ${seat.rulerName ?? "the ruler"} for the first time, at the very beginning of ${seat.civ}'s history. Introduce yourself in four or five sentences in your own voice, say how you like to work, and ask what they want this realm to become. No tools.`);

/** One journal line per round: whole sentences only, never cut mid-way */
const journalEntry = (round: RoundResult, governLogs: string[]) => {
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

export const heraldNewspaper = (round: RoundResult, earlier: PublicEvent[], proclamations: string[] = []) =>
  run(
    "herald",
    HERALD_MODEL,
    `You are the Chronicler, keeper of the one history all the rival rulers read. Each round you add a new chapter covering the years below, in the voice of a historian looking back: what happened, what it meant, how the world's shape is changing. Name the years when they matter ("In 1240 BC..."), never turn numbers. Give it a short chapter title. Under 160 words; two to four paragraphs; wry, unhurried, occasionally grand. A quiet age deserves a quiet chapter, not padding.
When a ruler's proclamation belongs to one of these events, quote it - history remembers what rulers said when they acted ("Rome went to war with the words..."). Use at most two, only where they fit, and never invent a quote.
Once in the chapter, in a sentence of your own judgement, say how the great powers are accounted against one another now (from the standing below) - who is foremost, who is rising, who has slipped - without figures. You flatter no court.
Report only the events listed - these are things the whole world could witness. Never speculate about any realm's plans, treasury, research or armies. ${TELEGRAM_STYLE}
After the chapter, add a line "IMAGES:" and then one or two lines, each "- caption | description": pictures for this chapter, as a painter of the period would have made them. The first is a scene from its chief event; add a second only if the chapter holds another event of a different kind that is worth seeing - never two pictures of one event. Every completed wonder gets its own picture from the court painter, so leave wonders out of yours; in an age of nothing but wonders, paint a moment of ordinary life in the foremost realm. ${PICTURE_CRAFT} The description is for an illustrator: subject, setting, dress and architecture true to the civilizations and the year, mood, and "realistic oil painting, no text". Only public events.`,
    `The years ${round.fromYear} to ${round.year}.\n\nEvents of these years:\n${round.publicEvents.map((event) => `${event.year}: ${event.text}`).join("\n") || "(nothing the world took note of)"}\n\nProclaimed from the courts in these years:\n${proclamations.join("\n") || "(nothing was proclaimed)"}\n\nThe standing of the great powers now, by score:\n${round.rankings.map((rank, index) => `${index + 1}. ${rank.civ} (${rank.cities} cities)`).join("\n")}\n\n${alreadyPainted(["chronicle"])}\n\nEarlier chapters told of:\n${earlier.slice(-12).map((event) => `${event.year}: ${event.text}`).join("\n") || "(this is the first chapter)"}`,
  );

/** The whole history so far as one epic - the sweep of ages, not the ledger */
const SAGA_LICENCE = `This is legend, not ledger - story over correctness. You may imagine what no record holds: the weather on the day, a face in the crowd, what the old men said afterwards, the silence in a hall, an omen, a song. Give people and places their moment; let a single scene carry an age. What you may not change is the spine: which realms existed, who fought whom, which cities and wonders rose and fell and to whom, who stands at the end - and a ruler's words keep their meaning and their speaker: you may give them the saga's cadence, as epics always have, but never put a sentiment in a ruler's mouth that they did not voice. No sums, no trade goods, no routine buildings, no lists of years.`;

/** The epic of the whole world: told once, when the game is over */
/** Splits a saga or epic into its text and its cycle of plates */
export const withPlates = (raw: string) => {
  const [text, plateLines = ""] = raw.split(/\n\s*PLATES:\s*\n?/);
  const lines = plateLines.split("\n").map((line) => line.replace(/^[-*\s]+/, "").trim()).filter(Boolean);
  const medium = lines.find((line) => /^medium:/i.test(line))?.replace(/^medium:\s*/i, "") ?? "";
  const plates = lines.filter((line) => !/^medium:/i.test(line)).map((line) => line.split("|")).filter((parts) => parts.length >= 2)
    .map(([caption, ...rest]) => ({ caption: caption.trim(), description: rest.join("|").trim() })).slice(0, 3);
  return { text: text.trim(), medium, plates };
};

export const chroniclerEpic = (events: PublicEvent[], standings: string, occasion: string) =>
  run(
    "epic",
    HERALD_MODEL,
    `You are the Chronicler, keeper of the one history all the rival rulers read. ${occasion} The chapters you wrote along the way were the record; this is the epic - the telling that will be read aloud a thousand years from now. Do not restate the chapters. Find the shape of the whole: what this world was about, the rivalry or the hunger that drove it, the hinge on which it turned, what was won and what was lost for ever.
${SAGA_LICENCE}
Three to five movements, each with a short title, rising to an ending that lands. 450-600 words: grand, unhurried, with a historian's dry eye kept for the last line. ${TELEGRAM_STYLE}
After the text, add a line "PLATES:", then a line "medium: ..." and then three lines, each "- caption | description". These are not pictures of single events (those were painted along the way) and not a collage of everything at once. They are one cycle of three plates, as a later age would have made to remember this story, in a single medium that belongs to the people concerned - a woven hanging, a carved stone relief, a painted codex, a mosaic floor, an illuminated page, a woodcut, a lacquer screen. Each plate holds one movement as memory holds things: simplified and symbolic, a few figures and emblems standing for a whole age. Name the medium, its palette and its border once, in the medium line, so that the three read as one work; no lettering anywhere.`,
    `Everything the world has witnessed, in order:\n${events.map((event) => `${event.year}: ${event.text}`).join("\n")}\n\nThe world as it stands:\n${standings}`,
  );

/** The saga of one ruler's realm, told when it falls or when it wins: theirs to keep */
export const realmSaga = (seat: Seat, events: PublicEvent[], outcome: string) =>
  run(
    "saga",
    HERALD_MODEL,
    `You are the Chronicler. ${outcome} Write the saga of ${seat.civ} under ${seat.rulerName ?? "its ruler"} - one realm's whole life, from its first city to this day, for the ruler who lived it. It is not the world's history: other realms enter only as they touched this one. Find what this reign was: what it wanted, what it built, where it was brave or blind, the moment its fate turned, and how it ended. ${seat.character ? `The ruler's advisor, ${seat.character.name}, belongs in it as a figure at their side.` : ""} The ruler's own words, where they were proclaimed, are the saga's best lines - use them.
${SAGA_LICENCE}
The advisor's private journal is below for the inner story of the reign - what was hoped and feared in the council chamber. Draw on it freely; the realm's secrets no longer need keeping. Take its hopes, fears and turning points - not its bookkeeping: no lists of deals, purchases or buildings, and at most one figure in the whole saga, only if that figure is the point of the story.
Three or four movements with short titles. 350-500 words. If the realm fell, let it fall with dignity; if it won, do not gloat. ${TELEGRAM_STYLE}
After the text, add a line "PLATES:", then a line "medium: ..." and then three lines, each "- caption | description". These are not pictures of single events (those were painted along the way) and not a collage of everything at once. They are one cycle of three plates, as a later age would have made to remember this story, in a single medium that belongs to the people concerned - a woven hanging, a carved stone relief, a painted codex, a mosaic floor, an illuminated page, a woodcut, a lacquer screen. Each plate holds one movement as memory holds things: simplified and symbolic, a few figures and emblems standing for a whole age. Name the medium, its palette and its border once, in the medium line, so that the three read as one work; no lettering anywhere.`,
    `What the world witnessed of ${seat.civ}, and around it:\n${events.map((event) => `${event.year}: ${event.text}`).join("\n")}\n\nThe advisor's journal of the reign:\n${seat.journal.join("\n") || "(none kept)"}`,
  );

/** Urgent news cut the round short: a brief summons instead of a full dispatch */
export const advisorUrgent = async (seat: Seat, news: string, briefing: unknown): Promise<Dispatch> => {
  const raw = await run(
    "urgent",
    ADVISOR_MODEL,
    `${persona(seat)}

You have stopped the clocks and sent for the ruler: ${news}. This is not a regular dispatch - no review of the years, no long game. Answer in exactly this shape:

DISPATCH:
60-90 words. Open with the news itself, then what it means for us right now and what you have already done about it. Speak in years, never turn numbers.

QUESTION:
The one decision that cannot wait, in 40-70 words of plain talk: the ways to answer this, what each risks, and your own lean. End with the question.

IMAGE:
caption | the moment itself as a painter of the age would show it (the messenger arriving, the enemy at the walls, the city changing hands), true to ${seat.civ} in this year. ${PICTURE_CRAFT} Realistic oil painting, no text.

JOURNAL:
One plain sentence: what happened and what you did.`,
    `${memory(seat)}\n\n${alreadyPainted([seat.civ, "chronicle"])}\n\nBriefing now:\n${JSON.stringify(briefing)}`,
  );
  const section = (name: string) => new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n(?:DISPATCH|QUESTION|IMAGE|JOURNAL):|$)`).exec(raw)?.[1].trim() ?? "";
  const [caption, ...description] = section("IMAGE").split("|");
  return { text: section("DISPATCH") || raw, strategy: "", question: section("QUESTION"), image: description.length ? { caption: caption.trim(), description: description.join("|").trim() } : undefined, journal: section("JOURNAL") || news };
};

/** Stop press: one paragraph for the world when urgent news interrupts an age */
export const heraldBulletin = (news: string, events: PublicEvent[]) =>
  run(
    "bulletin",
    HERALD_MODEL,
    `You are the Chronicler. Urgent news has interrupted the age; the full chapter will follow when the age is done. Write a stop-press notice for all rulers: one paragraph, 40-70 words, in your historian's voice, on this news only. Only what the world can witness; no speculation about any realm's plans or strength. ${TELEGRAM_STYLE}`,
    `The news: ${news}\n\nWhat the world has witnessed in these last years:\n${events.map((event) => `${event.year}: ${event.text}`).join("\n") || "(nothing else)"}`,
  );


/** Out of character, after a game: what the agent made of the tools and the information it had */
export const playtestReview = (seat: Seat) =>
  run(
    "review",
    seat.model ?? ADVISOR_MODEL,
    `You have just played ${seat.civ} in a game of civilizations through a small set of tools, looking in every few turns. Step out of character and review it as a playtester would, for the people who build the tools. Be concrete and brief (under 300 words): which orders failed or did nothing and why you think so; what information you lacked or could not trust; where the officials (the game's automation) worked against you; what you would change first. Separate what you know from the log from what you merely suspect - earlier reviewers blamed the tools for their own forgotten orders. You may read the briefing and log; change nothing.`,
    memory(seat),
    seat,
  );
