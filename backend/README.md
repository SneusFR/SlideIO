# SlideIO — Multiplayer Backend (Colyseus)

Node.js / TypeScript authoritative server for SlideIO multiplayer.
**Phase 1**: lobby foundation only (create / join / leave rooms, player list).
No gameplay synchronization yet.

## Commands

```powershell
npm install     # install dependencies
npm run dev     # dev server with hot reload (tsx watch) on ws://localhost:2567
npm run build   # compile TypeScript to dist/
npm start       # run the compiled server (node dist/index.js)
```

## Environment variables

Copy `.env.example` to `.env` (optional in local dev — defaults work):

| Variable      | Default                 | Description                                   |
| ------------- | ----------------------- | --------------------------------------------- |
| `PORT`        | `2567`                  | HTTP + WebSocket port                         |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend origins (comma-separated)    |

## Structure

```
src/
├── index.ts                 # Express + Colyseus bootstrap
├── config/serverConfig.ts   # port / room name / maxClients / CORS
├── rooms/GameRoom.ts        # private lobby room (maxClients = 8)
└── schemas/                 # synchronized state (players: id, name, isHost)
```

Health check: `http://localhost:2567/health`