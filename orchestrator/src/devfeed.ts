// The dev feed: what every model call was told, did and cost, posted to a chat for whoever runs the game.
// It carries each realm's secrets (will, plan, briefing), so it goes to DEV_CHAT_ID only - today that defaults to
// the Chronicler's chat because one person plays every seat; give it its own chat before friends join.

import { mkdirSync, writeFileSync } from "node:fs";
import { InputFile, type Bot } from "grammy";
import { onTrace, type Trace } from "./agents.ts";
import { state } from "./store.ts";

const traces: Trace[] = [];
onTrace((trace) => traces.push(trace));

/** DEV_FEED=chat posts to Telegram; anything else keeps the same detail as files under data/game/devfeed/ */
export const devFeedInChat = () => process.env.DEV_FEED === "chat";
const FOLDER = "../data/game/devfeed";

const devChat = () => Number(process.env.DEV_CHAT_ID) || state.heraldChats[0];
const money = (usd: number) => `$${usd.toFixed(2)}`;

const asMarkdown = (trace: Trace) =>
  [
    `## ${trace.role}${trace.civ ? ` - ${trace.civ}` : ""}`,
    `${trace.model} - ${Math.round(trace.inputTokens / 1000)}k in, ${trace.outputTokens} out, ${money(trace.costUsd)}, ${(trace.ms / 1000).toFixed(1)}s`,
    `### System prompt\n${trace.systemPrompt}`,
    `### Prompt\n${trace.prompt.length > 6000 ? trace.prompt.slice(0, 6000) + "\n…(cut)" : trace.prompt}`,
    ...trace.toolCalls.map((call) => `### Tool: ${call.name}\n\`\`\`json\n${JSON.stringify(call.input, null, 1)}\n\`\`\`\nResult: ${call.result ?? "(none)"}`),
    `### Reply\n${trace.reply}`,
  ].join("\n\n");

/** Post everything since the last flush: a short summary message and the full detail as a .md document */
export async function flushDevFeed(bot: Bot, title: string, extra: string[] = []) {
  if (traces.length === 0) return;
  const batch = traces.splice(0);
  const byRole = new Map<string, { calls: number; cost: number; ms: number; tokens: number }>();
  for (const trace of batch) {
    const row = byRole.get(trace.role) ?? { calls: 0, cost: 0, ms: 0, tokens: 0 };
    row.calls++; row.cost += trace.costUsd; row.ms += trace.ms; row.tokens += trace.inputTokens + trace.outputTokens;
    byRole.set(trace.role, row);
  }
  const orders = batch.flatMap((trace) =>
    trace.toolCalls.filter((call) => call.name === "set_orders").map((call) => {
      const result = (() => { try { return JSON.parse(JSON.parse(call.result ?? "[]")[0]?.text ?? "{}"); } catch { return {}; } })();
      return `${trace.civ}/${trace.role}: ${Object.keys((call.input as object) ?? {}).join(", ")} -> ${(result.done ?? []).length} done, ${(result.failed ?? []).length} failed${(result.failed ?? []).length ? ` (${result.failed.join("; ")})` : ""}`;
    }),
  );
  const summary = [
    `🛠 ${title}`,
    ...[...byRole].map(([role, row]) => `${role}: ${row.calls} calls, ${Math.round(row.tokens / 1000)}k tok, ${money(row.cost)}, ${(row.ms / row.calls / 1000).toFixed(0)}s avg`),
    `total ${money(batch.reduce((sum, trace) => sum + trace.costUsd, 0))}`,
    ...extra,
    ...(orders.length ? ["orders:", ...orders] : []),
  ].join("\n");
  const document = `# ${title}\n\n${summary}\n\n---\n\n${batch.map(asMarkdown).join("\n\n---\n\n")}`;
  mkdirSync(FOLDER, { recursive: true });
  writeFileSync(`${FOLDER}/${new Date().toISOString().replace(/[:.]/g, "-")}-${title.replace(/[^\w]+/g, "-").toLowerCase().slice(0, 60)}.md`, document);
  const chat = devChat();
  if (!devFeedInChat() || !chat) return;
  await bot.api.sendMessage(chat, summary.slice(0, 4000)).catch(() => {});
  await bot.api.sendDocument(chat, new InputFile(Buffer.from(document), `${title.replace(/[^\w]+/g, "-").toLowerCase()}.md`)).catch(() => {});
}
