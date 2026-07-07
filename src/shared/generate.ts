import type { LayerType } from './types';

export interface GenParams {
  typeCount: number;
  /** Blocks of each type on the wall (same number for every type). */
  layersPerType: number;
  columnCount: number;
  deckSlots: number;
  /** Initial ball supply size. */
  ballCount: number;
  /** Bounds on the size of each same-color adjacency group. */
  minGroup: number;
  maxGroup: number;
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

/** Can `total` be split into parts of size [lo, hi]? */
export function groupsFeasible(total: number, lo: number, hi: number): boolean {
  return Math.ceil(total / hi) <= Math.floor(total / lo);
}

/** Split N into random parts within [lo, hi]. Relaxes lo to 1 when infeasible. */
function decompose(N: number, lo: number, hi: number, rand: () => number): number[] {
  if (!groupsFeasible(N, lo, hi)) lo = 1;
  const sizes: number[] = [];
  let left = N;
  while (left > 0) {
    let s = lo + Math.floor(rand() * (Math.min(hi, left) - lo + 1));
    const rest = left - s;
    if (rest > 0 && rest < lo) {
      // leftover would be too small — take everything or leave a valid remainder
      s = left <= hi ? left : left - lo;
    }
    sizes.push(s);
    left -= s;
  }
  return sizes;
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 2D organic wall distribution. The wall is treated as a (jagged) grid; the
 * pool is split into groups of [minGroup, maxGroup] blocks, and each group is
 * grown as a connected blob across BOTH axes from a seed cell — random growth
 * gives organic shapes with ins and outs. Growth avoids touching same-color
 * blobs so groups stay within their size bounds where possible. Columns are
 * returned TOP-to-BOTTOM.
 *
 * Runs several full candidates and returns the one with the fewest group-size
 * violations (with few colors some violations are unavoidable — two groups of
 * the same color that touch merge into one adjacency group).
 */
export function generateWall(p: GenParams, rand: () => number): LayerType[][] {
  let best: LayerType[][] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < 8; i++) {
    const wall = generateWallOnce(p, rand);
    const score = violationScore(wall, p);
    if (score < bestScore) {
      bestScore = score;
      best = wall;
      if (score === 0) break;
    }
  }
  return best!;
}

/** Number of adjacency groups outside [minGroup, maxGroup]. */
function violationScore(columns: LayerType[][], p: GenParams): number {
  const lo = Math.max(1, Math.min(p.minGroup, p.maxGroup));
  const hi = Math.max(lo, p.maxGroup);
  const seen = new Set<string>();
  let bad = 0;
  for (let c = 0; c < columns.length; c++) {
    for (let r = 0; r < columns[c].length; r++) {
      const key = `${c},${r}`;
      if (seen.has(key)) continue;
      const type = columns[c][r];
      let size = 0;
      const stack: [number, number][] = [[c, r]];
      while (stack.length > 0) {
        const [cc, rr] = stack.pop()!;
        const k = `${cc},${rr}`;
        if (seen.has(k) || columns[cc]?.[rr] !== type) continue;
        seen.add(k);
        size++;
        stack.push([cc - 1, rr], [cc + 1, rr], [cc, rr - 1], [cc, rr + 1]);
      }
      if (size < lo || size > hi) bad++;
    }
  }
  return bad;
}

function generateWallOnce(p: GenParams, rand: () => number): LayerType[][] {
  const total = p.typeCount * p.layersPerType;
  const lo = Math.max(1, Math.min(p.minGroup, p.maxGroup));
  const hi = Math.max(lo, p.maxGroup);

  // Column heights: as balanced as possible, extras on random columns.
  const base = Math.floor(total / p.columnCount);
  const heights = new Array<number>(p.columnCount).fill(base);
  const extraCols = shuffle(Array.from({ length: p.columnCount }, (_, i) => i), rand);
  for (let i = 0; i < total % p.columnCount; i++) heights[extraCols[i]]++;

  // -1 = unassigned. grid[col][row], row 0 = top.
  const grid: number[][] = heights.map((h) => new Array<number>(h).fill(-1));
  const inBounds = (c: number, r: number) =>
    c >= 0 && c < p.columnCount && r >= 0 && r < heights[c];
  const neighbors = (c: number, r: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const [nc, nr] of [[c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1]] as [number, number][]) {
      if (inBounds(nc, nr)) out.push([nc, nr]);
    }
    return out;
  };
  const unassignedCells = (): [number, number][] => {
    const out: [number, number][] = [];
    for (let c = 0; c < p.columnCount; c++)
      for (let r = 0; r < heights[c]; r++) if (grid[c][r] === -1) out.push([c, r]);
    return out;
  };

