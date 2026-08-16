import {
  MultiplayerClient,
  MultiplayerError,
  type NetworkPlayerInfo,
} from "./MultiplayerClient";
import {
  buildInviteLink,
  generateGuestName,
  loadDisplayName,
  MultiplayerConfig,
  saveDisplayName,
} from "./MultiplayerConfig";

type Screen = "menu" | "join" | "lobby" | "busy" | "error";

/**
 * Multiplayer lobby UI (Phase 1) — a self-contained DOM overlay shown above
 * the Main Menu. Owns all lobby screens:
 *
 *   MULTIPLAYER  → CREATE LOBBY / JOIN LOBBY (+ display name)
 *   JOIN LOBBY   → enter Room ID manually
 *   PRIVATE LOBBY→ live player list, COPY INVITE LINK, LEAVE
 *   errors       → LOBBY NOT FOUND / LOBBY FULL / SERVER UNAVAILABLE
 *
 * All Colyseus traffic goes through MultiplayerClient — no network calls here.
 */
export class LobbyController {
  private readonly root: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private defaultName: string;

  constructor(
    private readonly client: MultiplayerClient,
    fallbackName: string,
  ) {
    this.defaultName = loadDisplayName() ?? fallbackName;
    injectStyles();

    this.root = document.createElement("div");
    this.root.id = "mp-overlay";
    this.root.classList.add("hidden");
    this.panel = document.createElement("div");
    this.panel.id = "mp-panel";
    this.root.appendChild(this.panel);
    document.body.appendChild(this.root);

    this.client.onPlayersChanged = (players) => this.renderPlayers(players);
    this.client.onLeft = () => {
      // Connection ended (LEAVE, kick or drop): back to the multiplayer menu
      // if the overlay is still open.
      if (!this.root.classList.contains("hidden")) this.showMenu();
    };
  }

  /** Open the overlay on the CREATE / JOIN menu. */
  open(): void {
    this.root.classList.remove("hidden");
    this.showMenu();
  }

  /** Open the overlay and immediately try to join a room (invite link). */
  openWithInvite(roomId: string): void {
    this.root.classList.remove("hidden");
    void this.join(roomId);
  }

  close(): void {
    this.root.classList.add("hidden");
  }

  // ---------------------------------------------------------------- screens

  private showMenu(): void {
    this.setScreen("menu");
    this.panel.innerHTML = `
      <div class="mp-title">MULTIPLAYER</div>
      <label class="mp-label" for="mp-name">DISPLAY NAME</label>
      <input id="mp-name" class="mp-input" maxlength="${MultiplayerConfig.maxNameLength}"
             spellcheck="false" autocomplete="off" value="${escapeHtml(this.defaultName)}" />
      <button class="mp-btn mp-btn-primary" data-mp="create">CREATE LOBBY</button>
      <button class="mp-btn" data-mp="join">JOIN LOBBY</button>
      <button class="mp-btn mp-btn-ghost" data-mp="back">BACK</button>
    `;
    this.bind("create", () => void this.create());
    this.bind("join", () => this.showJoin());
    this.bind("back", () => this.close());
  }

