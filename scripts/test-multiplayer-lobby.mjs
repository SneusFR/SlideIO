/**
 * Phase 1 smoke test — validates the Colyseus lobby without any browser:
 *
 *   1. Client A creates a room (VALENTIN, HOST)
 *   2. Client B joins by roomId (PLAYER 2)
 *   3. Both see the same 2-player list
 *   4. B leaves → A sees the list shrink in real time
 *   5. Joining an invalid roomId fails cleanly
 *   6. maxClients=8 is enforced (9th join rejected)
 *
 * Requires the backend running on ws://localhost:2567:
 *   cd backend && npm run dev   (or npm start)
 * Then: node scripts/test-multiplayer-lobby.mjs
 */
import { createRequire } from "node:module";

// Node 20 has no global WebSocket — borrow "ws" from the backend install.
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

function playerList(room) {
  const out = [];
  room.state.players.forEach((p) => out.push({ name: p.name, isHost: p.isHost }));
  return out;
}

// ---- 1. Create ----
const clientA = new Client(SERVER);
const roomA = await clientA.create(ROOM, { name: "VALENTIN" });
check("room created with a roomId", typeof roomA.roomId === "string" && roomA.roomId.length > 0);
await sleep(300);
check("creator is listed and marked HOST", playerList(roomA).some((p) => p.name === "VALENTIN" && p.isHost));

// ---- 2/3. Join by id + both see the same list ----
const clientB = new Client(SERVER);
const roomB = await clientB.joinById(roomA.roomId, { name: "PLAYER 2" });
await sleep(300);
const listA = playerList(roomA);
const listB = playerList(roomB);
check("browser A sees 2 players", listA.length === 2);
check("browser B sees 2 players", listB.length === 2);
check("both see VALENTIN + PLAYER 2",
  ["VALENTIN", "PLAYER 2"].every((n) => listA.some((p) => p.name === n)) &&
  ["VALENTIN", "PLAYER 2"].every((n) => listB.some((p) => p.name === n)));

// ---- 4. Leave propagates ----
await roomB.leave();
await sleep(400);
check("A sees PLAYER 2 disappear after leave", playerList(roomA).length === 1);

// ---- 5. Invalid room ----
let invalidRejected = false;
try {
  await new Client(SERVER).joinById("INVALIDROOM", { name: "GHOST" });
} catch {
  invalidRejected = true;
}
check("invalid roomId is rejected cleanly", invalidRejected);

// ---- 6. maxClients = 8 ----
const extras = [];
for (let i = 2; i <= 8; i++) {
  extras.push(await new Client(SERVER).joinById(roomA.roomId, { name: `PLAYER ${i}` }));
}
await sleep(300);
check("room reaches 8 players", playerList(roomA).length === 8);
let ninthRejected = false;
try {
  await new Client(SERVER).joinById(roomA.roomId, { name: "PLAYER 9" });
} catch {
  ninthRejected = true;
}
check("9th player is rejected (LOBBY FULL)", ninthRejected);

// ---- cleanup ----
for (const r of extras) await r.leave();
await roomA.leave();
await sleep(200);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);