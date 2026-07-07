import * as THREE from 'three';
import type { LevelData } from '../shared/types';
import { totalBlocks } from '../shared/types';
import { PALETTE } from '../shared/colors';
import { Board, Cell } from './Board';
import { WallView, PopBurst, makeBallMesh, makePadMesh, disposeMesh } from './WallView';
import { Tweens, easeInOutCubic, easeOutCubic } from './Tween';
import { Hud } from './Hud';
import {
  BLOCK_D,
  BLOCK_H,
  COL_PITCH,
  DECK_PITCH,
  QUEUE_PITCH,
  QUEUE_VISIBLE,
  VISIBLE_ROWS,
  WALL_TOP,
  colX,
  deckYFor,
  queueYFor,
  shootYFor,
} from './layout';

export interface GameAppOptions {
  level: LevelData;
  onMenu(): void;
  onRestart(): void;
  onNext?: () => void;
}

export class GameApp {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private rafId = 0;
  private clock = new THREE.Clock();
  private tweens = new Tweens();
  private resizeObserver: ResizeObserver;

  private board: Board;
  private wall: WallView;
  private bursts: PopBurst[] = [];
  private hud: Hud;

  // Hand meshes mirroring Board hand state.
  private activeMesh: THREE.Mesh | null = null;
  private queueMeshes: THREE.Mesh[] = [];
  private deckBalls: (THREE.Mesh | null)[] = [];
  private deckPads: THREE.Mesh[] = [];
  private ring: THREE.Mesh;
  private ringGeo: THREE.TorusGeometry;
  private ringMat: THREE.MeshStandardMaterial;

  private over = false;
  private shooting = false;
  private shake = 0;
  private camBase = new THREE.Vector3();
  private camLook = new THREE.Vector3();

  private columnCount: number;
  private visibleRows: number;
  private shootY: number;
  private deckY: number;
  private queueY: number;
  private floor: { mesh: THREE.Mesh; geo: THREE.BufferGeometry; mat: THREE.Material } | null =
    null;

  private onPointerDown = (e: PointerEvent) => this.handleTap(e);

  constructor(private parent: HTMLElement, private opts: GameAppOptions) {
    this.board = new Board(opts.level);
    this.columnCount = opts.level.columns.length;
    const maxRows = Math.max(1, ...opts.level.columns.map((c) => c.length));
    this.visibleRows = Math.min(maxRows, Math.max(1, opts.level.visibleRows ?? VISIBLE_ROWS));
    this.shootY = shootYFor(this.visibleRows);
    this.deckY = deckYFor(this.shootY);
    this.queueY = queueYFor(this.deckY);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xe6e3f4);
    parent.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(2, 5, 7);
    this.scene.add(dir);

