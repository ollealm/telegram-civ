// What a call cost, computed from the tokens it used and the official prices, beside the figure the backend gives: the Agent SDK (0.3.280) prices a
// Claude model its catalog does not know at Opus rates (Sonnet 5.5 came out ~2x its cost, Haiku 5.5 ~40x), and the Codex CLI gives no dollars at all.
//
// Prices are USD per million tokens, copied from the official pages:
//   Claude: https://platform.claude.com/docs/en/about-claude/pricing.md (Model pricing table), read 2026-10-07
//   OpenAI: https://developers.openai.com/api/docs/pricing (Standard pricing data; "Short context: <=272K input tokens. Long context: >272K"), read 2026-10-07
// Sonnet 5.5 cache hits are $0.10 (0.05x): the page's table now agrees with its prompt-caching section (read again 2026-10-09; on 2026-10-07 the table still said $0.20).
// The table's figure is used here, as the prompt-caching page's own table gives it too.
// A model missing here prices as null (and says so once); add it from the same pages, with the date read.

/** One kind of token each: input past the cache, cache writes by lifetime, cache reads, output (thinking and reasoning included) */
export type Tokens = { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number };
type Rates = Tokens;
/** A model's rates, and the higher rates a request pays when its prompt (input, cache writes and reads together) is over a size */
type Price = Rates & { longPrompt?: Rates & { over: number } };

const claude = (input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): Rates => ({ input, cacheWrite5m, cacheWrite1h, cacheRead, output });
/** OpenAI lists one cache-write price; where it lists none ("-"), a write bills as input */
const openai = (input: number, cacheRead: number, cacheWrite: number | null, output: number): Rates => ({ input, cacheWrite5m: cacheWrite ?? input, cacheWrite1h: cacheWrite ?? input, cacheRead, output });
const LONG_OPENAI = 272_000;

const PRICES: Record<string, Price> = {
  "claude-fable-5-1": claude(10, 12.5, 20, 0.25, 50),
  "claude-mythos-5-1": claude(10, 12.5, 20, 0.25, 50),
  "claude-fable-5": claude(10, 12.5, 20, 1, 50),
  "claude-mythos-5": claude(10, 12.5, 20, 1, 50),
  "claude-opus-5-5": claude(4, 5, 8, 0.2, 20),
  "claude-opus-5": claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-8": claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-7": claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-6": claude(5, 6.25, 10, 0.5, 25),
  "claude-opus-4-5": claude(5, 6.25, 10, 0.5, 25),
  "claude-sonnet-5-5": claude(2, 2.5, 4, 0.1, 10),
  "claude-sonnet-5": claude(2, 2.5, 4, 0.2, 10),
  "claude-sonnet-4-6": claude(3, 3.75, 6, 0.3, 15),
  "claude-sonnet-4-5": claude(3, 3.75, 6, 0.3, 15),
  "claude-haiku-5-5": { ...claude(0.1, 0.125, 0.2, 0.01, 0.5), longPrompt: { over: 100_000, ...claude(0.5, 0.625, 1, 0.05, 2.5) } },
  "claude-haiku-4-5": claude(1, 1.25, 2, 0.1, 5),
  "gpt-6-astra": { ...openai(10, 1, 12.5, 50), longPrompt: { over: LONG_OPENAI, ...openai(20, 2, 25, 75) } },
  "gpt-6.1-sol": { ...openai(2, 0.1, 2.5, 10), longPrompt: { over: LONG_OPENAI, ...openai(4, 0.2, 5, 15) } },
  "gpt-6-luna": { ...openai(0.1, 0.01, 0.125, 0.5), longPrompt: { over: LONG_OPENAI, ...openai(0.2, 0.02, 0.25, 0.75) } },
  "gpt-6-sol": { ...openai(2, 0.2, 2.5, 10), longPrompt: { over: LONG_OPENAI, ...openai(4, 0.4, 5, 15) } },
  "gpt-5.6-sol": { ...openai(4, 0.4, 5, 20), longPrompt: { over: LONG_OPENAI, ...openai(8, 0.8, 10, 30) } },
  "gpt-5.6-terra": { ...openai(2, 0.2, 2.5, 12), longPrompt: { over: LONG_OPENAI, ...openai(4, 0.4, 5, 18) } },
  "gpt-5.6-luna": { ...openai(0.2, 0.02, 0.25, 1.2), longPrompt: { over: LONG_OPENAI, ...openai(0.4, 0.04, 0.5, 1.8) } },
  "gpt-5.5": { ...openai(5, 0.5, null, 30), longPrompt: { over: LONG_OPENAI, ...openai(10, 1, null, 45) } },
};

/** A dated id (claude-haiku-4-5-20251001) prices as its model */
const priceOf = (model: string): Price | undefined => PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
const sameModel = (a: string, b: string) => a === b || a.replace(/-\d{8}$/, "") === b.replace(/-\d{8}$/, "");

const warned = new Set<string>();
const warnOnce = (key: string, text: string) => { if (!warned.has(key)) { warned.add(key); console.warn(`[prices] ${text}`); } };

