import type { MultiplayerNetworkDebug } from "../network/MultiplayerGameController";
import type { RemotePlayerNetDebug } from "../network/RemotePlayerManager";

/** HUD refresh interval while visible (s) — readable, never per frame. */
const REFRESH_INTERVAL = 0.25;
/** FPS smoothing factor. */
const FPS_SMOOTHING = 0.1;

/**
 * F1 — MULTIPLAYER NETWORK DEBUG HUD.
 *
 * A compact diagnostic overlay for real Internet play sessions: press F1
 * the moment a bug happens and read concrete values (ping, jitter,
 * snapshot gaps, seq loss/coalescing, buffer, extrapolation, corrections,
 * interpolation delay, renderTime vs serverTime) + a short timestamped
 * anomaly history. Pure presentation — it NEVER affects gameplay and has
 * zero per-frame cost while hidden.
 *
 * Created only in MULTIPLAYER (Game.enableMultiplayer) and disposed with
 * the session.
 */
export class NetworkDebugHUD {
  private readonly root: HTMLDivElement;
  private visible = false;
  private refreshTimer = 0;
  private fps = 60;
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== "F1") return;
    e.preventDefault(); // F1 opens the browser help otherwise
    this.toggle();
  };

  constructor(private readonly provider: () => MultiplayerNetworkDebug | null) {
    this.root = document.createElement("div");
    this.root.id = "network-debug-hud";
    this.root.classList.add("hidden");
    document.body.appendChild(this.root);
    window.addEventListener("keydown", this.onKeyDown);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.classList.toggle("hidden", !this.visible);
    if (this.visible) this.refresh(); // immediate content on open
  }

  /** Per-frame: FPS tracking (cheap) + throttled refresh when visible. */
  update(dt: number): void {
    if (dt > 0) {
      const inst = 1 / dt;
      this.fps += (inst - this.fps) * FPS_SMOOTHING;
    }
    if (!this.visible) return;
    this.refreshTimer += dt;
    if (this.refreshTimer < REFRESH_INTERVAL) return;
    this.refreshTimer = 0;
    this.refresh();
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    this.root.remove();
  }

  // ------------------------------------------------------------------

  private refresh(): void {
    const report = this.provider();
    if (!report) {
      this.root.textContent = "NETWORK DEBUG — waiting for session…";
      return;
    }

    const rtt = report.localRttMs !== null ? `${Math.round(report.localRttMs)}ms` : "—";
    const renderAge = report.serverNow - report.renderTime;
    const anyExtrap = report.players.some((p) => p.extrapolating);

    const lines: string[] = [];
    lines.push(`<div class="ndh-title">NETWORK DEBUG (F1)</div>`);
    lines.push(`<div class="ndh-section">GLOBAL</div>`);
    lines.push(row("FPS", this.fps.toFixed(0)));
    lines.push(row("RTT (local)", `${rtt}  jitter ${report.localRttJitterMs.toFixed(0)}ms`));
    lines.push(
      row(
        "Interp delay",
        `${report.interpDelayMs.toFixed(0)}ms` +
          (Math.abs(report.targetDelayMs - report.interpDelayMs) > 1
            ? ` → target ${report.targetDelayMs.toFixed(0)}ms`
            : ""),
      ),
    );
    lines.push(row("Snap gap avg/max", `${report.avgGapMs.toFixed(0)} / ${report.maxGapMs.toFixed(0)}ms`));
    lines.push(row("Arrival jitter", `${report.jitterMs.toFixed(0)}ms`));
    lines.push(row("Server time", report.serverNow > 0 ? `${Math.round(report.serverNow)}` : "—"));
    lines.push(row("Render time", report.serverNow > 0 ? `${Math.round(report.renderTime)}` : "—"));
    lines.push(row("Render age", `${renderAge.toFixed(0)}ms`));
    lines.push(row("Extrapolating", anyExtrap ? "<span class='ndh-warn'>YES</span>" : "NO"));

    for (const p of report.players) {
      lines.push(this.renderPlayer(p));
    }

    if (report.anomalies.length > 0) {
      lines.push(`<div class="ndh-section">ANOMALIES</div>`);
      // Newest last in the ring → show the last 8, newest at the bottom.
      const recent = report.anomalies.slice(-8);
      for (const a of recent) {
        lines.push(
          `<div class="ndh-anomaly">${formatTime(a.at)} ${escapeHtml(a.text)}</div>`,
        );
      }
    }

    this.root.innerHTML = lines.join("");
  }

  private renderPlayer(p: RemotePlayerNetDebug): string {
    const warnGap = p.maxSnapGapMs > 100;
    const warnSeq = p.seqGapTotal > 0;
    const lines: string[] = [];
    lines.push(`<div class="ndh-section">${escapeHtml(p.name.toUpperCase())}</div>`);
    lines.push(row("Ping", `${p.pingMs}ms`));
    lines.push(row("Last seq", `${p.lastSeq}${p.lastSeqGap > 0 ? ` <span class='ndh-warn'>(gap +${p.lastSeqGap})</span>` : ""}`));
    lines.push(row("Seq lost total", warnSeq ? `<span class='ndh-warn'>${p.seqGapTotal}</span>` : "0"));
    lines.push(row("Snapshot age", `${Math.round(p.snapshotAgeMs)}ms`));
    lines.push(row("Arrival gap", `${Math.round(p.lastArrivalGapMs)}ms`));
    lines.push(
      row(
        "Snap gap / max",
        `${Math.round(p.lastSnapGapMs)} / ${warnGap ? `<span class='ndh-warn'>${Math.round(p.maxSnapGapMs)}</span>` : Math.round(p.maxSnapGapMs)}ms`,
      ),
    );
    lines.push(row("Rate", `${p.rateHz.toFixed(1)}Hz`));
    lines.push(row("Buffer", `${p.buffer}`));
    lines.push(row("State", p.state));
    lines.push(
      row(
        "Interp / Extrap",
        `${p.interpolating ? "YES" : "no"} / ${
          p.extrapolating
            ? `<span class='ndh-warn'>YES ${Math.round(p.extrapolatedMs)}ms</span>`
            : "no"
        }`,
      ),
    );
    if (p.correctionM > 0.01) {
      lines.push(row("Correction", `<span class='ndh-warn'>${p.correctionM.toFixed(2)}m</span>`));
    }
    lines.push(row("Y raw/interp/vis", `${p.rawY.toFixed(2)} / ${p.interpY.toFixed(2)} / ${p.visualY.toFixed(2)}`));
    lines.push(row("Velocity", `${p.vx.toFixed(1)} ${p.vy.toFixed(1)} ${p.vz.toFixed(1)}`));
    return lines.join("");
  }
}

function row(label: string, value: string): string {
  return `<div class="ndh-row"><span class="ndh-label">${label}</span><span class="ndh-value">${value}</span></div>`;
}

function formatTime(atMs: number): string {
  const d = new Date(atMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}