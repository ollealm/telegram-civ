// Who the advisor is: a person of the ruler's own people, with a life behind them and a way of talking. Nothing else.
// There are no traits that bend judgement (daring, wary, a blind spot, a level of initiative): those are handicaps, and the
// one advisor who had one turned the ruler's passing remarks into law. The advisor plays as well as it can and asks when a
// call is not obvious; the temperament is the ruler's, and the advisor learns it (see the record of the ruler's wishes).
// Walk of life and manner are rolled by dice, and the ruler's goals are never seen here, so the advisor is no echo of the ruler.
import { run } from "./agents.ts";

const WALKS_OF_LIFE = ["a farmer's child", "a sailor or fisher", "an old soldier", "a merchant", "a temple servant", "a keeper of laws and records", "a builder or craftsman", "a herder", "a healer", "a singer of old songs", "an exile taken in from another land", "the steward of a great household", "a hunter and tracker", "a smith or miner"];

// Left to itself the model gives every ancient person the same voice (short plain sentences, prices in cows), so the manner is rolled too
const MANNERS = ["talkative and warm, thinks aloud", "dry and sparing, with a deadpan humour", "a storyteller who reaches for a tale or a saying to make the point", "formal and exact, a little courtly", "quick and teasing, fond of a joke at the ruler's expense", "quiet and thoughtful, asks a question before giving an answer"];

const shuffled = <T>(list: T[]) => list.map((item) => [Math.random(), item] as const).sort((a, b) => a[0] - b[0]).map(([, item]) => item);

export type Candidate = { name: string; title: string; pitch: string; sheet: string; walk?: string; manner?: string; pronouns?: string };

/** sovereign: a realm with no human ruler - the same kind of person, but ruling alone, so they need an aim of their own */
export const draftCandidate = async (civ: string, model: string, walk: string, manner: string, takenNames: string[] = [], sovereign = false): Promise<Candidate> => {
  const raw = await run(
    "character",
    model,
    `You invent ${sovereign ? "the sovereign of a civilization" : "a candidate for chief advisor to the ruler of a civilization"} at the very beginning of its history. Make a person, not a type.
Root them in this people's own land and early society - a station, a name and one detail of their life that is true to that people - and stay away from the single most famous cliche about it.
Their walk of life and manner of speaking were rolled by dice; keep to both, and do not let either become a costume. The manner must survive a thousand messages without turning into a pastiche: it lives in rhythm and choice of words. At most one small habit of speech, which surfaces now and then, never in every message. No dialect spelling, no pile of archaisms, no catchphrase.
They have sound judgement and no hobby-horse: no pet strategy, no blind spot, no creed about how realms should be run. ${sovereign ? "As they rule alone, give them one ambition for their people, in a sentence - what they want this realm to become." : "What the realm should become is the ruler's to say, and they know it."}
Answer in exactly this shape:
NAME: an attested but uncommon name of that people - not the first that comes to mind${takenNames.length ? `, and none of: ${takenNames.join(", ")}` : ""}
TITLE: two to four words for their station, as it would follow their name ("the Lawspeaker")
PRONOUNS: she | he | they - decide it, and keep the sheet consistent with it
PITCH: at most 30 words in their own voice, ${sovereign ? "as they would announce themselves to the world" : "presenting themselves to the ruler"}. It should let the manner be heard.
SHEET:
Four to six sentences in the second person ("You are..."): who they are and where they come from, how they speak, and ${sovereign ? "what they want for their people" : "how they feel about serving a ruler"}.`,
    `The people: ${civ}.\nWalk of life: ${walk}.\nManner of speaking: ${manner}.`,
  );
  const field = (name: string) => new RegExp(`${name}:\\s*(.+)`).exec(raw)?.[1].trim().replace(/^"|"$/g, "") ?? "";
  return { name: field("NAME") || "your advisor", title: field("TITLE"), pronouns: /PRONOUNS:\s*(she|he|they)/i.exec(raw)?.[1].toLowerCase(), pitch: field("PITCH"), sheet: /SHEET:\s*([\s\S]*)/.exec(raw)?.[1].trim() ?? raw, walk, manner };
};

/** Three people to choose from, each of a different walk of life and manner */
export const draftCandidates = async (civ: string, model: string, takenNames: string[] = [], count = 3): Promise<Candidate[]> => {
  const walks = shuffled(WALKS_OF_LIFE);
  const manners = shuffled(MANNERS);
  const first = (candidate: Candidate) => candidate.name.split(/[ ,]/)[0];
  const candidates = await Promise.all(Array.from({ length: count }, (_, index) => draftCandidate(civ, model, walks[index], manners[index], takenNames)));
  // Drafted side by side for speed; the model is fond of a few names, so a namesake is sent back once
  for (let index = 1; index < count; index++)
    if (candidates.slice(0, index).some((other) => first(other) === first(candidates[index])))
      candidates[index] = await draftCandidate(civ, model, walks[index], manners[index], [...takenNames, ...candidates.map(first)]);
  return candidates;
};

export const draftSovereign = (civ: string, model: string) => draftCandidate(civ, model, shuffled(WALKS_OF_LIFE)[0], shuffled(MANNERS)[0], [], true);

/** The pitch lets the voice be heard; the plain line under it says outright what kind of company this will be for a whole history */
export const card = (candidate: Candidate) =>
  `${candidate.name}${candidate.title ? `, ${candidate.title}` : ""}${candidate.pronouns ? ` (${candidate.pronouns})` : ""}\n"${candidate.pitch}"${candidate.manner ? `\n${candidate.walk![0].toUpperCase()}${candidate.walk!.slice(1)} - ${candidate.manner}.` : ""}`;
