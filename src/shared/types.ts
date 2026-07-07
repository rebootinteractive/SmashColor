/** A block's / ball's type is an index into the PALETTE (shared/colors.ts). */
export type LayerType = number;

export interface LevelData {
  id: string;
  name: string;
  /** Number of deck (hold) slots below the shooting point. */
  deckSlots: number;
  /** One entry per column (left to right), block types TOP-to-BOTTOM. */
  columns: LayerType[][];
  /** The full ball supply in order — balls[0] starts at the shooting point. */
  balls: LayerType[];
  /** Editor pool parameter (layers per type), persisted for re-editing. */
  layersPerType?: number;
}

export function totalBlocks(level: LevelData): number {
  return level.columns.reduce((n, c) => n + c.length, 0);
}

/** Distinct types used by a level (balls + blocks). */
export function typeCount(level: LevelData): number {
  const s = new Set<number>();
  for (const t of level.balls) s.add(t);
  for (const c of level.columns) for (const t of c) s.add(t);
  return s.size;
}
