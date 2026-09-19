# Unciv ruler game

LLM advisors play Unciv; humans rule through Telegram and never touch the game.

- `unciv/` - clone of [yairm210/Unciv](https://github.com/yairm210/Unciv) on the `ruler` branch (not tracked here; `patches/ruler.patch` holds our changes against upstream 4.22.1, commit 57d3c66).
- `orchestrator/` - Telegram bots and the advisor/chronicler agents (TypeScript, grammY, Claude Agent SDK).
- `data/` - live game save and state (not tracked).
- `.env` - bot tokens and settings (not tracked).

Run both with `./start.sh` (needs JDK 21 at `/opt/homebrew/opt/openjdk@21`, Node 22, and a logged-in `claude` CLI).
To rebuild `unciv/` from scratch: clone upstream at the commit above and `git apply ../patches/ruler.patch`.
