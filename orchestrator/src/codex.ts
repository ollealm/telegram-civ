// A second backend for the model seam (agents.ts call): a model named gpt-* runs through the Codex CLI (`codex exec --json`) on Olle's ChatGPT
// subscription. The realm tools are the very ones the Claude path serves (gameTools), served to Codex over loopback HTTP from this process as one MCP
// session: they change the seat and the orchestrator's state and persist it, and a second process would write a second copy of that state.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type CodexToolCall = { name: string; input: unknown; result?: string };
/** Tokens exactly as codex's --json usage event reports them: input_tokens (cached and cache-written included), cached_input_tokens, cache_write_input_tokens,
 *  output_tokens (reasoning included), reasoning_output_tokens */
export type CodexReply = { spoken: string[]; toolCalls: CodexToolCall[]; inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number; failure?: string };

/** The realm's MCP server (the instance createSdkMcpServer made) on 127.0.0.1, an ephemeral port, for one call */
export async function serveRealm(instance: { connect(transport: unknown): Promise<void>; close(): Promise<void> }) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await instance.connect(transport);
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => void transport.handleRequest(request, response, body ? JSON.parse(body) : undefined).catch(() => response.end()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/mcp`, close: async () => { server.close(); await transport.close().catch(() => {}); await instance.close().catch(() => {}); } };
}

/** One Codex run: [systemPrompt] as the model's instructions (they replace Codex's own coding persona), [prompt] on stdin, the realm tools if a seat's,
 *  the final message held to [outputSchema] when one is given. None of Olle's own Codex config, MCP servers or skills load (--ignore-user-config);
 *  the sandbox is read-only in an empty folder, so the model's own shell can touch nothing */
export async function runCodex(model: string, systemPrompt: string, prompt: string, options: {
  realm?: { connect(transport: unknown): Promise<void>; close(): Promise<void> };
  outputSchema?: Record<string, unknown>;
  effort?: string;
  timeoutMs?: number;
}): Promise<CodexReply> {
  const dir = mkdtempSync(join(tmpdir(), "ruler-codex-"));
  const served = options.realm ? await serveRealm(options.realm) : undefined;
  try {
    if (options.outputSchema) writeFileSync(join(dir, "schema.json"), JSON.stringify(options.outputSchema));
    // A JSON string is a TOML basic string: the instructions go whole through -c, newlines and quotes escaped
    const args = ["exec", "--skip-git-repo-check", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "-m", model,
      "-c", `instructions=${JSON.stringify(systemPrompt)}`,
      ...(options.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(options.effort)}`] : []),
      ...(served ? ["-c", `mcp_servers.realm.url=${JSON.stringify(served.url)}`, "-c", `mcp_servers.realm.default_tools_approval_mode="approve"`] : []),
      ...(options.outputSchema ? ["--output-schema", join(dir, "schema.json")] : []),
      "--json", "-"];
    const reply: CodexReply = { spoken: [], toolCalls: [], inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let pending = "";
    const read = (line: string) => {
      let event: { type?: string; item?: Record<string, unknown>; usage?: Record<string, number>; message?: string; error?: { message?: string } };
      try { event = JSON.parse(line); } catch { return; }
      const item = event.item;
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string" && item.text.trim()) reply.spoken.push(item.text.trim());
      // The realm's tools only: Codex's own (update_plan, its read-only shell in an empty folder) are not the court's acts
      if (event.type === "item.completed" && item?.type === "mcp_tool_call" && item.server === "realm")
        reply.toolCalls.push({ name: String(item.tool), input: item.arguments, result: JSON.stringify(item.result ?? item.error ?? null).slice(0, 1500) });
      if (event.type === "turn.completed" && event.usage) {
        reply.inputTokens += event.usage.input_tokens ?? 0;
        reply.cachedInputTokens += event.usage.cached_input_tokens ?? 0;
        reply.cacheWriteTokens += event.usage.cache_write_input_tokens ?? 0;
        reply.outputTokens += event.usage.output_tokens ?? 0;
        reply.reasoningTokens += event.usage.reasoning_output_tokens ?? 0;
      }
      if (event.type === "turn.failed" || event.type === "error") reply.failure = event.error?.message ?? event.message ?? event.type;
    };
    await new Promise<void>((resolve, reject) => {
      // Its own process group: `codex` is a Node wrapper around the native binary, and killing the wrapper alone left the binary running
      const child = spawn("codex", args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"], detached: true });
      let stderr = "";
      const stop = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); } };
      const timer = options.timeoutMs ? setTimeout(() => { stop(); reject(new Error(`timed out after ${Math.round(options.timeoutMs! / 1000)} s`)); }, options.timeoutMs) : undefined;
      child.stdout.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        lines.forEach(read);
      });
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (pending) read(pending);
        if (code !== 0 && !reply.failure) reply.failure = `codex exited ${code}: ${stderr.trim().split("\n").at(-1) ?? ""}`;
        resolve();
      });
      child.stdin.end(prompt);
    });
    return reply;
  } finally {
    await served?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
