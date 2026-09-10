/**
 * Keyboard + mouse input with pointer lock.
 * Movement code reads state through this class only — never from DOM events directly.
 *
 * MELEE BINDING ("A" key) — centralized here to avoid any input conflict:
 * movement uses PHYSICAL key codes (KeyW/KeyA/KeyS/KeyD positions), so on
 * AZERTY keyboards the key labeled "A" is the physical "KeyQ" position while
 * the "KeyA" CODE is the strafe-left binding (labeled "Q" on AZERTY).
 * Melee therefore triggers on the "A" KEY VALUE (layout-aware) or the
 * physical "KeyQ" code, and NEVER on the "KeyA" code — this guarantees the
 * melee attack and strafe-left can never fire from the same key press.
 */
/**
 * Pointer-lock spike filter (long-standing Chromium/Windows bug):
 * movementX/Y occasionally report a huge ABSOLUTE-coordinate jump packed
 * into a SINGLE mousemove event (often right after (re)locking, sometimes
 * sporadically mid-game) — thousands of px in one event whips the camera
 * a full 360°. Real motion is spread across many events (mousemove is
 * coalesced to roughly once per frame), so:
 *   - an event above SPIKE_HARD px is physically impossible → dropped;
 *   - an event above SPIKE_MIN px that is ALSO SPIKE_RATIO× larger than
 *     the previous ACCEPTED event is an isolated spike → dropped (a real
 *     flick ramps up — consecutive events have comparable magnitudes,
 *     so fast legitimate motion always passes the ratio check).
 */
const SPIKE_MIN = 350;
const SPIKE_RATIO = 8;
const SPIKE_HARD = 2000;

export class InputManager {
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>(); // edge-triggered, cleared each frame
  private mouseButtons = new Set<number>();
  private mousePressed = new Set<number>(); // edge-triggered, cleared each frame
  private meleePressed = false; // edge-triggered virtual action, cleared each frame
  /** Physical code currently holding the melee action down (null = released). */
  private meleeHeldCode: string | null = null;
  /** |dx|+|dy| of the last ACCEPTED mousemove event (spike detector). */
  private lastMoveMag = 0;

  mouseDX = 0;
  mouseDY = 0;
  pointerLocked = false;
  /** Signed wheel notches this frame (+1 = down/away, -1 = up/toward). */
  private wheelDelta = 0;

  constructor(private lockTarget: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keysDown.add(e.code);
      this.keysPressed.add(e.code);
      if (this.isMeleeEvent(e)) {
        this.meleePressed = true;
        this.meleeHeldCode = e.code;
      }
      if (e.code === "Space") e.preventDefault();
    });

    window.addEventListener("keyup", (e) => {
      this.keysDown.delete(e.code);
      if (e.code === this.meleeHeldCode) this.meleeHeldCode = null;
    });

    window.addEventListener("blur", () => {
      this.keysDown.clear();
      this.keysPressed.clear();
      this.mouseButtons.clear();
      this.mousePressed.clear();
      this.meleePressed = false;
      this.meleeHeldCode = null;
    });

    window.addEventListener("mousedown", (e) => {
      if (!this.pointerLocked) return;
      this.mouseButtons.add(e.button);
      this.mousePressed.add(e.button);
    });

    window.addEventListener("mouseup", (e) => {
      this.mouseButtons.delete(e.button);
    });

    // Mouse wheel: accumulated per frame (weapon slot cycling). Only while
    // the pointer is locked — the menus keep their native scrolling.
    window.addEventListener(
      "wheel",
      (e) => {
        if (!this.pointerLocked) return;
        e.preventDefault();
        this.wheelDelta += Math.sign(e.deltaY);
      },
      { passive: false },
    );

    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      // Spike filter — see the constants above. lastMoveMag is NOT updated
      // on a rejected event, so consecutive spikes are all filtered.
      const mag = Math.abs(e.movementX) + Math.abs(e.movementY);
      if (mag > SPIKE_HARD) return;
      if (mag > SPIKE_MIN && mag > this.lastMoveMag * SPIKE_RATIO) return;
      this.lastMoveMag = mag;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.lockTarget;
      // Spikes are most frequent right after (re)acquiring the lock: with
      // the detector reset, the very first event is compared against 0 —
      // anything above SPIKE_MIN gets dropped (a real first move never is).
      this.lastMoveMag = 0;
      if (!this.pointerLocked) {
        this.keysDown.clear();
        this.keysPressed.clear();
        this.mouseButtons.clear();
        this.mousePressed.clear();
        this.meleePressed = false;
        this.meleeHeldCode = null;
      }
    });
  }

  /**
   * "A" key, layout-aware and conflict-free:
   * - the "KeyA" CODE is reserved for strafe-left → never melee;
   * - key VALUE "a" (AZERTY "A" key emits code "KeyQ" + value "a") → melee;
   * - physical "KeyQ" code as a fallback for other layouts.
   */
  private isMeleeEvent(e: KeyboardEvent): boolean {
    if (e.code === "KeyA") return false; // strafe-left binding: never melee
    return e.code === "KeyQ" || e.key.toLowerCase() === "a";
  }

  requestPointerLock(): void {
    this.lockTarget.requestPointerLock();
  }

  isDown(code: string): boolean {
    return this.keysDown.has(code);
  }

  /** Mouse button held? 0 = left, 1 = middle, 2 = right. */
  isMouseDown(button = 0): boolean {
    return this.mouseButtons.has(button);
  }

  /** True only on the frame the key went down. */
  wasPressed(code: string): boolean {
    return this.keysPressed.has(code);
  }

  /** True only on the frame the mouse button went down. 0 = left, 2 = right. */
  wasMousePressed(button = 0): boolean {
    return this.mousePressed.has(button);
  }

  /** True only on the frame the melee key ("A") went down. */
  wasMeleePressed(): boolean {
    return this.meleePressed;
  }

  /** True while the melee key ("A") is physically held down. */
  isMeleeDown(): boolean {
    return this.meleeHeldCode !== null;
  }

  /** Wheel notches accumulated this frame (0 when the wheel did not move). */
  wheelSteps(): number {
    return this.wheelDelta;
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.keysPressed.clear();
    this.mousePressed.clear();
    this.meleePressed = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
  }
}