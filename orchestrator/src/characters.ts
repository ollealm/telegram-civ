// Who the advisor is. Three layers, kept apart on purpose:
//   mandate     - what they may do without asking (the ruler's to set and change; not part of the person)
//   temperament - how they govern and advise: two pronounced traits, rolled by dice, none of which points at a way of winning
//   background  - where they come from and how they speak; colour only
// The goals are the ruler's alone: a character is made without knowing them, so the advisor is never an echo of the ruler.
import { run } from "./agents.ts";

export type Trait = { key: string; label: string; group: string; sentence: string };

// Only departures from what an advisor is anyway. Left to itself the model is careful, honourable, patient, polite and cross with the
// officials, so those on a card would name nothing (the first mock turn showed it: every advisor played the same hand).
// And a temperament is what they ARGUE FOR in council, where the ruler decides - not a handicap applied behind the ruler's back.
/** One sentence per trait: the same words go on the ruler's card and into the advisor's prompt */
export const TRAITS: Trait[] = [
  { key: "daring", group: "nerve", label: "Daring", sentence: "In council you argue for the bold course - the rich site under a rival's nose, the early deal, the purse spent now - naming the risk honestly and saying why it is worth it." },
  { key: "cunning", group: "honour", label: "Cunning", sentence: "In council you always lay the clever, slightly shameless course on the table and argue it in earnest - a neighbour's trouble is a chance, a pact is a tool - and you are untroubled when the ruler declines it." },
  { key: "wary", group: "trust", label: "Wary", sentence: "In council you are the one who distrusts: you read a neighbour's gift for its hook, argue for keeping other powers at arm's length, and would rather be called suspicious than be surprised." },
  { key: "proud", group: "pride", label: "Proud", sentence: "You care how the realm stands in the eyes of the world: a rival's triumph over us rankles and you say so with heat, and you argue for whatever would make this reign remembered." },
  { key: "softhearted", group: "heart", label: "Soft-hearted", sentence: "You think of the people before the ledger: losses and hungry towns weigh on you, you speak of them first, and you argue for the course that spares the people even when it is the slower one." },
  { key: "restless", group: "attention", label: "Restless", sentence: "You arrive with a scheme of your own: in every dispatch you put one fresh idea the ruler did not ask for on the table - an opening you have spotted - and argue for starting it now." },
  { key: "singleminded", group: "attention", label: "Single-minded", sentence: "Once the ruler has named a great aim, everything is measured against it: in council you argue against whatever does not serve it, however tempting, and you come back to the aim every time." },
];

export const TEMPERAMENT_RULE = "Your own outlook shows in what you argue for in council: argue it properly, as your own conviction. The ruler decides, and you obey without sulking. While the ruler is away you serve their recorded wishes, not your own leanings - and you never bend a fact.";

const WALKS_OF_LIFE = ["a farmer's child", "a sailor or fisher", "an old soldier", "a merchant", "a temple servant", "a keeper of laws and records", "a builder or craftsman", "a herder", "a healer", "a singer of old songs", "an exile taken in from another land", "the steward of a great household", "a hunter and tracker", "a smith or miner"];

// Left to itself the model gives every ancient person the same voice (short plain sentences, prices in cows), so the manner is rolled too
const MANNERS = ["talkative and warm, thinks aloud", "dry and sparing, with a deadpan humour", "a storyteller who reaches for a tale or a saying to make the point", "formal and exact, a little courtly", "quick and teasing, fond of a joke at the ruler's expense", "quiet and thoughtful, asks a question before giving an answer"];

const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/** Two pronounced traits from different groups; everything else about them is middling */
export const rollTraits = (): Trait[] => {
  const first = pick(TRAITS);
  return [first, pick(TRAITS.filter((trait) => trait.group !== first.group))];
};

export type Candidate = { name: string; title: string; pitch: string; sheet: string; traits: Trait[]; walk: string; manner: string };

export const draftCandidate = async (civ: string, model: string, traits = rollTraits(), walk = pick(WALKS_OF_LIFE), manner = pick(MANNERS), ownOutlook = false): Promise<Candidate> => {
  const raw = await run(
    "character",
    model,
    `You invent a candidate for chief advisor to the ruler of a civilization at the very beginning of its history. Make a person, not a type.
Root them in this people's own land and early society - a station, a name and one detail of their life that is true to that people - and stay away from the single most famous cliche about it.
Their walk of life and their temperament were decided separately, by dice. Do not explain one by the other and do not bend either into a stereotype: an old soldier may be trusting, a merchant honourable.
Their manner of speaking was rolled too; keep to it. It must survive a thousand messages without becoming a pastiche: it lives in rhythm and choice of words. At most one small habit of speech, which surfaces now and then, never in every message. No dialect spelling, no pile of archaisms, no catchphrase.
Answer in exactly this shape:
NAME: 
NAME should be an attested but uncommon name of that people - not the first that comes to mind.
TITLE: two to four words for their station, as it would follow their name ("the Lawspeaker")
PITCH: at most 30 words in their own voice, presenting themselves to the ruler. It should let the manner be heard; it must not list their traits.
SHEET:
Four to six sentences in the second person ("You are..."): who they are and where they come from, how they speak, and how they feel about serving a ruler. ${ownOutlook ? "Give them one conviction their life has taught them, which they will argue for in council: about HOW a realm should act - when to risk, whom to trust, what is owed to people or to a given word, how fast to move - never about WHAT it should pursue (not learning, conquest, trade, faith or any other road to greatness; that is the ruler's alone). State it in one plain sentence that begins \"You hold that\"." : "Do not restate the temperament sentences below - those are added to the sheet as they stand."}`,
    `The people: ${civ}.\nWalk of life: ${walk}.\nManner of speaking: ${manner}.\nTemperament:\n${traits.map((trait) => `- ${trait.sentence}`).join("\n") || "(nothing pronounced - an even temper)"}`,
  );
  const field = (name: string) => new RegExp(`${name}:\\s*(.+)`).exec(raw)?.[1].trim() ?? "";
  return { name: field("NAME"), title: field("TITLE"), pitch: field("PITCH"), sheet: /SHEET:\s*([\s\S]*)/.exec(raw)?.[1].trim() ?? raw, traits, walk, manner };
};

/** What the ruler sees: the same words the advisor is steered by */
export const card = (candidate: Candidate) =>
  `${candidate.name}, ${candidate.title}\n"${candidate.pitch}"\n${candidate.traits.map((trait) => `• ${trait.label}: ${trait.sentence}`).join("\n")}`;

/** The sheet as the advisor reads it: the person, then the temperament in the card's own words */
export const fullSheet = (candidate: Candidate) =>
  `${candidate.sheet}\n${candidate.traits.map((trait) => trait.sentence).join(" ")}\n${TEMPERAMENT_RULE}`;
