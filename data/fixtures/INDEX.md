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
| run32-t168-siam | 168 | Run 32 at T168: Siam at war on Germany, posture attack on Hamburg across the sea, its host strung out at sea off Lampang since T156; the landings recursed to a StackOverflowError at T169 |
| run32-t189-osaka | 189 | Run 32 at T189: England at war with Japan, its host at sea off Osaka with no shore out of reach (the court had just set defend: W33 sets attack on Osaka); a Japanese Frigate off York |
| run32-t216-peace | 216 | Run 32 at T216: Japan's offer of peace with 150 gold waits on England's desk, sent with the trade order (want: Peace Treaty) and so one-sided; England's peace order accepted it and stayed at war |
| run32-t259-munich | 259 | Run 32 at T259: England's fleet at war off Munich, Berlin and Hamburg; on the build before the shore rule it lost five ships to the shore's guns in ten turns |
| run36-t310 | 310 | Run 36 at T310, twelve courts late on a large map: Egypt wins the Scientific victory advancing to T311; Apollo Programs standing, ship parts building, many deals in force with renewals ordered; Siam, Greece and Persia unhappy |
| run36-t300 | 300 | Run 36 at T300, twelve courts late on a large map: many deals in force and renewals due, the officials' proposals refused by other courts; Austria, India and Egypt with Apollo and Hydro Plants |
