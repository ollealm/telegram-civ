// Image generation behind one seam. Today: the Codex CLI on the ruler's ChatGPT subscription (no API key).
// A picture is never worth waiting for: callers send their text first and the image when (and if) it arrives.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { host } from "./host.ts";

const ENABLED = process.env.IMAGES !== "off";
const TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS ?? 240_000);
const MAX_PARALLEL = 3;
let running = 0;
const waiting: (() => void)[] = [];

export type ImageLog = (message: string) => void;
let log: ImageLog = () => {};
export const onImageLog = (sink: ImageLog) => (log = sink);

/** One image from a prompt, optionally guided by reference images. Null when it fails or takes too long. */
export async function generateImage(prompt: string, references: { name: string; png: Buffer }[] = []): Promise<Buffer | null> {
  if (!ENABLED) return null;
  if (running >= MAX_PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  const started = Date.now();
  try {
    const dir = mkdtempSync(join(tmpdir(), "ruler-image-"));
    for (const reference of references) writeFileSync(join(dir, reference.name), reference.png);
    const instruction = `${references.length ? `Use your built-in image generation tool in image-to-image (edit) mode with the attached ${references.map((r) => r.name).join(", ")} as input.` : "Use your built-in image generation tool."}\n\n${prompt}\n\nSave the result as out.png in the current directory. Do nothing else. Reply only DONE or FAILED: reason.`;
    const args = ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", ...(process.env.CODEX_IMAGE_MODEL ? ["-m", process.env.CODEX_IMAGE_MODEL] : []), ...references.flatMap((r) => ["-i", r.name]), "-"];
    await new Promise<void>((resolve, reject) => {
      const child = spawn("codex", args, { cwd: dir, stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => { child.kill(); reject(new Error("timed out")); }, TIMEOUT_MS);
      child.on("error", reject);
      child.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`codex exited ${code}`)); });
      child.stdin.end(instruction);
    });
    const out = join(dir, "out.png");
    if (!existsSync(out)) throw new Error("no image produced");
    log(`image ok in ${Math.round((Date.now() - started) / 1000)}s: ${prompt.slice(0, 70)}…`);
    return readFileSync(out);
  } catch (error) {
    log(`image FAILED after ${Math.round((Date.now() - started) / 1000)}s (${(error as Error).message}): ${prompt.slice(0, 70)}…`);
    return null;
  } finally {
    running--;
    waiting.shift()?.();
  }
}

const MAP_PROMPT = `Repaint the reference as a realistic hand-painted relief map seen from directly above, like a museum-quality physical atlas plate: natural terrain textures, forests as canopy, hills and mountains with shaded relief, soft shorelines with pale shallows deepening smoothly to open sea, rivers as thin natural lines, and the blank parchment areas left as aged blank parchment.
STRICTLY preserve the layout: same framing and aspect ratio, every coastline, river, lake and landmass exactly where it is in the reference.
No hexagons, cells or grid anywhere - least of all in the water. No text, labels, borders, icons or compass.`;

/** The civ's known world: our accurate render repainted by the image model, with names and borders drawn back on by the host. Falls back to our own atlas drawing. */
export async function paintedMap(civ: string): Promise<Buffer> {
  const repaint = await generateImage(MAP_PROMPT, [{ name: "reference.png", png: await host.map(civ, "reference") }]);
  if (repaint) {
    try {
      return await host.mapOverlay(civ, repaint);
    } catch (error) {
      log(`map overlay failed: ${(error as Error).message}`);
    }
  }
  return host.map(civ);
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
