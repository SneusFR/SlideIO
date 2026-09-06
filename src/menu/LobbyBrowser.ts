import type { MenuAudio } from "./MenuAudio";
import type { AvailableLobby, MultiplayerClient } from "../network/MultiplayerClient";
import { MultiplayerConfig } from "../network/MultiplayerConfig";
import { isMapId } from "../../shared/map/MapRegistry";
import { mapDisplayName } from "../world/MapSelection";

/**
 * Compact LOBBY BROWSER modal (opened by the server panel's CHANGE
 * button). Lists the REAL open lobbies of the current server via
 * Colyseus room listing — id, players / max — with one-click JOIN.
 *
 * Creating a lobby / joining by code are delegated to the existing
 * LobbyController flows through callbacks — nothing is duplicated.
 */
export class LobbyBrowser {
  /** Player picked a listed lobby → join it (nickname flow outside). */
  onJoin: ((roomId: string) => void) | null = null;
  /** CREATE LOBBY → existing create flow. */
  onCreate: (() => void) | null = null;
  /** JOIN BY CODE → existing manual-code flow. */
  onJoinByCode: (() => void) | null = null;

  private readonly root: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private refreshTimer: number | null = null;
  private refreshing = false;

  constructor(
    private readonly client: MultiplayerClient,
    private readonly sounds: MenuAudio,
  ) {
    this.root = document.createElement("div");
    this.root.id = "lobby-browser";
    this.root.classList.add("hidden");
    this.root.innerHTML = `
      <div id="lb-panel">
        <div class="lbw-header">
          <div>
            <div class="lbw-title">LOBBIES</div>
            <div class="lbw-region">${escapeHtml(MultiplayerConfig.serverRegion)} · FREE FOR ALL</div>
          </div>
          <button class="lbw-close" type="button" data-lbw="close">✕</button>
        </div>
        <div class="lbw-list"></div>
        <div class="lbw-actions">
          <button class="lbw-btn lbw-btn-primary" type="button" data-lbw="create">CREATE LOBBY</button>
          <button class="lbw-btn" type="button" data-lbw="code">JOIN BY CODE</button>
          <button class="lbw-btn lbw-btn-ghost" type="button" data-lbw="refresh">REFRESH</button>
        </div>
      </div>
    `;
    document.body.appendChild(this.root);
    this.listEl = this.root.querySelector<HTMLDivElement>(".lbw-list")!;

    // Backdrop click closes; panel clicks don't bubble to the backdrop.
    this.root.addEventListener("click", (e) => {
      if (e.target === this.root) this.close();
    });
    this.bind("close", () => this.close());
    this.bind("create", () => {
      this.close();
      this.onCreate?.();
    });
    this.bind("code", () => {
      this.close();
      this.onJoinByCode?.();
    });
    this.bind("refresh", () => void this.refresh());

    document.addEventListener("keydown", this.onKeyDown);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Escape" && this.isOpen) this.close();
  };

  get isOpen(): boolean {
    return !this.root.classList.contains("hidden");
  }

  open(): void {
    this.root.classList.remove("hidden");
    void this.refresh();
    // Live list while open — light 5 s poll, cleared on close.
    this.refreshTimer = window.setInterval(() => void this.refresh(), 5000);
  }

  close(): void {
    this.root.classList.add("hidden");
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    if (!this.listEl.hasChildNodes()) {
      this.listEl.innerHTML = `<div class="lbw-empty">SEARCHING<span class="lbw-dots"></span></div>`;
    }
    const lobbies = await this.client.getAvailableLobbies();
    this.refreshing = false;
    if (!this.isOpen) return;
    this.render(lobbies);
  }

  private render(lobbies: AvailableLobby[]): void {
    if (lobbies.length === 0) {
      this.listEl.innerHTML = `
        <div class="lbw-empty">
          No open lobby right now.<br />
          <span class="lbw-empty-sub">Create one and invite your friends — or jump into solo FFA!</span>
        </div>
      `;
      return;
    }

    this.listEl.innerHTML = lobbies
      .map(
        (l) => `
        <div class="lbw-row">
          <span class="lbw-row-region">${escapeHtml(regionShort())}</span>
          <span class="lbw-row-id">${escapeHtml(l.roomId)}</span>
          <span class="lbw-row-mode">${escapeHtml(mapLabel(l.map))}</span>
          <span class="lbw-row-players">${l.clients}/${l.maxClients}</span>
          <button class="lbw-btn lbw-btn-join" type="button" data-room="${escapeHtml(l.roomId)}"
            ${l.clients >= l.maxClients ? "disabled" : ""}>
            ${l.clients >= l.maxClients ? "FULL" : "JOIN"}
          </button>
        </div>`,
      )
      .join("");

    this.listEl.querySelectorAll<HTMLButtonElement>(".lbw-btn-join").forEach((btn) => {
      btn.addEventListener("pointerenter", () => this.sounds.hover());
      btn.addEventListener("click", () => {
        this.sounds.click();
        const roomId = btn.dataset.room;
        if (!roomId) return;
        this.close();
        this.onJoin?.(roomId);
      });
    });
  }

  private bind(action: string, handler: () => void): void {
    const btn = this.root.querySelector<HTMLButtonElement>(`[data-lbw="${action}"]`);
    if (!btn) return;
    btn.addEventListener("pointerenter", () => this.sounds.hover());
    btn.addEventListener("click", () => {
      this.sounds.click();
      handler();
    });
  }

  dispose(): void {
    this.close();
    document.removeEventListener("keydown", this.onKeyDown);
    this.root.remove();
  }
}

/** Map tag for list rows ("YARD" → "YARD 01", unknown → "FFA"). */
function mapLabel(raw: string): string {
  return isMapId(raw) ? mapDisplayName(raw) : "FFA";
}

/** Short region tag for list rows ("EUROPE" → "EU"). */
function regionShort(): string {
  const r = MultiplayerConfig.serverRegion.toUpperCase();
  if (r.startsWith("EU")) return "EU";
  if (r.startsWith("NA") || r.startsWith("US") || r.startsWith("NORTH")) return "NA";
  if (r.startsWith("AS")) return "AS";
  return r.slice(0, 2);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}