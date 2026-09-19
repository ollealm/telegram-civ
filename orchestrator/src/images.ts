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
Title it "The Known World of ${civ}, ${briefing.year ?? ""}". Leave out the schematic's footnote about shields and discs. No hexagons, cells or grid anywhere. Natural painted terrain, not game tiles.`;
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
