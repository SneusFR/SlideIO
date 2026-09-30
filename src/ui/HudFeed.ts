import { replayAnim } from "./hudKit";

/** Sticker flavour: colour + little icon on the left. */
export type FeedKind = "kill" | "streak" | "heal" | "info";

interface FeedSlot {
  el: HTMLDivElement;
  title: HTMLSpanElement;
  sub: HTMLSpanElement;
  timer: number;
  kind: FeedKind | "";
}

const SLOTS = 3;
const LIFE = 1.8; // seconds a sticker stays readable
const LEAVE = 0.28; // exit animation length (must match hud.css .feed-sticker.leaving)

/**
 * Top-centre EVENT FEED — short stickers stacked under the mode badge
 * ("BEANED!", "MOLE STRIKE READY [W]"…). Replaces every text that used to
 * pop over the aim point. Pool of 3 pre-built stickers: `push` recycles
 * the oldest one, `update` only touches the DOM on enter/leave edges.
 */
export class HudFeed {
  private readonly root: HTMLElement;
  private readonly slots: FeedSlot[] = [];
  private seq = 0;
  private readonly order: number[] = [];

  constructor() {
    this.root = document.getElementById("event-feed") ?? document.body;
    for (let i = 0; i < SLOTS; i++) {
      const el = document.createElement("div");
      el.className = "feed-sticker";
      el.innerHTML = `<span class="feed-icon"></span><span class="feed-title"></span><span class="feed-sub"></span>`;
      this.root.appendChild(el);
      this.slots.push({
        el,
        title: el.querySelector(".feed-title")!,
        sub: el.querySelector(".feed-sub")!,
        timer: 0,
        kind: "",
      });
      this.order.push(0);
    }
  }

  /** Show a sticker (newest on top). `sub` is the small grey tail text. */
  push(kind: FeedKind, title: string, sub = ""): void {
    // Recycle the oldest (or an idle) slot.
    let idx = 0;
    for (let i = 1; i < SLOTS; i++) if (this.order[i] < this.order[idx]) idx = i;
    const s = this.slots[idx];
    this.order[idx] = ++this.seq;

    if (s.kind !== kind) {
      if (s.kind) s.el.classList.remove(`feed-${s.kind}`);
      s.el.classList.add(`feed-${kind}`);
      s.kind = kind;
    }
    s.title.textContent = title;
    s.sub.textContent = sub;
    s.timer = LIFE;
    s.el.classList.remove("leaving");
    s.el.classList.add("show");
    // Newest first: flex order (CSS) — lower = higher on screen.
    s.el.style.order = String(-this.seq);
    replayAnim(s.el, "in");
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (s.timer <= 0) continue;
      const before = s.timer;
      s.timer -= dt;
      if (before > LEAVE && s.timer <= LEAVE) s.el.classList.add("leaving");
      if (s.timer <= 0) s.el.classList.remove("show", "leaving");
    }
  }
}

/** Shared instance (CombatHUD / KillstreakHUD post into it). */
let feed: HudFeed | null = null;
export function hudFeed(): HudFeed {
  if (!feed) feed = new HudFeed();
  return feed;
}
