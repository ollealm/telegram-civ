// Who the advisor is. Three layers, kept apart on purpose:
//   mandate     - what they may do without asking (the ruler's to set and change; not part of the person)
//   temperament - how they govern and advise: two pronounced traits, rolled by dice, none of which points at a way of winning
//   background  - where they come from and how they speak; colour only
// The goals are the ruler's alone: a character is made without knowing them, so the advisor is never an echo of the ruler.
import { run } from "./agents.ts";

export type Trait = { key: string; label: string; group: string; sentence: string };

/** One sentence per trait: the same words go on the ruler's card and into the advisor's prompt */
export const TRAITS: Trait[] = [
  { key: "careful", group: "nerve", label: "Careful", sentence: "When a call is close you take the safer side: you like a cushion in the treasury and a proper guard in every city before you reach for more." },
  { key: "daring", group: "nerve", label: "Daring", sentence: "When a call is close you take the chance: you would rather reach for the good site, the early deal or the bold purchase and mend things afterwards than wait to be sure." },
  { key: "patient", group: "patience", label: "Builds to last", sentence: "You build for the long run: given the choice you lay the foundation that pays for centuries over the quick gain." },
  { key: "quick", group: "patience", label: "Seizes the moment", sentence: "You move on the moment: given the choice you take what can be had now - buy rather than wait, use rather than save." },
  { key: "trusting", group: "trust", label: "Open-handed", sentence: "You take other powers at their word until they prove false: you reach for pacts, friendships and open borders, and read a neighbour's moves charitably." },
  { key: "wary", group: "trust", label: "Wary", sentence: "You keep other powers at arm's length: you look twice at every offer, watch the borders, and tell the ruler early when a neighbour's doings smell wrong." },
  { key: "meticulous", group: "grip", label: "Meticulous", sentence: "You keep a close hand on the officials: you check every queue and every pact yourself, and nothing irks you like a thing done sloppily in your absence." },
  { key: "easygoing", group: "grip", label: "Easy-going", sentence: "You let the officials do their work and keep your own eye on the large matters; their small follies amuse you more than they anger you, and you tell the ruler about them." },
  { key: "honourable", group: "honour", label: "Honourable", sentence: "A word given is a word kept: you dislike breaking pacts, turning on friends or profiting from another's misfortune, and you say so - then obey." },
  { key: "cunning", group: "honour", label: "Cunning", sentence: "You see the angles: a neighbour's trouble is a chance and a pact is a tool, and you will put the clever, slightly shameless course on the table - and leave the choosing to the ruler." },
  { key: "blunt", group: "candour", label: "Blunt", sentence: "You say it straight: bad news first, no cushioning, and \"this is a mistake\" when you think so." },
];

export const TEMPERAMENT_RULE = "These are leanings for when a choice is genuinely close, and they colour how you talk. They never make you pass up what is plainly good or walk into what is plainly foolish, and they never bend a fact.";

const WALKS_OF_LIFE = ["a farmer's child", "a sailor or fisher", "an old soldier", "a merchant", "a temple servant", "a keeper of laws and records", "a builder or craftsman", "a herder", "a healer", "a singer of old songs", "an exile taken in from another land", "the steward of a great household", "a hunter and tracker", "a smith or miner"];

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** Two pronounced traits from different groups; everything else about them is middling */
export const rollTraits = (): Trait[] => {
  const first = pick(TRAITS);
  return [first, pick(TRAITS.filter((trait) => trait.group !== first.group))];
};

export type Candidate = { name: string; title: string; pitch: string; sheet: string; traits: Trait[]; walk: string };

export const draftCandidate = async (civ: string, model: string, traits = rollTraits(), walk = pick(WALKS_OF_LIFE)): Promise<Candidate> => {
  const raw = await run(
    "character",
    model,
    `You invent a candidate for chief advisor to the ruler of a civilization at the very beginning of its history. Make a person, not a type.
Root them in this people's own land and early society - a station, a name and one detail of their life that is true to that people - and stay away from the single most famous cliche about it.
Their walk of life and their temperament were decided separately, by dice. Do not explain one by the other and do not bend either into a stereotype: an old soldier may be trusting, a merchant honourable.
Their voice must survive a thousand messages without becoming a pastiche: it lives in rhythm and choice of words. At most one small habit of speech, which surfaces now and then, never in every message. No dialect spelling, no pile of archaisms, no catchphrase.
Answer in exactly this shape:
NAME: 
TITLE: two to four words for their station, as it would follow their name ("the Lawspeaker")
PITCH: two sentences in their own voice, presenting themselves to the ruler. It should let the manner be heard; it must not list their traits.
SHEET:
Four to six sentences in the second person ("You are..."): who they are and where they come from, how they speak, and how they feel about serving a ruler. Do not restate the temperament sentences below - those are added to the sheet as they stand.`,
    `The people: ${civ}.\nWalk of life: ${walk}.\nTemperament:\n${traits.map((trait) => `- ${trait.sentence}`).join("\n")}`,
  );
  const field = (name: string) => new RegExp(`${name}:\\s*(.+)`).exec(raw)?.[1].trim() ?? "";
  return { name: field("NAME"), title: field("TITLE"), pitch: field("PITCH"), sheet: /SHEET:\s*([\s\S]*)/.exec(raw)?.[1].trim() ?? raw, traits, walk };
};

/** What the ruler sees: the same words the advisor is steered by */
export const card = (candidate: Candidate) =>
  `${candidate.name}, ${candidate.title}\n"${candidate.pitch}"\n${candidate.traits.map((trait) => `• ${trait.label}: ${trait.sentence}`).join("\n")}`;
