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
import { loadMapSelection, saveMapSelection, mapDisplayName, listMaps } from "../world/MapSelection";
import { isMapId, type MapId } from "../../shared/map/MapRegistry";

type Screen = "menu" | "join" | "lobby" | "busy" | "error";

/** Persisted across the reload triggered by a create-with-other-map. */
interface PendingCreate {
  name: string;
  map: string;
}

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
  /** Map picked in the CREATE menu (defaults to the map this page loaded). */
  private selectedMap: MapId = loadMapSelection();

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

  /** Open the overlay on the NICKNAME prompt, then join (invite link). */
  openWithInvite(roomId: string): void {
    this.root.classList.remove("hidden");
    this.showNamePrompt(roomId);
  }

  /**
   * Resume a lobby creation interrupted by a map reload: the host picked a
   * map the page had not loaded → we persisted the choice, reloaded with
   * that map, and now create the room right away. Returns true when a
   * pending creation was found (the caller then skips other boot flows).
   */
  resumePendingCreate(): boolean {
    const pending = takePendingCreate();
    if (!pending) return false;
    // Only resume if the boot phase really loaded the requested map —
    // otherwise the host would end up in a room on a map it has not loaded.
    if (!isMapId(pending.map) || pending.map !== loadMapSelection()) return false;
    this.defaultName = pending.name || this.defaultName;
    this.selectedMap = pending.map;
    this.root.classList.remove("hidden");
    void this.create(pending.name);
    return true;
  }

  close(): void {
    this.root.classList.add("hidden");
  }

  // ---------------------------------------------------------------- screens

  private showMenu(): void {
    this.setScreen("menu");
    // The map picker lists every registered map; the room's map is FIXED
    // at creation and every joining client is forced onto it (see join()).
    const mapButtons = listMaps()
      .map(
        (m) => `
        <button class="mp-map${m.id === this.selectedMap ? " mp-map-active" : ""}"
                type="button" data-mp-map="${escapeHtml(m.id)}">${escapeHtml(m.name)}</button>`,
      )
      .join("");
    this.panel.innerHTML = `
      <div class="mp-title">MULTIPLAYER</div>
      <label class="mp-label" for="mp-name">DISPLAY NAME</label>
      <input id="mp-name" class="mp-input" maxlength="${MultiplayerConfig.maxNameLength}"
             spellcheck="false" autocomplete="off" value="${escapeHtml(this.defaultName)}" />
      <div class="mp-label">LOBBY MAP</div>
      <div class="mp-maps">${mapButtons}</div>
      <button class="mp-btn mp-btn-primary" data-mp="create">CREATE LOBBY</button>
      <button class="mp-btn" data-mp="join">JOIN LOBBY</button>
      <button class="mp-btn mp-btn-ghost" data-mp="back">BACK</button>
    `;
    this.panel.querySelectorAll<HTMLButtonElement>("[data-mp-map]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.mpMap;
        if (!isMapId(id)) return;
        this.selectedMap = id;
        this.panel
          .querySelectorAll<HTMLButtonElement>("[data-mp-map]")
          .forEach((b) => b.classList.toggle("mp-map-active", b === btn));
      });
    });
    this.bind("create", () => void this.create());
    this.bind("join", () => this.showJoin());
    this.bind("back", () => this.close());
  }

  private showJoin(prefill = ""): void {
    this.setScreen("join");
    this.panel.innerHTML = `
      <div class="mp-title">JOIN LOBBY</div>
      <label class="mp-label" for="mp-join-name">YOUR NICKNAME</label>
      <input id="mp-join-name" class="mp-input" maxlength="${MultiplayerConfig.maxNameLength}"
             spellcheck="false" autocomplete="off" value="${escapeHtml(this.defaultName)}" />
      <label class="mp-label" for="mp-room">ENTER ROOM ID</label>
      <input id="mp-room" class="mp-input" spellcheck="false" autocomplete="off"
             placeholder="J4K8XZ" value="${escapeHtml(prefill)}" />
      <button class="mp-btn mp-btn-primary" data-mp="go">JOIN</button>
      <button class="mp-btn mp-btn-ghost" data-mp="back">BACK</button>
    `;
    const nameInput = this.panel.querySelector<HTMLInputElement>("#mp-join-name")!;
    const input = this.panel.querySelector<HTMLInputElement>("#mp-room")!;
    const go = () => {
      const id = input.value.trim();
      if (id.length > 0) void this.join(id, nameInput.value.trim());
    };
    this.bind("go", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    this.bind("back", () => this.showMenu());
    input.focus();
  }

  /**
   * NICKNAME prompt shown before joining a lobby from an invite link:
   * the pseudo entered here is displayed in-game (nametag above the
   * avatar) and on the leaderboard.
   */
  private showNamePrompt(roomId: string): void {
    this.setScreen("join");
    this.panel.innerHTML = `
      <div class="mp-title">JOIN LOBBY</div>
      <div class="mp-room-row">Room: <span class="mp-room-id">${escapeHtml(roomId)}</span></div>
      <label class="mp-label" for="mp-join-name">ENTER YOUR NICKNAME</label>
      <input id="mp-join-name" class="mp-input" maxlength="${MultiplayerConfig.maxNameLength}"
             spellcheck="false" autocomplete="off" value="${escapeHtml(this.defaultName)}" />
      <button class="mp-btn mp-btn-primary" data-mp="go">JOIN</button>
      <button class="mp-btn mp-btn-ghost" data-mp="back">CANCEL</button>
    `;
    const nameInput = this.panel.querySelector<HTMLInputElement>("#mp-join-name")!;
    const go = () => void this.join(roomId, nameInput.value.trim());
    this.bind("go", go);
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
    this.bind("back", () => this.close());
    nameInput.focus();
    nameInput.select();
  }

  private showLobby(): void {
    this.setScreen("lobby");
    const roomId = this.client.roomId ?? "—";
    const roomMap = this.client.roomMapId;
    const mapLabel = roomMap && isMapId(roomMap) ? mapDisplayName(roomMap) : "";
    this.panel.innerHTML = `
      <div class="mp-title">PRIVATE LOBBY</div>
      <div class="mp-room-row">Room: <span class="mp-room-id">${escapeHtml(roomId)}</span></div>
      ${mapLabel ? `<div class="mp-room-row">Map: <span class="mp-room-id">${escapeHtml(mapLabel)}</span></div>` : ""}
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

  private async create(explicitName?: string): Promise<void> {
    const name = explicitName || this.readName();
    const map = this.selectedMap;

    // MAP CHECK (host side): the map is loaded ONCE during the boot phase.
    // A pick that differs from the loaded map persists the selection and
    // reloads — the creation resumes automatically after the boot
    // (resumePendingCreate) so the host lands in a lobby on the map it
    // actually has loaded. Same reload pattern as joining a foreign-map room.
    if (map !== loadMapSelection()) {
      savePendingCreate({ name, map });
      saveMapSelection(map);
      this.showBusy(`LOADING ${mapDisplayName(map)}`);
      window.location.assign("/");
      return;
    }

    this.showBusy("CREATING LOBBY");
    try {
      // The room's map is FIXED at creation (server-validated). Every
      // joining client compares it with its loaded map and reloads onto it
      // if needed — everybody plays the SAME map.
      await this.client.createLobby(name, map);
      this.showLobby();
    } catch (err) {
      this.showError(errorTitle(err));
    }
  }

  private async join(roomId: string, explicitName?: string): Promise<void> {
    // The nickname prompt / join screen passes the name explicitly;
    // fall back to the saved one, then to a generated guest name.
    const name =
      explicitName ||
      this.panel.querySelector<HTMLInputElement>("#mp-name")?.value.trim() ||
      loadDisplayName() ||
      generateGuestName();
    this.defaultName = name;
    saveDisplayName(name);

    this.showBusy("JOINING LOBBY");
    try {
      await this.client.joinLobby(roomId, name);

      // MAP CHECK: the room's map is fixed at creation. If it differs from
      // the map THIS page has loaded, persist the room's map and reload to
      // /join/{roomId} — the boot phase loads the right map, then the
      // invite flow auto-rejoins (same reload pattern as the graphics
      // preset; assets are only ever loaded once per page life).
      const roomMap = this.client.roomMapId;
      if (roomMap && isMapId(roomMap) && roomMap !== loadMapSelection()) {
        saveMapSelection(roomMap);
        this.showBusy(`LOADING ${mapDisplayName(roomMap)}`);
        await this.client.leaveLobby();
        window.location.assign(`${MultiplayerConfig.joinPathPrefix}${roomId}`);
        return;
      }

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

/** Persist a lobby creation that must survive the map reload (sessionStorage: tab-scoped, one-shot). */
function savePendingCreate(pending: PendingCreate): void {
  try {
    sessionStorage.setItem(MultiplayerConfig.pendingCreateStorageKey, JSON.stringify(pending));
  } catch {
    /* private browsing — the host simply lands on the menu after the reload */
  }
}

/** Read AND clear the pending creation (never resumes twice). */
function takePendingCreate(): PendingCreate | null {
  try {
    const raw = sessionStorage.getItem(MultiplayerConfig.pendingCreateStorageKey);
    if (!raw) return null;
    sessionStorage.removeItem(MultiplayerConfig.pendingCreateStorageKey);
    const parsed = JSON.parse(raw) as Partial<PendingCreate>;
    if (typeof parsed.map !== "string") return null;
    return { name: typeof parsed.name === "string" ? parsed.name : "", map: parsed.map };
  } catch {
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Inject the overlay styles once (bean-green theme matching the Main Menu). */
function injectStyles(): void {
  if (document.getElementById("mp-styles")) return;
  const style = document.createElement("style");
  style.id = "mp-styles";
  style.textContent = `
#mp-overlay {
  position: fixed; inset: 0; z-index: 60;
  display: flex; align-items: center; justify-content: center;
  background: rgba(4, 12, 7, 0.82);
  backdrop-filter: blur(6px);
  font-family: "Baloo 2", sans-serif;
}
#mp-overlay.hidden { display: none; }
#mp-panel {
  width: min(420px, 92vw);
  padding: 34px 38px;
  display: flex; flex-direction: column; gap: 12px;
  background: linear-gradient(160deg, rgba(11, 34, 18, 0.96), rgba(6, 18, 10, 0.96));
  border: 2px solid rgba(22, 163, 74, 0.45);
  border-radius: 22px;
  box-shadow: 0 0 42px rgba(22, 163, 74, 0.25);
}
.mp-title {
  font-family: "Luckiest Guy", cursive;
  font-size: 22px; font-weight: 400; letter-spacing: 3px;
  color: #dcfce7; text-align: center; margin-bottom: 8px;
}
.mp-title.mp-error { color: #fbbf24; }
.mp-label {
  font-size: 12px; letter-spacing: 2.5px; color: #86bd94; font-weight: 600;
}
.mp-input {
  padding: 10px 12px; font-family: "Baloo 2", sans-serif;
  font-size: 14px; letter-spacing: 2px; color: #f0fdf4; font-weight: 600;
  background: rgba(22, 163, 74, 0.08);
  border: 1px solid rgba(22, 163, 74, 0.5); border-radius: 12px;
  outline: none; text-transform: uppercase;
}
.mp-input:focus { border-color: #4ade80; box-shadow: 0 0 10px rgba(74, 222, 128, 0.35); }
.mp-btn {
  padding: 12px 14px; cursor: pointer;
  font-family: "Luckiest Guy", cursive; font-size: 13px;
  font-weight: 400; letter-spacing: 2.5px;
  color: #dcfce7; background: rgba(22, 163, 74, 0.14);
  border: 1px solid rgba(22, 163, 74, 0.55); border-radius: 14px;
  transition: background 0.15s, box-shadow 0.15s, transform 0.06s;
}
.mp-btn:hover { background: rgba(22, 163, 74, 0.3); box-shadow: 0 0 14px rgba(74, 222, 128, 0.35); }
.mp-btn:active { transform: scale(0.98); }
.mp-btn-primary { background: rgba(22, 163, 74, 0.42); }
.mp-btn-ghost { background: transparent; border-color: rgba(22, 163, 74, 0.3); color: #86bd94; }
.mp-btn-disabled, .mp-btn:disabled {
  opacity: 0.4; cursor: not-allowed; box-shadow: none;
}
.mp-btn.mp-copied { background: rgba(250, 204, 21, 0.25); border-color: rgba(250, 204, 21, 0.6); color: #fef9c3; }
.mp-maps { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
.mp-map {
  padding: 10px 8px; cursor: pointer;
  font-family: "Luckiest Guy", cursive; font-size: 12px;
  font-weight: 400; letter-spacing: 2px;
  color: #86bd94; background: rgba(22, 163, 74, 0.08);
  border: 1px solid rgba(22, 163, 74, 0.35); border-radius: 12px;
  transition: background 0.15s, box-shadow 0.15s, color 0.15s, transform 0.06s;
}
.mp-map:hover { background: rgba(22, 163, 74, 0.22); color: #dcfce7; }
.mp-map:active { transform: scale(0.98); }
.mp-map.mp-map-active {
  color: #06140b; background: #4ade80; border-color: #4ade80;
  box-shadow: 0 0 14px rgba(74, 222, 128, 0.45);
}
.mp-room-row { text-align: center; font-size: 15px; color: #bbf7d0; letter-spacing: 1.5px; }
.mp-room-id {
  font-family: "Luckiest Guy", cursive; color: #f0fdf4; font-weight: 400;
  letter-spacing: 3px; user-select: all;
}
.mp-sub { font-size: 12px; letter-spacing: 2.5px; color: #86bd94; font-weight: 600; margin-top: 4px; }
.mp-sep { height: 1px; background: rgba(22, 163, 74, 0.35); }
#mp-players { display: flex; flex-direction: column; gap: 6px; min-height: 54px; }
.mp-player {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 12px; border-radius: 10px;
  background: rgba(22, 163, 74, 0.1);
  font-family: "Baloo 2", sans-serif; font-size: 13px; font-weight: 600;
  letter-spacing: 2px; color: #f0fdf4;
}
.mp-player.mp-me { border: 1px solid rgba(74, 222, 128, 0.5); }
.mp-host {
  font-size: 10px; letter-spacing: 2px; color: #06140b;
  background: #4ade80; border-radius: 6px; padding: 2px 7px; font-weight: 700;
}
.mp-waiting { padding: 8px 12px; color: #6f9b7c; font-size: 13px; letter-spacing: 1.5px; }
.mp-status {
  text-align: center; padding: 18px 0; color: #bbf7d0;
  font-size: 14px; letter-spacing: 2.5px; font-weight: 600;
}
.mp-dots::after { content: ""; animation: mp-dots 1.2s steps(4) infinite; }
@keyframes mp-dots { 0% { content: ""; } 25% { content: "."; } 50% { content: ".."; } 75% { content: "..."; } }
`;
  document.head.appendChild(style);
}