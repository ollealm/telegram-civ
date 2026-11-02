// Image generation behind one seam, with two providers: the Gemini API (GEMINI_API_KEY) and the Codex CLI on a
// ChatGPT subscription (no key). IMAGE_PROVIDER picks one; by default Gemini when a key is set, and the other as fallback.
// A picture is never worth waiting for: callers send their text first and the image when (and if) it arrives.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { host, type AgeSummary } from "./host.ts";

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
export const picturePrompt = (picture: { description: string; year: string }) => `${picture.description}\n\nThe year is ${picture.year}. No text or lettering. No real people.`;

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
  const inSight = now?.inSight;
  const era = String(briefing.era ?? "");
  const prompt = `Two attachments. map.png is an accurate schematic of the world as the ${civ} know it in ${briefing.year ?? "this age"}. ${STYLE_NOTE}
Make the world of map.png into a map of its age, something a ruler would hang in the throne room.
${cartography(era)}
${MAP_RULES}
Every city stands where the schematic has it, with its name lettered beside it (copy the names exactly; "Name · Nation" means a foreign city - letter just the name and show whose it is by colour or a small banner). Show each realm's territory with a soft tinted border in its colour. ${companies(civ, inSight)} ${UNKNOWN_COUNTRY(civ, now?.glimpses)}
Title it "The Known World of ${civ}, ${briefing.year ?? ""}", modestly.`;
  return (await generateImage(prompt, [{ name: "map.png", png: atlas }, styleReference(era, "atlas")])) ?? atlas;
}

/** Nothing but blank ground beyond what the realm has seen: how a painter is to treat it */
const UNKNOWN_COUNTRY = (civ: string, glimpses: string[] = []) => `Where the schematic's colours fade out into its bare light ground, the ${civ}'s knowledge ends. That ground is unexplored - not sea, not shore, not land: leave it as the map's own plain blank ground. Nothing runs along its edge: known land that fades into it does not end there but runs on unseen, so never close it with a coastline or ring it with water, and known sea fading into it gets no shore or shallows either - both simply thin out into the blank.${glimpses.length ? ` ${glimpses.join(", ")} ${glimpses.length === 1 ? "stands" : "stand"} in a glimpse of country seen from afar, not on an island: paint the land round ${glimpses.length === 1 ? "it" : "each"} as a small vignette that thins out into the blank on every side, with no coast and no water round it.` : ""} A city that stands on the blank ground is known to exist: draw it where the schematic gives it, on a little land that thins out into the blank. Paint all of the known world the schematic shows, out to its farthest seas and shores; crop nothing.`;

/** An age's campaigns on the painted map, as a history atlas prints them: the host reckons the forces and draws their arrows; the painter only repaints them */
export async function campaignMap(civ: string, age: AgeSummary, marches: Buffer): Promise<Buffer> {
  const [atlas, briefing] = await Promise.all([host.map(civ), host.briefing(civ).catch(() => ({}) as Record<string, unknown>)]);
  const title = `The Marches of ${civ}, ${age.fromYear} to ${age.toYear}`;
  const era = String(briefing.era ?? "");
  const campaigns = [...age.marches, ...age.enemyMarches];
  // Only the endings this map has: a painter told of a way home draws one
  const endings = [
    campaigns.some((c) => c.outcome === "took") && "a head against a red ring - the city was taken",
    campaigns.some((c) => c.outcome === "broken") && "a bar with crossed swords - the force was broken there",
    campaigns.some((c) => c.outcome === "back") && "a dashed line on from it - the way home",
  ].filter(Boolean);
  const arrows = campaigns.length
    ? `marches.png is the same map with the campaigns of these years already drawn on it as a history atlas draws them: one broad arrow for each force that went somewhere, in its realm's colour, broader for a larger force.${endings.length ? ` How an arrow ends tells how the campaign ended: ${endings.join("; ")}.` : ""}
Paint exactly the ${campaigns.length} arrow${campaigns.length === 1 ? "" : "s"} marches.png has, over the painted world: each from where it starts to where it ends, along the same curve, in the same colour, with the same ending - broad, bold arrows that read at a glance, as a history atlas prints them, painted in the manner of the age. The arrows come from marches.png alone, not from the places the words below name: add no other arrow, route, trail or battle mark, and leave none out. Each arrow has one head, where marches.png puts it.`
    : "marches.png has no arrows: no force went anywhere worth an arrow in these years. Draw none.";
  const prompt = `Three attachments. map.png is an accurate schematic of the world as the ${civ} know it in ${age.toYear}; marches.png is the same map with the campaigns of these years drawn on it. ${STYLE_NOTE}
Paint the world first as a map of its age, something a ruler would hang in the throne room, and then, over it, the campaigns of the age.
${cartography(era, "campaign")}
${MAP_RULES}
Every city stands where the schematic has it, drawn as the age draws towns (the capital larger), with its name lettered beside it (copy the names exactly; "Name · Nation" means a foreign city - letter just the name and show whose it is by colour or a small banner); each realm's territory with a soft tinted border in its colour.
${companies(civ, age.inSight)}
${UNKNOWN_COUNTRY(civ, age.glimpses)} Use no real-world coat of arms or flag.
${arrows}
Title it "${title}" in a cartouche, and beneath the title, in small script, tell what happened in two or three lines of plain prose of the age, keeping to what the chancery's words say - no figures, no "tiles", no names in brackets: "A company of pikemen wandered from the Russian marches to the walls of Genoa; ships found new waters to the south-east." A quiet age says so in one line. What happened in these years, in the chancery's words: ${age.lines.join(" ")}`;
  return (await generateImage(prompt, [{ name: "map.png", png: atlas }, { name: "marches.png", png: marches }, styleReference(era, "campaign")])) ?? marches;
}

/** The Chronicler's emblem: one plate per world, painted at its making, in the medium of a later age remembering it; no face, since the Chronicler has no person */
export async function chroniclerEmblem(peoples: string[]): Promise<Buffer | null> {
  return generateImage(`A round emblem for the chronicler of a world's whole history, made as an illuminated manuscript roundel on aged vellum: deep blues, earth reds and gold leaf. At the centre a stylised map of an unknown world - coastlines, rivers, mountain ranges, forests, small walled cities - that is no real place on Earth. Around the rim, in small painted cartouches, the emblems of the peoples of this world, one each, invented from what each people is known for: ${peoples.join(", ")}. Centred composition that reads at the size of a small round profile picture; no text, no lettering, no numerals anywhere. Realistic painted texture, the gold slightly worn.`);
}

/** Portraits are kept so the advisor looks the same all game and can be a reference for later scenes */
const PORTRAITS = join(process.env.RULER_STATE_FILE ? join(process.env.RULER_STATE_FILE, "..") : "../data/game", "portraits");
export const portraitPath = (civ: string) => join(PORTRAITS, `${civ}.png`);

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
