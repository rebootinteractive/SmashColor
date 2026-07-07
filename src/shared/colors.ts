/** Block type palette — a LayerType indexes into this. Read-only constants. */
export const PALETTE: number[] = [
  0xff4fa8, // 0 pink
  0x8b46f0, // 1 purple
  0x2f7bff, // 2 blue
  0x18a26e, // 3 green
  0xffd23f, // 4 yellow
  0xff8c1a, // 5 orange
  0xff3b3b, // 6 red
  0x58e1c4, // 7 teal
];

export const MAX_TYPES = PALETTE.length;

export function colorHexCss(type: number): string {
  return `#${PALETTE[type % PALETTE.length].toString(16).padStart(6, '0')}`;
}
