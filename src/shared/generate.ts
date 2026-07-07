import type { LayerType } from './types';

export interface GenParams {
  typeCount: number;
  /** Blocks of each type on the wall (same number for every type). */
  layersPerType: number;
  columnCount: number;
  deckSlots: number;
  /** Initial ball supply size. */
  ballCount: number;
}

/** Deterministic PRNG (mulberry32) so generated content is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scatter the pool (typeCount x layersPerType blocks) onto the wall as short
 * vertical runs, keeping column heights balanced. Columns are TOP-to-BOTTOM.
 */
export function generateWall(p: GenParams, rand: () => number): LayerType[][] {
  const runs: { type: LayerType; len: number }[] = [];
  for (let t = 0; t < p.typeCount; t++) {
    let left = p.layersPerType;
    while (left > 0) {
      const len = Math.min(left, 1 + Math.floor(rand() * 3)); // runs of 1..3
      runs.push({ type: t, len });
      left -= len;
    }
  }
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }

  const columns: LayerType[][] = Array.from({ length: p.columnCount }, () => []);
  for (const run of runs) {
    // Shortest column first (random tiebreak); avoid extending a same-type run.
    const order = columns
      .map((c, i) => ({ i, len: c.length, r: rand() }))
      .sort((a, b) => a.len - b.len || a.r - b.r);
    let target = order[0].i;
    for (const { i } of order) {
      const c = columns[i];
      if (c.length === 0 || c[c.length - 1] !== run.type) {
        target = i;
        break;
      }
    }
    for (let k = 0; k < run.len; k++) columns[target].push(run.type);
  }
  return columns;
}

/**
 * A ball supply of `ballCount` balls: at least one per type present, the rest
 * uniform random over the level's types, shuffled.
 */
export function generateBalls(p: GenParams, rand: () => number): LayerType[] {
  const balls: LayerType[] = [];
  for (let t = 0; t < p.typeCount && balls.length < p.ballCount; t++) balls.push(t);
  while (balls.length < p.ballCount) balls.push(Math.floor(rand() * p.typeCount));
  for (let i = balls.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [balls[i], balls[j]] = [balls[j], balls[i]];
  }
  return balls;
}
