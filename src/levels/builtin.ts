import type { LevelData } from '../shared/types';

/**
 * All three levels were verified winnable with a solver (see the design spec).
 * Level 1 clears with straight shooting; level 2 requires holding a ball in
 * the deck; level 3 is a full wall with a tight ball budget.
 */

const level1: LevelData = {
  id: 'l1-first-smash',
  name: 'First Smash',
  deckSlots: 2,
  columns: [
    [0, 0, 1],
    [0, 1, 1],
    [0, 0, 1],
  ],
  balls: [0, 1, 0],
};

const level2: LevelData = {
  id: 'l2-hold-the-line',
  name: 'Hold the Line',
  deckSlots: 2,
  columns: [
    [1, 0, 0, 2],
    [0, 0, 1, 2],
    [1, 0, 2, 2],
    [0, 0, 1, 2],
  ],
  balls: [1, 0, 2, 1, 1],
};

const level3: LevelData = {
  id: 'l3-the-big-wall',
  name: 'The Big Wall',
  deckSlots: 3,
  layersPerType: 12,
  columns: [
    [2, 2, 2, 1, 1, 0, 0, 0],
    [1, 3, 3, 0, 3, 3, 3],
    [3, 3, 2, 2, 2, 0, 1, 1, 1],
    [2, 2, 3, 3, 3, 1, 2, 2],
    [1, 1, 1, 0, 0, 0, 2],
    [2, 0, 3, 3, 1, 1, 0, 0, 0],
  ],
  balls: [2, 3, 2, 2, 0, 0, 2, 2, 1, 3, 1],
};

export const BUILTIN_LEVELS: LevelData[] = [level1, level2, level3];
