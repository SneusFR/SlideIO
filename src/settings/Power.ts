/**
 * POWER STATE — whether the laptop runs on its battery, for the Auto guard
 * (settings/AutoGuard). Measured on the owner's laptop, same scene: on
 * battery the main thread takes ~2.8× longer per frame (7 ms vs 2.5 ms) and
 * the GPU ~20 % longer; plugged in, 60 FPS hold. A step the guard takes on
 * battery says nothing about the next session on the charger.
 *
 * Source: the Battery Status API (`navigator.getBattery()`: Chrome / Edge,
 * secure pages only), feature-detected and NEVER waited for — "unknown"
 * until it answers, and for good without it (Firefox, Safari, an http page,
 * a refusal, `?diag=nopowerguard`): "unknown" is the guard's behaviour
 * without power awareness. A desktop reports `charging: true` (no battery):
 * mains.
 */
export type PowerState = "battery" | "mains" | "unknown";

export const POWER_STATES: readonly PowerState[] = ["battery", "mains", "unknown"];

/** Where the controller reads the power state (the browser's API; a fake in the tests). */
export interface PowerSource {
  /** The state now ("unknown" while not known). */
  readonly state: PowerState;
  /** Called on every change of state (the API's first answer, a charger plugged in or out). */
  subscribe(listener: (state: PowerState) => void): () => void;
}

/** No power information: the guard behaves as without power awareness. */
export const UNKNOWN_POWER: PowerSource = {
  state: "unknown",
  subscribe: () => () => {},
};

/** What the page needs of a BatteryManager (not in TypeScript's DOM library). */
interface BatteryLike {
  readonly charging: boolean;
  addEventListener(type: "chargingchange", listener: () => void): void;
}

/**
 * The browser's power state: `navigator.getBattery()` when the page may use
 * it, read once it answers and on each `chargingchange`. Never throws, never
 * blocks the caller.
 */
export function browserPower(nav: unknown = typeof navigator === "undefined" ? undefined : navigator): PowerSource {
  let state: PowerState = "unknown";
  const listeners: ((s: PowerState) => void)[] = [];
  /** Kept referenced while its listener lives (an event target nobody holds could be collected). */
  let battery: BatteryLike | null = null;
  const set = (next: PowerState) => {
    if (next === state) return;
    state = next;
    for (const l of [...listeners]) l(next);
  };
  const getBattery = (nav as { getBattery?: unknown } | null | undefined)?.getBattery;
  if (typeof getBattery === "function") {
    try {
      Promise.resolve((getBattery as () => Promise<BatteryLike>).call(nav)).then(
        (b) => {
          if (!b || typeof b.charging !== "boolean") return;
          battery = b;
          const read = () => {
            const c = battery?.charging;
            set(c === false ? "battery" : c === true ? "mains" : "unknown");
          };
          read();
          b.addEventListener("chargingchange", read);
        },
        () => {}, // refused (permissions policy, insecure page): unknown for good
      );
    } catch {
      // unknown for good
    }
  }
  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}
