import { MedalType } from "./MedalType";

/**
 * Simple FIFO of medals awaiting presentation. Medals are NEVER shown on
 * top of each other — the MedalManager drains this queue one medal at a
 * time with fast transitions.
 */
export class MedalQueue {
  private readonly items: MedalType[] = [];

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  push(medal: MedalType): void {
    this.items.push(medal);
  }

  shift(): MedalType | undefined {
    return this.items.shift();
  }

  clear(): void {
    this.items.length = 0;
  }
}