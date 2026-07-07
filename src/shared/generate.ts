import type { LayerType } from './types';

export interface GenParams {
  typeCount: number;
  /** Blocks of each type on the wall (same number for every type). */
  layersPerType: number;
  columnCount: number;
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
  // Bigger walls get fewer candidate runs so generation stays instant.
  const total = p.typeCount * p.layersPerType;
  const candidates = total <= 300 ? 8 : total <= 900 ? 3 : 2;
  let best: LayerType[][] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < candidates; i++) {
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
  const triesHard = total <= 300 ? 14 : 8;
  const triesSoft = total <= 300 ? 10 : 6;

  // Column heights: as balanced as possible, extras on random columns.
  const base = Math.floor(total / p.columnCount);
  const heights = new Array<number>(p.columnCount).fill(base);
  const extraCols = shuffle(Array.from({ length: p.columnCount }, (_, i) => i), rand);
  for (let i = 0; i < total % p.columnCount; i++) heights[extraCols[i]]++;

  // -1 = unassigned. grid[col][row], row 0 = top. Cells encoded col*K+row for
  // cheap set membership.
  const K = 4096;
  const grid: number[][] = heights.map((h) => new Array<number>(h).fill(-1));
  const open = new Set<number>();
  for (let c = 0; c < p.columnCount; c++) for (let r = 0; r < heights[c]; r++) open.add(c * K + r);

  const inBounds = (c: number, r: number) =>
    c >= 0 && c < p.columnCount && r >= 0 && r < heights[c];
  const neighborKeys = (key: number): number[] => {
    const c = Math.floor(key / K);
    const r = key % K;
    const out: number[] = [];
    if (inBounds(c - 1, r)) out.push(key - K);
    if (inBounds(c + 1, r)) out.push(key + K);
    if (inBounds(c, r - 1)) out.push(key - 1);
    if (inBounds(c, r + 1)) out.push(key + 1);
    return out;
  };
  const typeAt = (key: number) => grid[Math.floor(key / K)][key % K];
  const touchesType = (key: number, type: LayerType) =>
    neighborKeys(key).some((k) => typeAt(k) === type);
  const freeNeighbors = (key: number) => neighborKeys(key).filter((k) => open.has(k)).length;

  // The pool as shuffled groups.
  const groups: { type: LayerType; size: number }[] = [];
  for (let t = 0; t < p.typeCount; t++) {
    for (const size of decompose(p.layersPerType, lo, hi, rand)) groups.push({ type: t, size });
  }
  shuffle(groups, rand);

  /**
   * Grow one connected blob of `size` on unassigned cells. With hardAvoid the
   * blob refuses to touch existing same-color cells (no merging past
   * maxGroup) and fails instead — the caller retries or relaxes. The frontier
   * is maintained incrementally (the grid is static during one growth).
   */
  const growBlob = (
    openArr: number[],
    type: LayerType,
    size: number,
    attempt: number,
    hardAvoid: boolean
  ): number[] | null => {
    if (openArr.length < size) return null;
    // Seed from a small random sample, preferring tight pockets (fewest
    // unassigned neighbors) so no orphan holes are left behind.
    let seed = -1;
    let seedScore = Infinity;
    const sample = Math.min(openArr.length, attempt === 0 ? 24 : 10);
    for (let i = 0; i < sample; i++) {
      const key = openArr[Math.floor(rand() * openArr.length)];
      if (hardAvoid && touchesType(key, type)) continue;
      const score = freeNeighbors(key) + rand() * 0.5;
      if (score < seedScore) {
        seedScore = score;
        seed = key;
      }
    }
    if (seed < 0) return null;

    const blob: number[] = [seed];
    const inBlob = new Set<number>([seed]);
    const frontier: number[] = [];
    const inFrontier = new Set<number>();
    const pushNeighbors = (key: number) => {
      for (const nk of neighborKeys(key)) {
        if (!open.has(nk) || inBlob.has(nk) || inFrontier.has(nk)) continue;
        if (hardAvoid && touchesType(nk, type)) continue;
        inFrontier.add(nk);
        frontier.push(nk);
      }
    };
    pushNeighbors(seed);
    while (blob.length < size) {
      if (frontier.length === 0) return null;
      const i = Math.floor(rand() * frontier.length);
      const next = frontier[i];
      frontier[i] = frontier[frontier.length - 1];
      frontier.pop();
      inFrontier.delete(next);
      blob.push(next);
      inBlob.add(next);
      pushNeighbors(next);
    }
    return blob;
  };

  const tryPlace = (g: { type: LayerType; size: number }, hardAvoid: boolean, tries: number) => {
    if (open.size < g.size) return false;
    const openArr = [...open];
    for (let attempt = 0; attempt < tries; attempt++) {
      const blob = growBlob(openArr, g.type, g.size, attempt, hardAvoid);
      if (blob) {
        for (const key of blob) {
          grid[Math.floor(key / K)][key % K] = g.type;
          open.delete(key);
        }
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
    if (tryPlace(g, true, triesHard) || (stall > remaining.length && tryPlace(g, false, triesSoft))) {
      stall = 0;
      continue;
    }
    if (stall <= remaining.length) {
      remaining.push(g);
      stall++;
      continue;
    }
    let left = g.size;
    for (const key of shuffle([...open], rand)) {
      if (left === 0) break;
      grid[Math.floor(key / K)][key % K] = g.type;
      open.delete(key);
      left--;
    }
    stall = 0;
  }

  return grid;
}

/**
 * A ball supply of `count` balls whose color ratio mirrors the wall's actual
 * block counts (largest-remainder rounding), shuffled. Every color present on
 * the wall gets at least one ball when the count allows it.
 */
export function generateBalls(
  count: number,
  columns: LayerType[][],
  rand: () => number
): LayerType[] {
  const blockCounts = new Map<LayerType, number>();
  let total = 0;
  for (const c of columns) {
    for (const t of c) {
      blockCounts.set(t, (blockCounts.get(t) ?? 0) + 1);
      total++;
    }
  }
  if (total === 0) return [];

  const types = [...blockCounts.keys()];
  const alloc = types.map((t) => {
    const quota = (count * blockCounts.get(t)!) / total;
    return { t, n: Math.floor(quota), frac: quota - Math.floor(quota), rnd: rand() };
  });
  let left = count - alloc.reduce((n, a) => n + a.n, 0);
  alloc.sort((a, b) => b.frac - a.frac || a.rnd - b.rnd);
  for (let i = 0; left > 0; i = (i + 1) % alloc.length) {
    alloc[i].n++;
    left--;
  }
  // No color present on the wall should end up unclearable if we can help it.
  if (count >= types.length) {
    for (const zero of alloc.filter((a) => a.n === 0)) {
      const donor = alloc.reduce((m, a) => (a.n > m.n ? a : m), alloc[0]);
      if (donor.n <= 1) break;
      donor.n--;
      zero.n++;
    }
  }

  const balls: LayerType[] = [];
  for (const a of alloc) for (let i = 0; i < a.n; i++) balls.push(a.t);
  for (let i = balls.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [balls[i], balls[j]] = [balls[j], balls[i]];
  }
  return balls;
}
