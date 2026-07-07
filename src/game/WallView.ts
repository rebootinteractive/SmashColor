import * as THREE from 'three';
import type { LayerType } from '../shared/types';
import { PALETTE } from '../shared/colors';
import type { Cell } from './Board';
import { BLOCK_W, BLOCK_H, BLOCK_D, BALL_R, colX, rowY } from './layout';

// Shared, never-mutated geometries — safe as module statics (page-session lifetime).
const blockGeo = new THREE.BoxGeometry(BLOCK_W, BLOCK_H * 0.88, BLOCK_D);
const shardGeo = new THREE.BoxGeometry(0.14, 0.1, 0.14);
const ballGeo = new THREE.SphereGeometry(BALL_R, 24, 18);
const padGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.08, 28);
const railGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 10);

/** Fresh material per block — blast/fade animations mutate materials, so no sharing. */
export function makeBlockMesh(type: LayerType, clipPlane?: THREE.Plane): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color: PALETTE[type % PALETTE.length],
    roughness: 0.42,
    metalness: 0.05,
  });
  if (clipPlane) mat.clippingPlanes = [clipPlane];
  const mesh = new THREE.Mesh(blockGeo, mat);
  mesh.userData.type = type;
  return mesh;
}

/** type < 0 = dynamic (undecided) ball — rendered gray until it takes a color. */
export function makeBallMesh(type: LayerType): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color: type < 0 ? 0x878da3 : PALETTE[type % PALETTE.length],
    roughness: 0.22,
    metalness: 0.15,
  });
  const mesh = new THREE.Mesh(ballGeo, mat);
  mesh.userData.type = type;
  return mesh;
}

/** A deck slot pad (flat disc facing the camera). */
export function makePadMesh(slot: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color: 0xb9bdd1, roughness: 0.7 });
  const mesh = new THREE.Mesh(padGeo, mat);
  mesh.rotation.x = Math.PI / 2; // disc faces +z (toward the camera)
  mesh.userData.slot = slot;
  return mesh;
}

export function disposeMesh(mesh: THREE.Mesh): void {
  mesh.parent?.remove(mesh);
  (mesh.material as THREE.Material).dispose();
  // geometry is shared/static — not disposed here
}

/**
 * The wall: one mesh per block, tracked as jagged column arrays that mirror
 * Board.columns (index 0 = top row). Group origin = world origin.
 */
export class WallView {
  readonly group = new THREE.Group();
  /** meshes[col][row] — same shape as Board.columns. */
  readonly cols: THREE.Mesh[][] = [];
  private rails: THREE.Mesh[] = [];
  private railMat: THREE.MeshStandardMaterial;

  constructor(
    columns: LayerType[][],
    private columnCount: number,
    private clipPlane?: THREE.Plane
  ) {
    this.railMat = new THREE.MeshStandardMaterial({ color: 0x8d93c8, roughness: 0.55 });
    if (clipPlane) this.railMat.clippingPlanes = [clipPlane];
    const maxRows = Math.max(1, ...columns.map((c) => c.length));
    for (let c = 0; c < columns.length; c++) {
      const meshes: THREE.Mesh[] = [];
      for (let r = 0; r < columns[c].length; r++) {
        const mesh = makeBlockMesh(columns[c][r], clipPlane);
        mesh.position.set(colX(c, columnCount), rowY(r), 0);
        this.group.add(mesh);
        meshes.push(mesh);
      }
      this.cols.push(meshes);
      // The rod each column hangs on, like the reference scene.
      const rail = new THREE.Mesh(railGeo, this.railMat);
      const len = (maxRows + 1.2) * BLOCK_H;
      rail.scale.y = len;
      rail.position.set(colX(c, columnCount), rowY(0) + BLOCK_H / 2 - len / 2 + 0.1, -BLOCK_D * 0.62);
      this.group.add(rail);
      this.rails.push(rail);
    }
  }

  allMeshes(): THREE.Mesh[] {
    return this.cols.flat();
  }

  /** The (col,row) of a block mesh, or null when it isn't part of the wall. */
  cellOf(mesh: THREE.Object3D): Cell | null {
    for (let c = 0; c < this.cols.length; c++) {
      const r = this.cols[c].indexOf(mesh as THREE.Mesh);
      if (r >= 0) return { col: c, row: r };
    }
    return null;
  }

  meshAt(cell: Cell): THREE.Mesh | undefined {
    return this.cols[cell.col]?.[cell.row];
  }

  /** Remove cell meshes from the wall tracking (still parented for animation). */
  detachCells(cells: Cell[]): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    const byCol = new Map<number, Set<number>>();
    for (const c of cells) {
      if (!byCol.has(c.col)) byCol.set(c.col, new Set());
      byCol.get(c.col)!.add(c.row);
    }
    for (const [col, rows] of byCol) {
      const kept: THREE.Mesh[] = [];
      this.cols[col].forEach((m, r) => {
        if (rows.has(r)) out.push(m);
        else kept.push(m);
      });
      this.cols[col] = kept;
    }
    return out;
  }

  /** Piston pass: surviving blocks whose row changed, with their target y. */
  compactMoves(): { mesh: THREE.Mesh; toY: number }[] {
    const moves: { mesh: THREE.Mesh; toY: number }[] = [];
    for (const col of this.cols) {
      col.forEach((mesh, r) => {
        const toY = rowY(r);
        if (Math.abs(mesh.position.y - toY) > 1e-4) moves.push({ mesh, toY });
      });
    }
    return moves;
  }

  dispose(): void {
    for (const m of this.allMeshes()) disposeMesh(m);
    this.cols.length = 0;
    for (const r of this.rails) this.group.remove(r);
    this.railMat.dispose();
    this.rails = [];
    this.group.parent?.remove(this.group);
  }
}

interface Shard {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

/** Particle burst for a blast. One shared (burst-scoped) material, faded out. */
export class PopBurst {
  private shards: Shard[] = [];
  private mat: THREE.MeshStandardMaterial;
  private life = 0;
  private readonly maxLife = 0.75;

  constructor(private scene: THREE.Scene, center: THREE.Vector3, colorHex: number, count = 16) {
    this.mat = new THREE.MeshStandardMaterial({
      color: colorHex,
      roughness: 0.4,
      transparent: true,
    });
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(shardGeo, this.mat);
      mesh.position
        .copy(center)
        .add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.8, 0));
      const vel = new THREE.Vector3(
        (Math.random() - 0.5) * 5,
        Math.random() * 4 + 1.5,
        (Math.random() - 0.2) * 3
      );
      const spin = new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8);
      scene.add(mesh);
      this.shards.push({ mesh, vel, spin });
    }
  }

  /** Returns false once finished. */
  update(dt: number): boolean {
    this.life += dt;
    const k = this.life / this.maxLife;
    if (k >= 1) return false;
    this.mat.opacity = 1 - k * k;
    for (const s of this.shards) {
      s.vel.y -= 12 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
    }
    return true;
  }

  dispose(): void {
    for (const s of this.shards) this.scene.remove(s.mesh);
    this.mat.dispose();
    this.shards.length = 0;
  }
}