    // Tall walls continue below a floor; hidden rows rise into view as the
    // pistons push columns up. A clipping plane makes them emerge smoothly.
    let clipPlane: THREE.Plane | undefined;
    if (maxRows > this.visibleRows) {
      const floorY = WALL_TOP - this.visibleRows * BLOCK_H;
      clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
      this.renderer.localClippingEnabled = true;
      const geo = new THREE.BoxGeometry(
        this.columnCount * COL_PITCH + 0.8,
        0.3,
        BLOCK_D + 0.6
      );
      const mat = new THREE.MeshStandardMaterial({ color: 0xb3aede, roughness: 0.65 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(0, floorY - 0.15, 0);
      this.scene.add(mesh);
      this.floor = { mesh, geo, mat };
    }

    this.wall = new WallView(this.board.columns, this.columnCount, clipPlane);
    this.scene.add(this.wall.group);

    // Shooting point ring.
    this.ringGeo = new THREE.TorusGeometry(0.46, 0.045, 12, 36);
    this.ringMat = new THREE.MeshStandardMaterial({ color: 0x6f76b8, roughness: 0.5 });
    this.ring = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.ring.position.set(0, this.shootY, -0.1);
    this.scene.add(this.ring);

    // Deck pads.
    const slots = opts.level.deckSlots;
    for (let s = 0; s < slots; s++) {
      const pad = makePadMesh(s);
      pad.position.set(colX(s, slots, DECK_PITCH), this.deckY, -0.15);
      this.scene.add(pad);
      this.deckPads.push(pad);
      this.deckBalls.push(null);
    }

    // Hand meshes: active + queue.
    if (this.board.active) {
      this.activeMesh = makeBallMesh(this.board.active.type);
      this.activeMesh.position.set(0, this.shootY, 0);
      this.scene.add(this.activeMesh);
    }
    for (const t of this.board.queue) {
      const m = makeBallMesh(t);
      this.scene.add(m);
      this.queueMeshes.push(m);
    }
    this.layoutQueue(false);

    this.hud = new Hud(parent, {
      levelName: opts.level.name,
      totalBalls: opts.level.balls.length,
      totalBlocks: totalBlocks(opts.level),
      onMenu: opts.onMenu,
      onRestart: opts.onRestart,
      onNext: opts.onNext,
    });

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.resizeObserver = new ResizeObserver(() => this.handleResize());
    this.resizeObserver.observe(parent);
    this.handleResize();

    // An already-empty wall (editor experiments) wins immediately.
    if (this.board.cleared) {
      this.over = true;
      this.tweens.add(0.01, () => {}, { delay: 0.6, done: () => this.hud.showWin() });
    }

    this.rafId = requestAnimationFrame(this.tick);
  }

  // ---- input -----------------------------------------------------------

  private handleTap(e: PointerEvent): void {
    if (this.over || this.shooting) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);

    // Only blocks above the floor are in play.
    const targets: THREE.Mesh[] = [];
    for (const col of this.wall.cols) {
      for (let r = 0; r < Math.min(col.length, this.visibleRows); r++) targets.push(col[r]);
    }
    const wallHits = ray.intersectObjects(targets, false);
    if (wallHits.length > 0) {
      const cell = this.wall.cellOf(wallHits[0].object);
      if (cell) this.shoot(cell);
      return;
    }

    const deckTargets = [...this.deckPads, ...this.deckBalls.filter((m): m is THREE.Mesh => !!m)];
    const deckHits = ray.intersectObjects(deckTargets, false);
    if (deckHits.length > 0) {
      const obj = deckHits[0].object as THREE.Mesh;
      let slot = obj.userData.slot as number | undefined;
      if (slot === undefined) slot = this.deckBalls.indexOf(obj);
      if (slot === undefined || slot < 0) return;
      if (this.board.deck[slot] !== null) this.recall(slot);
      else this.stash(slot);
    }
  }

  // ---- shooting ----------------------------------------------------------

  private shoot(cell: Cell): void {
    if (!this.board.active || !this.activeMesh) {
      this.pulseRing();
      return;
    }
    const type = this.board.active.type;
    const targetMesh = this.wall.meshAt(cell);
    if (!targetMesh) return;
    const target = targetMesh.position.clone();
    const match = this.board.blockAt(cell) === type;
    const region = match ? this.board.region(cell, this.visibleRows) : [];

    this.shooting = true;
    this.board.consumeActive();
    const ball = this.activeMesh;
    this.activeMesh = null;
    this.tweens.add(0.12, () => {}, { delay: 0.1, done: () => this.refillVisual() });

    const start = ball.position.clone();
    this.tweens.add(
      0.28,
      (k) => {
        ball.position.lerpVectors(start, target, k);
        ball.position.z += Math.sin(k * Math.PI) * 1.0; // arc out in front
      },
      {
        ease: easeInOutCubic,
        done: () => {
          if (match) this.resolveBlast(ball, target, type, region);
          else this.resolveMiss(ball, targetMesh, target);
        },
      }
    );
  }

  private resolveBlast(
    ball: THREE.Mesh,
    target: THREE.Vector3,
    type: number,
    region: Cell[]
  ): void {
    disposeMesh(ball);
    this.board.blast(region);
    const detached = this.wall.detachCells(region);
    this.bursts.push(
      new PopBurst(this.scene, target, PALETTE[type % PALETTE.length], Math.min(26, 10 + region.length * 2))
    );
    this.shake = 0.28;

    detached.forEach((mesh, i) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = true;
      const from = mesh.position.clone();
      this.tweens.add(
        0.22,
        (k) => {
          mesh.scale.setScalar(1 - k * 0.9);
          mesh.position.z = from.z + k * 0.7;
          mat.opacity = 1 - k;
        },
        { delay: Math.min(0.12, i * 0.008), done: () => disposeMesh(mesh) }
      );
    });

