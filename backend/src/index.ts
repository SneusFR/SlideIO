import { createServer } from "http";
import express from "express";
import cors from "cors";
import { Server } from "colyseus";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { serverConfig } from "./config/serverConfig";
import { GameRoom } from "./rooms/GameRoom";

/**
 * SlideIO multiplayer server — Phase 1 (lobby foundation).
 *
 * Express handles the matchmaking HTTP endpoints (with CORS restricted to
 * the frontend origins) and Colyseus attaches its WebSocket transport to
 * the same HTTP server.
 */
const app = express();
app.use(cors({ origin: serverConfig.corsOrigins }));
app.use(express.json());

// Simple liveness probe (also handy to verify the server from a browser).
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "slideio-multiplayer" });
});

const httpServer = createServer(app);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// Private lobbies — created on demand, joined by roomId only.
gameServer.define(serverConfig.roomName, GameRoom);

gameServer
  .listen(serverConfig.port)
  .then(() => {
    console.log(`[SlideIO] Multiplayer server listening on ws://localhost:${serverConfig.port}`);
    console.log(`[SlideIO] Allowed origins: ${serverConfig.corsOrigins.join(", ")}`);
  })
  .catch((err) => {
    console.error("[SlideIO] Failed to start multiplayer server:", err);
    process.exit(1);
  });