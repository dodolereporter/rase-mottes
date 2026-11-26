// Rendu de la ville : un pool de tronçons recyclés, chacun avec des InstancedMesh.

import {
  BoxGeometry,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  ShaderMaterial,
  TorusGeometry,
  Vector3,
} from 'three';
import { Box } from '../../../../shared/collision';
import { Chunk, Collider, World, moverOffset, rotorAngle } from '../../../../shared/world';
import { Rng, hash2 } from '../../../../shared/prng';
import { createGlowMaterial, createStructureMaterial } from './materials';
import { KIND_CODE, PALETTES } from './palette';

const STATIC_CAP = 1100;
const MOVER_CAP = 80;
const RING_CAP = 40;
const PICKUP_CAP = 8;

const boxGeo = new BoxGeometry(1, 1, 1);
const ringGeo = new TorusGeometry(3.2, 0.22, 8, 40);
const pickupGeo = new OctahedronGeometry(1.4, 0);

const m4 = new Matrix4();
const q = new Quaternion();
const v = new Vector3();
const s = new Vector3();
const tmpColor = new Color();
const zAxis = new Vector3(0, 0, 1);

const CONTAINER_COLORS = ['#7a2a1e', '#1e4a7a', '#2a6a3a', '#7a6a1e', '#5a5a64', '#7a3a5a'].map((h) => new Color(h));

/** Conversion repère du jeu (z avant) -> repère three (z vers la caméra). */
export function setBoxMatrix(mat: Matrix4, b: Box, offX = 0, offY = 0) {
  v.set((b.minX + b.maxX) / 2 + offX, (b.minY + b.maxY) / 2 + offY, -(b.minZ + b.maxZ) / 2);
  s.set(Math.max(0.01, b.maxX - b.minX), Math.max(0.01, b.maxY - b.minY), Math.max(0.01, b.maxZ - b.minZ));
  q.identity();
  mat.compose(v, q, s);
}

function makeInstanced(cap: number, material: ShaderMaterial, dynamic: boolean): InstancedMesh {
  const geo = boxGeo.clone();
  geo.setAttribute('aStyle', new InstancedBufferAttribute(new Float32Array(cap * 4), 4));
  geo.setAttribute('aColor', new InstancedBufferAttribute(new Float32Array(cap * 3), 3));
  const mesh = new InstancedMesh(geo, material, cap);
  mesh.count = 0;
  mesh.frustumCulled = false;
  if (dynamic) {
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    (geo.getAttribute('aStyle') as InstancedBufferAttribute).setUsage(DynamicDrawUsage);
  }
  return mesh;
}

class ChunkView {
  group = new Group();
  statics: InstancedMesh;
  movers: InstancedMesh;
  rings: InstancedMesh;
  pickups: InstancedMesh[];
  chunk: Chunk | null = null;
  moverList: Collider[] = [];
  rotorList: Collider[] = [];

