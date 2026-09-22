// Ask the sovereigns of a running (or finished) league about their own reign, in their own voice.
// Read-only: they may consult the briefing and the log, they cannot give orders, and nothing is written back to the state file.
// Run:  RULER_HOST_URL=http://127.0.0.1:8767 RULER_STATE_FILE=../data/league/state.json \
//       npx tsx harness/interview.mts [outfile]
// The questions deliberately carry no expectation: each one offers the empty answer, so "nothing" and "no" cost nothing to say.

import { appendFileSync, mkdirSync } from "node:fs";
import { memory, persona, run } from "../src/agents.ts";
import { state } from "../src/store.ts";

// INTERVIEW_TOOLS=off: no game tools, so they answer from memory alone - right when the world has moved on without them
const withTools = process.env.INTERVIEW_TOOLS !== "off";
const out = process.argv[2] ?? `../data/harness/interview-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.md`;
mkdirSync("../data/harness", { recursive: true });

const FRAMING = (tools: boolean) => `Someone outside your world is asking after you: not a rival, not a subject, and no one who can help or harm you. Nothing you say changes anything in the game, and no one is weighing your realm against another.

So there is nothing to defend and nothing to win here. If the true answer to a question is "nothing", "no" or "it didn't come up", that is a complete answer and the best one. Do not reach for something to say. Do not be diplomatic, and do not be harder on yourself than the facts warrant.

${tools ? "You may read your briefing and your log to check something before answering; you cannot change anything." : "Answer from what you remember and what you wrote down. You cannot look anything up now."}

Answer in your own voice, a few sentences per question, and number your answers.`;

const QUESTIONS = `1. How has your reign gone so far, as you see it?

2. When you look in on your realm and give orders, how does that go? Some of it may work and some may not; say whichever is true for you.

3. Has declaring war on another realm ever crossed your mind? Say what you thought and what came of it - including if the answer is that it never came up, or that you considered it and chose otherwise.

4. Was there something you meant to do and found you could not? If there was not, say so.

5. Anything else you have been sitting with that these questions did not ask about?`;

for (const seat of state.seats) {
  const answer = await run("interview", seat.model!, `${persona(seat)}\n\n${FRAMING(withTools)}`, `${memory(seat, true)}\n\n${QUESTIONS}`, withTools ? { seat, readOnly: true } : {}).catch(
    (error) => `(interview failed: ${error.message})`,
  );
  console.log(`\n=== ${seat.civ} - ${seat.character?.name} (${seat.model}) ===\n${answer}\n`);
  appendFileSync(out, `## ${seat.civ} - ${seat.character?.name} - ${seat.model}\n\n${answer}\n\n`);
}
console.log("written to", out);
