import type { LevelData, LayerType } from '../shared/types';

export interface Cell {
  col: number;
  row: number;
}

export type BallSource = { kind: 'queue' } | { kind: 'deck'; slot: number };

export interface ActiveBall {
  type: LayerType;
  source: BallSource;
}

/** Pure game state + rules. No three.js, no DOM — the views mirror this. */
export class Board {
  /** Block types per column, TOP-to-BOTTOM. Pistons compact toward the top. */
  readonly columns: LayerType[][];
  /** Upcoming balls, leader (next to load) first. */
  readonly queue: LayerType[];
  /** Deck (hold) slots; null = empty. */
  readonly deck: (LayerType | null)[];
  active: ActiveBall | null;

  constructor(level: LevelData) {
    this.columns = level.columns.map((c) => [...c]);
    const balls = [...level.balls];
    this.active = balls.length > 0 ? { type: balls.shift()!, source: { kind: 'queue' } } : null;
    this.queue = balls;
    this.deck = new Array<LayerType | null>(level.deckSlots).fill(null);
  }

  blockAt(cell: Cell): LayerType | undefined {
    return this.columns[cell.col]?.[cell.row];
  }

  /** Connected same-type region containing `cell` (4-adjacency on the grid). */
  region(cell: Cell): Cell[] {
    const type = this.blockAt(cell);
    if (type === undefined) return [];
    const seen = new Set<string>();
    const out: Cell[] = [];
    const stack: Cell[] = [cell];
    while (stack.length > 0) {
      const c = stack.pop()!;
      const key = `${c.col},${c.row}`;
      if (seen.has(key)) continue;
      if (this.blockAt(c) !== type) continue;
      seen.add(key);
      out.push(c);
      stack.push(
        { col: c.col - 1, row: c.row },
        { col: c.col + 1, row: c.row },
        { col: c.col, row: c.row - 1 },
        { col: c.col, row: c.row + 1 }
      );
    }
    return out;
  }

  /** Remove cells; each column compacts toward the top (order preserved). */
  blast(cells: Cell[]): void {
    const byCol = new Map<number, Set<number>>();
    for (const c of cells) {
      if (!byCol.has(c.col)) byCol.set(c.col, new Set());
      byCol.get(c.col)!.add(c.row);
    }
    for (const [col, rows] of byCol) {
      this.columns[col] = this.columns[col].filter((_, r) => !rows.has(r));
    }
  }

  get cleared(): boolean {
    return this.columns.every((c) => c.length === 0);
  }

  get ballsLeft(): number {
    return (
      (this.active ? 1 : 0) +
      this.queue.length +
      this.deck.filter((b) => b !== null).length
    );
  }

  get lost(): boolean {
    return !this.cleared && this.ballsLeft === 0;
  }

  /** Consume the active ball (a shot); the queue leader auto-loads. */
  consumeActive(): LayerType | null {
    if (!this.active) return null;
    const t = this.active.type;
    this.active = null;
    this.refill();
    return t;
  }

  /** True when the queue leader was loaded into the empty shooting point. */
  refill(): boolean {
    if (this.active || this.queue.length === 0) return false;
    this.active = { type: this.queue.shift()!, source: { kind: 'queue' } };
    return true;
  }

  /** Move the active ball into an empty deck slot; the queue leader loads. */
  stash(slot: number): boolean {
    if (!this.active || this.deck[slot] !== null) return false;
    this.deck[slot] = this.active.type;
    this.active = null;
    this.refill();
    return true;
  }

  /**
   * Make the deck ball at `slot` active. The previous active ball returns to
   * its source: front of the queue, or its origin deck slot (any empty slot
   * when the origin is taken — the freed slot guarantees one exists).
   */
  recall(slot: number): { returned: BallSource | null } | null {
    const ball = this.deck[slot];
    if (ball === null) return null;
    this.deck[slot] = null;
    let returned: BallSource | null = null;
    if (this.active) {
      const src = this.active.source;
      if (src.kind === 'queue') {
        this.queue.unshift(this.active.type);
        returned = { kind: 'queue' };
      } else {
        let s = src.slot;
        if (this.deck[s] !== null) s = this.deck.indexOf(null);
        this.deck[s] = this.active.type;
        returned = { kind: 'deck', slot: s };
      }
    }
    this.active = { type: ball, source: { kind: 'deck', slot } };
    return { returned };
  }
}
