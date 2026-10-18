import { hudFeed } from "./HudFeed";

/** A HUD part with STATE (leaderboard…) warmed through its own API. */
export interface HudWarmupHook {
  /** Put the part in its rare states (called once the DOM states are set). */
  show(): void;
  /** Back to its exact initial state (always called, even on failure). */
  hide(): void;
}

/**
 * LOAD-TIME HUD WARM-UP — every RARE HUD state (kill medal, BEANED! sticker,
 * combo tag, killstreak READY capsules, hitmarker, damage numbers, damage /
 * low-HP / heal vignettes, death screen…) is drawn for a few frames while the
 * loading screen is still up: above it, at 0.4 % opacity (invisible — at most
 * one level out of 255 on a pixel).
 *
 * Why: the FIRST time the browser draws a new kind of effect (conic / radial
 * gradients behind a mask, blurred shadows, stroked text, SVG filters) its
 * GPU rasterizer compiles new shaders (D3D11 on Windows: tens of ms each) and
 * builds the text / SVG caches — on the first kill that landed as 100-175 ms
 * frames without any game-code cost. Paid here, during the loading, instead.
 *
 * Pure DOM, no game state: every class / text / inline style touched here is
 * recorded and restored exactly (the HUD classes never notice). Parts with a
 * state of their own (the leaderboard) come as `hooks`.
 */
export async function warmUpHud(hooks: readonly HudWarmupHook[] = []): Promise<void> {
  if (document.hidden) return; // no frames would come: nothing to warm
  const patch = new DomPatch();
  const shown: HudWarmupHook[] = [];
  try {
    hudFeed(); // the 3 pooled stickers exist from now on
    patch.add(document.documentElement, "hud-warm");

    // Medal badge: every art at once, all stars, the HYPE glow, the pop.
    const medal = byId("medal-display");
    patch.remove(medal, "hidden");
    patch.add(medal, "stars-3", "hype");
    patch.add(medal?.querySelector(".md-body"), "pop-a");
    medal?.querySelectorAll(".md-icon").forEach((el) => patch.add(el, "on"));
    patch.text(medal?.querySelector(".md-label"), "TRIPLE KILL");

    // Event feed: one sticker of each flavour.
    const feed: [string, string, string][] = [
      ["kill", "BEANED!", ""],
      ["streak", "MOLE STRIKE READY", "[W]"],
      ["heal", "+35 HP", ""],
    ];
    document.querySelectorAll("#event-feed .feed-sticker").forEach((el, i) => {
      const [kind, title, sub] = feed[i % feed.length];
      patch.add(el, "show", `feed-${kind}`, "in-a");
      patch.text(el.querySelector(".feed-title"), title);
      patch.text(el.querySelector(".feed-sub"), sub);
    });

    // Combo tag (hottest tier, blinking rope, swing).
    patch.add(byId("combo-hud"), "show", "tier-3", "ending");
    patch.add(byId("combo-tag"), "swing-a");

    // Killstreak capsules in their READY look.
    const ks = byId("killstreak-hud");
    patch.remove(ks, "hidden");
    ks?.querySelectorAll(".ks-cap").forEach((cap) => {
      patch.add(cap, "on", "ready", "pulse-a");
      const count = cap.querySelector(".ks-count");
      if (count && !count.textContent) patch.text(count, "3/3");
      const key = cap.querySelector(".ks-key");
      if (key && !key.textContent) patch.text(key, "W");
    });

    // Aim point: fire kick, KILL hitmarker, LOW AMMO ticker.
    patch.add(byId("crosshair"), "cx-firing");
    patch.add(byId("hitmarker"), "hm-kill");
    const ticker = byId("aim-ticker");
    patch.add(ticker, "show", "low");
    patch.text(ticker, "LOW AMMO");

    // Damage numbers: a body tick and a headshot kill (temporary nodes).
    const numbers = byId("damage-numbers");
    if (numbers) {
      ["dmg-num", "dmg-num dmg-head dmg-kill"].forEach((cls, i) => {
        const el = document.createElement("div");
        el.className = cls;
        el.style.display = "block";
        el.style.transform = `translate(${40 + i * 12}vw, 40vh)`;
        const inner = document.createElement("span");
        inner.className = "dmg-num-inner dmg-pop";
        inner.textContent = "100";
        el.appendChild(inner);
        patch.append(numbers, el);
      });
    }

    // Screen feedback: vignettes, a damage bite, heal / phase glows, the
    // knockdown banner, the heal "+N", the death card, every buddy face.
    for (const id of ["damage-vignette", "lowhp-vignette", "heal-flash", "phase-overlay"]) {
      patch.style(byId(id), "opacity", "1");
    }
    patch.style(document.querySelector<HTMLElement>("#damage-dir-container .damage-dir"), "opacity", "1");
    patch.remove(byId("knockdown-hint"), "hidden");
    patch.remove(byId("heal-feedback"), "hidden");
    patch.remove(byId("death-screen"), "hidden");
    patch.add(byId("bean-buddy"), "mood-worried", "mood-panic", "mood-dead", "ouch");

    for (const hook of hooks) {
      shown.push(hook);
      hook.show();
    }

    await frames(4);
  } finally {
    for (let i = shown.length - 1; i >= 0; i--) {
      try {
        shown[i].hide();
      } catch (err) {
        console.error("[hud warm-up]", err);
      }
    }
    patch.restore();
  }
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** `n` rendered frames (style, layout, paint, raster) — bounded by a timeout. */
function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const timer = window.setTimeout(resolve, 100 * n);
    const step = (): void => {
      if (--left <= 0) {
        window.clearTimeout(timer);
        resolve();
      } else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** DOM edits recorded with their exact undo, restored in reverse order. */
class DomPatch {
  private readonly undo: (() => void)[] = [];

  add(el: Element | null | undefined, ...names: string[]): void {
    if (!el) return;
    for (const name of names) {
      if (el.classList.contains(name)) continue;
      el.classList.add(name);
      this.undo.push(() => el.classList.remove(name));
    }
  }

  remove(el: Element | null | undefined, ...names: string[]): void {
    if (!el) return;
    for (const name of names) {
      if (!el.classList.contains(name)) continue;
      el.classList.remove(name);
      this.undo.push(() => el.classList.add(name));
    }
  }

  style(el: HTMLElement | null | undefined, prop: string, value: string): void {
    if (!el) return;
    const prev = el.style.getPropertyValue(prop);
    const priority = el.style.getPropertyPriority(prop);
    el.style.setProperty(prop, value);
    this.undo.push(() => {
      if (prev) el.style.setProperty(prop, prev, priority);
      else el.style.removeProperty(prop);
    });
  }

  text(el: Element | null | undefined, text: string): void {
    if (!el) return;
    const prev = el.textContent ?? "";
    if (prev === text) return;
    el.textContent = text;
    this.undo.push(() => {
      el.textContent = prev;
    });
  }

  append(parent: Element, child: Element): void {
    parent.appendChild(child);
    this.undo.push(() => child.remove());
  }

  restore(): void {
    for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i]();
    this.undo.length = 0;
  }
}
