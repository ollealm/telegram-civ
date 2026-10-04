# Fixtures: saved worlds the fixes were proven on

Each is save.unciv + host.json (chancery trimmed to its last 12 turns). Run one by hand on a copy: `cp -R data/fixtures/<name> /tmp/x && ./host.sh /tmp/x 8769`; the regression cases are in orchestrator/harness/regress.mts (`npx tsx harness/regress.mts [case...]`).

| Fixture | Turn | What it reproduces |
|---|---|---|
| run20-t123-spain-swordsman | 123 | Run 20 crash: Spain's Swordsman under a garrison order, drafted as escort, sent to a tile it could not enter (fixed 67d802b) |
| run20-t187-france-cannon | 187 | Run 20 crash: France's Cannon pulled back toward a puppet held by its own Rifleman (fixed 2a92b43) |
| run22-t234-greece | 234 | Greece declares on Inca with war aim Cuzco: the garrison in Sparta stays; deals swept; allies join (audit #3, #4, #6, #7); Greece 5 of 6 parts |
| run23-t236-persia | 236 | Persia declares on England: Polynesia drawn in by its pact, city-states join, the RA lost (audit #6, #7, folded joins) |
| run23-t241-persia | 241 | Persia and Polynesia ruled, Iroquois fallen: faith reserve, free tech to the goal, protect orders, missionary refusal, embassies (audit #8, #11-#14, #19) |
| run23-t245-won | 245 | Persia has won by science; the Iroquois are no more (410 for a fallen realm, 409 game over) |
| run21-t294-austria | 294 | Austria can marry Manila; Japan's renewal held from the near-winner Aztecs (marry order, renewal hold, culture facts) |
| run21-t300-war | 300 | Aztecs at war with Japan, Arabia and Songhai: the war estimate lists enemies first; strikes logged |
| run19-t230-un | 230 | The UN stands (Egypt), the vote due next turn: one countdown for all, pledged votes, the tally |
| run20-t279-barbarians | 279 | Run 20 late game: barbarian ships and strikes at sea, Lhasa's alliance lost at T282, the vote at T283 |
| t100-world | 100 | A fresh 6-realm Medium Pangaea world at T100, played by the officials: briefing size and the one-line sections |
| run20-t216 | 216 | Run 20 at the start of an age, with the league's state.json: the chronicle samples (harness/chronicle-samples.mts) |
| run32-t117-munich | 117 | England at war on Germany with posture attack and war aim Munich across the strait: every seaborne land unit died embarked under Munich's guns, T118-124 |