  private showJoin(prefill = ""): void {
    this.setScreen("join");
    this.panel.innerHTML = `
      <div class="mp-title">JOIN LOBBY</div>
      <label class="mp-label" for="mp-room">ENTER ROOM ID</label>
      <input id="mp-room" class="mp-input" spellcheck="false" autocomplete="off"
             placeholder="J4K8XZ" value="${escapeHtml(prefill)}" />
      <button class="mp-btn mp-btn-primary" data-mp="go">JOIN</button>
      <button class="mp-btn mp-btn-ghost" data-mp="back">BACK</button>
    `;
    const input = this.panel.querySelector<HTMLInputElement>("#mp-room")!;
    const go = () => {
      const id = input.value.trim();
      if (id.length > 0) void this.join(id);
    };
    this.bind("go", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    this.bind("back", () => this.showMenu());
    input.focus();
  }

  private showLobby(): void {
    this.setScreen("lobby");
    const roomId = this.client.roomId ?? "—";
    this.panel.innerHTML = `
      <div class="mp-title">PRIVATE LOBBY</div>
      <div class="mp-room-row">Room: <span class="mp-room-id">${escapeHtml(roomId)}</span></div>
      <div class="mp-sub">PLAYERS</div>
      <div class="mp-sep"></div>
      <div id="mp-players"></div>
      <div class="mp-sep"></div>
      <button class="mp-btn" data-mp="copy">COPY INVITE LINK</button>
      <button class="mp-btn mp-btn-primary mp-btn-disabled" data-mp="start" disabled>START GAME</button>
      <button class="mp-btn mp-btn-ghost" data-mp="leave">LEAVE</button>
    `;
    this.bind("copy", () => void this.copyInvite());
    // The click only REQUESTS the start — the server validates that the
    // sender is the host and that enough players are present.
    this.bind("start", () => this.client.requestStartGame());
    this.bind("leave", () => void this.leave());
    this.refreshStartButton(this.client.getPlayers());
  }

  private showBusy(message: string): void {
    this.setScreen("busy");
    this.panel.innerHTML = `
      <div class="mp-title">MULTIPLAYER</div>
      <div class="mp-status">${escapeHtml(message)}<span class="mp-dots"></span></div>
    `;
  }

  private showError(title: string, retryRoomId?: string): void {
    this.setScreen("error");
    this.panel.innerHTML = `
      <div class="mp-title mp-error">${escapeHtml(title)}</div>
      ${retryRoomId ? `<button class="mp-btn" data-mp="retry">RETRY</button>` : ""}
      <button class="mp-btn mp-btn-ghost" data-mp="back">BACK TO MENU</button>
    `;
    if (retryRoomId) this.bind("retry", () => void this.join(retryRoomId));
    this.bind("back", () => this.showMenu());
  }

  // ---------------------------------------------------------------- actions

  private async create(): Promise<void> {
    const name = this.readName();
    this.showBusy("CREATING LOBBY");
    try {
      await this.client.createLobby(name);
      this.showLobby();
    } catch (err) {
      this.showError(errorTitle(err));
    }
  }

  private async join(roomId: string): Promise<void> {
    // Invite joins may happen before the user ever typed a name.
    const name =
      this.panel.querySelector<HTMLInputElement>("#mp-name")?.value.trim() ||
      loadDisplayName() ||
      generateGuestName();
    this.defaultName = name;
    saveDisplayName(name);

    this.showBusy("JOINING LOBBY");
    try {
      await this.client.joinLobby(roomId, name);
      this.showLobby();
    } catch (err) {
      const kind = err instanceof MultiplayerError ? err.kind : "unknown";
      this.showError(errorTitle(err), kind === "unavailable" ? roomId : undefined);
    }
  }

  private async leave(): Promise<void> {
    await this.client.leaveLobby();
    this.showMenu();
  }

  private async copyInvite(): Promise<void> {
    const roomId = this.client.roomId;
    if (!roomId) return;
    try {
      await navigator.clipboard.writeText(buildInviteLink(roomId));
      this.flashCopied();
    } catch {
      /* clipboard denied — show the link so it can be copied manually */
      window.prompt("Invite link:", buildInviteLink(roomId));
    }
  }

  private flashCopied(): void {
    const btn = this.panel.querySelector<HTMLButtonElement>('[data-mp="copy"]');
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = "COPIED!";
    btn.classList.add("mp-copied");
    setTimeout(() => {
      btn.textContent = original;
      btn.classList.remove("mp-copied");
    }, 1200);
  }

  // ---------------------------------------------------------------- helpers

  private renderPlayers(players: NetworkPlayerInfo[]): void {
    const list = this.panel.querySelector("#mp-players");
    if (!list) return; // not on the lobby screen
    const me = this.client.sessionId;
    list.innerHTML = players
      .map(
        (p) => `
        <div class="mp-player${p.id === me ? " mp-me" : ""}">
          <span class="mp-player-name">${escapeHtml(p.name)}</span>
          ${p.isHost ? `<span class="mp-host">HOST</span>` : ""}
        </div>`,
      )
      .join("");
    if (players.length < 2) {
      list.innerHTML += `<div class="mp-waiting">Waiting…</div>`;
    }
    this.refreshStartButton(players);
  }

  /**
   * START GAME is enabled only for the HOST once enough players are in.
   * This is pure UX — the server independently validates every request.
   */
  private refreshStartButton(players: NetworkPlayerInfo[]): void {
    const btn = this.panel.querySelector<HTMLButtonElement>('[data-mp="start"]');
    if (!btn) return;
    const me = players.find((p) => p.id === this.client.sessionId);
    const canStart =
      me?.isHost === true && players.length >= MultiplayerConfig.minPlayersToStart;
    btn.disabled = !canStart;
    btn.classList.toggle("mp-btn-disabled", !canStart);
    btn.textContent = canStart
      ? "START GAME"
      : me?.isHost
        ? `START GAME (NEED ${MultiplayerConfig.minPlayersToStart})`
        : "WAITING FOR HOST";
  }

  private readName(): string {
    const input = this.panel.querySelector<HTMLInputElement>("#mp-name");
    const name = input?.value.trim() || this.defaultName || generateGuestName();
    this.defaultName = name;
    saveDisplayName(name);
    return name;
  }

  private bind(action: string, handler: () => void): void {
    this.panel
      .querySelector<HTMLButtonElement>(`[data-mp="${action}"]`)
      ?.addEventListener("click", handler);
  }

  private setScreen(screen: Screen): void {
    this.panel.dataset.screen = screen;
  }
}

function errorTitle(err: unknown): string {
  if (err instanceof MultiplayerError) {
    switch (err.kind) {
      case "not_found":
        return "LOBBY NOT FOUND";
      case "full":
        return "LOBBY FULL";
      case "in_progress":
        return "GAME ALREADY STARTED";
      case "unavailable":
        return "MULTIPLAYER SERVER UNAVAILABLE";
    }
  }
  return "CONNECTION FAILED";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inject the overlay styles once (violet theme matching the Main Menu). */
function injectStyles(): void {
  if (document.getElementById("mp-styles")) return;
  const style = document.createElement("style");
  style.id = "mp-styles";
  style.textContent = `
#mp-overlay {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(7, 4, 15, 0.82);
  backdrop-filter: blur(6px);
  font-family: "Rajdhani", sans-serif;
}
#mp-overlay.hidden { display: none; }
#mp-panel {
  width: min(420px, 92vw);
  padding: 34px 38px;
  display: flex; flex-direction: column; gap: 12px;
  background: linear-gradient(160deg, rgba(21, 11, 38, 0.96), rgba(12, 7, 24, 0.96));
  border: 1px solid rgba(124, 58, 237, 0.45);
  border-radius: 10px;
  box-shadow: 0 0 42px rgba(124, 58, 237, 0.25);
}
.mp-title {
  font-family: "Orbitron", sans-serif;
  font-size: 22px; font-weight: 700; letter-spacing: 3px;
  color: #e9d5ff; text-align: center; margin-bottom: 8px;
}
.mp-title.mp-error { color: #f0abfc; }
.mp-label {
  font-size: 12px; letter-spacing: 2.5px; color: #a78bfa; font-weight: 600;
}
.mp-input {
  padding: 10px 12px; font-family: "Orbitron", sans-serif;
  font-size: 14px; letter-spacing: 2px; color: #f5f3ff;
  background: rgba(124, 58, 237, 0.08);
  border: 1px solid rgba(124, 58, 237, 0.5); border-radius: 6px;
  outline: none; text-transform: uppercase;
}
.mp-input:focus { border-color: #a855f7; box-shadow: 0 0 10px rgba(168, 85, 247, 0.35); }
.mp-btn {
  padding: 12px 14px; cursor: pointer;
  font-family: "Orbitron", sans-serif; font-size: 13px;
  font-weight: 600; letter-spacing: 2.5px;
  color: #e9d5ff; background: rgba(124, 58, 237, 0.14);
  border: 1px solid rgba(124, 58, 237, 0.55); border-radius: 6px;
  transition: background 0.15s, box-shadow 0.15s, transform 0.06s;
}
.mp-btn:hover { background: rgba(124, 58, 237, 0.3); box-shadow: 0 0 14px rgba(168, 85, 247, 0.35); }
.mp-btn:active { transform: scale(0.98); }
.mp-btn-primary { background: rgba(124, 58, 237, 0.42); }
.mp-btn-ghost { background: transparent; border-color: rgba(124, 58, 237, 0.3); color: #a78bfa; }
.mp-btn-disabled, .mp-btn:disabled {
  opacity: 0.4; cursor: not-allowed; box-shadow: none;
}
.mp-btn.mp-copied { background: rgba(52, 211, 153, 0.25); border-color: rgba(52, 211, 153, 0.6); color: #d1fae5; }
.mp-room-row { text-align: center; font-size: 15px; color: #c4b5fd; letter-spacing: 1.5px; }
.mp-room-id {
  font-family: "Orbitron", sans-serif; color: #f5f3ff; font-weight: 700;
  letter-spacing: 3px; user-select: all;
}
.mp-sub { font-size: 12px; letter-spacing: 2.5px; color: #a78bfa; font-weight: 600; margin-top: 4px; }
.mp-sep { height: 1px; background: rgba(124, 58, 237, 0.35); }
#mp-players { display: flex; flex-direction: column; gap: 6px; min-height: 54px; }
.mp-player {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-radius: 5px;
  background: rgba(124, 58, 237, 0.1);
  font-family: "Orbitron", sans-serif; font-size: 13px;
  letter-spacing: 2px; color: #f5f3ff;
}
.mp-player.mp-me { border: 1px solid rgba(168, 85, 247, 0.5); }
.mp-host {
  font-size: 10px; letter-spacing: 2px; color: #0e0817;
  background: #a855f7; border-radius: 3px; padding: 2px 7px; font-weight: 700;
}
.mp-waiting { padding: 8px 12px; color: #7c6f9b; font-size: 13px; letter-spacing: 1.5px; }
.mp-status {
  text-align: center; padding: 18px 0; color: #c4b5fd;
  font-size: 14px; letter-spacing: 2.5px; font-weight: 600;
}
.mp-dots::after { content: ""; animation: mp-dots 1.2s steps(4) infinite; }
@keyframes mp-dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
`;
  document.head.appendChild(style);
}