// Sample pictures through the game's own writers (Claude) and painter, for a look before a change to the picture prompts goes live (picture guide, 2026-11-02).
// Needs its own host on a COPY of a fixture (never the live one):  ../host.sh /tmp/pics 8768
// Run:  RULER_HOST_URL=http://127.0.0.1:8768 RULER_STATE_FILE=/tmp/pics/state.json IMAGE_PROVIDER=codex ADVISOR_MODEL=claude-opus-5-5 LETTER_EFFORT=high \
//       HERALD_MODEL=claude-opus-5-5 HERALD_EFFORT=high npx tsx harness/picture-samples.mts <out dir> <job ...>
// Jobs, over the host's last twelve turns as one age: letter:<civ> (the advisor's letter scene), chronicle (the Chronicler's pictures for the chapter),
// era:<civ> (that people's last entry into an age), wonders (every wonder completed in the age, as the game chooses and describes them).
// Each picture lands in <out dir> as a PNG; index.md there gets its writer, the age line its writer was given, its caption and the prompt as painted.

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, ...jobs] = process.argv.slice(2);
if (!out || !jobs.length || !process.env.RULER_HOST_URL || !process.env.RULER_STATE_FILE) throw new Error("Usage: RULER_HOST_URL=<scratch host> RULER_STATE_FILE=<scratch> picture-samples.mts <out dir> <job ...>");
if (/:8765\b/.test(process.env.RULER_HOST_URL)) throw new Error("never the live host");

const { host } = await import("../src/host.ts");
const agents = await import("../src/agents.ts");
const { generateImage, picturePrompt, onImageLog } = await import("../src/images.ts");
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

type Sample = { name: string; writer: string; age: string; caption: string; description: string; year: string };
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
  } else if (kind === "wonders") {
    for (const picture of await agents.wonderPictures(round, say))
      samples.push({ name: `wonder-${picture.caption.split(",")[0]}`, writer: "the Chronicler's wonder (chooseWonder)", age: ageGiven.find((line) => line.startsWith(`The people's age: ${/completed by (.+?) in /.exec(picture.caption)?.[1]},`)) ?? "(none found)", year: picture.year, caption: picture.caption, description: picture.description });
  } else throw new Error(`no such job: ${job}`);
}

mkdirSync(out, { recursive: true });
const index = join(out, "index.md");
if (!existsSync(index)) writeFileSync(index, `# Picture samples (picture guide, 2026-11-02)\n\nWritten by the game's own writers (Claude) and painted through the game's own prompt (picturePrompt) with ${process.env.IMAGE_PROVIDER ?? "the default provider"}, on throwaway copies of fixtures.\n\n`);
appendFileSync(index, `## ${game.year} (turn ${game.turn}), from the host at ${process.env.RULER_HOST_URL}\n\n`);
// At most three at a time: images.ts holds the rest in its queue
await Promise.all(samples.map(async (sample) => {
  const file = `${sample.name.replace(/[^A-Za-z0-9-]+/g, "-")}.png`;
  const prompt = picturePrompt(sample);
  const png = await generateImage(prompt).catch((error) => { say(`${sample.name} failed:`, error.message); return null; });
  if (png) writeFileSync(join(out, file), png);
  say(`${sample.name}: ${png ? file : "not painted"}`);
  appendFileSync(index, `### ${sample.name}\n\n${png ? `![${sample.name}](${file})` : "(not painted)"}\n\n- Writer: ${sample.writer}\n- Caption: ${sample.caption}\n- The age line the writer was given:\n\n\`\`\`\n${sample.age}\n\`\`\`\n\nThe prompt as painted:\n\n\`\`\`\n${prompt}\n\`\`\`\n\n`);
}));
say("samples in", out);
