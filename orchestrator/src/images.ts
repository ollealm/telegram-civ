// Image generation behind one seam, with two providers: the Gemini API (GEMINI_API_KEY) and the Codex CLI on a
// ChatGPT subscription (no key). IMAGE_PROVIDER picks one; by default Gemini when a key is set, and the other as fallback.
// A picture is never worth waiting for: callers send their text first and the image when (and if) it arrives.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { host, type AgeSummary, type Realm } from "./host.ts";

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

export type Reference = { name: string; png: Buffer };
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
  const images = references.map((reference) => ({ mime: /\.jpe?g$/i.test(reference.name) ? "image/jpeg" : "image/png", data: reference.png.toString("base64") }));
  let json: unknown;
  try {
    json = await post(`${GEMINI_API}/interactions`, {
      model: GEMINI_MODEL,
      input: [{ type: "text", text: prompt }, ...images.map(({ mime, data }) => ({ type: "image", mime_type: mime, data }))],
      response_format: { type: "image" },
    });
  } catch (error) {
    if (![404].includes((error as { status?: number }).status ?? 0)) throw error; // a 400 is about our request - say so, do not mask it
    // Older surface of the same API
    json = await post(`${GEMINI_API}/models/${GEMINI_MODEL}:generateContent`, {
      contents: [{ parts: [{ text: prompt }, ...images.map(({ mime, data }) => ({ inline_data: { mime_type: mime, data } }))] }],
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

/** What the painter is given for a picture a writer described: the description, then the year and the general guardrail. The medium is the writer's,
 *  chosen from what the people's age allows - the code no longer appends one (picture guide A, 2026-11-02) */
export const picturePrompt = (picture: { description: string; year: string }, shown: string[] = []) =>
  `${picture.description}\n\n${shown.length ? `${shownLine(picture.description, shown)}\n\n` : ""}The year is ${picture.year}. No text or lettering. No real people.`;

/** A place picture's attached wonders (picture guide N): their look from the pictures, the style from this description's medium - its words up to the
 *  first full stop or colon, first letter lowercased */
const shownLine = (description: string, shown: string[]) => {
  const medium = (/^[^.:]*/.exec(description.trim())?.[0] ?? "").trim();
  const names = shown.map(withArticle);
  const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `The attached ${names.length === 1 ? "picture shows" : "pictures show"} ${listed} as first painted. Take only how ${names.length === 1 ? "it looks" : "they look"}, not the style: this picture is ${medium.charAt(0).toLowerCase()}${medium.slice(1)}.`;
};
/** A wonder's name as English says it: "the Colossus", "the Great Library" (the game's "The Great Library"), and the proper names bare */
const BARE_WONDERS = new Set(["Stonehenge", "Petra", "Hagia Sophia", "Chichen Itza", "Machu Picchu", "Angkor Wat", "Notre Dame", "Big Ben", "Neuschwanstein", "Himeji Castle", "Cristo Redentor"]);
const withArticle = (wonder: string) => (/^the /i.test(wonder) ? `the ${wonder.slice(4)}` : BARE_WONDERS.has(wonder) ? wonder : `the ${wonder}`);

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
    // Its own process group: `codex` is a Node wrapper around the native binary, and killing the wrapper alone left the binary running
    const child = spawn("codex", args, { cwd: dir, stdio: ["pipe", "pipe", "ignore"], detached: true });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGTERM"); } catch { child.kill(); } reject(new Error("timed out")); }, TIMEOUT_MS);
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

/** The ages a map is painted in, each with the style Olle chose for it (data/harness/map-all-ages-2026-10-22, selected-recipes.json, 2026-10-23);
 *  an era the game names otherwise (Future) is painted as Information */
export const MAP_AGES = ["Ancient", "Classical", "Medieval", "Renaissance", "Industrial", "Modern", "Atomic", "Information"] as const;
type MapAge = (typeof MAP_AGES)[number];
const mapAge = (era: string): MapAge => MAP_AGES.find((age) => era.includes(age)) ?? "Information";

/** Each age's map language, its towns and units, and what sets it apart from the age before; campaign: what the campaign plate adds, where it differs */
const MAP_STYLES: Record<MapAge, { map: string; towns: string; change: string; campaign: string }> = {
  Ancient: {
    map: "Warm fresh papyrus. Assured broad, slightly broken charcoal-brown brush strokes with ochre, muted green, rust and mineral-blue touches: a flat pictorial diagram, never scenic landscape or perspective. Coasts and rivers carry expressive hand movement; the sea is small separated groups of wave marks with a few shore stones, not a continuous blue band or a shaded cliff coast. Well-spaced clusters of tree glyphs, short patterned field strips and a few hill chevrons give the land substance, with visible blank gaps among them and no continuous grain of filler. Labels in a rough brush-written hand. The signs are deliberate, confident and beautiful, not a child's drawing.",
    towns: "Settlements are tiny flat side-elevation pictograms: a few mud-brick walls, flat roofs, a timber or thatch shelter, a fenced enclosure or granary. The capital or largest town is two to four linked signs, smaller towns one or two. No columned temple, tower or castle. Units are minute flat profile glyphs in the same brush: a spear-bearer, a walking person, a pack animal, a boat as a single hull sign. Few assured marks, no faces, no shaded bodies; storytelling through signs, not figurines.",
    change: "The first age: the only one drawn as flat pictograms with no depth at all, towns as small linked sign groups and units as minute profile glyphs.",
    campaign: "",
  },
  Classical: {
    map: "A pale, open regional plan on warm papyrus, drawn ink first: fine warm carbon-ink lines for shores, rivers, roads and little linear hill chains, with small scattered olive and cypress signs and a few patterned field strips. Colour comes only as touches - muted blue water strokes and a soft wash along the shores that fades into the papyrus within a short way of the coast, a faint sage tint in places, vermilion on roofs and standards. Land is never filled with green or painted solid: most of it stays the bare papyrus between sparse ink marks, and the open sea fades out into the papyrus rather than covering it. Labels in small Roman capitals with a fine rule beneath the title. Ample open surface and restrained colour; the map stays much simpler and quieter than Medieval and later plates - no painted panorama, no full-colour landscape, no decorative border.",
    towns: "Compact, slightly dimensional walled towns seen a little obliquely, drawn in ink with a touch of vermilion on their roofs: a ring of low wall, a gate, a pediment or colonnade at the civic heart, a few roofs, with modest depth and only light shading. The capital or largest town is a walled precinct with a colonnaded civic block; lesser towns smaller, a coastal one a gate and a short mole, a distant one a small walled sign. Never flatten them into abstract signs, never make them busy painted cities. Units are small standards on a staff and worker or tool marks, with a few restrained profile strokes for people, all in the same ink with vermilion touches; at sea, small oared galleys in a few ink strokes.",
    change: "The rough Ancient brush gives way to finer, ordered carbon-ink drawing with colour only in touches, towns gain walls and slight depth as civic precincts, and units become small standards and tool marks instead of profile glyphs.",
    campaign: "",
  },
  Medieval: {
    map: "An opulent illuminated manuscript map on clean ivory vellum: flat lapis-blue water with fine gold strokes, malachite green land, vermilion and small burnished-gold accents in a flat mineral-pigment hand. Graphic undulating ribbon rivers, patterned rows of hill forms and small grouped tree signs, with delicate manuscript pen work and a narrow, beautifully painted foliate edge. Rich but composed, with plenty of label space; flat expressive silhouettes, not aerial landscape rendering. Restrained, legible blackletter. Where far land runs into blankness it ends in a soft unfinished pigment edge rather than a newly outlined coast.",
    towns: "Towns are compact flat or stacked manuscript vignettes of stone walls, timber roofs, keeps and church towers, varied in silhouette: some only ordinary roof clusters with a low church, not an identical castle at every label. The capital or largest town is a compact walled town with low roofs and one important civic tower, not a fantasy forest of turrets; towers stay modest in height. Each visible force is a handful of tiny gestural brush marks: low-detail mounted riders, small shield-and-spear foot groups, working figures; at sea, small medieval sailing craft. Figures fit the height of a doorway and sit partly hidden by terrain, realm colour only on a pennon or small cloth accent, never whole coloured bodies, and never stiff rows of toy soldiers.",
    change: "Restrained ink gives way to opulent flat pigment, gold and a painted border, towns become varied manuscript vignettes with keeps and church towers, and units become gestural riders and spear groups with pennons.",
    campaign: "",
  },
  Renaissance: {
    map: "A generous copperplate atlas engraving of the age of discovery: hairline dark-brown incisions, engraved hill relief and close parallel sea strokes, with subdued hand washes of teal water and ochre and sage land. Rich cartographic craft, a small elegant strapwork title cartouche and one compact compass rose in known open water, all ornament subordinate to the map. Balanced and finely drawn; clearly engraved, not gold manuscript illumination or a painted fantasy landscape.",
    towns: "Small oblique walled town prospects: tiled roofs, bastions, civic towers, quays and occasional domes, varied from town to town; the capital or largest town larger but still subordinate to the map. Armies are tiny sketched pike-and-shot detachments, cavalry and minute field pieces in fine brown engraved strokes with small realm-colour pennants and varied profiles; fine irregular marks imply motion. A group is smaller than a town and a person smaller than a doorway, yet readable on close inspection. At sea, small galleons or oared craft. No oversized people, no stiff rows, no repeated front-facing figures.",
    change: "Flat illuminated pigment gives way to copperplate line, hachured relief and hand washes, towns become oblique bastioned prospects with domes, and units become engraved pike-and-shot, cavalry and field-piece groups.",
    campaign: "",
  },
  Industrial: {
    map: "A quiet, pale nineteenth-century steel-engraved atlas plate on pale cream paper: precise grey-brown hachured relief, hairline shore strokes, translucent sage and ochre land washes and muted slate-blue water fading softly into the paper. Fine river lines, modest engraved serif lettering, a restrained double-rule plate edge and a small typographic title. Rich topographic information in a measured print hierarchy; no baroque gilding, wind heads, medieval symbols or large title illustration.",
    towns: "Compact brick urban blocks with mills, chimney groups, iron bridges, modest stations and quays, the industrial landmarks differing by settlement and staying tiny; no skyscrapers, and chimneys not enlarged everywhere. Infrastructure may enrich a town's vicinity but never becomes a network of roads across unknown country. Land forces are very small rifle, cavalry and artillery detachments in the same delicate grey-brown ink with minute uniform or pennant accents: every person smaller than a doorway in the nearby town, never as tall as its roofs, with a trace of walking movement rather than standing rows, still visible on close inspection. At sea, small steam vessels with a wisp of smoke. No portraits or bright toy uniforms.",
    change: "The decorated Renaissance engraving turns into a pale, quiet steel plate with a plain rule edge, towns become brick blocks with chimneys, mills and stations, and units become minute rifle, horse and gun detachments beside steamships.",
    campaign: "",
  },
  Modern: {
    map: "A striking early-twentieth-century travel-map lithograph: bold yet sophisticated flat shapes of jade, navy, muted coral and cream, graceful simplified and gently faceted terrain, crisp printed shadow forms and controlled ink grain. A pictorial map, not photoreal terrain, rich through considered shapes rather than dense microtexture; warm, inviting and confident in colour. An assured tall-lettered typographic heading and a minimal, restrained Art Deco frame. No gilded scrollwork, parchment, medieval figures or steel-engraved hatching.",
    towns: "Small printed vignettes of early twentieth-century urban life: compact low-to-mid-rise masonry street blocks, varied civic rooflines, a small station roof or harbour crane where it fits, a few brick industry details and a little heritage architecture, but no repeated spire clusters. No glass supertowers, slab suburbs or saturated toy skylines; buildings stay tiny, not a parade of large landmarks. Forces are tiny grounded troop or vehicle groups drawn with a few gestural strokes, not rows of dolls, and tiny steamships where ships stand, all in the same simplified lithographic shape language. No decorative fleets or extra aircraft.",
    change: "The pale hachured steel plate gives way to bold flat lithographic colour shapes and printed shadows, towns become masonry street blocks with station roofs and cranes, and units become gestural early-twentieth-century troop and vehicle groups.",
    campaign: "",
  },
  Atomic: {
    map: "A vivid mid-century airline or world's-fair pictorial map, brighter and clearer than Modern: assured cut-paper-like gouache shapes, simplified gently faceted landforms, turquoise coasts on a warm cream ground, olive and mustard land with coral accents, and fine offset-print grain. Economical but lively drawing with playful adult editorial confidence. A strong geometric sans-serif heading, no ornate cartouche or parchment. A superb 1950s or 1960s printed map, not a modern game interface.",
    towns: "Compact, low isometric groups of flat-roofed civic buildings in a coherent mid-century editorial hand: a small slab block, a modest radio mast, a station canopy or harbour shed, built from very few deliberately geometric shapes with restrained shadow planes, varied from town to town. The capital or largest town may have two or three modest taller modernist blocks; no spire forests, red-roofed castles, Manhattan skylines or futuristic landmarks, and an airfield only as a tiny town detail. Land forces are tiny groups of olive tracked vehicles with a few minute infantry strokes on open ground, simple olive and charcoal silhouettes with a trace of shadow, each vehicle no bigger than a small house; at sea, small naval silhouettes. No toy models, giant soldiers, comic icons or floating aircraft ornaments.",
    change: "The lithograph's deep confident colour brightens into cut-paper gouache with turquoise and mustard, towns become low isometric slabs with radio masts, and units become olive tracked vehicles and grey naval silhouettes.",
    campaign: "",
  },
  Information: {
    map: "A contemporary editorial relief atlas on a fresh white ground, so blank unknown surface reads as paper and never as sea. Continuous, richly painted natural terrain: deep marine-blue coastal water clearly edged against the white, layered forest green and mineral-grey ridges, bright river networks and very fine urban texture. High information density with a calm visual hierarchy. Crisp, quiet modern sans-serif labels set directly on pale clearings without old placards, a minimal modern heading and generous clean margins. No parchment, ornamental frame, cartouche or compass. A contemporary illustrated atlas, not a videogame board or satellite interface.",
    towns: "Compact contemporary urban fabric with varied density: small high-rise clusters only for major centres, quays, civic buildings and a few rooftop details, road textures confined to settled patches. The capital or largest town is the densest and largest. Forces are minute naturalistically painted vehicle and infantry formations, subdued olive and grey with small realm accents, a group comparable to a few tiny houses or smaller; at sea, tiny naval vessels. Never military icons, oversized machines or soldiers, futuristic toys, or swarms of aircraft, satellites or drones.",
    change: "Flat mid-century gouache gives way to continuous naturalistic painted relief on white, towns become contemporary urban fabric with high-rise cores, and units become minute naturalistic vehicle formations.",
    campaign: "",
  },
};

/** What every age's map keeps, said once */
const MAP_RULES = "Draw a complete head-on map of the known world, not a photograph of a map object and not a modern game map dressed in a period border. Atmosphere and the drawing hand matter more than exact coordinates, but named towns keep their broad places and the broad coasts, bays, rivers and main landmass silhouette hold. Shores are natural, with no hexagonal, honeycomb or tile traces. Unexplored surface stays blank, the age's own plain ground, never new water or filled land. Remote glimpses stay separate vignettes that thin out into that blankness on their unseen sides: no invented islands, coast rings or continents, and no joining every patch into one landmass. Richness comes from cartographic craft, not added content: no extra place names, sea names, scale bars, resource dots, UI, badges or circular icons. Labels are clear and quiet, each name copied exactly as written. Towns and units belong to the same medium and hand as the terrain. Forces appear only where units stand, each group smaller than a town, and no armies, fleets or aircraft are invented elsewhere. Leave ample space between labels and unit groups. Never mosaic in any form: no tesserae, tiled stone or mosaic texture anywhere.";

/** How a mapmaker of the age draws it: the age's chosen style, for the atlas or for the campaign plate */
export const cartography = (era: string, kind: "atlas" | "campaign" = "atlas") => {
  const age = mapAge(era);
  const style = MAP_STYLES[age];
  return `THE ${age.toUpperCase()} AGE'S MAP: ${style.map}
TOWNS AND UNITS: ${style.towns}
${style.change}${kind === "campaign" && style.campaign ? `\nON THE CAMPAIGN PLATE: ${style.campaign}` : ""}`;
};

/** The image the age's style was chosen by, downscaled (orchestrator/assets/map-styles): passed as a style starting point, never as geography */
const styleReference = (era: string, kind: "atlas" | "campaign") =>
  ({ name: "style.jpg", png: readFileSync(fileURLToPath(new URL(`../assets/map-styles/${mapAge(era)}-${kind}.jpg`, import.meta.url))) });
const STYLE_NOTE = "style.jpg is a map of another world, made in this age's style: a style starting point only - its ground, hand, palette and way of drawing towns and figures. Never copy its geography, coasts, names or places, and do not repeat it mark for mark; the map you make is of the world in map.png.";

/** The schematic's badges in words, so that the painter paints the companies that are there, as what they are, and no others */
function companies(civ: string, inSight: AgeSummary["inSight"] | undefined): string {
  if (!inSight?.length) return "No company is in sight: paint no soldiers, ships, machines or aircraft anywhere on the map.";
  const shown = inSight.slice(0, 24).map((c) => `${c.whose === civ ? "ours" : c.whose}: ${c.what} ${c.at}`);
  return `The schematic's round badges are the companies in sight, the icon in each telling what it is. Paint each as a small group of figures of what it is, in the dress and arms of this age, where its badge is: ${shown.join("; ")}${inSight.length > shown.length ? `; and ${inSight.length - shown.length} more where the badges show` : ""}. No other soldiers, ships, machines or aircraft anywhere on the map, and no badges or dots.`;
}

/**
 *  The civ's known world as a mapmaker of its age would have made it. The image model paints the whole thing - land,
 *  names, borders, armies - from our accurate drawing; a name slightly off matters less than a map worth looking at.
 *  Falls back to our own atlas drawing.
 */
export async function paintedMap(civ: string): Promise<Buffer> {
  const [atlas, briefing] = await Promise.all([host.map(civ), host.briefing(civ).catch(() => ({}) as Record<string, unknown>)]);
  const now = await host.age(civ, Number(briefing.turn ?? 0)).catch(() => undefined);
  const era = String(briefing.era ?? "");
  return (await generateImage(paintedMapPrompt(civ, era, briefing.year as string | undefined, now), [{ name: "map.png", png: atlas }, styleReference(era, "atlas")])) ?? atlas;
}

export function paintedMapPrompt(civ: string, era: string, year: string | undefined, now: Pick<AgeSummary, "inSight" | "glimpses" | "realms"> | undefined): string {
  const ancient = mapAge(era) === "Ancient";
  return `Two attachments. map.png is an accurate schematic of the world as the ${civ} know it in ${year ?? "this age"}. ${STYLE_NOTE}
Make the world of map.png into a map of its age, something a ruler would hang in the throne room.
${cartography(era)}
${MAP_RULES}
Every city stands where the schematic has it, with its name lettered beside it (copy the names exactly; "Name · Nation" means a foreign city - letter just the name and show whose it is by colour or a small banner).${ancient ? " Show each realm's territory with a soft tinted border in its colour." : ""} ${companies(civ, now?.inSight)} ${UNKNOWN_COUNTRY(civ, now?.glimpses)}${ancient ? "" : `\n${frontiers(era, civ, now?.realms, now?.glimpses)}`}
Title it "The Known World of ${civ}, ${year ?? ""}", modestly.`;
}

/** Nothing but blank ground beyond what the realm has seen: how a painter is to treat it */
const UNKNOWN_COUNTRY = (civ: string, glimpses: string[] = []) => `Where the schematic's colours fade out into its bare light ground, the ${civ}'s knowledge ends. That ground is unexplored - not sea, not shore, not land: leave it as the map's own plain blank ground. Nothing runs along its edge: known land that fades into it does not end there but runs on unseen, so never close it with a coastline or ring it with water, and known sea fading into it gets no shore or shallows either - both simply thin out into the blank.${glimpses.length ? ` ${glimpses.join(", ")} ${glimpses.length === 1 ? "stands" : "stand"} in a glimpse of country seen from afar, not on an island: paint the land round ${glimpses.length === 1 ? "it" : "each"} as a small vignette that thins out into the blank on every side, with no coast and no water round it.` : ""} A city that stands on the blank ground is known to exist: draw it where the schematic gives it, on a little land that thins out into the blank. Paint all of the known world the schematic shows, out to its farthest seas and shores; crop nothing.`;

/** An age's campaigns on the painted map, as a history atlas prints them: the host reckons the forces and draws their arrows; the painter only repaints them */
export async function campaignMap(civ: string, age: AgeSummary, marches: Buffer): Promise<Buffer> {
  const [atlas, briefing] = await Promise.all([host.map(civ), host.briefing(civ).catch(() => ({}) as Record<string, unknown>)]);
  const era = String(briefing.era ?? "");
  return (await generateImage(campaignMapPrompt(civ, era, age), [{ name: "map.png", png: atlas }, { name: "marches.png", png: marches }, styleReference(era, "campaign")])) ?? marches;
}

export function campaignMapPrompt(civ: string, era: string, age: AgeSummary): string {
  const title = `The Marches of ${civ}, ${age.fromYear} to ${age.toYear}`;
  const ancient = mapAge(era) === "Ancient";
  const campaigns = [...age.marches, ...age.enemyMarches];
  // Only the endings this map has: a painter told of a way home draws one
  const endings = [
    campaigns.some((c) => c.outcome === "took") && "a head against a red ring - the city was taken",
    campaigns.some((c) => c.outcome === "broken") && "a bar with crossed swords - the force was broken there",
    campaigns.some((c) => c.outcome === "back") && "a dashed line on from it - the way home",
  ].filter(Boolean);
  const arrows = campaigns.length
    ? `marches.png is the same map with the campaigns of these years already drawn on it as a history atlas draws them: one broad arrow for each force that went somewhere, in its realm's colour, broader for a larger force.${endings.length ? ` How an arrow ends tells how the campaign ended: ${endings.join("; ")}.` : ""}
Paint exactly the ${campaigns.length} arrow${campaigns.length === 1 ? "" : "s"} marches.png has, over the painted world: each from where it starts to where it ends, along the same curve, in the same colour, with the same ending - broad, bold arrows that read at a glance, as a history atlas prints them, painted in the manner of the age. The arrows come from marches.png alone, not from the places the words below name: add no other arrow, route, trail or battle mark, and leave none out. Each arrow has one head, where marches.png puts it.${ancient ? "" : " The arrows lie over the frontiers and owe them nothing: an arrow crosses every frontier on its way as marches.png has it, no frontier bends to it, and an arrow stays far broader than any frontier line. An arrow of a realm whose frontier colour is given above may take that colour where marches.png's is paler."}`
    : "marches.png has no arrows: no force went anywhere worth an arrow in these years. Draw none.";
  return `Three attachments. map.png is an accurate schematic of the world as the ${civ} know it in ${age.toYear}; marches.png is the same map with the campaigns of these years drawn on it. ${STYLE_NOTE}
Paint the world first as a map of its age, something a ruler would hang in the throne room, and then, over it, the campaigns of the age.
${cartography(era, "campaign")}
${MAP_RULES}
Every city stands where the schematic has it, drawn as the age draws towns (the capital larger), with its name lettered beside it (copy the names exactly; "Name · Nation" means a foreign city - letter just the name and show whose it is by colour or a small banner)${ancient ? "; each realm's territory with a soft tinted border in its colour." : "."}
${companies(civ, age.inSight)}
${UNKNOWN_COUNTRY(civ, age.glimpses)} Use no real-world coat of arms or flag.${ancient ? "" : `\n${frontiers(era, civ, age.realms, age.glimpses, true)}`}
${arrows}
Title it "${title}" in a cartouche, and beneath the title, in small script, tell what happened in two or three lines of plain prose of the age, keeping to what the chancery's words say - no figures, no "tiles", no names in brackets. A quiet age says so in one line. What happened in these years, in the chancery's words: ${age.lines.join(" ")}`;
}

/** How each later age draws a frontier and letters its key (data/harness/map-border-tests-2026-11-03, the selected passes); Ancient keeps its soft tint */
const FRONTIER_HANDS: Record<Exclude<MapAge, "Ancient">, { line: string; key: string }> = {
  Classical: { line: "a firm, flowing reed-pen line in the realm's colour, slightly irregular, with a short inner feather of its pigment", key: "small Roman capitals" },
  Medieval: { line: "an assured painted line of the realm's pigment with short inward hatching, never a heavy modern band", key: "restrained manuscript lettering" },
  Renaissance: { line: "an engraved line with a restrained hand-coloured edge of the realm's colour on its inner side", key: "small engraved italic" },
  Industrial: { line: "a crisp printed boundary edged in the realm's colour, with a very light inner tint", key: "quiet engraved serif" },
  Modern: { line: "a confident lithographic stroke in the realm's colour", key: "the heading's period typography, small" },
  Atomic: { line: "a clean printed line of firm coloured ink with a very subtle inward feather", key: "small geometric sans-serif" },
  Information: { line: "a precise contemporary cartographic line in the realm's colour with a dark edge and a very restrained inward accent", key: "clean quiet sans-serif" },
};
/** Every city-state's frontier: one colour for all, each still its own realm */
const CITY_STATE_INK = "#4a4038";

/**
 *  The realms' frontiers from Classical on, as a firm line where a realm's land meets known land outside it (map border tests,
 *  2026-11-03): the soft tint alone was lost under terrain at phone size. The colours are the game's, chosen per game.
 */
export function frontiers(era: string, civ: string, realms: Realm[] = [], glimpses: string[] = [], campaign = false): string {
  const hand = FRONTIER_HANDS[mapAge(era) as Exclude<MapAge, "Ancient">] ?? FRONTIER_HANDS.Information;
  const colours = frontierColours(realms);
  const far = (realm: Realm) => !realm.meets.length && realm.cities.length > 0 && realm.cities.every((city) => glimpses.includes(city));
  const told = (realm: Realm) => {
    const hex = realm.cityState ? CITY_STATE_INK : colours.get(realm.name)!;
    // its towns tie the colour to the schematic's labels, where a colour the schematic tints otherwise would leave the painter guessing whose land is whose
    const towns = realm.cityState || !realm.cities.length ? "" : ` - ${realm.cities.slice(0, 5).join(", ")}${realm.cities.length > 5 ? " and more" : ""} -`;
    return `${realm.name}${towns} ${realm.cityState ? "warm charcoal" : colourName(hex)} ${hex}${luminance(hex) > 0.35 ? ", edged in dark ink" : ""}`;
  };
  // where its line runs, from the game: a realm whose every edge is coast or the unknown has none, and a painter told only "not along coasts" outlines it anyway
  const runs = (realm: Realm) => {
    const toward = [...realm.meets, ...(realm.open ? ["the unclaimed land beside it"] : [])];
    return toward.length ? `, its frontier only toward ${toward.length === 1 ? toward[0] : `${toward.slice(0, -1).join(", ")} and ${toward.at(-1)}`}` : ", with no frontier line at all: its edges are coast and the unknown, so its colour shows only in the key and a small accent by its towns";
  };
  const powers = realms.filter((realm) => !realm.cityState && !far(realm));
  const cityStates = realms.filter((realm) => realm.cityState && !far(realm));
  const distant = realms.filter(far);
  const named = cityStates.slice(0, 10).map((realm) => realm.name);
  return [
    `COUNTRY FRONTIERS: the schematic's coloured edges are the realms as they are - draw them where it has them, never from alliances or as a tidy outline round each land. A frontier runs only across land, where a realm's land meets known land outside it, and is drawn as ${hand.line}: continuous, firmer than rivers, roads and relief, and readable when the whole map is seen on a phone, with a narrow clearance of the map's own ground behind it where the terrain is busy. A natural flowing line, never a cell trace, and no flat political fill; where two realms meet, one division, not parallel lines. A frontier that reaches the sea stops at the shore: a realm's coasts are no frontier and keep their ordinary drawing, with no coloured line, stripe or halo along them, so a realm on the sea is never outlined all round. Where known country fades into the unexplored, the frontier fades out with it: no closed ring round a realm's known edge or round a far glimpse. Frontiers stay distinct from roads and rivers${campaign ? " and from the campaign arrows" : ""}.`,
    powers.length ? `The realms, their towns, the colour each frontier is drawn in (the schematic may tint it otherwise; the towns tell whose land is whose) and where it runs: ${powers.map((realm) => told(realm) + runs(realm)).join("; ")}.` : "",
    cityStates.length ? `The city-state${cityStates.length === 1 ? "" : "s"} ${named.join(", ")}${cityStates.length > named.length ? ` and ${cityStates.length - named.length} more` : ""}: each its own small realm, its frontier in warm charcoal ${CITY_STATE_INK} on its landward sides only, whatever its alliances.` : "",
    distant.length ? `Known only from afar: ${distant.map(told).join("; ")} - a small accent in that colour by the town's name, and no frontier.` : "",
    realms.length >= 2 ? `A small quiet key - a short line sample beside each realm's name${cityStates.length ? ", and one for the city-states" : ""}, in ${hand.key} - stands in open margin, never over the land. A realm's name may also be lettered small on its own land, among its own towns, where there is room - never over a town's name or a company, and never where its towns are not. The key and those names are the only words the map adds.` : "",
  ].filter(Boolean).join("\n");
}

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex: string) => { const [r, g, b] = channels(hex).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** CIE Lab, for telling two colours apart as the eye does */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linear);
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [x, y, z] = [(0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, 0.2126 * r + 0.7152 * g + 0.0722 * b, (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883].map(f);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const apart = (a: string, b: string) => { const [p, q] = [lab(a), lab(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
/** Two frontier colours a reader tells apart in a thin line: a clear difference of hue, lightness or strength, or one a grey and the other not */
function distinct(a: string, b: string): boolean {
  const [p, q] = [lab(a), lab(b)];
  const [cp, cq] = [Math.hypot(p[1], p[2]), Math.hypot(q[1], q[2])];
  if ((cp < 12) !== (cq < 12)) return true;
  const turn = Math.abs(Math.atan2(p[2], p[1]) - Math.atan2(q[2], q[1])) * 180 / Math.PI;
  return (cp >= 12 && Math.min(turn, 360 - turn) >= 30) || Math.abs(p[0] - q[0]) >= 30 || Math.abs(cp - cq) >= 35;
}
const chroma = (hex: string) => { const c = channels(hex); return Math.max(...c) - Math.min(...c); };

/** Each great power's frontier colour: the member of its game pair that reads as a firm line on a light map - dark enough and not a grey,
 *  the outer one when both will do - and above all one no near twin of a colour already given (a pale one is then edged in dark ink) */
export function frontierColours(realms: Realm[]): Map<string, string> {
  const fit = (hex: string) => (luminance(hex) <= 0.35 ? 1 : 0) + Math.min(1, chroma(hex) * 2.5);
  const chosen = new Map<string, string>();
  for (const realm of realms.filter((each) => !each.cityState)) {
    const taken = [...chosen.values(), ...(realms.some((each) => each.cityState) ? [CITY_STATE_INK] : [])];
    const score = (hex: string) => fit(hex) + (hex === realm.outer ? 0.3 : 0) + (taken.every((other) => distinct(hex, other)) ? 2.5 : 0) + Math.min(0.5, ...taken.map((other) => apart(hex, other) / 100));
    chosen.set(realm.name, score(realm.inner) > score(realm.outer) ? realm.inner : realm.outer);
  }
  return chosen;
}

/** A colour in a painter's words: "deep red", "muted teal", "charcoal" */
export function colourName(hex: string): string {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (s < 0.15 || max - min < 0.08) return l < 0.1 ? "black" : l < 0.25 ? "charcoal" : l < 0.6 ? "slate grey" : l < 0.92 ? "pale grey" : "white";
  const h = max === r ? (60 * ((g - b) / (max - min)) + 360) % 360 : max === g ? 60 * ((b - r) / (max - min)) + 120 : 60 * ((r - g) / (max - min)) + 240;
  const hue = ([[15, "red"], [40, "orange"], [55, "amber"], [70, l < 0.45 ? "ochre" : "yellow"], [95, "olive"], [150, "green"], [200, "teal"], [265, "blue"], [320, "purple"], [345, "crimson"], [360, "red"]] as const).find(([top]) => h < top)![1];
  if (hue === "blue" && l < 0.25) return "navy";
  return `${l < 0.25 ? "deep " : l > 0.7 ? "pale " : s < 0.5 ? "muted " : ""}${hue}`;
}

/** The Chronicler's emblem: one plate per world, painted at its making, in the medium of a later age remembering it; no face, since the Chronicler has no person */
export async function chroniclerEmblem(peoples: string[]): Promise<Buffer | null> {
  return generateImage(`A round emblem for the chronicler of a world's whole history, made as an illuminated manuscript roundel on aged vellum: deep blues, earth reds and gold leaf. At the centre a stylised map of an unknown world - coastlines, rivers, mountain ranges, forests, small walled cities - that is no real place on Earth. Around the rim, in small painted cartouches, the emblems of the peoples of this world, one each, invented from what each people is known for: ${peoples.join(", ")}. Centred composition that reads at the size of a small round profile picture; no text, no lettering, no numerals anywhere. Realistic painted texture, the gold slightly worn.`);
}

/** Portraits are kept so the advisor looks the same all game and can be a reference for later scenes */
const PORTRAITS = join(process.env.RULER_STATE_FILE ? join(process.env.RULER_STATE_FILE, "..") : "../data/game", "portraits");
export const portraitPath = (civ: string) => join(PORTRAITS, `${civ}.png`);

/** Wonder pictures are kept beside them, so a place picture can show its wonders as they were first painted (picture guide N) */
const WONDERS = join(PORTRAITS, "..", "wonders");
const wonderFile = (wonder: string) => `${wonder.replace(/[^A-Za-z0-9-]+/g, "-")}.png`;
export function keepWonderPicture(wonder: string, png: Buffer) {
  mkdirSync(WONDERS, { recursive: true });
  writeFileSync(join(WONDERS, wonderFile(wonder)), png);
}
/** A new world keeps none of the last one's wonders */
export const forgetWonderPictures = () => rmSync(WONDERS, { recursive: true, force: true });
export const wonderPicture = (wonder: string): Buffer | null => (existsSync(join(WONDERS, wonderFile(wonder))) ? readFileSync(join(WONDERS, wonderFile(wonder))) : null);
/** The kept pictures of these wonders, as painter references, and the names of those that have one (the rest are named in the writer's input only) */
export const wonderReferences = (wonders: string[]) => {
  const kept = wonders.flatMap((wonder) => { const png = wonderPicture(wonder); return png ? [{ wonder, png }] : []; });
  return { shown: kept.map((each) => each.wonder), references: kept.map(({ wonder, png }): Reference => ({ name: wonderFile(wonder), png })) };
};

/** The portrait as Telegram wants a profile photo: a JPEG, by way of the system's own converter */
export async function asJpeg(png: Buffer): Promise<Buffer> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { tmpdir } = await import("node:os");
  const { writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const base = join(tmpdir(), `portrait-${process.pid}-${Date.now()}`);
  writeFileSync(`${base}.png`, png);
  try {
    await promisify(execFile)("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "85", `${base}.png`, "--out", `${base}.jpg`]);
    return readFileSync(`${base}.jpg`);
  } finally {
    rmSync(`${base}.png`, { force: true }); rmSync(`${base}.jpg`, { force: true });
  }
}

export async function advisorPortrait(civ: string, characterSheet: string, era: string): Promise<Buffer | null> {
  const png = await generateImage(`A portrait of this person, in the manner and dress of the ${era} of the ${civ} civilization, head and shoulders, natural light, no text:\n\n${characterSheet}`);
  if (png) {
    mkdirSync(PORTRAITS, { recursive: true });
    writeFileSync(portraitPath(civ), png);
  }
  return png;
}
