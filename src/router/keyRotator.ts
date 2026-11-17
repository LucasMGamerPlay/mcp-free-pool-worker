export class KeyRotator {
  private index = 0;
  private readonly dead = new Set<number>();

  constructor(private readonly keys: string[]) {}

  current(): string | null {
    for (let offset = 0; offset < this.keys.length; offset += 1) {
      const candidate = (this.index + offset) % this.keys.length;
      if (!this.dead.has(candidate)) {
        this.index = candidate;
        return this.keys[candidate];
      }
    }
    return null;
  }

  rotate(): string | null {
    if (this.keys.length === 0) return null;
    this.index = (this.index + 1) % this.keys.length;
    return this.current();
  }

  killCurrent(): void {
    if (this.keys.length > 0) this.dead.add(this.index);
  }

  get available(): number {
    return this.keys.length - this.dead.size;
  }
}
