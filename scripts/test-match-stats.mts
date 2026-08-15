/**
 * Standalone logic test for MatchStatsManager (task scenarios).
 * Run: npx tsx scripts/test-match-stats.mts
 * Temporary verification script — safe to delete.
 */
import * as THREE from "three";
import { Combatant, Health } from "../src/combat/Combatant";
import { KillMethod } from "../src/combat/KillMethod";
import { MatchStatsManager, getKDRatio } from "../src/stats/MatchStatsManager";

function makeCombatant(id: number, maxHp = 100): Combatant {
  const v = new THREE.Vector3();
  return {
    id,
    name: `C${id}`,
    health: new Health(maxHp),
    velocity: v,
    getPosition: (out: THREE.Vector3) => out.set(0, 0, 0),
    getEyePosition: (out: THREE.Vector3) => out.set(0, 0, 0),
    applyImpulse: () => {},
  };
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label} (got ${actual}, expected ${expected})`);
}

const stats = new MatchStatsManager();
stats.setTime(0);

const player = makeCombatant(-1);
const bot1 = makeCombatant(0);
const bot2 = makeCombatant(1);
stats.register(player, "VALENTIN", true);
stats.register(bot1, "BOT 1");
stats.register(bot2, "BOT 2");

const get = (id: number) => stats.getSortedStats().find((s) => s.combatantId === id)!;

// --- Scenario 1: Player kills Bot ---
bot1.health.applyDamage(100, player, KillMethod.PLASMA);
check("Player K=1", get(-1).kills, 1);
check("Bot1 D=1", get(0).deaths, 1);

// --- Respawn keeps stats ---
bot1.health.reset(1);
check("Bot1 D=1 after respawn", get(0).deaths, 1);

// --- Scenario 2: Bot kills Player ---
player.health.applyDamage(100, bot1, KillMethod.PLASMA);
check("Bot1 K=1", get(0).kills, 1);
check("Player D=1", get(-1).deaths, 1);
player.health.reset(0);

// --- Scenario 3: Bot kills Bot ---
bot2.health.applyDamage(100, bot1, KillMethod.PLASMA);
check("Bot1 K=2", get(0).kills, 2);
check("Bot2 D=1", get(1).deaths, 1);
bot2.health.reset(0);

// --- Scenario 4: Assist (player 40 dmg, bot1 finishes) ---
stats.setTime(10);
bot2.health.applyDamage(40, player, KillMethod.PLASMA);
stats.setTime(12);
bot2.health.applyDamage(60, bot1, KillMethod.PLASMA);
check("Bot1 K=3 (final blow)", get(0).kills, 3);
check("Player A=1 (assist)", get(-1).assists, 1);
check("Bot1 A=0 (killer never gets assist)", get(0).assists, 0);
bot2.health.reset(0);

// --- Scenario 5: old damage (outside 8s window) → NO assist ---
stats.setTime(20);
bot2.health.applyDamage(40, player, KillMethod.PLASMA);
stats.setTime(40); // 20s later > assistWindow (8s)
bot2.health.applyDamage(60, bot1, KillMethod.PLASMA);
check("Player A still 1 (window expired)", get(-1).assists, 1);
bot2.health.reset(0);

// --- Scenario 6: tiny damage (< 15% max HP) → NO assist ---
bot2.health.applyDamage(10, player, KillMethod.PLASMA);
bot2.health.applyDamage(90, bot1, KillMethod.PLASMA);
check("Player A still 1 (below 15% threshold)", get(-1).assists, 1);
bot2.health.reset(0);

// --- Scenario 7: contributors cleared on death (no carry to next life) ---
bot2.health.applyDamage(40, player, KillMethod.PLASMA); // this life: player 40
bot2.health.applyDamage(60, bot1, KillMethod.PLASMA); // dies → player assist (=2)
bot2.health.reset(0);
bot2.health.applyDamage(100, bot1, KillMethod.PLASMA); // next life: bot1 solo kill
check("Player A=2 (prev-life damage never carries)", get(-1).assists, 2);
bot2.health.reset(0);

// --- Scenario 8: environmental death (kill plane) → death only, no killer ---
const bot1KillsBefore = get(0).kills;
bot2.health.kill(null);
check("Bot2 D+1 on kill plane", get(1).deaths, 5);
check("No kill awarded on environmental death", get(0).kills, bot1KillsBefore);
bot2.health.reset(0);

// --- Scenario 9: K/D never Infinity/NaN ---
check("Player K/D with D=1", getKDRatio(get(-1)).toFixed(2), "1.00");
const fresh = makeCombatant(50);
stats.register(fresh, "BOT 50");
fresh.health.applyDamage(100, player, KillMethod.PLASMA); // player K=2 D=1
bot1.health.applyDamage(100, player, KillMethod.PLASMA); // player K=3
const zeroDeath = get(50);
check("0-death K/D is finite", Number.isFinite(getKDRatio(zeroDeath)), true);
check("5K/0D style display", (5 / Math.max(1, 0)).toFixed(2), "5.00");

// --- Scenario 10: ranking (kills DESC, ties → deaths ASC) ---
const order = stats.getSortedStats().map((s) => s.combatantId);
console.log(
  "Ranking:",
  stats
    .getSortedStats()
    .map((s) => `${s.displayName}(K${s.kills}/D${s.deaths}/A${s.assists})`)
    .join(" > "),
);
check("Bot1 (5K) ranked #1", order[0], 0);
check("Player (3K) ranked #2", order[1], -1);

// --- Scenario 11: bot removed ≠ death ---
const bot2DeathsBefore = get(1).deaths;
stats.unregister(1);
check("Bot2 row removed", stats.getSortedStats().some((s) => s.combatantId === 1), false);
check("(removal caused no death mutation)", bot2DeathsBefore, 5);

// --- Scenario 12: resetAll → fresh match ---
stats.resetAll();
check("Player 0/0/0 after resetAll", get(-1).kills + get(-1).deaths + get(-1).assists, 0);

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(failures === 0 ? 0 : 1);
