import * as THREE from 'three';
import type { LevelData, LayerType } from '../shared/types';
import type { Cell } from '../game/Board';
import { MAX_TYPES, PALETTE, colorHexCss } from '../shared/colors';
import { generateBalls, generateWall, groupsFeasible, mulberry32 } from '../shared/generate';
import { WallView, makeBlockMesh } from '../game/WallView';
import { BLOCK_H, COL_PITCH, WALL_TOP, colX } from '../game/layout';
import { saveCustomLevel } from '../ui/storage';

export interface EditorAppOptions {
  initial?: LevelData;
  onExit(): void;
  onTestPlay(level: LevelData): void;
}

type Mode = 'group' | 'layer' | 'brush';

const MODES: Mode[] = ['group', 'layer', 'brush'];

interface PendingTap {
  cell: Cell;
  sx: number;
  sy: number;
}

interface DragState {
  types: LayerType[];
  fromCol: number;
  fromIdx: number;
  ghost: THREE.Group;
  ghostMeshes: THREE.Mesh[];
  target: { col: number; idx: number } | null;
}

export class EditorApp {
  // three
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rafId = 0;
  private resizeObserver: ResizeObserver;
  private wall: WallView | null = null;
  private marker: THREE.Mesh;
  private markerMat: THREE.MeshBasicMaterial;

  // level state
  private levelId: string;
  private name: string;
  private typeCount = 4;
  private layersPerType = 12;
  private columnCount = 6;
  private deckSlots = 3;
  private ballCount = 12;
  private minGroup = 2;
  private maxGroup = 6;
  private columns: LayerType[][] | null = null;
  private balls: LayerType[] | null = null;
  private wallSig = '';
  private ballsSig = '';
  private mode: Mode = 'group';
  private paint: LayerType = 0;
  private seed = 1;
  private selectedBall: number | null = null;

  // dom
  private root: HTMLDivElement;
  private setupPanel!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private toolbarEl!: HTMLDivElement;
  private ballsBarEl!: HTMLDivElement;
  private bottomEl!: HTMLDivElement;
  private modalEl: HTMLDivElement | null = null;

  // input
  private pending: PendingTap | null = null;
  private drag: DragState | null = null;
  private brushing = false;

  private onPointerDown = (e: PointerEvent) => this.pointerDown(e);
  private onPointerMove = (e: PointerEvent) => this.pointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.pointerUp(e);

  constructor(private parent: HTMLElement, private opts: EditorAppOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xe6e3f4);
    parent.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(2, 5, 7);
    this.scene.add(dir);