  // The pool as shuffled groups.
  const groups: { type: LayerType; size: number }[] = [];
  for (let t = 0; t < p.typeCount; t++) {
    for (const size of decompose(p.layersPerType, lo, hi, rand)) groups.push({ type: t, size });
  }
  shuffle(groups, rand);

  const touchesType = (c: number, r: number, type: LayerType) =>
    neighbors(c, r).some(([nc, nr]) => grid[nc][nr] === type);

  /**
   * Grow one connected blob of `size` on unassigned cells. With hardAvoid the
   * blob refuses to touch existing same-color cells (no merging past
   * maxGroup) and fails instead — the caller retries or relaxes.
   */
  const growBlob = (
    type: LayerType,
    size: number,
    attempt: number,
    hardAvoid: boolean
  ): [number, number][] | null => {
    let open = unassignedCells();
    if (open.length < size) return null;
    if (hardAvoid) {
      const clean = open.filter(([c, r]) => !touchesType(c, r, type));
      if (clean.length === 0) return null;
      open = clean;
    }
    // Seed in tight pockets first (fewest unassigned neighbors) so no orphan
    // holes are left behind; later attempts seed more randomly.
    const scored = open
      .map(([c, r]) => ({
        c,
        r,
        free: neighbors(c, r).filter(([nc, nr]) => grid[nc][nr] === -1).length,
        rnd: rand(),
      }))
      .sort((a, b) => a.free - b.free || a.rnd - b.rnd);
    const pick = attempt === 0 ? 0 : Math.floor(rand() * Math.min(scored.length, 6));
    const seed: [number, number] = [scored[pick].c, scored[pick].r];

    const blob: [number, number][] = [seed];
    const inBlob = new Set<string>([`${seed[0]},${seed[1]}`]);
    while (blob.length < size) {
      const frontier: [number, number][] = [];
      const seen = new Set<string>();
      for (const [c, r] of blob) {
        for (const [nc, nr] of neighbors(c, r)) {
          const key = `${nc},${nr}`;
          if (grid[nc][nr] !== -1 || inBlob.has(key) || seen.has(key)) continue;
          if (hardAvoid && touchesType(nc, nr, type)) continue;
          seen.add(key);
          frontier.push([nc, nr]);
        }
      }
      if (frontier.length === 0) return null;
      const next = frontier[Math.floor(rand() * frontier.length)];
      blob.push(next);
      inBlob.add(`${next[0]},${next[1]}`);
    }
    return blob;
  };

  const tryPlace = (g: { type: LayerType; size: number }, hardAvoid: boolean, tries: number) => {
    for (let attempt = 0; attempt < tries; attempt++) {
      const blob = growBlob(g.type, g.size, attempt, hardAvoid);
      if (blob) {
        for (const [c, r] of blob) grid[c][r] = g.type;
        return true;
      }
    }
    return false;
  };

  // Round-robin: a group that doesn't fit right now goes to the back of the
  // line — another color may unlock the space. Only when every remaining
  // group is stuck does one get scattered (pool counts stay exact).
  const remaining = [...groups];
  let stall = 0;
  while (remaining.length > 0) {
    const g = remaining.shift()!;
    if (tryPlace(g, true, 14) || (stall > remaining.length && tryPlace(g, false, 10))) {
      stall = 0;
      continue;
    }
    if (stall <= remaining.length) {
      remaining.push(g);
      stall++;
      continue;
    }
    let left = g.size;
    for (const [c, r] of shuffle(unassignedCells(), rand)) {
      if (left === 0) break;
      grid[c][r] = g.type;
      left--;
    }
    stall = 0;
  }

  return grid;
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
