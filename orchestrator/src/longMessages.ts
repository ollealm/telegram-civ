// Telegram takes a message of at most 4096 characters and refuses a longer one whole, so a long will, letter or saga arrived as nothing (2026-11-06:
// /will and /status went dead for Germany, whose will was 4319 characters). Every bot sends through one path: a text past the limit goes as two or three
// messages, cut on a paragraph break where there is one, with any buttons under the last.
import type { Bot } from "grammy";

/** Telegram's limit for one message's text */
export const LIMIT = 4096;

/** The text in parts of at most `limit` characters: each cut at the last blank line, else line break, else sentence end, else space, in the part's second half */
export function partsOf(text: string, limit = LIMIT): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1); // a break right at the limit still counts
    let cut = 0;
    for (const [pattern, after] of [[/\n[ \t]*\n/g, false], [/\n/g, false], [/[.!?…]["'”’)\]]*\s/g, true], [/\s/g, false]] as const) {
      for (const match of window.matchAll(pattern)) {
        const at = after ? match.index! + match[0].length - 1 : match.index!;
        if (at >= limit / 2 && at <= limit) cut = at;
      }
      if (cut) break;
    }
    if (!cut) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest || !parts.length) parts.push(rest);
  return parts;
}

/** Sends past the limit go as several messages, the buttons under the last; an edit past it edits in the first part and sends the rest after it */
export function splitLongMessages(bot: Bot) {
  bot.api.config.use(async (prev, method, payload, signal) => {
    const sent = payload as { text?: unknown; chat_id?: number | string; reply_markup?: unknown };
    if ((method !== "sendMessage" && method !== "editMessageText") || typeof sent.text !== "string" || sent.text.length <= LIMIT || sent.chat_id === undefined) return prev(method, payload, signal);
    const [first, ...more] = partsOf(sent.text);
    const { reply_markup, ...plain } = sent;
    let response = await prev(method, { ...plain, text: first, ...(!more.length && reply_markup !== undefined && { reply_markup }) } as typeof payload, signal);
    const { message_id: _, ...fresh } = plain as typeof plain & { message_id?: number };
    for (const [at, text] of more.entries()) {
      if (!response.ok) return response;
      const next = await prev("sendMessage", { ...fresh, text, ...(at === more.length - 1 && reply_markup !== undefined && { reply_markup }) } as never, signal);
      // A send answers with its last part; an edit with the message it edited, unless a part sent after it failed
      if (method === "sendMessage" || !next.ok) response = next as never;
    }
    return response;
  });
}
