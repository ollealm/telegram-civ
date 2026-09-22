// Image generation behind one seam, with two providers: the Gemini API (GEMINI_API_KEY) and the Codex CLI on a
// ChatGPT subscription (no key). IMAGE_PROVIDER picks one; by default Gemini when a key is set, and the other as fallback.
// A picture is never worth waiting for: callers send their text first and the image when (and if) it arrives.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { host } from "./host.ts";

const ENABLED = process.env.IMAGES !== "off";
const TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS ?? 240_000);
const MAX_PARALLEL = 3;
let running = 0;
const waiting: (() => void)[] = [];
const idlers: (() => void)[] = [];
/** Resolves once no picture is being painted or queued - so closing words can follow the last picture of an age instead of racing it */
export const imagesIdle = () => (running === 0 && waiting.length === 0 ? Promise.resolve() : new Promise<void>((resolve) => idlers.push(resolve)));

export type ImageLog = (message: string) => void;
let log: ImageLog = () => {};
export const onImageLog = (sink: ImageLog) => (log = sink);

type Reference = { name: string; png: Buffer };
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL ?? "gemini-3.1-flash-image";
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";

/** The first base64 image anywhere in a Gemini response, whichever of its response shapes we got */
function findImage(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  const mime = String(record.mime_type ?? record.mimeType ?? "");
  if (typeof record.data === "string" && record.data.length > 1000 && (mime.startsWith("image/") || !mime)) return record.data;
  for (const value of Object.values(record)) {
    const found = findImage(value);
    if (found) return found;
  }
  return null;
}

async function viaGemini(prompt: string, references: Reference[]): Promise<Buffer> {
  const headers = { "x-goog-api-key": process.env.GEMINI_API_KEY!, "content-type": "application/json" };
  const post = async (url: string, body: unknown) => {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`${response.status} ${JSON.stringify((json as any).error?.message ?? json).slice(0, 200)}`), { status: response.status });
    return json;
  };
  const images = references.map((reference) => reference.png.toString("base64"));
  let json: unknown;
  try {
    json = await post(`${GEMINI_API}/interactions`, {
      model: GEMINI_MODEL,
      input: [{ type: "text", text: prompt }, ...images.map((data) => ({ type: "image", mime_type: "image/png", data }))],
      response_format: { type: "image" },
    });
  } catch (error) {
    if (![404].includes((error as { status?: number }).status ?? 0)) throw error; // a 400 is about our request - say so, do not mask it
    // Older surface of the same API
    json = await post(`${GEMINI_API}/models/${GEMINI_MODEL}:generateContent`, {
      contents: [{ parts: [{ text: prompt }, ...images.map((data) => ({ inline_data: { mime_type: "image/png", data } }))] }],
      generationConfig: { responseModalities: ["IMAGE"] },
    });
  }
  const data = findImage(json);
  if (!data) throw new Error(`no image in response: ${JSON.stringify(json).slice(0, 200)}`);
  return Buffer.from(data, "base64");
}

const providers = (): ("gemini" | "codex")[] => {
  const chosen = process.env.IMAGE_PROVIDER ?? (process.env.GEMINI_API_KEY ? "gemini" : "codex");
  const order: ("gemini" | "codex")[] = chosen === "gemini" ? ["gemini", "codex"] : ["codex", "gemini"];
  return order.filter((provider) => provider === "codex" || process.env.GEMINI_API_KEY);
};

/** One image from a prompt, optionally guided by reference images. Null when every provider fails or takes too long. */
export async function generateImage(prompt: string, references: Reference[] = []): Promise<Buffer | null> {
  if (!ENABLED) return null;
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    for (const provider of providers()) {
      const started = Date.now();
      try {
        const png = provider === "gemini" ? await viaGemini(prompt, references) : await viaCodex(prompt, references);
        log(`image ok via ${provider} in ${Math.round((Date.now() - started) / 1000)}s: ${prompt.slice(0, 70)}…`);
        return png;
      } catch (error) {
        log(`image FAILED via ${provider} after ${Math.round((Date.now() - started) / 1000)}s (${(error as Error).message}): ${prompt.slice(0, 70)}…`);
      }
    }
    return null;
  } finally {
    running--;
    waiting.shift()?.();
    if (running === 0 && waiting.length === 0) idlers.splice(0).forEach((resolve) => resolve());
  }
}

