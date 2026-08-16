/**
 * PHASE 4 integration test — server-authoritative combat state.
 *
 * Requires the backend running locally (cd backend && npm run dev).
 * Run with: node scripts/test-multiplayer-phase4.mjs
 *
 * Covers: full roster visible to every client (leaderboard bug fix),
 * server-owned HP, clamped damage, death + K/D/A, assists, no double
 * death, dead players can't move or be damaged, server-driven respawn
 * (new spawn + seq bump), spawn protection, disconnect cleanup.
 */
import { Client } from "colyseus.js";

const SERVER = process.env.SERVER_URL ?? "ws://localhost:2567";
const ROOM = "game_room";

let passed = 0;
let failed = 0;
function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function playersOf(room) {
  const list = [];
  room.state.players.forEach((p, key) => list.push({ key, ...p.toJSON() }));
  return list;
}
function playerOf(room, sessionId) {
  return playersOf(room).find((p) => p.key === sessionId);
}

async function main() {
  console.log(`Phase 4 combat test → ${SERVER}\n`);

  const cA = new Client(SERVER);
  const cB = new Client(SERVER);
  const cC = new Client(SERVER);

  // ---- Join: VALENTIN (host) + PLAYER 65 + PLAYER 24 ----
  const roomA = await cA.create(ROOM, { name: "VALENTIN" });
  const roomB = await cB.joinById(roomA.roomId, { name: "PLAYER 65" });
  const roomC = await cC.joinById(roomA.roomId, { name: "PLAYER 24" });
  const [idA, idB, idC] = [roomA.sessionId, roomB.sessionId, roomC.sessionId];

  const events = { died: [], respawned: [] };
  for (const room of [roomA, roomB, roomC]) {
    room.onMessage("PLAYER_DIED", (m) => events.died.push({ via: room.sessionId, ...m }));
    room.onMessage("PLAYER_RESPAWNED", (m) => events.respawned.push({ via: room.sessionId, ...m }));
  }
  await sleep(300);

  console.log("LEADERBOARD SOURCE (bug fix)");
  for (const [label, room] of [["host", roomA], ["player65", roomB], ["player24", roomC]]) {
    const names = playersOf(room).map((p) => p.name).sort();
    check(
      `${label} sees ALL 3 players`,
      names.length === 3 && names.includes("VALENTIN") && names.includes("PLAYER 65") && names.includes("PLAYER 24"),
      JSON.stringify(names),
    );
  }
  const zeroed = playersOf(roomB).every((p) => p.kills === 0 && p.deaths === 0 && p.assists === 0);
  check("all players start at K0 D0 A0", zeroed);

  // ---- Start the match ----
  roomA.send("START_GAME");
  await sleep(300);
  check("phase = PLAYING", roomB.state.phase === "PLAYING");

  console.log("\nINITIAL COMBAT STATE");
  const all = playersOf(roomA);
  check("everyone alive at 100/100", all.every((p) => p.isAlive && p.health === 100 && p.maxHealth === 100));
  const spawnKeys = new Set(all.map((p) => `${p.x},${p.z}`));
  check("distinct spawns", spawnKeys.size === 3);

  // Spawn protection is active right after START — let it expire first.
  await sleep(1100);

  console.log("\nDAMAGE (server-owned HP)");
  roomA.send("DEBUG_DAMAGE", { targetId: idB, amount: 25 });
  await sleep(250);
  check("A sees B at 75", playerOf(roomA, idB)?.health === 75);
  check("C sees B at 75 (same data everywhere)", playerOf(roomC, idB)?.health === 75);

  // Assist setup: C contributes 30 (≥15% of 100) inside the window.
  roomC.send("DEBUG_DAMAGE", { targetId: idB, amount: 30 });
  await sleep(250);
  check("B at 45 after C's 30", playerOf(roomA, idB)?.health === 45);

  console.log("\nDEATH + K/D/A (overkill must clamp to 0)");
  roomA.send("DEBUG_DAMAGE", { targetId: idB, amount: 999 });
  await sleep(300);
  let b = playerOf(roomC, idB);
  check("B health clamped to 0", b?.health === 0, `health=${b?.health}`);
  check("B isAlive = false", b?.isAlive === false);
  check("B deaths = 1", b?.deaths === 1);
  check("A kills = 1", playerOf(roomC, idA)?.kills === 1);
  check("C assist = 1", playerOf(roomA, idC)?.assists === 1);
  check("A (killer) got NO assist", playerOf(roomC, idA)?.assists === 0);
  const deadEvents = events.died.filter((e) => e.victimId === idB);
  check(
    "PLAYER_DIED broadcast to all 3 clients (killer=A)",
    deadEvents.length === 3 && deadEvents.every((e) => e.killerId === idA && e.isHeadshot === false),
  );

  console.log("\nDEAD = UNTOUCHABLE + IMMOBILE");
  roomA.send("DEBUG_DAMAGE", { targetId: idB, amount: 50 });
  roomC.send("DEBUG_DAMAGE", { targetId: idB, amount: 50 });
  const deathPos = { x: playerOf(roomA, idB).x, z: playerOf(roomA, idB).z };
  roomB.send("PLAYER_TRANSFORM", { x: 99, y: 5, z: 99, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0, state: 0, seq: 999999 });
  await sleep(300);
  b = playerOf(roomA, idB);
  check("no double death (deaths still 1)", b?.deaths === 1, `deaths=${b?.deaths}`);
  check("PLAYER_DIED fired exactly once per client", events.died.filter((e) => e.victimId === idB).length === 3);
  check("dead player's transform refused", b.x === deathPos.x && b.z === deathPos.z);

  console.log("\nSERVER-DRIVEN RESPAWN (~3s)");
  check("respawnAt set on the victim", playerOf(roomA, idB)?.respawnAt > 0);
  await sleep(3200);
  b = playerOf(roomC, idB);
  check("B alive again", b?.isAlive === true);
  check("B back to 100 HP", b?.health === 100);
  check("respawn position ≠ death position", b.x !== deathPos.x || b.z !== deathPos.z);
  const respawnEvents = events.respawned.filter((e) => e.playerId === idB);
  check("PLAYER_RESPAWNED broadcast to all 3 clients", respawnEvents.length === 3);

  console.log("\nSPAWN PROTECTION (1s server-side)");
  roomA.send("DEBUG_DAMAGE", { targetId: idB, amount: 25 });
  await sleep(250);
  check("damage refused during protection (still 100)", playerOf(roomA, idB)?.health === 100);
  await sleep(1000);
  roomA.send("DEBUG_DAMAGE", { targetId: idB, amount: 25 });
  await sleep(250);
  check("damage applies after protection (75)", playerOf(roomA, idB)?.health === 75);

  console.log("\nSECOND KILL CYCLE (stats accumulate exactly)");
  roomA.send("DEBUG_DAMAGE", { targetId: idB, amount: 75 });
  await sleep(300);
  check("B deaths = 2", playerOf(roomC, idB)?.deaths === 2);
  check("A kills = 2", playerOf(roomC, idA)?.kills === 2);
  check("C assists STILL 1 (contributions cleared on death)", playerOf(roomA, idC)?.assists === 1);

  console.log("\nDISCONNECT CLEANUP (C leaves while B is dead)");
  await roomC.leave(true);
  await sleep(300);
  check("A sees 2 players", playersOf(roomA).length === 2);
  check("B sees 2 players", playersOf(roomB).length === 2);
  await sleep(3200); // B's pending respawn must still complete cleanly
  check("B respawned fine after C left", playerOf(roomA, idB)?.isAlive === true);

  await roomA.leave(true);
  await roomB.leave(true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Test crashed:", err.message ?? err);
  console.error("Is the backend running? (cd backend && npm run dev)");
  process.exit(1);
});