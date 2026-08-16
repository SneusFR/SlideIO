/**
 * Phase 2 smoke test — validates spawn & transform sync without a browser:
 *
 *   1. A creates, B joins (LOBBY phase)
 *   2. NON-host START_GAME is refused (phase stays LOBBY)
 *   3. Host START_GAME → phase = PLAYING on BOTH clients
 *   4. Server assigned DIFFERENT spawn points to A and B
 *   5. A sends PLAYER_TRANSFORM → B sees A's x/y/z/yaw/pitch update
 *   6. Invalid transform (NaN / Infinity / huge) is ignored, room survives
 *   7. New join while PLAYING is refused ("GAME ALREADY STARTED")
 *   8. B leaves mid-game → A sees the roster shrink
 *
 * Requires the backend running on ws://localhost:2567:
 *   cd backend && npm run dev   (or npm start)
 * Then: node scripts/test-multiplayer-phase2.mjs
 */
import { createRequire } from "node:module";

const backendRequire = createRequire(new URL("../backend/package.json", import.meta.url));
globalThis.WebSocket = backendRequire("ws").WebSocket;

const { Client } = await import("colyseus.js");

const SERVER = "ws://localhost:2567";
const ROOM = "game_room";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
}

function snapshot(room) {
  const out = new Map();
  room.state.players.forEach((p, key) => {
    out.set(key, { name: p.name, isHost: p.isHost, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
  });
  return out;
}

// ---- 1. Create + join (LOBBY) ----
const clientA = new Client(SERVER);
const roomA = await clientA.create(ROOM, { name: "VALENTIN" });
const clientB = new Client(SERVER);
const roomB = await clientB.joinById(roomA.roomId, { name: "PLAYER 65" });
await sleep(300);
check("phase starts as LOBBY", roomA.state.phase === "LOBBY" && roomB.state.phase === "LOBBY");

// ---- 2. Non-host cannot start ----
roomB.send("START_GAME");
await sleep(300);
check("non-host START_GAME is refused (phase stays LOBBY)", roomA.state.phase === "LOBBY");

// ---- 3. Host starts → PLAYING everywhere ----
roomA.send("START_GAME");
await sleep(400);
check("host START_GAME flips phase to PLAYING (A)", roomA.state.phase === "PLAYING");
check("phase PLAYING propagated to B", roomB.state.phase === "PLAYING");

// ---- 4. Distinct server-assigned spawns ----
const spawns = snapshot(roomA);
const a = spawns.get(roomA.sessionId);
const b = spawns.get(roomB.sessionId);
const dist = Math.hypot(a.x - b.x, a.z - b.z);
check(`spawns are distinct (distance ${dist.toFixed(1)}m)`, dist > 1);
check("spawn heights are valid", a.y > 0 && b.y > 0);

// ---- 5. Transform sync A → B ----
roomA.send("PLAYER_TRANSFORM", { x: 10.2, y: 1.8, z: -4.1, yaw: 1.42, pitch: -0.12 });
await sleep(400);
const seenByB = snapshot(roomB).get(roomA.sessionId);
check(
  "B sees A's transform (x/y/z/yaw/pitch)",
  Math.abs(seenByB.x - 10.2) < 0.01 &&
    Math.abs(seenByB.y - 1.8) < 0.01 &&
    Math.abs(seenByB.z + 4.1) < 0.01 &&
    Math.abs(seenByB.yaw - 1.42) < 0.01 &&
    Math.abs(seenByB.pitch + 0.12) < 0.01,
);

// ---- 6. Invalid transforms are ignored, room survives ----
roomA.send("PLAYER_TRANSFORM", { x: NaN, y: Infinity, z: "hack", yaw: 0, pitch: 0 });
roomA.send("PLAYER_TRANSFORM", { x: 999999, y: 0, z: 0, yaw: 0, pitch: 0 });
roomA.send("PLAYER_TRANSFORM", null);
await sleep(400);
const afterBad = snapshot(roomB).get(roomA.sessionId);
check(
  "invalid transforms ignored (position unchanged)",
  Math.abs(afterBad.x - 10.2) < 0.01 && Number.isFinite(afterBad.y),
);
roomA.send("PLAYER_TRANSFORM", { x: 11, y: 2, z: -4, yaw: 0.5, pitch: 0 });
await sleep(300);
check("room still processes valid transforms after bad packets",
  Math.abs(snapshot(roomB).get(roomA.sessionId).x - 11) < 0.01);

// ---- 7. Join while PLAYING is refused ----
let lateRefused = false;
let lateMessage = "";
try {
  await new Client(SERVER).joinById(roomA.roomId, { name: "LATE GUY" });
} catch (err) {
  lateRefused = true;
  lateMessage = String(err?.message ?? err);
}
check(`join-in-progress refused ("${lateMessage}")`, lateRefused);

// ---- 8. Leave mid-game propagates ----
await roomB.leave();
await sleep(400);
check("A sees PLAYER 65 removed after leave", snapshot(roomA).size === 1);

await roomA.leave();
await sleep(200);
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);