// A Codex run is a chat agent around the image tool, and the agent is where the tokens go: left to itself it reads its
// imagegen skill, looks at the reference, and copies the result about - six model calls on a context full of the user's
// plugins. So: no user config, low effort, the reference by path (not attached), the one tool call written out for it,
// and we fetch the file from Codex's own output folder instead of asking for a copy. ~28k tokens an image, from ~140k.
async function viaCodex(prompt: string, references: Reference[]): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "ruler-image-"));
  for (const reference of references) writeFileSync(join(dir, reference.name), reference.png);
  const call = JSON.stringify({ prompt, ...(references.length ? { referenced_image_paths: references.map((reference) => join(dir, reference.name)) } : {}) });
  const instruction = `Your first and only tool call is your exec tool with exactly this script (if you have no such tool, call the image generation tool once directly with the same arguments). Do not read the imagegen skill or any file, and do not view or copy any image - the script is complete.\n\n// @exec: {"yield_time_ms": 300000, "max_output_tokens": 100}\nawait tools.image_gen__imagegen(${call});\ntext("DONE");\n\nThen reply only DONE or FAILED: reason.`;
  const args = ["exec", "--skip-git-repo-check", "--ignore-user-config", "--sandbox", "workspace-write", "-c", 'model_reasoning_effort="low"', ...(process.env.CODEX_IMAGE_MODEL ? ["-m", process.env.CODEX_IMAGE_MODEL] : []), "--json", "-"];
  let events = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn("codex", args, { cwd: dir, stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => { child.kill(); reject(new Error("timed out")); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk) => (events += chunk));
    child.on("error", reject);
    child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`codex exited ${code}`)); });
    child.stdin.end(instruction);
  });
  const thread = /"thread_id":"([\w-]+)"/.exec(events)?.[1];
  const usage = /"usage":\{"input_tokens":(\d+),"cached_input_tokens":(\d+)/.exec(events);
  if (usage) log(`codex image used ${usage[1]} input tokens (${usage[2]} cached)`);
  const made = thread ? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "generated_images", thread) : "";
  const newest = made && existsSync(made) ? readdirSync(made).filter((name) => name.endsWith(".png")).map((name) => join(made, name)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined;
  const out = newest ?? join(dir, "out.png"); // an agent that copied it anyway still counts
  try {
    if (!existsSync(out)) throw new Error("no image produced");
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true }); // the scratch folder and its reference copies are not kept
  }
}

/** How a mapmaker of the age would have drawn it */
const cartography = (era: string) =>
  /Ancient|Classical/.test(era) ? "an ancient map painted on papyrus or a wall fresco, with earth pigments, little drawn cities and stylised waves"
  : /Medieval/.test(era) ? "an illuminated medieval map on vellum, with gold leaf, tiny castles for cities, sea monsters and ornate borders"
  : /Renaissance/.test(era) ? "a hand-coloured copperplate map of the age of discovery, with engraved relief, sailing ships, a compass rose and a decorated cartouche"
  : /Industrial/.test(era) ? "a finely engraved nineteenth-century atlas plate with hachured mountains, delicate tinted borders and elegant lettering"
  : "a printed twentieth-century atlas plate with shaded relief and clean typography";

/**
 *  The civ's known world as a mapmaker of its age would have made it. The image model paints the whole thing - land,
 *  names, borders, armies - from our accurate drawing; a name slightly off matters less than a map worth looking at.
 *  Falls back to our own atlas drawing.
 */
export async function paintedMap(civ: string): Promise<Buffer> {
  const [atlas, briefing] = await Promise.all([host.map(civ), host.briefing(civ).catch(() => ({}) as Record<string, unknown>)]);
  const prompt = `The attached map.png is an accurate schematic of the world as the ${civ} know it in ${briefing.year ?? "this age"}. Make it into ${cartography(String(briefing.era ?? ""))} - something a ruler would hang in the throne room.
Keep the geography faithful: the same landmasses, coasts, rivers, mountains and forests in the same places, and every city where the schematic has it, with its name lettered beside it (copy the names exactly; "Name · Nation" means a foreign city - letter just the name and show whose it is by colour or a small banner). Show each realm's territory with a soft tinted border in its colour, and the little shields and discs as tiny armies and travellers. Unknown regions stay blank and mysterious, as unexplored as they are.
Title it "The Known World of ${civ}, ${briefing.year ?? ""}". Leave out the schematic's footnote about shields and discs.
The schematic is built from six-sided cells; the finished map must show no trace of them. Redraw every coastline as a natural, irregular shore with bays and headlands, and every border as a soft flowing line that follows rivers and ridges - nothing angular, zigzag or honeycomb-shaped anywhere. Natural painted terrain, not game tiles.`;
  return (await generateImage(prompt, [{ name: "map.png", png: atlas }])) ?? atlas;
}

/** Portraits are kept so the advisor looks the same all game and can be a reference for later scenes */
const PORTRAITS = join(process.env.RULER_STATE_FILE ? join(process.env.RULER_STATE_FILE, "..") : "../data/game", "portraits");
export const portraitPath = (civ: string) => join(PORTRAITS, `${civ}.png`);

export async function advisorPortrait(civ: string, characterSheet: string, era: string): Promise<Buffer | null> {
  const png = await generateImage(`A portrait of this person, as a realistic oil painting in the manner and dress of the ${era} of the ${civ} civilization, head and shoulders, natural light, no text:\n\n${characterSheet}`);
  if (png) {
    mkdirSync(PORTRAITS, { recursive: true });
    writeFileSync(portraitPath(civ), png);
  }
  return png;
}
