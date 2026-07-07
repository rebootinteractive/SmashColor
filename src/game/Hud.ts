export interface HudOptions {
  levelName: string;
  totalBalls: number;
  totalBlocks: number;
  onMenu(): void;
  onRestart(): void;
  onNext?: () => void;
}

/** HTML overlay above the canvas: top bar, counters, win/lose modals. */
export class Hud {
  private root: HTMLDivElement;
  private modalEl: HTMLDivElement | null = null;
  private ballsEl: HTMLElement;
  private blocksEl: HTMLElement;

  constructor(private parent: HTMLElement, private opts: HudOptions) {
    this.root = document.createElement('div');
    this.root.className = 'overlay';
    this.root.innerHTML = `
      <div class="hud-top">
        <button class="btn ghost small" data-act="menu">← Levels</button>
        <div class="hud-title">${escapeHtml(opts.levelName)}</div>
        <button class="btn ghost small" data-act="restart">↻</button>
      </div>
      <div class="hud-counters">
        <span class="hud-pill">🧱 <strong data-el="blocks">${opts.totalBlocks}</strong></span>
        <span class="hud-pill">⚪ <strong data-el="balls">${opts.totalBalls}</strong></span>
      </div>`;
    parent.appendChild(this.root);
    this.ballsEl = this.root.querySelector('[data-el="balls"]')!;
    this.blocksEl = this.root.querySelector('[data-el="blocks"]')!;
    this.root.querySelector('[data-act="menu"]')!.addEventListener('click', () => opts.onMenu());
    this.root
      .querySelector('[data-act="restart"]')!
      .addEventListener('click', () => opts.onRestart());
  }

  setCounts(blocks: number, balls: number): void {
    this.blocksEl.textContent = String(blocks);
    this.ballsEl.textContent = String(balls);
    this.ballsEl.parentElement!.classList.toggle('warn', balls <= 2 && blocks > 0);
  }

  showWin(): void {
    this.showModal(
      'win',
      'Wall Smashed!',
      'Every layer blasted away. Clean shooting.',
      this.opts.onNext
        ? [
            { label: 'Next Level', cls: 'btn', act: this.opts.onNext },
            { label: 'Menu', cls: 'btn ghost', act: this.opts.onMenu },
          ]
        : [{ label: 'Menu', cls: 'btn', act: this.opts.onMenu }]
    );
  }

  showLose(): void {
    this.showModal('lose', 'Out of Balls!', 'The wall still stands. Plan the blasts better.', [
      { label: 'Retry', cls: 'btn', act: this.opts.onRestart },
      { label: 'Menu', cls: 'btn ghost', act: this.opts.onMenu },
    ]);
  }

  private showModal(
    kind: 'win' | 'lose',
    title: string,
    sub: string,
    actions: { label: string; cls: string; act(): void }[]
  ): void {
    if (this.modalEl) return;
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal';
    const card = document.createElement('div');
    card.className = `modal-card endgame ${kind}`;
    card.innerHTML = `<h1>${title}</h1><p>${sub}</p>`;
    const row = document.createElement('div');
    row.className = 'modal-actions';
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = a.cls;
      b.textContent = a.label;
      b.addEventListener('click', () => a.act());
      row.appendChild(b);
    }
    card.appendChild(row);
    this.modalEl.appendChild(card);
    this.parent.appendChild(this.modalEl);
  }

  dispose(): void {
    this.modalEl?.remove();
    this.modalEl = null;
    this.root.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
