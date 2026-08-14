/**
 * Keyboard + mouse input with pointer lock.
 * Movement code reads state through this class only — never from DOM events directly.
 */
export class InputManager {
  private keysDown = new Set<string>();
  private keysPressed = new Set<string>(); // edge-triggered, cleared each frame
  private mouseButtons = new Set<number>();

  mouseDX = 0;
  mouseDY = 0;
  pointerLocked = false;

  constructor(private lockTarget: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this.keysDown.add(e.code);
      this.keysPressed.add(e.code);
      if (e.code === "Space") e.preventDefault();
    });

    window.addEventListener("keyup", (e) => {
      this.keysDown.delete(e.code);
    });

    window.addEventListener("blur", () => {
      this.keysDown.clear();
      this.keysPressed.clear();
      this.mouseButtons.clear();
    });

    window.addEventListener("mousedown", (e) => {
      if (!this.pointerLocked) return;
      this.mouseButtons.add(e.button);
    });

    window.addEventListener("mouseup", (e) => {
      this.mouseButtons.delete(e.button);
    });

    document.addEventListener("mousemove", (e) => {
      if (!this.pointerLocked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener("pointerlockchange", () => {
      this.pointerLocked = document.pointerLockElement === this.lockTarget;
      if (!this.pointerLocked) {
        this.keysDown.clear();
        this.keysPressed.clear();
        this.mouseButtons.clear();
      }
    });
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

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.keysPressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}