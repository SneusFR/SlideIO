/**
 * Unit test — end-of-match statistics + next-map vote (pure logic).
 * Run: npx --prefix backend tsx scripts/test-match-results.mts
 */
import { MatchResultsTracker, sanitizeMatchResults } from "../shared/match/MatchResultsTracker";
import { formatMatchClock, MATCH_DURATION_SECONDS } from "../shared/match/MatchRules";
import { MapVote } from "../backend/src/match/MapVote";
import { MapId } from "../shared/map/MapRegistry";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

console.log("MATCH RULES");
check("match lasts 5 minutes", MATCH_DURATION_SECONDS, 300);
check("clock 300 s", formatMatchClock(300), "5:00");
check("clock 59.2 s rounds up", formatMatchClock(59.2), "1:00");
check("clock 9 s", formatMatchClock(9), "0:09");
check("clock never negative", formatMatchClock(-3), "0:00");

console.log("\nACCURACY — discrete shots");
const t = new MatchResultsTracker();
t.recordShot("a");
t.recordShot("a");
t.recordShot("a");
t.recordShot("a");
t.recordHit("a", "b", "PAINTBALL_RIFLE", 1);
t.recordHit("a", "b", "PAINTBALL_RIFLE", 2);
// one shotgun blast hitting 2 players at the same instant = ONE hit
t.recordHit("a", "b", "POPCORN_SHOTGUN", 3);
t.recordHit("a", "c", "POPCORN_SHOTGUN", 3);
// melee / the hex bite are never aimed shots
t.recordHit("a", "c", "HAMMER_SWING", 4);
t.recordHit("a", "c", "HEX_SNIPER_BITE", 5);
// self / environment ignored
t.recordHit("a", "a", "PAINTBALL_RIFLE", 6);
t.recordHit(null, "a", "ENVIRONMENT", 7);


console.log("\nDAMAGE");
t.recordDamage("a", "b", 40);
t.recordDamage("a", "c", 25.4);
t.recordDamage("a", "a", 999); // self: ignored
t.recordDamage(null, "a", 50); // world: ignored

console.log("\nKILL FEED");
t.recordKill(12.34, "a", "b", ["c", "a", "b"]);
t.recordKill(30, "b", "b", []); // suicide → killer null

const res = t.build(
  [
    { id: "a", name: "A", kills: 1, deaths: 0, assists: 0 },
    { id: "b", name: "B", kills: 0, deaths: 2, assists: 0 },
  ],
  299.6,
);
const a = res.players.find((p) => p.id === "a")!;
const b = res.players.find((p) => p.id === "b")!;
check("A shots fired", a.shotsFired, 4);
check("A shots hit (2 paintball + 1 merged shotgun)", a.shotsHit, 3);
check("A damage (self / world ignored)", a.damage, 65);
check("duration rounded", res.duration, 300);
check("feed entry 1", res.killFeed[0], { t: 12.3, killer: "a", victim: "b", assisters: ["c"] });
check("suicide has no killer", res.killFeed[1].killer, null);
check("K/D/A passed through", [a.kills, b.deaths], [1, 2]);

console.log("\nNETWORK SANITIZE");
check("garbage rejected", sanitizeMatchResults({ players: "x" }), null);
const round = sanitizeMatchResults(JSON.parse(JSON.stringify(res)));
check("round trip", round?.players.length, 2);
check("round trip feed", round?.killFeed.length, 2);

console.log("\nRESET");
t.reset();
check("reset clears", t.build([{ id: "a", name: "A", kills: 0, deaths: 0, assists: 0 }], 1).players[0].shotsFired, 0);

console.log("\nMAP VOTE");
const vote = new MapVote([MapId.JUNGLE, MapId.YARD, MapId.GIVRE]);
check("invalid map refused", vote.cast("p1", "DOCKS"), false);
check("valid ballot", vote.cast("p1", MapId.YARD), true);
check("same ballot = no change", vote.cast("p1", MapId.YARD), false);
check("change ballot", vote.cast("p1", MapId.GIVRE), true);
vote.cast("p2", MapId.GIVRE);
vote.cast("p3", MapId.YARD);
check("tally", vote.tally(), { JUNGLE: [], YARD: ["p3"], GIVRE: ["p1", "p2"] });
check("leaver ballot dropped", vote.remove("p2"), true);
check("tie broken by random (low)", new MapVote([MapId.YARD, MapId.GIVRE]).close(() => 0), MapId.YARD);
// After p2 left: YARD [p3] vs GIVRE [p1] → tie, random 0.99 → last tied map.
check("tie broken by random (high)", vote.close(() => 0.99), MapId.GIVRE);
check("closed vote refuses ballots", vote.cast("p4", MapId.JUNGLE), false);
const v2 = new MapVote([MapId.JUNGLE, MapId.YARD, MapId.GIVRE]);
v2.cast("a", MapId.JUNGLE);
v2.cast("b", MapId.JUNGLE);
v2.cast("c", MapId.GIVRE);
check("majority wins", v2.close(() => 0.5), MapId.JUNGLE);

console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