  constructor(material: ShaderMaterial, ringMat: ShaderMaterial, pickupMats: ShaderMaterial[], public world: World) {
    this.statics = makeInstanced(STATIC_CAP, material, false);
    this.movers = makeInstanced(MOVER_CAP, material, true);
    this.rings = new InstancedMesh(ringGeo, ringMat, RING_CAP);
    this.rings.instanceMatrix.setUsage(DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.count = 0;
    this.pickups = pickupMats.map((m) => {
      const im = new InstancedMesh(pickupGeo, m, PICKUP_CAP);
      im.frustumCulled = false;
      im.count = 0;
      im.instanceMatrix.setUsage(DynamicDrawUsage);
      return im;
    });
    this.group.add(this.statics, this.movers, this.rings, ...this.pickups);
  }

  assign(chunk: Chunk) {
    this.chunk = chunk;
    const pal = PALETTES[chunk.district];
    const style = this.statics.geometry.getAttribute('aStyle') as InstancedBufferAttribute;
    const color = this.statics.geometry.getAttribute('aColor') as InstancedBufferAttribute;
    let n = 0;
    const put = (b: Box, kind: string, rnd: number) => {
      if (n >= STATIC_CAP) return;
      setBoxMatrix(m4, b);
      this.statics.setMatrixAt(n, m4);
      const code = KIND_CODE[kind] ?? 2;
      style.setXYZW(n, code, rnd, kind === 'wall' || kind === 'decor' ? (rnd > 0.3 ? 1 : 0.2) : 1, 1);
      if (code === 0) tmpColor.copy(pal.building).multiplyScalar(0.75 + rnd * 0.5);
      else if (code === 4) tmpColor.copy(CONTAINER_COLORS[Math.floor(rnd * CONTAINER_COLORS.length)]);
      else if (code === 1) tmpColor.copy(pal.building).multiplyScalar(0.6);
      else tmpColor.copy(pal.building).multiplyScalar(0.55).lerp(pal.neonA, 0.05);
      color.setXYZ(n, tmpColor.r, tmpColor.g, tmpColor.b);
      n++;
    };
    this.moverList = [];
    this.rotorList = [];
    for (const c of chunk.colliders) {
      if (c.mover || c.rotor) this.moverList.push(c);
      else put(c.box, c.kind, c.style);
    }
    chunk.decor.forEach((b, i) => put(b, 'decor', ((i * 0.618) % 1) * 0.9 + 0.05));
    // habillage purement visuel : étages en retrait, enseignes, balises de toit
    const rng = new Rng(hash2(this.world.seed, 900_000 + chunk.index));
    const dressing = (b: Box, facade: boolean) => {
      const h = b.maxY - b.minY;
      const w = b.maxX - b.minX;
      const d = b.maxZ - b.minZ;
      let top = b.maxY;
      if (h > 14 && rng.chance(0.55)) {
        const ix = w * rng.range(0.12, 0.3);
        const iz = d * rng.range(0.12, 0.3);
        const th = h * rng.range(0.2, 0.6);
        put({ minX: b.minX + ix, maxX: b.maxX - ix, minZ: b.minZ + iz, maxZ: b.maxZ - iz, minY: top, maxY: top + th }, 'decor', rng.float());
        top += th;
        if (rng.chance(0.4)) {
          put({ minX: b.minX + ix * 2, maxX: b.maxX - ix * 2, minZ: b.minZ + iz * 2, maxZ: b.maxZ - iz * 2, minY: top, maxY: top + th * 0.5 }, 'decor', rng.float());
          top += th * 0.5;
        }
      }
      if (h > 12 && rng.chance(0.45)) {
        const cx = (b.minX + b.maxX) / 2;
        const cz = (b.minZ + b.maxZ) / 2;
        put({ minX: cx - 0.15, maxX: cx + 0.15, minZ: cz - 0.15, maxZ: cz + 0.15, minY: top, maxY: top + 6 }, 'pillar', 0.2);
        put({ minX: cx - 0.5, maxX: cx + 0.5, minZ: cz - 0.5, maxZ: cz + 0.5, minY: top + 6, maxY: top + 7 }, 'beacon', rng.float());
      }
      if (!facade || h < 9) return;
      // enseigne sur la façade côté couloir
      const pathX = this.world.pathAt((b.minZ + b.maxZ) / 2).x;
      const left = (b.minX + b.maxX) / 2 < pathX;
      const fx = left ? b.maxX : b.minX;
      const out = left ? 0.25 : -0.25;
      const x0 = Math.min(fx, fx + out);
      const x1 = Math.max(fx, fx + out);
      if (rng.chance(0.5)) {
        const sz = rng.range(1.5, 3);
        const sh = rng.range(5, Math.min(16, h - 3));
        const sy = rng.range(3, Math.max(3.5, h - sh - 1));
        const zc = rng.range(b.minZ + 2, Math.max(b.minZ + 2.5, b.maxZ - 2));
        put({ minX: x0, maxX: x1, minY: sy, maxY: sy + sh, minZ: zc - sz / 2, maxZ: zc + sz / 2 }, 'sign', rng.float());
      } else if (rng.chance(0.6)) {
        const sy = rng.range(4, Math.max(4.5, h - 3));
        put({ minX: x0, maxX: x1, minY: sy, maxY: sy + rng.range(0.8, 1.8), minZ: b.minZ + 1, maxZ: b.maxZ - 1 }, 'sign', rng.float());
      }
    };
    for (const c of chunk.colliders) if (c.kind === 'wall') dressing(c.box, true);
    for (const b of chunk.decor) dressing(b, false);
    this.statics.count = n;
    this.statics.instanceMatrix.needsUpdate = true;
    style.needsUpdate = true;
    color.needsUpdate = true;

    // mobiles : couleur fixe, matrices mises à jour à chaque image
    const mstyle = this.movers.geometry.getAttribute('aStyle') as InstancedBufferAttribute;
    const mcolor = this.movers.geometry.getAttribute('aColor') as InstancedBufferAttribute;
    this.moverList = this.moverList.slice(0, MOVER_CAP);
    this.moverList.forEach((c, i) => {
      mstyle.setXYZW(i, KIND_CODE[c.kind] ?? 2, c.style, 1, 1);
      tmpColor.copy(pal.building).multiplyScalar(c.kind === 'train' ? 1.4 : 0.8);
      mcolor.setXYZ(i, tmpColor.r, tmpColor.g, tmpColor.b);
    });
    this.movers.count = this.moverList.length;
    mstyle.needsUpdate = true;
    mcolor.needsUpdate = true;
    this.group.visible = true;
  }

  updateMovers(t: number) {
    if (!this.moverList.length) return;
    const mstyle = this.movers.geometry.getAttribute('aStyle') as InstancedBufferAttribute;
    this.moverList.forEach((c, i) => {
      if (c.rotor) {
        const r = c.rotor;
        v.set(r.cx, r.cy, -(c.box.minZ + c.box.maxZ) / 2);
        q.setFromAxisAngle(zAxis, rotorAngle(r, t));
        s.set(r.halfLen * 2, r.halfThick * 2, c.box.maxZ - c.box.minZ);
        m4.compose(v, q, s);
        this.movers.setMatrixAt(i, m4);
        return;
      }
      const { off, active } = moverOffset(c.mover!, t);
      setBoxMatrix(m4, c.box, c.mover!.axis === 'x' ? off : 0, c.mover!.axis === 'y' ? off : 0);
      this.movers.setMatrixAt(i, m4);
      mstyle.setW(i, active ? 1 : 0);
    });
    this.movers.instanceMatrix.needsUpdate = true;
    mstyle.needsUpdate = true;
  }

  /** Anneaux / bonus visibles pour un pilote donné (ceux qu'il a pris disparaissent). */
  updateCollectables(t: number, isTaken: (id: number) => boolean) {
    const chunk = this.chunk!;
    let n = 0;
    for (const r of chunk.rings) {
      if (isTaken(r.id)) continue;
      v.set(r.x, r.y, -r.z);
      s.setScalar(r.r / 3.2);
      q.identity();
      m4.compose(v, q, s);
      this.rings.setMatrixAt(n++, m4);
      if (n >= RING_CAP) break;
    }
    this.rings.count = n;
    this.rings.instanceMatrix.needsUpdate = true;
    const types = ['shield', 'slowmo', 'magnet'];
    this.pickups.forEach((im, ti) => {
      let k = 0;
      for (const p of chunk.pickups) {
        if (p.type !== types[ti] || isTaken(p.id)) continue;
        v.set(p.x, p.y + Math.sin(t * 3 + p.z) * 0.4, -p.z);
        q.setFromAxisAngle(new Vector3(0, 1, 0), t * 2 + p.z);
        s.setScalar(1);
        m4.compose(v, q, s);
        im.setMatrixAt(k++, m4);
      }
      im.count = k;
      im.instanceMatrix.needsUpdate = true;
    });
  }
}

export class CityRenderer {
  readonly group = new Group();
  readonly material = createStructureMaterial();
  private ringMat = createGlowMaterial(new Color('#ffe14d'));
  private pickupMats = [
    createGlowMaterial(new Color('#4dd2ff')),
    createGlowMaterial(new Color('#c86bff')),
    createGlowMaterial(new Color('#ff6b4d')),
  ];
  private pool: ChunkView[] = [];
  private active = new Map<number, ChunkView>();

