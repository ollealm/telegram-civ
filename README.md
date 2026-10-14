# Unciv ruler game

LLM advisors play Unciv; humans rule through Telegram and never touch the game.

- `unciv/` - clone of [yairm210/Unciv](https://github.com/yairm210/Unciv) on the `ruler` branch (not tracked here; `patches/ruler.patch` holds our changes against upstream 4.22.1, commit 57d3c66).
- `orchestrator/` - Telegram bots and the advisor/chronicler agents (TypeScript, grammY, Claude Agent SDK).
- `data/` - live game save and state (not tracked).
- `.env` - bot tokens and settings (not tracked).

Run both with `./start.sh` (needs JDK 21 at `/opt/homebrew/opt/openjdk@21`, Node 22, and a logged-in `claude` CLI).
To rebuild `unciv/` from scratch: clone upstream at the commit above and `git apply ../patches/ruler.patch`.

## Setup

1. JDK 21, Node 22, the `claude` CLI logged in (advisors and the Chronicler run on Claude through the Agent SDK); optionally the `codex` CLI logged in for pictures and GPT seats.
2. Clone Unciv into `unciv/` at the commit named above and apply `patches/ruler.patch` (or clone the `ruler` branch of the fork).
3. Copy `.env.example` to `.env` and fill in the bot tokens from @BotFather: one Chronicler bot and one advisor bot per human seat.
4. `./start.sh` builds the host, starts it on port 8765 and the Telegram bots, and restarts either if it dies.
5. Players send `/start` to their advisor bot; the ruler of the first seat runs `/newgame`.

Tests: `cd orchestrator && npx tsx harness/regress.mts` plays planted scenarios on throwaway hosts; `harness/probe-live.mts` runs one real look-in on a copy of the live game; `harness/league.mts` runs a league of sovereigns.

## Licence

The orchestrator, host scripts and harness are MIT (see LICENSE). `patches/ruler.patch` modifies and extends Unciv and is MPL-2.0, as Unciv is (patches/LICENSE-MPL-2.0).
