// Sample pictures through the game's own writers (Claude) and painter, for a look before a change to the picture prompts goes live (picture guide, 2026-11-02).
// Needs its own host on a COPY of a fixture (never the live one):  ../host.sh /tmp/pics 8768
// Run:  RULER_HOST_URL=http://127.0.0.1:8768 RULER_STATE_FILE=/tmp/pics/state.json IMAGE_PROVIDER=codex ADVISOR_MODEL=claude-opus-5-5 LETTER_EFFORT=high \
//       HERALD_MODEL=claude-opus-5-5 HERALD_EFFORT=high npx tsx harness/picture-samples.mts <out dir> <job ...>
// Jobs, over the host's last twelve turns as one age: letter:<civ> (the advisor's letter scene), chronicle (the Chronicler's pictures for the chapter),
// era:<civ> (that people's last entry into an age), wonders (every wonder completed in the age, as the game chooses and describes them - kept, PNG and
// description, on the scratch state as the game keeps them), places (the real candidates and the real chooser, on all of the host's events; a none
// is logged with its why) and place:<City> (that city as the only candidate). Place pictures are painted last, with their wonders' kept pictures attached.
// Each picture lands in <out dir> as a PNG; index.md there gets its writer, the age line its writer was given, its caption and the prompt as painted.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, ...jobs] = process.argv.slice(2);
if (!out || !jobs.length || !process.env.RULER_HOST_URL || !process.env.RULER_STATE_FILE) throw new Error("Usage: RULER_HOST_URL=<scratch host> RULER_STATE_FILE=<scratch> picture-samples.mts <out dir> <job ...>");
if (/:8765\b/.test(process.env.RULER_HOST_URL)) throw new Error("never the live host");

const { host } = await import("../src/host.ts");
const agents = await import("../src/agents.ts");
const { generateImage, picturePrompt, onImageLog, keepWonderPicture, wonderReferences } = await import("../src/images.ts");
const { state, persist } = await import("../src/store.ts");
const say = (...args: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...args);
onImageLog(say);

const game = await host.state();
const all = await host.events();
const fromTurn = game.turn - 12;
const inAge = all.filter((event) => event.turn > fromTurn);
const round = { fromTurn, turn: game.turn, fromYear: inAge[0]?.year ?? game.year, year: game.year, publicEvents: inAge, rankings: [] } as never;

// What each writer was given about the age, read from its input as sent
const ageGiven: string[] = [];
agents.onTrace((trace) => {
  const lines = trace.prompt.split("\n");
  const at = lines.findIndex((line) => /^The people's age|^The peoples' ages/.test(line));
  const end = lines.findIndex((line, index) => index > at && !line.startsWith("- "));
  if (at >= 0) ageGiven.push(lines.slice(at, end < 0 ? lines.length : end).join("\n"));
});
const ageOfLast = () => ageGiven.at(-1) ?? "(none found)";