    this.markerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.marker = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.7), this.markerMat);
    this.marker.visible = false;
    this.scene.add(this.marker);

    if (opts.initial) {
      const lv = opts.initial;
      this.levelId = lv.id;
      this.name = lv.name;
      this.deckSlots = lv.deckSlots;
      this.minGroup = lv.minGroup ?? 2;
      this.maxGroup = lv.maxGroup ?? 6;
      this.columns = lv.columns.map((c) => [...c]);
      this.balls = [...lv.balls];
      this.columnCount = lv.columns.length;
      this.ballCount = lv.balls.length;
      let maxType = 1;
      for (const c of lv.columns) for (const t of c) maxType = Math.max(maxType, t);
      for (const t of lv.balls) maxType = Math.max(maxType, t);
      this.typeCount = Math.min(MAX_TYPES, maxType + 1);
      this.layersPerType =
        lv.layersPerType ??
        Math.max(1, Math.round(lv.columns.reduce((n, c) => n + c.length, 0) / this.typeCount));
    } else {
      this.levelId = `custom-${Date.now()}`;
      this.name = 'My Level';
    }
    this.wallSig = this.sigWall();
    this.ballsSig = this.sigBalls();

    this.root = document.createElement('div');
    this.root.className = 'overlay';
    parent.appendChild(this.root);
    this.buildChrome();
    this.buildSetupPanel();
    if (opts.initial) this.enterWall();
    else this.showSetup();

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.addEventListener('pointercancel', this.onPointerUp);

    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(parent);
    this.handleResize();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private sigWall(): string {
    return `${this.typeCount}|${this.layersPerType}|${this.columnCount}|${this.minGroup}|${this.maxGroup}`;
  }
  private sigBalls(): string {
    return `${this.typeCount}|${this.ballCount}`;
  }
  private genParams() {
    return {
      typeCount: this.typeCount,
      layersPerType: this.layersPerType,
      columnCount: this.columnCount,
      deckSlots: this.deckSlots,
      ballCount: this.ballCount,
      minGroup: this.minGroup,
      maxGroup: this.maxGroup,
    };
  }
  private nextRand(): () => number {
    this.seed = ((this.seed * 1103515245 + 12345) >>> 0) ^ (Date.now() & 0xffff);
    return mulberry32(this.seed);
  }

  // ---- page 1: setup ---------------------------------------------------------

  private buildSetupPanel(): void {
    this.setupPanel = document.createElement('div');
    this.setupPanel.className = 'setup-panel';
    this.root.appendChild(this.setupPanel);
    this.renderSetup();
  }

  private renderSetup(): void {
    this.setupPanel.innerHTML = `
      <div class="menu-title">Level Setup</div>
      <div class="menu-sub">Page 1 of 2 — define the pool: how much of each color the
      wall holds, and what the player gets to shoot with.</div>
      <div class="ed-card">
        <div class="ed-row"><span class="ed-label">Name</span>
          <input class="mini-num" style="width:160px" data-f="name" type="text" /></div>
        <div class="ed-row"><span class="ed-label">Colors</span>
          <input class="mini-num" data-f="types" type="number" min="2" max="${MAX_TYPES}" /></div>
        <div class="ed-row"><span class="ed-label">Layers / color</span>
          <input class="mini-num" data-f="layers" type="number" min="1" max="999" /></div>
        <div class="ed-row"><span class="ed-label">Columns</span>
          <input class="mini-num" data-f="columns" type="number" min="2" max="9" /></div>
        <div class="ed-row"><span class="ed-label">Deck slots</span>
          <input class="mini-num" data-f="deck" type="number" min="0" max="5" /></div>
        <div class="ed-row"><span class="ed-label">Balls</span>
          <input class="mini-num" data-f="balls" type="number" min="1" max="999" /></div>
        <div class="ed-row"><span class="ed-label">Min group</span>
          <input class="mini-num" data-f="mingroup" type="number" min="1" max="999" /></div>
        <div class="ed-row"><span class="ed-label">Max group</span>
          <input class="mini-num" data-f="maxgroup" type="number" min="1" max="999" /></div>
      </div>
      <div class="setup-summary" data-el="summary"></div>
      <div class="setup-warn" data-el="warn"></div>
      <div class="menu-footer" style="display:flex;gap:10px">
        <button class="btn ghost" data-act="exit">← Menu</button>
        <button class="btn" style="flex:1" data-act="continue">Continue →</button>
      </div>`;

    const f = (k: string) => this.setupPanel.querySelector(`[data-f="${k}"]`) as HTMLInputElement;
    f('name').value = this.name;
    f('types').value = String(this.typeCount);
    f('layers').value = String(this.layersPerType);
    f('columns').value = String(this.columnCount);
    f('deck').value = String(this.deckSlots);
    f('balls').value = String(this.ballCount);
    f('mingroup').value = String(this.minGroup);
    f('maxgroup').value = String(this.maxGroup);

    const readBack = () => {
      this.name = f('name').value || 'My Level';
      this.typeCount = clampInt(f('types').value, 2, MAX_TYPES, 4);
      this.layersPerType = clampInt(f('layers').value, 1, 999, 12);
      this.columnCount = clampInt(f('columns').value, 2, 9, 6);
      this.deckSlots = clampInt(f('deck').value, 0, 5, 3);
      this.ballCount = clampInt(f('balls').value, 1, 999, 12);
      this.minGroup = clampInt(f('mingroup').value, 1, 999, 2);
      this.maxGroup = clampInt(f('maxgroup').value, 1, 999, 6);
      this.updateSetupSummary();
    };
    for (const k of ['name', 'types', 'layers', 'columns', 'deck', 'balls', 'mingroup', 'maxgroup']) {
      f(k).addEventListener('input', readBack);
    }
    this.updateSetupSummary();

    this.setupPanel
      .querySelector('[data-act="exit"]')!
      .addEventListener('click', () => this.opts.onExit());
    this.setupPanel.querySelector('[data-act="continue"]')!.addEventListener('click', () => {
      readBack();
      if (this.sigWall() !== this.wallSig) {
        this.columns = null;
        this.balls = null; // ball ratios derive from the wall
      }
      if (this.sigBalls() !== this.ballsSig) this.balls = null;
      this.wallSig = this.sigWall();
      this.ballsSig = this.sigBalls();
      this.paint = Math.min(this.paint, this.typeCount - 1);
      this.enterWall();
    });
  }

  private updateSetupSummary(): void {
    const summary = this.setupPanel.querySelector('[data-el="summary"]') as HTMLElement;
    const warn = this.setupPanel.querySelector('[data-el="warn"]') as HTMLElement;
    const total = this.typeCount * this.layersPerType;
    const rows = Math.ceil(total / this.columnCount);
    const dots = Array.from({ length: this.typeCount }, (_, t) =>
      `<span style="color:${colorHexCss(t)}">●</span>`
    ).join('');
    summary.innerHTML = `${dots} ${total} blocks · ~${rows} rows · ${this.ballCount} balls · ${this.deckSlots} deck slot(s)`;
    const warns: string[] = [];
    if (this.ballCount < this.typeCount)
      warns.push('Fewer balls than colors — some colors can never be cleared.');
    if (this.deckSlots === 0) warns.push('No deck slots — pure queue order, very strict.');
    if (this.minGroup > this.maxGroup)
      warns.push('Min group is larger than max group — they will be swapped.');
    else if (!groupsFeasible(this.layersPerType, this.minGroup, this.maxGroup))
      warns.push(
        `${this.layersPerType} layers per color can't split into groups of ${this.minGroup}–${this.maxGroup} — min will relax to 1.`
      );
    warn.textContent = warns.join(' ');
  }

  private showSetup(): void {
    this.setupPanel.style.display = 'flex';
    this.toolbarEl.style.display = 'none';
    this.statusEl.style.display = 'none';
    this.ballsBarEl.style.display = 'none';
    this.bottomEl.style.display = 'none';
  }

  // ---- page 2: wall + balls ---------------------------------------------------

  private buildChrome(): void {
    this.toolbarEl = document.createElement('div');
    this.toolbarEl.className = 'editor-toolbar';
    this.toolbarEl.innerHTML = `
      <button class="tool-btn" data-act="setup">⚙ Setup</button>
      <button class="tool-btn" data-act="distribute">🎲 Wall</button>
      <button class="tool-btn" data-mode="group">Group</button>
      <button class="tool-btn" data-mode="layer">Layer</button>
      <button class="tool-btn" data-mode="brush">🖌 Brush</button>
      <div class="color-row" data-el="palette"></div>
      <button class="tool-btn" data-act="exit">← Menu</button>`;
    this.root.appendChild(this.toolbarEl);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'editor-status';
    this.root.appendChild(this.statusEl);

    this.ballsBarEl = document.createElement('div');
    this.ballsBarEl.style.marginTop = 'auto';
    this.ballsBarEl.style.padding = '0 10px';
    this.root.appendChild(this.ballsBarEl);

    this.bottomEl = document.createElement('div');
    this.bottomEl.className = 'editor-bottom';
    this.bottomEl.innerHTML = `
      <button class="btn small" data-act="test">▶ Test</button>
      <button class="btn ghost small" data-act="copy">Copy JSON</button>
      <button class="btn ghost small" data-act="download">↓ Download</button>
      <button class="btn small" data-act="save">💾 Save</button>`;
    this.root.appendChild(this.bottomEl);

    this.toolbarEl.querySelector('[data-act="setup"]')!.addEventListener('click', () => {
      this.renderSetup();
      this.showSetup();
    });
    this.toolbarEl
      .querySelector('[data-act="exit"]')!
      .addEventListener('click', () => this.opts.onExit());
    this.toolbarEl.querySelector('[data-act="distribute"]')!.addEventListener('click', () => {
      this.columns = generateWall(this.genParams(), this.nextRand());
      this.rebuild();
      this.updateStatus();
    });
    for (const mode of MODES) {
      this.toolbarEl.querySelector(`[data-mode="${mode}"]`)!.addEventListener('click', () => {
        this.mode = mode;
        this.syncModeButtons();
        this.updateStatus();
      });
    }
    this.bottomEl.querySelector('[data-act="test"]')!.addEventListener('click', () => {
      if (this.columns && this.balls) this.opts.onTestPlay(this.snapshot());
    });
    this.bottomEl
      .querySelector('[data-act="copy"]')!
      .addEventListener('click', () => this.showJsonModal());
    this.bottomEl
      .querySelector('[data-act="download"]')!
      .addEventListener('click', () => this.downloadJson());
    this.bottomEl.querySelector('[data-act="save"]')!.addEventListener('click', () => {
      if (!this.columns || !this.balls) return;
      saveCustomLevel(this.snapshot());
      this.flashStatus('Saved to Your Levels ✓');
    });
  }

  private renderPalette(): void {
    const row = this.toolbarEl.querySelector('[data-el="palette"]') as HTMLElement;
    row.innerHTML = '';
    for (let t = 0; t < this.typeCount; t++) {
      const dot = document.createElement('button');
      dot.className = 'color-dot' + (this.paint === t ? ' active' : '');
      dot.style.background = colorHexCss(t);
      dot.addEventListener('click', () => {
        this.paint = t;
        this.renderPalette();
        this.updateStatus();
      });
      row.appendChild(dot);
    }
  }

  private enterWall(): void {
    if (!this.columns) this.columns = generateWall(this.genParams(), this.nextRand());
    if (!this.balls) this.balls = generateBalls(this.ballCount, this.columns, this.nextRand());
    this.selectedBall = null;
    this.setupPanel.style.display = 'none';
    this.toolbarEl.style.display = 'flex';
    this.statusEl.style.display = 'block';
    this.ballsBarEl.style.display = 'block';
    this.bottomEl.style.display = 'flex';
    this.syncModeButtons();
    this.renderPalette();
    this.renderBallsBar();
    this.rebuild();
    this.updateStatus();
  }

  private syncModeButtons(): void {
    for (const mode of MODES) {
      this.toolbarEl
        .querySelector(`[data-mode="${mode}"]`)!
        .classList.toggle('active', this.mode === mode);
    }
  }

  // ---- balls strip (same page as the wall) ------------------------------------

  private renderBallsBar(): void {
    if (!this.balls) return;
    const sel = this.selectedBall;
    this.ballsBarEl.innerHTML = `
      <div class="ed-card" style="margin-bottom:6px">
        <div class="ed-row" style="max-height:64px;overflow-y:auto">
          <span class="ed-label">Queue ▸</span>
          <div class="queue-chips" data-el="chips"></div>
        </div>
        <div class="ed-row">
          <span class="ed-label">Add</span>
          <div class="color-row" data-el="add"></div>
          <span class="ed-spacer"></span>
          ${sel !== null ? '<button class="btn danger small" data-act="remove">🗑</button>' : ''}
          <button class="btn ghost small" data-act="rand-balls">🎲</button>
        </div>
      </div>`;

    const chips = this.ballsBarEl.querySelector('[data-el="chips"]') as HTMLElement;
    this.balls.forEach((t, i) => {
      const dot = document.createElement('button');
      dot.className = 'color-dot' + (sel === i ? ' active' : '');
      dot.style.background = colorHexCss(t);
      dot.title = i === 0 ? 'first shot' : `#${i + 1}`;
      dot.addEventListener('click', () => this.ballClicked(i));
      chips.appendChild(dot);
    });
    const plus = document.createElement('button');
    plus.className = 'color-dot';
    plus.style.background = 'transparent';
    plus.style.border = '2px dashed #8b91a6';
    plus.title = 'move to end';
    plus.addEventListener('click', () => {
      if (this.selectedBall === null) return;
      const [b] = this.balls!.splice(this.selectedBall, 1);
      this.balls!.push(b);
      this.selectedBall = null;
      this.renderBallsBar();
    });
    chips.appendChild(plus);

    const add = this.ballsBarEl.querySelector('[data-el="add"]') as HTMLElement;
    for (let t = 0; t < this.typeCount; t++) {
      const dot = document.createElement('button');
      dot.className = 'color-dot';
      dot.style.background = colorHexCss(t);
      dot.addEventListener('click', () => {
        this.balls!.push(t);
        this.renderBallsBar();
      });
      add.appendChild(dot);
    }

    this.ballsBarEl.querySelector('[data-act="remove"]')?.addEventListener('click', () => {
      if (this.selectedBall === null) return;
      this.balls!.splice(this.selectedBall, 1);
      this.selectedBall = null;
      this.renderBallsBar();
    });
    this.ballsBarEl.querySelector('[data-act="rand-balls"]')!.addEventListener('click', () => {
      this.ballCount = this.balls!.length || this.ballCount;
      this.balls = generateBalls(this.ballCount, this.columns ?? [], this.nextRand());
      this.selectedBall = null;
      this.renderBallsBar();
    });
  }

  private ballClicked(i: number): void {
    const sel = this.selectedBall;
    if (sel === null) {
      this.selectedBall = i;
    } else if (sel === i) {
      this.selectedBall = null;
    } else {
      const [ball] = this.balls!.splice(sel, 1);
      let target = i;
      if (sel < i) target--; // removal shifted the target left
      this.balls!.splice(target, 0, ball);
      this.selectedBall = null;
    }
    this.renderBallsBar();
  }

  // ---- scene ---------------------------------------------------------------

  private rebuild(): void {
    this.wall?.dispose();
    this.wall = null;
    if (!this.columns) return;
    this.wall = new WallView(this.columns, this.columnCount);
    this.scene.add(this.wall.group);
    this.fitCamera();
  }

  // ---- wall input: tap = paint, drag = move ----------------------------------

  private cellAt(e: PointerEvent): Cell | null {
    if (!this.wall) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.wall.allMeshes(), false);
    if (hits.length === 0) return null;
    return this.wall.cellOf(hits[0].object);
  }

  /** World point on the wall plane (z = 0) under the pointer. */
  private pointerWorld(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const dz = ray.ray.direction.z;
    if (Math.abs(dz) < 1e-6) return null;
    const t = -ray.ray.origin.z / dz;
    return ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
  }

  /** The rows this edit affects: the single layer, or its vertical run. */
  private runBounds(cell: Cell): { start: number; count: number } {
    const column = this.columns![cell.col];
    if (this.mode === 'layer') return { start: cell.row, count: 1 };
    const type = column[cell.row];
    let start = cell.row;
    while (start > 0 && column[start - 1] === type) start--;
    let end = cell.row;
    while (end < column.length - 1 && column[end + 1] === type) end++;
    return { start, count: end - start + 1 };
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.columns || this.drag) return;
    if (this.toolbarEl.style.display === 'none') return; // setup panel is open
    const cell = this.cellAt(e);
    if (!cell) return;
    if (this.mode === 'brush') {
      // Brush disables moving: press paints, and dragging keeps painting.
      this.brushing = true;
      this.renderer.domElement.setPointerCapture(e.pointerId);
      this.brushCell(cell);
      return;
    }
    this.pending = { cell, sx: e.clientX, sy: e.clientY };
    this.renderer.domElement.setPointerCapture(e.pointerId);
  }

  private pointerMove(e: PointerEvent): void {
    if (this.brushing) {
      const cell = this.cellAt(e);
      if (cell) this.brushCell(cell);
      return;
    }
    if (this.drag) {
      this.updateDrag(e);
      return;
    }
    if (!this.pending || !this.columns) return;
    const dx = e.clientX - this.pending.sx;
    const dy = e.clientY - this.pending.sy;
    if (dx * dx + dy * dy < 120) return; // still a tap
    this.beginDrag(e);
  }

  /** Paint one block in place (no rebuild — structure is unchanged). */
  private brushCell(cell: Cell): void {
    if (!this.columns || !this.wall) return;
    if (this.columns[cell.col][cell.row] === this.paint) return;
    this.columns[cell.col][cell.row] = this.paint;
    const mesh = this.wall.meshAt(cell);
    if (mesh) {
      (mesh.material as THREE.MeshStandardMaterial).color.setHex(
        PALETTE[this.paint % PALETTE.length]
      );
      mesh.userData.type = this.paint;
    }
    this.updateStatus();
  }

  private beginDrag(e: PointerEvent): void {
    const cell = this.pending!.cell;
    this.pending = null;
    const { start, count } = this.runBounds(cell);
    const types = this.columns![cell.col].splice(start, count);
    this.rebuild();

    const ghost = new THREE.Group();
    const ghostMeshes: THREE.Mesh[] = [];
    types.forEach((t, i) => {
      const m = makeBlockMesh(t);
      m.position.y = -i * BLOCK_H; // keep top-to-bottom visual order
      m.scale.setScalar(0.92);
      ghost.add(m);
      ghostMeshes.push(m);
    });
    this.scene.add(ghost);
    this.drag = { types, fromCol: cell.col, fromIdx: start, ghost, ghostMeshes, target: null };
    this.updateDrag(e);
    this.statusEl.textContent = 'Drop on a column to insert — release elsewhere to put it back.';
    this.statusEl.className = 'editor-status';
  }

  private updateDrag(e: PointerEvent): void {
    if (!this.drag || !this.columns) return;
    const p = this.pointerWorld(e);
    if (!p) return;
    this.drag.ghost.position.set(p.x, p.y + 0.2, 0.5);

    let target: { col: number; idx: number } | null = null;
    for (let c = 0; c < this.columnCount; c++) {
      if (Math.abs(p.x - colX(c, this.columnCount)) <= COL_PITCH / 2) {
        const L = this.columns[c].length;
        const idx = Math.max(0, Math.min(L, Math.round((WALL_TOP - p.y) / BLOCK_H)));
        target = { col: c, idx };
        break;
      }
    }
    this.drag.target = target;
    if (target) {
      this.marker.visible = true;
      this.marker.position.set(
        colX(target.col, this.columnCount),
        WALL_TOP - target.idx * BLOCK_H,
        0.1
      );
    } else {
      this.marker.visible = false;
    }
  }

  private pointerUp(e: PointerEvent): void {
    if (this.brushing) {
      this.brushing = false;
      return;
    }
    if (this.drag && this.columns) {
      const d = this.drag;
      this.drag = null;
      this.marker.visible = false;
      this.scene.remove(d.ghost);
      for (const m of d.ghostMeshes) (m.material as THREE.Material).dispose();
      if (d.target) {
        this.columns[d.target.col].splice(d.target.idx, 0, ...d.types);
      } else {
        this.columns[d.fromCol].splice(d.fromIdx, 0, ...d.types);
      }
      this.rebuild();
      this.updateStatus();
    } else if (this.pending && this.columns) {
      // A tap: paint the layer / group under the finger.
      const cell = this.pending.cell;
      this.pending = null;
      const { start, count } = this.runBounds(cell);
      const column = this.columns[cell.col];
      for (let r = start; r < start + count; r++) column[r] = this.paint;
      this.rebuild();
      this.updateStatus();
    }
    this.pending = null;
  }

  // ---- status -------------------------------------------------------------------

  private updateStatus(): void {
    if (!this.columns) return;
    const counts = new Array<number>(this.typeCount).fill(0);
    for (const c of this.columns) for (const t of c) if (t < this.typeCount) counts[t]++;
    const parts = counts.map(
      (n, t) =>
        `<span style="color:${colorHexCss(t)}">●</span>${n}${n !== this.layersPerType ? '⚠' : ''}`
    );
    const off = counts.some((n) => n !== this.layersPerType);
    const hint =
      this.mode === 'brush'
        ? 'Brush · drag to paint (moving off)'
        : `${this.mode === 'group' ? 'Group' : 'Layer'} · tap = paint, drag = move`;
    this.statusEl.innerHTML =
      `${hint} &nbsp; ${parts.join(' ')}` +
      (off ? ` &nbsp;(pool target ${this.layersPerType} each)` : ' &nbsp;✓ pool balanced');
    this.statusEl.className = 'editor-status' + (off ? '' : ' ok');
  }

  private flashStatus(msg: string): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = 'editor-status ok';
    window.setTimeout(() => this.updateStatus(), 2200);
  }

  // ---- export ---------------------------------------------------------------------

  private snapshot(): LevelData {
    return {
      id: this.levelId,
      name: this.name,
      deckSlots: this.deckSlots,
      layersPerType: this.layersPerType,
      minGroup: this.minGroup,
      maxGroup: this.maxGroup,
      columns: (this.columns ?? []).map((c) => [...c]),
      balls: [...(this.balls ?? [])],
    };
  }

  private showJsonModal(): void {
    if (!this.columns || this.modalEl) return;
    const json = JSON.stringify(this.snapshot(), null, 2);
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card';
    card.innerHTML = `<h2>Level JSON</h2>
      <p>Copy this, or use ↓ Download and drop the file into src/levels/contributed/.</p>`;
    const ta = document.createElement('textarea');
    ta.className = 'json';
    ta.value = json;
    card.appendChild(ta);
    const row = document.createElement('div');
    row.className = 'modal-actions';
    row.style.marginTop = '12px';
    const copy = document.createElement('button');
    copy.className = 'btn small';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      navigator.clipboard?.writeText(json);
      copy.textContent = 'Copied ✓';
    });
    const close = document.createElement('button');
    close.className = 'btn ghost small';
    close.textContent = 'Close';
    close.addEventListener('click', () => {
      this.modalEl?.remove();
      this.modalEl = null;
    });
    row.append(copy, close);
    card.appendChild(row);
    this.modalEl.appendChild(card);
    this.root.appendChild(this.modalEl);
  }

  private downloadJson(): void {
    if (!this.columns) return;
    const lv = this.snapshot();
    const json = JSON.stringify(lv, null, 2);
    const slug =
      (lv.name || lv.id || 'level')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'level';
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    this.flashStatus('Downloaded — drop into src/levels/contributed/ to ship it.');
  }

  // ---- frame / sizing -----------------------------------------------------------------

  private tick = () => {
    this.rafId = requestAnimationFrame(this.tick);
    this.renderer.render(this.scene, this.camera);
  };

  private handleResize(): void {
    const w = this.parent.clientWidth;
    const h = this.parent.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.fitCamera();
    this.camera.updateProjectionMatrix();
  }

  private fitCamera(): void {
    const maxRows = Math.max(4, ...(this.columns ?? [[]]).map((c) => c.length));
    const width = this.columnCount * COL_PITCH + 1.2;
    const top = WALL_TOP + BLOCK_H + 1.6; // headroom under the toolbar
    const bottom = WALL_TOP - maxRows * BLOCK_H - 2.6; // room for the balls strip
    const height = top - bottom;
    const cy = (top + bottom) / 2;
    const fovV = THREE.MathUtils.degToRad(this.camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.camera.aspect);
    const d = Math.max(height / (2 * Math.tan(fovV / 2)), width / (2 * Math.tan(fovH / 2)));
    this.camera.position.set(0, cy, d + 1.6);
    this.camera.lookAt(0, cy, 0);
  }

  // ---- teardown --------------------------------------------------------------------------

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerup', this.onPointerUp);
    this.renderer.domElement.removeEventListener('pointercancel', this.onPointerUp);
    this.resizeObserver.disconnect();
    this.wall?.dispose();
    this.wall = null;
    if (this.drag) {
      this.scene.remove(this.drag.ghost);
      for (const m of this.drag.ghostMeshes) (m.material as THREE.Material).dispose();
      this.drag = null;
    }
    (this.marker.geometry as THREE.BufferGeometry).dispose();
    this.markerMat.dispose();
    this.modalEl?.remove();
    this.modalEl = null;
    this.root.remove();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