export const NO_TOKENS: Tokens = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
const KINDS = Object.keys(NO_TOKENS) as (keyof Tokens)[];
const sum = (blocks: Tokens[]): Tokens => Object.fromEntries(KINDS.map((kind) => [kind, blocks.reduce((total, block) => total + block[kind], 0)])) as Tokens;
const cost = (tokens: Tokens, rates: Rates) => KINDS.reduce((total, kind) => total + tokens[kind] * rates[kind], 0) / 1_000_000;

/** The dollars of a call on one model: each request at the rates its own prompt size calls for, and tokens known only as a sum
 *  (a backend that reports a whole turn at once) at the base rates, since no single request's size can be told from them. Null for a model not in the table */
export function priceUsd(model: string, requests: Tokens[], summed: Tokens = NO_TOKENS): number | null {
  const price = priceOf(model);
  if (!price) {
    warnOnce(`unknown ${model}`, `no price for "${model}": its calls carry pricedUsd null (costUsd stays the backend's figure); add it to src/prices.ts from the official page`);
    return null;
  }
  const { longPrompt } = price;
  const ratesFor = (request: Tokens) => (longPrompt && request.input + request.cacheWrite5m + request.cacheWrite1h + request.cacheRead > longPrompt.over ? longPrompt : price);
  return requests.reduce((total, request) => total + cost(request, ratesFor(request)), cost(summed, price));
}

/** The SDK's usage block of one request (a stream's message_start), the cache writes split by lifetime as it reports them */
export type SdkUsage = {
  input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
};
export function sdkTokens(usage: SdkUsage): Tokens {
  const writes = usage.cache_creation_input_tokens ?? 0;
  const write1h = Math.min(writes, usage.cache_creation?.ephemeral_1h_input_tokens ?? 0);
  return { input: usage.input_tokens ?? 0, cacheWrite5m: writes - write1h, cacheWrite1h: write1h, cacheRead: usage.cache_read_input_tokens ?? 0, output: usage.output_tokens ?? 0 };
}

/** One model's totals for the whole call, as the SDK's result gives them in modelUsage (every model the call used, side calls included) */
export type SdkModelUsage = { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number; costBasis?: string };

/** The dollars of one SDK call. Every request of the main loop is priced as it was sent (stream events, so a long prompt meets its own tier); whatever
 *  a model's totals in modelUsage hold beyond those requests (the SDK's own side calls, a request whose events were missed) is priced at base rates,
 *  its cache writes split by lifetime as the result's usage splits them. Null when a model it used is not in the table. Each model's figure is held
 *  against the SDK's: over 10% apart, it is said once per model, so a price that changed, or one the SDK guesses, shows */
export function priceSdkCall(requests: { model: string; tokens: Tokens }[], resultUsage: SdkUsage, modelUsage: Record<string, SdkModelUsage>): number | null {
  const resultWrites = sdkTokens(resultUsage);
  const share1h = resultWrites.cacheWrite5m + resultWrites.cacheWrite1h ? resultWrites.cacheWrite1h / (resultWrites.cacheWrite5m + resultWrites.cacheWrite1h) : 0;
  const models = [...Object.keys(modelUsage), ...requests.map((request) => request.model).filter((model) => !Object.keys(modelUsage).some((name) => sameModel(name, model)))];
  let total = 0;
  let unknown = false;
  for (const model of new Set(models)) {
    const own = requests.filter((request) => sameModel(request.model, model)).map((request) => request.tokens);
    const counted = sum(own);
    const used = modelUsage[model];
    const writesLeft = used ? Math.max(0, used.cacheCreationInputTokens - counted.cacheWrite5m - counted.cacheWrite1h) : 0;
    const rest: Tokens = used
      ? { input: Math.max(0, used.inputTokens - counted.input), cacheWrite5m: writesLeft - Math.round(writesLeft * share1h), cacheWrite1h: Math.round(writesLeft * share1h),
          cacheRead: Math.max(0, used.cacheReadInputTokens - counted.cacheRead), output: Math.max(0, used.outputTokens - counted.output) }
      : NO_TOKENS;
    const priced = priceUsd(model, own, rest);
    if (priced === null) { unknown = true; continue; }
    total += priced;
    if (used && Math.abs(used.costUSD - priced) > 0.1 * Math.max(priced, 1e-9))
      warnOnce(`mismatch ${model}`, `${model}: the SDK says $${used.costUSD.toFixed(4)} for a call the table prices at $${priced.toFixed(4)} (${Math.round((100 * (used.costUSD - priced)) / Math.max(priced, 1e-9))}%; SDK cost basis "${used.costBasis ?? "list"}") - said once per model`);
  }
  return unknown ? null : total;
}

/** Codex's usage of a turn, summed over its requests: input_tokens includes the cached and the cache-written tokens, output_tokens the reasoning ones
 *  (its total_tokens is input plus output), so reasoning bills as output once */
export const codexTokens = (usage: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number }): Tokens => ({
  input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens), cacheWrite5m: usage.cacheWriteTokens, cacheWrite1h: 0,
  cacheRead: usage.cachedInputTokens, output: usage.outputTokens,
});

/** The figure every total uses: the priced one where the model is in the table, else the backend's */
export const dollars = (spent: { costUsd: number; pricedUsd?: number | null }) => spent.pricedUsd ?? spent.costUsd;
/** Said once wherever a total holds Codex seats' figures */
export const API_EQUIVALENT = "API-equivalent; the subscription bills no dollars";
