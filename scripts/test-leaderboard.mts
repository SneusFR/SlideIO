// Leaderboard logic — pure unit test (no DOM).
// Usage (repo root):  npx --prefix backend tsx scripts/test-leaderboard.mts
import assert from "node:assert/strict";
import { PlayerMatchStats, compareMatchStats } from "../src/stats/MatchStatsManager.ts";
import {
  LB_GEOM,
  LbEntry,
  crownOwner,
  diffLeaderboard,
  layoutSlots,
  sameSnapshot,
  scoreDigitsClass,
} from "../src/ui/leaderboard/leaderboardLogic.ts";

const ME = 99;
const stat = (id: number, kills: number, deaths = 0, assists = 0): PlayerMatchStats => ({
  combatantId: id,
  displayName: id === ME ? "VALENTIN" : `BOT ${id - 10}`,
  isLocalPlayer: id === ME,
  kills,
  deaths,
  assists,
});
/** What the game does: official comparator → LbEntry list (same mapping as LeaderboardHUD.refresh). */
const board = (scores: Record<number, number>): LbEntry[] =>
  Object.entries(scores)
    .map(([id, k]) => stat(Number(id), k))
    .sort(compareMatchStats)
    .map((s) => ({ id: s.combatantId, name: s.displayName, score: s.kills, isLocal: s.isLocalPlayer }));
const ids = (l: LbEntry[]) => l.map((e) => e.id);

// Reference frame: BOT1 19, BOT3 15, BOT4 14, VOUS 13, BOT2 12.
const base = { 11: 19, 13: 15, 14: 14, [ME]: 13, 12: 12 };

// 1. The official comparator is a strict total order → ties never flip-flop.
{
  const players = [stat(11, 5, 2, 1), stat(12, 5, 2, 1), stat(13, 5, 2, 1), stat(ME, 5, 2, 1)];
  const first = [...players].sort(compareMatchStats).map((p) => p.combatantId);
  assert.deepEqual(first, [11, 12, 13, ME], "equal stats → stable id order");
  for (let i = 0; i < 20; i++) {
    const shuffled = [...players].sort(() => Math.random() - 0.5);
    assert.deepEqual(shuffled.sort(compareMatchStats).map((p) => p.combatantId), first);
  }
  assert.ok(compareMatchStats(stat(1, 3, 1), stat(2, 3, 0)) > 0, "fewer deaths wins the tie");
  assert.ok(compareMatchStats(stat(1, 3, 0, 2), stat(2, 3, 0, 1)) < 0, "more assists wins the tie");
  console.log("PASS official ranking: total order, no flip-flop");
}

// 2. A point without overtaking.
{
  const a = board({ ...base, 13: 17, 14: 16 });
  const b = board({ ...base, 13: 17, 14: 16, [ME]: 14 });
  const d = diffLeaderboard(a, b);
  assert.equal(d.kind, "none");
  assert.equal(d.scoreDeltas.get(ME), 1);
  assert.equal(d.orderChanged, false);
  assert.equal(d.reset, false);
  console.log("PASS point without overtake");
}

// 3. Tie: reaching an equal score does not move me (id decides), nothing re-orders.
{
  const a = board(base);
  const b = board({ ...base, [ME]: 14 });
  assert.deepEqual(ids(a), ids(b), "same order after the tie");
  const d = diffLeaderboard(a, b);
  assert.equal(d.kind, "none");
  assert.equal(d.orderChanged, false);
  assert.equal(d.tookLead, false);
  console.log("PASS tie keeps the official order");
}

