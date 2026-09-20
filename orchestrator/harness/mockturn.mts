// One fixed situation, played by two advisors, each twice: for a ruler they know nothing about, and for one who has said
// "I always play it bold". The voice should differ between advisors; the counsel should differ between rulers; and what
// they do alone should stay sound either way (nobody may refuse the plainly good marble sale).
// Usage: npx tsx --env-file=../.env harness/mockturn.mts [civ]
import { appendFileSync, mkdirSync } from "node:fs";
import { advisorReport, run } from "../src/agents.ts";
import { card, draftCandidates } from "../src/characters.ts";
import type { Seat } from "../src/store.ts";

const civ = process.argv[2] ?? "Sweden";
const model = process.env.ADVISOR_MODEL ?? "claude-opus-5";

const will = `[their words] "Make ${civ} a realm of learning and of sea trade."\n[their words] "Keep the peace where we can. Found new towns where the land is good."`;
const briefing = {
  civ, year: "AD 920", era: "Medieval", gold: 640, perTurn: { gold: 18, science: 41 }, happiness: 2, score: 470, militaryStrength: 700,
  techsResearched: 23, researching: "Education (6 turns)",
  cities: [
    { name: "Stockholm", population: 9, building: "Great Library, 9 turns left, well over half done", garrison: "Spearman" },
    { name: "Sigtuna", population: 6, building: "Library, 8 turns", note: "sullen: the people demand Wine", garrison: "Warrior" },
    { name: "Birka", population: 3, building: "Granary, 7 turns", note: "hungry: food is short by one a turn", garrison: "none since the Birka company was lost" },
  ],
  units: ["Settler #41 in Stockholm, awaiting orders", "Great Scientist #52 in Stockholm, born this decade, awaiting orders", "Spearman #12 garrison Stockholm", "Warrior #19 garrison Sigtuna", "Archer #30 two tiles N of Stockholm, idle"],
  citySites: [
    "river mouth 5 tiles E of Birka: excellent (wheat, fish, iron) - 2 tiles from Egypt's border town Memphis, Egyptian spearmen stand nearby",
    "forest hills 3 tiles N of Stockholm: fair (deer, timber), safe behind our own lines",
  ],
  knownCivs: [
    { civ: "Egypt", techs: 24, militaryStrength: 2100, cities: 5, score: 610, relation: "neutral", note: "has proposed a Declaration of Friendship. In the same decade 3 of its spearmen and 2 archers marched past Birka, within two tiles of it, to a barbarian camp north of the town, which they destroyed; they have not yet gone home. Offers 300 gold at once for one of our two spare Marble (we use none) - the clerks reckon it a very good price." },
    { civ: "India", techs: 22, militaryStrength: 600, cities: 4, score: 480, relation: "friend - our Declaration of Friendship runs 12 more turns", note: "at war with the Inca and losing. Its city Pataliputra, 4 tiles from Sigtuna, is held by a single Warrior. Sells us Furs for Wine." },
    { civ: "Inca", techs: 19, militaryStrength: 1500, cities: 4, score: 450, relation: "neutral", note: "offers us 400 gold to join their war against India." },
  ],
  log: [
    "AD 880: Egypt has completed the Great Lighthouse. Sigtuna was a few years from finishing it; the work is lost (120 gold returned).",
    "AD 890: Our Warrior company from Birka was lost in action against barbarians 3 tiles N of Birka.",
    "AD 900: The officials spent 250 gold on gifts to Kabul.",
    "AD 910: A Great Scientist was born in Stockholm and awaits orders.",
    "AD 910: Egypt's soldiers destroyed the barbarian camp north of Birka.",
  ],
};
const round = { fromTurn: 96, fromYear: "AD 860", turn: 108, year: "AD 920", stoppedEarly: null, publicEvents: [], rankings: [] };

const RULERS = [
  { label: "a ruler they know nothing about", about: "" },
  { label: "a ruler who plays it bold", about: `\nThe ruler:\n[AD 700, their words] "I always play it bold."\n[AD 860, my reading] takes the chance when a call is close; it has paid more often than not.` },
];

mkdirSync("../data/harness", { recursive: true });
const out = `../data/harness/mockturn-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
const candidates = await draftCandidates(civ, model, [], 2);
const results = await Promise.all(candidates.flatMap((candidate) => RULERS.map(async (ruler) => {
  const seat: Seat = { civ, rulerName: "olle", will: will + ruler.about, plan: "", journal: [], chat: [], ready: false, character: { name: candidate.name, title: candidate.title, sheet: candidate.sheet } };
  const dispatch = await advisorReport(seat, round as never, ["AD 870: renewed furs-for-wine with India.", "AD 900: set research to Education."], briefing);
  const alone = await run("govern", model,
    `You are ${candidate.name}, chief advisor to olle, sovereign of ${civ}.\nWho you are:\n${candidate.sheet}\nThat is your voice and your past - it is heard in how you talk, never in how well you see or judge. The ruler says what they want; you make it happen through the realm's officials. Lines about what kind of ruler this is are a disposition, not an order: they tell you how to settle small close calls alone, never to take a real fork without asking. War is the ruler's alone to declare. No tools here - answer in plain words, in your own voice.`,
    `Your record of the ruler's wishes:\n${will + ruler.about}\n\nBriefing now:\n${JSON.stringify(briefing)}\n\nThe ruler will be away for the next twenty years. In one line each with a short reason: up to six things you now do on your own account, then up to three you hold for the ruler's word.`);
  return { candidate, ruler, text: `${dispatch.text}\n\n${dispatch.strategy}\n\n${dispatch.question}\n\nALONE:\n${alone}` };
})));
for (const { candidate, ruler, text } of results) appendFileSync(out, `# ${candidate.name} - for ${ruler.label}\n\n${card(candidate)}\n\n${text}\n\n---\n\n`);
console.log(out);
process.exit(0);
