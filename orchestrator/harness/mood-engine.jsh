// The mood block's truth (regress W60): the engine itself, on in-memory copies of a save (never saved), for one civ - the mood now, after one and two
// cities founded at pop 1 (civ.addCity), and for each named foreign city after CityConquestFunctions.puppetCity and then annexCity.
// Run from unciv/android/assets:  SAVE=<save.unciv> CIV=<name> CITIES=<a,b,c> jshell --class-path <classpath> mood-engine.jsh
com.unciv.utils.Log.INSTANCE.setBackend(new com.unciv.app.desktop.DesktopLogBackend());
var game = new com.unciv.UncivGame(true);
com.unciv.UncivGame.Companion.setCurrent(game);
game.setSettings(new com.unciv.models.metadata.GameSettings());
com.unciv.models.ruleset.RulesetCache.INSTANCE.loadRulesets(true, false);
String text = java.nio.file.Files.readString(java.nio.file.Path.of(System.getenv("SAVE")));
String civName = System.getenv("CIV");
com.unciv.logic.civilization.Civilization load() {
  var info = com.unciv.logic.files.UncivFiles.Companion.gameInfoFromString(text);
  game.setGameInfo(info);
  return info.getCivilization(civName);
}
int mood(com.unciv.logic.civilization.Civilization c) { c.updateStatsForNextTurn(); return c.getHappiness(); }

var civ = load();
System.out.println("now " + mood(civ));
// Two plain sites far from every city, the nearest to our capital first
var capital = civ.getCapital(true).getCenterTile();
var centres = new java.util.ArrayList<com.unciv.logic.map.tile.Tile>();
for (var other : civ.getGameInfo().getCivilizations()) for (var c : other.getCities()) centres.add(c.getCenterTile());
// A plain site: what its own tiles bring (a luxury or a natural wonder within two tiles) is the site's, not the cost of a city the host reckons
boolean free(com.unciv.logic.map.tile.Tile tile) {
  for (var centre : centres) if (centre.aerialDistanceTo(tile) <= 4) return false;
  for (var near : kotlin.sequences.SequencesKt.toList(tile.getTilesInDistance(2)))
    if (near.getNaturalWonder() != null || (near.getResource() != null && near.getTileResource().getResourceType() == com.unciv.models.ruleset.tile.ResourceType.Luxury)) return false;
  return true;
}
var sites = new java.util.ArrayList<com.unciv.logic.map.tile.Tile>();
for (var tile : civ.getGameInfo().getTileMap().getTileList())
  if (tile.isLand() && !tile.isImpassible() && tile.getOwner() == null && free(tile)) sites.add(tile);
sites.sort(java.util.Comparator.comparingInt(t -> t.aerialDistanceTo(capital)));
var a = civ.addCity(sites.get(0).getPosition(), null);
System.out.println("one " + mood(civ) + " pop " + a.getPopulation().getPopulation());
com.unciv.logic.map.tile.Tile second = null;
for (var tile : sites) if (tile.aerialDistanceTo(sites.get(0)) >= 3) { second = tile; break; }
civ.addCity(second.getPosition(), null);
System.out.println("two " + mood(civ));

for (var target : System.getenv("CITIES").split(",")) {
  civ = load();
  com.unciv.logic.city.City city = null;
  for (var other : civ.getGameInfo().getCivilizations()) for (var c : other.getCities()) if (c.getName().equals(target)) city = c;
  city.puppetCity(civ);
  int asPuppet = mood(civ);
  city.annexCity();
  System.out.println("city " + target + " puppet " + asPuppet + " annexed " + mood(civ));
}
/exit