// 4. Simple overtake, multi-place overtake, lead.
{
  const a = board(base);
  const one = diffLeaderboard(a, board({ ...base, [ME]: 15 })); // ties BOT3 (id wins) → passes BOT4 only
  assert.equal(one.kind, "gain");
  assert.equal(one.places, 1);
  assert.deepEqual(one.passed, [14]);
  assert.equal(one.tookLead, false);

  const multi = diffLeaderboard(a, board({ ...base, [ME]: 17 }));
  assert.equal(multi.places, 2);
  assert.deepEqual([...multi.passed].sort(), [13, 14]);

  const lead = diffLeaderboard(board({ ...base, [ME]: 18 }), board({ ...base, [ME]: 20 }));
  assert.equal(lead.kind, "gain");
  assert.equal(lead.tookLead, true);
  assert.equal(lead.crownFrom, 11);
  assert.equal(lead.crownTo, ME);
  console.log("PASS overtake / multi-place / lead");
}

// 5. Losing a place, losing the lead (the crown goes to the real first).
{
  const loss = diffLeaderboard(board(base), board({ ...base, 12: 13 })); // BOT2 ties me, smaller id → passes me
  assert.equal(loss.kind, "loss");
  assert.equal(loss.places, 1);
  assert.equal(loss.lostLead, false);

  const lostLead = diffLeaderboard(board({ ...base, [ME]: 20 }), board({ ...base, [ME]: 20, 11: 21 }));
  assert.equal(lostLead.kind, "loss");
  assert.equal(lostLead.lostLead, true);
  assert.equal(lostLead.crownFrom, ME);
  assert.equal(lostLead.crownTo, 11);
  console.log("PASS loss / lost lead");
}

// 6. Someone above me leaving is NOT a reward; opponents trading places is not mine.
{
  const a = board(base);
  const left = diffLeaderboard(a, board({ 13: 15, 14: 14, [ME]: 13, 12: 12 })); // BOT1 disconnects
  assert.deepEqual(left.left, [11]);
  assert.equal(left.kind, "none", "my index improved, but nobody was overtaken");
  const swap = diffLeaderboard(a, board({ ...base, 14: 16 })); // BOT4 passes BOT3 and nothing else
  assert.equal(swap.kind, "none");
  assert.equal(swap.orderChanged, true);
  console.log("PASS disconnect and opponent swaps are not rewards");
}

// 7. Joins, leaves, new match, mode switch.
{
  const a = board(base);
  const join = diffLeaderboard(a, board({ ...base, 15: 0 }));
  assert.deepEqual(join.joined, [15]);
  assert.equal(join.reset, false);
  assert.equal(diffLeaderboard(null, a).first, true);
  assert.equal(diffLeaderboard([], a).first, true);
  const reset = diffLeaderboard(a, board({ 11: 0, 13: 0, 14: 0, [ME]: 0, 12: 0 }));
  assert.equal(reset.reset, true, "scores went down → new match → rebuild, no animation");
  const mode = diffLeaderboard(a, board({ 1000: 3, 1001: 1, 1002: 0 }));
  assert.equal(mode.reset, true, "unrelated roster → rebuild");
  console.log("PASS join / leave / reset");
}

// 7b. Crown has exactly one owner and only once someone scored.
{
  assert.equal(crownOwner(board({ 11: 0, 12: 0, [ME]: 0 })), null);
  assert.equal(crownOwner(board(base)), 11);
  console.log("PASS crown owner");
}

// 8. Layout: fixed slots, local row a little taller, long scores shrink instead of moving columns.
{
  const l = board(base);
  const { tops, height } = layoutSlots(l);
  assert.equal(tops[0], 0);
  assert.equal(tops[1], LB_GEOM.ROW_H + LB_GEOM.GAP);
  const rows = l.length;
  assert.equal(height, (rows - 1) * LB_GEOM.ROW_H + LB_GEOM.LOCAL_H + (rows - 1) * LB_GEOM.GAP);
  assert.equal(scoreDigitsClass(19), "");
  assert.equal(scoreDigitsClass(1234), "d4");
  assert.equal(scoreDigitsClass(12345), "d5");
  assert.ok(sameSnapshot(l, [...l]));
  assert.ok(!sameSnapshot(l, board({ ...base, [ME]: 14 })));
  console.log("PASS layout / digits / snapshot equality");
}

console.log("\nAll leaderboard checks passed.");