  constructor(private world: World) {}

  setWorld(world: World) {
    this.world = world;
    for (const view of this.active.values()) this.release(view);
    this.active.clear();
  }

  private acquire(): ChunkView {
    const view = this.pool.pop() ?? new ChunkView(this.material, this.ringMat, this.pickupMats, this.world);
    view.world = this.world;
    if (!view.group.parent) this.group.add(view.group);
    return view;
  }

  private release(view: ChunkView) {
    view.group.visible = false;
    view.chunk = null;
    this.pool.push(view);
  }

  /** Garde affichés les tronçons couvrant les intervalles demandés (un par pilote). */
  update(ranges: [number, number][], t: number) {
    const needed = new Set<number>();
    for (const [a, b] of ranges) for (let i = Math.max(0, a); i <= b; i++) needed.add(i);
    for (const [idx, view] of this.active) {
      if (!needed.has(idx)) {
        this.release(view);
        this.active.delete(idx);
      }
    }
    // au plus 2 nouveaux tronçons par image pour lisser le coût de génération
    let budget = 2;
    const sorted = [...needed].sort((a, b) => a - b);
    for (const idx of sorted) {
      if (this.active.has(idx)) continue;
      if (budget-- <= 0 && this.world.peekChunk(idx) === undefined) continue;
      const view = this.acquire();
      view.assign(this.world.getChunk(idx));
      this.active.set(idx, view);
    }
    for (const view of this.active.values()) view.updateMovers(t);
  }

  prepareView(t: number, isTaken: (id: number) => boolean) {
    for (const view of this.active.values()) view.updateCollectables(t, isTaken);
  }

  get chunkCount() {
    return this.active.size;
  }
}