    // Pistons push the survivors up to close the gaps.
    for (const move of this.wall.compactMoves()) {
      const fromY = move.mesh.position.y;
      this.tweens.add(
        0.3,
        (k) => {
          move.mesh.position.y = fromY + (move.toY - fromY) * k;
        },
        { ease: easeOutCubic, delay: 0.18 }
      );
    }

    this.afterShot();
  }

  private resolveMiss(ball: THREE.Mesh, blockMesh: THREE.Mesh, target: THREE.Vector3): void {
    // The wall shrugs it off — small wiggle on the struck block.
    const bx = blockMesh.position.x;
    this.tweens.add(0.3, (k) => {
      blockMesh.position.x = bx + Math.sin(k * Math.PI * 4) * (1 - k) * 0.05;
    });
    // The ball bounces off and falls away, wasted.
    const mat = ball.material as THREE.MeshStandardMaterial;
    mat.transparent = true;
    const dirX = (Math.random() - 0.5) * 2;
    this.tweens.add(
      0.5,
      (k) => {
        ball.position.x = target.x + dirX * k * 1.4;
        ball.position.y = target.y + 1.6 * k - 5.5 * k * k;
        ball.position.z = target.z + 1.2 * k;
        ball.rotation.x += 0.2;
        mat.opacity = 1 - k * k;
      },
      { done: () => disposeMesh(ball) }
    );
    this.afterShot();
  }

  private afterShot(): void {
    this.hud.setCounts(this.blocksLeft(), this.board.ballsLeft);
    if (this.board.cleared) {
      this.over = true;
      this.tweens.add(0.01, () => {}, { delay: 0.8, done: () => this.hud.showWin() });
    } else if (this.board.lost) {
      this.over = true;
      this.tweens.add(0.01, () => {}, { delay: 0.8, done: () => this.hud.showLose() });
    }
    this.shooting = false;
  }

  private blocksLeft(): number {
    return this.board.columns.reduce((n, c) => n + c.length, 0);
  }

  // ---- deck ----------------------------------------------------------------

  private stash(slot: number): void {
    if (!this.board.active || !this.activeMesh) return;
    if (!this.board.stash(slot)) return;
    const mesh = this.activeMesh;
    this.activeMesh = null;
    this.deckBalls[slot] = mesh;
    this.moveBall(mesh, this.deckPos(slot), 0.88);
    this.refillVisual();
  }

  private recall(slot: number): void {
    const incoming = this.deckBalls[slot];
    const res = this.board.recall(slot);
    if (!res || !incoming) return;
    const prev = this.activeMesh;
    this.deckBalls[slot] = null;
    this.activeMesh = incoming;
    this.moveBall(incoming, new THREE.Vector3(0, this.shootY, 0), 1);
    if (res.returned && prev) {
      if (res.returned.kind === 'queue') {
        this.queueMeshes.unshift(prev);
        this.layoutQueue(true);
      } else {
        this.deckBalls[res.returned.slot] = prev;
        this.moveBall(prev, this.deckPos(res.returned.slot), 0.88);
      }
    }
  }

  private deckPos(slot: number): THREE.Vector3 {
    return new THREE.Vector3(colX(slot, this.deckPads.length, DECK_PITCH), this.deckY, 0);
  }

  private moveBall(mesh: THREE.Mesh, to: THREE.Vector3, scale: number): void {
    const from = mesh.position.clone();
    const fromScale = mesh.scale.x;
    this.tweens.add(
      0.28,
      (k) => {
        mesh.position.lerpVectors(from, to, k);
        mesh.position.y += Math.sin(k * Math.PI) * 0.25;
        mesh.scale.setScalar(fromScale + (scale - fromScale) * k);
      },
      { ease: easeInOutCubic }
    );
  }

  // ---- queue -----------------------------------------------------------------

  /** Load the queue leader into the empty shooting point (visual side). */
  private refillVisual(): void {
    if (!this.board.active || this.activeMesh) return;
    const mesh = this.queueMeshes.shift();
    if (!mesh) return;
    this.activeMesh = mesh;
    mesh.visible = true;
    this.moveBall(mesh, new THREE.Vector3(0, this.shootY, 0), 1);
    this.layoutQueue(true);
  }

  private queueSlot(i: number): { pos: THREE.Vector3; scale: number; visible: boolean } {
    const n = Math.min(this.queueMeshes.length, QUEUE_VISIBLE);
    const j = Math.min(i, QUEUE_VISIBLE - 1);
    return {
      pos: new THREE.Vector3(colX(j, n, QUEUE_PITCH), this.queueY, 0),
      scale: 0.72,
      visible: i < QUEUE_VISIBLE,
    };
  }

  private layoutQueue(animate: boolean): void {
    this.queueMeshes.forEach((mesh, i) => {
      const s = this.queueSlot(i);
      mesh.visible = s.visible;
      if (animate && s.visible) {
        const from = mesh.position.clone();
        const fromScale = mesh.scale.x;
        this.tweens.add(0.24, (k) => {
          mesh.position.lerpVectors(from, s.pos, k);
          mesh.scale.setScalar(fromScale + (s.scale - fromScale) * k);
        });
      } else {
        mesh.position.copy(s.pos);
        mesh.scale.setScalar(s.scale);
      }
    });
  }

  private pulseRing(): void {
    this.tweens.add(0.35, (k) => {
      const s = 1 + Math.sin(k * Math.PI) * 0.25;
      this.ring.scale.setScalar(s);
    });
  }

  // ---- frame loop --------------------------------------------------------

  private tick = () => {
    this.rafId = requestAnimationFrame(this.tick);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.tweens.update(dt);
    this.bursts = this.bursts.filter((b) => {
      const alive = b.update(dt);
      if (!alive) b.dispose();
      return alive;
    });
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      const a = this.shake * 0.12;
      this.camera.position.set(
        this.camBase.x + (Math.random() - 0.5) * a,
        this.camBase.y + (Math.random() - 0.5) * a,
        this.camBase.z
      );
    } else {
      this.camera.position.copy(this.camBase);
    }
    this.camera.lookAt(this.camLook);
    this.renderer.render(this.scene, this.camera);
  };

  // ---- sizing ------------------------------------------------------------

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
    const width =
      Math.max(
        this.columnCount * COL_PITCH,
        QUEUE_VISIBLE * QUEUE_PITCH,
        this.deckPads.length * DECK_PITCH
      ) + 1.2;
    const top = WALL_TOP + BLOCK_H + 1.0; // headroom under the HUD
    const bottom = this.queueY - 0.9;
    const height = top - bottom;
    const cy = (top + bottom) / 2;
    const fovV = THREE.MathUtils.degToRad(this.camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.camera.aspect);
    const d = Math.max(height / (2 * Math.tan(fovV / 2)), width / (2 * Math.tan(fovH / 2)));
    this.camBase.set(0, cy, d + 1.6);
    this.camLook.set(0, cy, 0);
  }

  // ---- teardown ------------------------------------------------------------

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.resizeObserver.disconnect();
    this.tweens.clear();
    this.wall.dispose();
    if (this.activeMesh) disposeMesh(this.activeMesh);
    this.activeMesh = null;
    for (const m of this.queueMeshes) disposeMesh(m);
    this.queueMeshes = [];
    for (const m of this.deckBalls) if (m) disposeMesh(m);
    this.deckBalls = [];
    for (const p of this.deckPads) disposeMesh(p);
    this.deckPads = [];
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.scene.remove(this.ring);
    if (this.floor) {
      this.floor.geo.dispose();
      this.floor.mat.dispose();
      this.scene.remove(this.floor.mesh);
      this.floor = null;
    }
    for (const b of this.bursts) b.dispose();
    this.bursts = [];
    this.hud.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