type Sample = { name: string; writer: string; age: string; caption: string; description: string; year: string; wonder?: string; wonders?: string[] };
const samples: Sample[] = [];
for (const job of jobs) {
  const [kind, civ] = job.split(":");
  say(`writing ${job}`);
  if (kind === "letter") {
    const seat = { civ, kind: "human", rulerName: "the ruler", chat: [], journal: [], annals: [] } as never;
    const briefing = await host.briefing(civ, fromTurn);
    const deeds = (await host.age(civ, fromTurn).catch(() => ({ lines: [] as string[] }))).lines;
    const dispatch = await agents.advisorReport(seat, round, [], briefing, undefined, deeds);
    if (dispatch.image) samples.push(agents.dated({ name: `letter-${civ}`, writer: `the advisor's letter (${civ})`, age: ageOfLast(), ...dispatch.image }, game.year));
    else say(`${civ}'s advisor chose no picture`);
  } else if (kind === "chronicle") {
    const { images } = await agents.heraldNewspaper(round, { earlier: [], lastChapters: [], proclamations: [], campaigns: [], cast: [] });
    images.forEach((image, index) => samples.push(agents.dated({ name: `chronicle-${index + 1}`, writer: "the Chronicler's chapter", age: ageOfLast(), ...image }, game.year)));
  } else if (kind === "era") {
    const entry = all.filter((event) => event.text.startsWith(`${civ} entered the `)).at(-1);
    const era = /entered the (.+?)(?: with the learning of .+?)?\.?$/.exec(entry?.text ?? "")?.[1];
    if (!entry || !era) { say(`no age entry for ${civ}`); continue; }
    const recent = all.filter((event) => event.turn <= entry.turn && event.text.startsWith(civ)).slice(-12);
    const scene = await agents.eraScene(civ, era, entry.year, recent, await host.cities(civ).catch(() => []));
    samples.push(agents.dated({ name: `era-${civ}-${era.replace(/ era$/, "")}`, writer: `the Chronicler's era entry (${civ} enter the ${era}, ${entry.year})`, age: ageOfLast(), caption: scene.caption, description: scene.description, year: scene.year }, entry.year));
  } else if (kind === "places" || kind === "place") {
    const all = await agents.placeCandidates();
    const candidates = kind === "place" ? all.filter((each) => each.name.toLowerCase() === (civ ?? "").toLowerCase()) : all;
    if (kind === "place" && !candidates.length) { say(`${civ} is no candidate (three events or more naming it, standing, not pictured as a place lately); candidates: ${all.map((each) => each.name).join(", ") || "none"}`); continue; }
    const placeRound = { ...(round as object), stoppedEarly: undefined } as never;
    const pictured = kind === "place" ? await agents.choosePlace(candidates, game.year).then((answer) => {
      const place = candidates.find((each) => each.name.toLowerCase() === (answer.place ?? "").trim().toLowerCase());
      if (!place || !answer.picture) { say(`no place picture: ${answer.why}`); return []; }
      return [{ caption: `${place.name} as the years have left it, ${game.year}. ${answer.picture.caption}`, description: answer.picture.description, year: game.year, wonders: place.wonders.filter((each) => answer.picture!.description.toLowerCase().includes(each.wonder.toLowerCase())).map((each) => each.wonder) }];
    }) : await agents.placePictures(placeRound, [], say);
    for (const picture of pictured) samples.push({ name: `place-${picture.caption.split(" as the years")[0]}`, writer: `the Chronicler's place (choosePlace, of ${candidates.map((each) => `${each.name} ${each.events.length}`).join(", ")})`, age: ageOfLast(), caption: picture.caption, description: picture.description, year: picture.year, wonders: picture.wonders });
  } else if (kind === "wonders") {
    for (const picture of await agents.wonderPictures(round, say)) {
      // Kept as the game keeps them: the description now (a place job later in this run reads it), the PNG once painted
      (state.paintedWonders ??= []).push({ wonder: picture.caption.split(",")[0], civ: /completed by (.+?) in /.exec(picture.caption)?.[1] ?? "", place: picture.place, year: picture.year, description: picture.description });
      persist();
      samples.push({ name: `wonder-${picture.caption.split(",")[0]}`, wonder: picture.caption.split(",")[0], writer: "the Chronicler's wonder (chooseWonder)", age: ageGiven.find((line) => line.startsWith(`The people's age: ${/completed by (.+?) in /.exec(picture.caption)?.[1]},`)) ?? "(none found)", year: picture.year, caption: picture.caption, description: picture.description });
    }
  } else throw new Error(`no such job: ${job}`);
}

mkdirSync(out, { recursive: true });
const index = join(out, "index.md");
if (!existsSync(index)) writeFileSync(index, `# Picture samples (picture guide, 2026-11-02)\n\nWritten by the game's own writers (Claude) and painted through the game's own prompt (picturePrompt) with ${process.env.IMAGE_PROVIDER ?? "the default provider"}, on throwaway copies of fixtures.\n\n`);
appendFileSync(index, `## ${game.year} (turn ${game.turn}), from the host at ${process.env.RULER_HOST_URL}\n\n`);
// At most three at a time: images.ts holds the rest in its queue. Place pictures last, once this run's wonders are kept
const paint = async (sample: Sample) => {
  const file = `${sample.name.replace(/[^A-Za-z0-9-]+/g, "-")}.png`;
  const attached = sample.wonders ? wonderReferences(sample.wonders) : { shown: [], references: [] };
  const prompt = picturePrompt(sample, attached.shown);
  const png = await generateImage(prompt, attached.references).catch((error) => { say(`${sample.name} failed:`, error.message); return null; });
  if (png) writeFileSync(join(out, file), png);
  if (png && sample.wonder) keepWonderPicture(sample.wonder, png);
  if (sample.wonders) sample.writer += `; references: ${attached.references.map((each, at) => `${attached.shown[at]} (${each.name})`).join(", ") || "none kept"}${sample.wonders.length > attached.shown.length ? `; named only: ${sample.wonders.filter((each) => !attached.shown.includes(each)).join(", ")}` : ""}`;
  say(`${sample.name}: ${png ? file : "not painted"}`);
  appendFileSync(index, `### ${sample.name}\n\n${png ? `![${sample.name}](${file})` : "(not painted)"}\n\n- Writer: ${sample.writer}\n- Caption: ${sample.caption}\n- The age line the writer was given:\n\n\`\`\`\n${sample.age}\n\`\`\`\n\nThe prompt as painted:\n\n\`\`\`\n${prompt}\n\`\`\`\n\n`);
};
await Promise.all(samples.filter((sample) => !sample.wonders).map(paint));
await Promise.all(samples.filter((sample) => sample.wonders).map(paint));
say("samples in", out);
