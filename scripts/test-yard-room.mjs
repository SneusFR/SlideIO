// TEMP integration check: create a YARD room + a JUNGLE room on the local
// server, verify state.mapId, room metadata via getAvailableRooms, and the
// acid tick path (phase flip requires 2 players — covered by unit paths).
// Run: node scripts/test-yard-room.mjs   (server must be running)
import { Client } from "colyseus.js";

const client = new Client("ws://localhost:2567");

// 1. YARD room
const yardRoom = await client.create("game_room", { name: "TESTER", map: "YARD" });
await new Promise((r) => setTimeout(r, 300));
console.log("YARD room:", yardRoom.roomId, "state.mapId =", yardRoom.state.mapId);

// 2. Default (no map option) → JUNGLE
const client2 = new Client("ws://localhost:2567");
const jungleRoom = await client2.create("game_room", { name: "TESTER2" });
await new Promise((r) => setTimeout(r, 300));
console.log("Default room:", jungleRoom.roomId, "state.mapId =", jungleRoom.state.mapId);

// 3. Invalid map id → fallback JUNGLE
const client3 = new Client("ws://localhost:2567");
const badRoom = await client3.create("game_room", { name: "TESTER3", map: "NOT_A_MAP" });
await new Promise((r) => setTimeout(r, 300));
console.log("Invalid-map room:", badRoom.roomId, "state.mapId =", badRoom.state.mapId);

// 4. Lobby browser metadata
const rooms = await client.getAvailableRooms("game_room");
for (const r of rooms) {
  console.log("listed:", r.roomId, "clients:", r.clients, "metadata:", JSON.stringify(r.metadata));
}

await yardRoom.leave(true);
await jungleRoom.leave(true);
await badRoom.leave(true);
console.log("ALL ROOM CHECKS DONE");
process.exit(0);
