# SmashColor — approved design (2026-07-07)

Inspired by Bubble Shooter and Smash Fest, plus a reference scene of colored
slabs stacked in columns on rods.

## What the player sees and does

- A flat wall of colored slabs: a grid of columns, each column a stack anchored
  at the top.
- Below it: a shooting point holding the active ball, a visible queue of
  upcoming balls, and a row of deck slots.
- Tap **any slab** on the wall to shoot the active ball at it.
  - Same color → that slab and every connected same-color slab
    (up/down/left/right) blasts away.
  - Wrong color → the ball bounces off, wasted.
- After a blast, pistons push each column's remaining slabs **upward** (reverse
  gravity) to close the gaps — creating new color clusters.

## The deck

- Tap an empty deck slot to stash the active ball.
- Tap a stashed ball to make it active. Whatever was active returns to where it
  came from: front of the queue, or its origin deck slot (any empty slot if the
  origin is taken).
- Holding colors while the wall compacts into bigger clusters is the core
  strategy — the ball supply is limited.

## Win / lose

- Win: wall fully cleared.
- Lose: all balls spent (queue + deck + active empty) with slabs remaining →
  fail modal with restart.

## Menu

Level select (built-in + contributed + local custom levels) + level editor.

## Level editor (assisted, two pages)

1. **Setup page** — the pool: color type count, layers per type (one number for
   all types), column count, deck slot count, initial ball count.
2. **Wall + balls page** — a randomize tool distributes the pool onto the wall;
   manual repainting in **layer mode** (single slab) or **group mode** (a
   vertical same-color run). Status line tracks per-color counts against the
   pool target (soft warning, not blocking). Ball queue: distribute tool plus
   free manual add / remove / reorder.
- Export: Test in place, Copy JSON, Download (drop into
  `src/levels/contributed/`), Save to localStorage.

## Ships in v1

3 starter levels (first tutorial-trivial), the editor, GitHub Pages deploy,
phone-frame viewport.
