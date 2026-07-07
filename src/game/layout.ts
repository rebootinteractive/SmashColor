/** Shared world-layout constants for the wall + shooter + deck (game and editor). */

export const BLOCK_W = 0.92;
export const BLOCK_H = 0.42;
export const BLOCK_D = 0.6;

/** Horizontal distance between column centers. */
export const COL_PITCH = 1.0;

/** World y of the wall's top edge — columns hang downward from here. */
export const WALL_TOP = 0;

/**
 * Rows shown above the floor in the game. Taller columns continue below the
 * floor, hidden, and rise into view as the pistons push them up.
 */
export const VISIBLE_ROWS = 12;

export const BALL_R = 0.32;
export const DECK_PITCH = 0.9;
export const QUEUE_PITCH = 0.52;
/** Max queue balls rendered as meshes (the HUD shows the true count). */
export const QUEUE_VISIBLE = 7;

/** Center x of column c out of `count` (also used for deck slots / queue). */
export function colX(c: number, count: number, pitch = COL_PITCH): number {
  return (c - (count - 1) / 2) * pitch;
}

/** World y of the block at row r (rows count downward from the wall top). */
export function rowY(r: number): number {
  return WALL_TOP - (r + 0.5) * BLOCK_H;
}

/** Shooting point sits below the deepest possible wall extent. */
export function shootYFor(maxRows: number): number {
  return WALL_TOP - maxRows * BLOCK_H - 1.5;
}

export function deckYFor(shootY: number): number {
  return shootY - 1.15;
}

export function queueYFor(deckY: number): number {
  return deckY - 1.05;
}
