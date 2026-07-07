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

  /** Queue entries with this value are dynamic: their color is decided only
   * when they scroll into view, picking whatever the wall needs most. */
  static readonly DYNAMIC: LayerType = -1;

  constructor(level: LevelData) {
    this.columns = level.columns.map((c) => [...c]);
    this.queue = [
      ...level.balls,
      ...new Array<LayerType>(Math.max(0, level.dynamicBalls ?? 0)).fill(Board.DYNAMIC),
    ];
    this.deck = new Array<LayerType | null>(level.deckSlots).fill(null);
    this.active = null;
    this.refill();
  }

  blockAt(cell: Cell): LayerType | undefined {
    return this.columns[cell.col]?.[cell.row];
  }

  /**
   * Connected same-type region containing `cell` (4-adjacency on the grid).
   * Rows at or beyond `maxRow` are out of play (hidden below the floor) — the
   * blast neither destroys them nor spreads through them.
   */
  region(cell: Cell, maxRow = Number.POSITIVE_INFINITY): Cell[] {
    const type = this.blockAt(cell);
    if (type === undefined || cell.row >= maxRow) return [];
    const seen = new Set<string>();
    const out: Cell[] = [];
    const stack: Cell[] = [cell];
    while (stack.length > 0) {
      const c = stack.pop()!;
      const key = `${c.col},${c.row}`;
      if (seen.has(key)) continue;
      if (c.row >= maxRow) continue;
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
    if (this.queue[0] === Board.DYNAMIC) this.queue[0] = this.neededType();
    this.active = { type: this.queue.shift()!, source: { kind: 'queue' } };
    return true;
  }

  /**
   * Decide the color of any dynamic balls within the first `visible` queue
   * slots. Returns what was decided so the view can recolor the meshes.
   */
  decideDynamic(visible: number): { index: number; type: LayerType }[] {
    const out: { index: number; type: LayerType }[] = [];
    const n = Math.min(visible, this.queue.length);
    for (let i = 0; i < n; i++) {
      if (this.queue[i] !== Board.DYNAMIC) continue;
      const type = this.neededType();
      this.queue[i] = type;
      out.push({ index: i, type });
    }
    return out;
  }

  /**
   * The color the player most needs: every same-color cluster costs one ball,
   * so pick the color with the biggest cluster-count vs. supply deficit
   * (block count breaks ties).
   */
  private neededType(): LayerType {
    const blocks = new Map<LayerType, number>();
    const regions = new Map<LayerType, number>();
    const seen = new Set<string>();
    for (let c = 0; c < this.columns.length; c++) {
      for (let r = 0; r < this.columns[c].length; r++) {
        const t = this.columns[c][r];
        blocks.set(t, (blocks.get(t) ?? 0) + 1);
        if (!seen.has(`${c},${r}`)) {
          for (const cell of this.region({ col: c, row: r })) {
            seen.add(`${cell.col},${cell.row}`);
          }
          regions.set(t, (regions.get(t) ?? 0) + 1);
        }
      }
    }
    if (blocks.size === 0) return 0;

    const supply = new Map<LayerType, number>();
    const addSupply = (t: LayerType | null) => {
      if (t !== null && t !== Board.DYNAMIC) supply.set(t, (supply.get(t) ?? 0) + 1);
    };
    addSupply(this.active?.type ?? null);
    for (const t of this.queue) addSupply(t);
    for (const t of this.deck) addSupply(t);

    let best: LayerType = 0;
    let bestDeficit = -Infinity;
    let bestBlocks = -1;
    for (const [t, n] of blocks) {
      const deficit = (regions.get(t) ?? 0) - (supply.get(t) ?? 0);
      if (deficit > bestDeficit || (deficit === bestDeficit && n > bestBlocks)) {
        best = t;
        bestDeficit = deficit;
        bestBlocks = n;
      }
    }
    return best;
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
