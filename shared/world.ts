// Génération procédurale déterministe de la ville.
// Repère : x = latéral (droite +), y = altitude (haut +), z = distance parcourue (avant +).
//
// Principe d'équité : on trace d'abord un chemin navigable (pente et courbure
// bornées), puis on pose les obstacles autour. Chaque obstacle est « découpé »
// pour ne jamais empiéter sur un tube libre de largeur `minGap(z)` centré sur
// le chemin. Suivre le chemin garantit donc toujours un passage.

import { Box, boxesOverlap, makeBox } from './collision';
import { Rng, hash2 } from './prng';

export const CHUNK_LEN = 200;
export const DISTRICT_LEN = 1500;
export const PATH_STEP = 10;
export const CELL_LEN = 20;
export const CELLS_PER_CHUNK = CHUNK_LEN / CELL_LEN;
export const GROUND_Y = 0;
export const SOFT_CEILING = 70;
export const MISSILE_RADIUS = 0.7;
/** Marge de chemin prise de part et d'autre d'un obstacle pour le tube libre. */
const SAFE_MARGIN_Z = 4;

export enum District {
  Downtown = 0,
  Industrial = 1,
  Canyon = 2,
  Metro = 3,
  Port = 4,
}
export const DISTRICT_COUNT = 5;
export const DISTRICT_NAMES = ['Centre-ville néon', 'Zone industrielle', 'Canyon de verre', 'Tunnel de métro', 'Le Port'];

export interface DistrictDef {
  halfW: number;
  yMin: number;
  yMax: number;
  maxSlope: number;
  wallH: [number, number];
  ceiling?: number;
  density: number;
  weights: Partial<Record<ObstacleTemplate, number>>;
}

export type ObstacleTemplate =
  | 'beam'
  | 'pillar'
  | 'block'
  | 'slit'
  | 'containers'
  | 'gantry'
  | 'drone'
  | 'train'
  | 'laser'
  | 'crane'
  | 'door';

export const DISTRICTS: DistrictDef[] = [
  {
    halfW: 20,
    yMin: 9,
    yMax: 30,
    maxSlope: 0.24,
    wallH: [25, 85],
    density: 1,
    weights: { beam: 3, pillar: 2, block: 3, slit: 1, drone: 2, laser: 1.5 },
  },
  {
    halfW: 22,
    yMin: 8,
    yMax: 26,
    maxSlope: 0.24,
    wallH: [8, 24],
    density: 1,
    weights: { beam: 4, pillar: 3, slit: 0.6, crane: 1.6, train: 1.6, block: 1 },
  },
  {
    halfW: 10,
    yMin: 12,
    yMax: 40,
    maxSlope: 0.14,
    wallH: [90, 230],
    density: 0.9,
    weights: { beam: 4, slit: 2, block: 2, pillar: 1, drone: 1 },
  },
  {
    halfW: 10,
    yMin: 8,
    yMax: 8.6,
    maxSlope: 0.14,
    wallH: [17, 17],
    ceiling: 17,
    density: 1.05,
    weights: { pillar: 3, block: 2, door: 2.2, laser: 2, slit: 1.5, beam: 1 },
  },
  {
    halfW: 28,
    yMin: 8,
    yMax: 22,
    maxSlope: 0.24,
    wallH: [3, 9],
    density: 1,
    weights: { containers: 4, gantry: 2, crane: 2, beam: 1, train: 1.2, pillar: 1 },
  },
];

export type ObstacleKind =
  | 'wall'
  | 'decor'
  | 'ceiling'
  | 'beam'
  | 'pillar'
  | 'block'
  | 'slit'
  | 'container'
  | 'gantry'
  | 'drone'
  | 'train'
  | 'laser'
  | 'crane'
  | 'door';

export type MoveMode = 'sine' | 'loop' | 'blink' | 'door';

export interface Mover {
  axis: 'x' | 'y';
  amp: number; // amplitude (sine/door) ou course totale (loop)
  period: number;
  phase: number;
  mode: MoveMode;
  duty?: number; // blink : fraction de temps active
}

export interface Collider {
  id: number; // unique dans la partie (chunk * 10000 + index)
  kind: ObstacleKind;
  box: Box; // position de repos (statique) ; pour un mobile : position à t = 0 de son mouvement
  swept: Box; // enveloppe de tout le mouvement (= box pour un statique)
  mover?: Mover;
  style: number; // [0, 1) pour la variation visuelle
}

export type PickupType = 'shield' | 'slowmo' | 'magnet';

export interface Ring {
  id: number;
  x: number;
  y: number;
  z: number;
  r: number;
}
export interface Pickup {
  id: number;
  type: PickupType;
  x: number;
  y: number;
  z: number;
}

export interface Chunk {
  index: number;
  z0: number;
  z1: number;
  district: District;
  colliders: Collider[];
  decor: Box[]; // bâtiments d'arrière-plan, sans collision
  rings: Ring[];
  pickups: Pickup[];
  /** cellules de CELL_LEN mètres -> indices de `colliders` */
  grid: number[][];
}

// ---------------------------------------------------------------------------

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Difficulté de 0 à 1 selon la distance. */
export function difficulty(z: number): number {
  return clamp(z / 9000, 0, 1);
}
/** Largeur minimale de passage garantie (m). */
export function minGap(z: number): number {
  return lerp(15, 6.5, Math.pow(difficulty(z), 0.85));
}
/** Vitesse de croisière (m/s) en fonction de la distance. */
export function baseSpeed(z: number): number {
  return 60 + 175 * (1 - Math.exp(-z / 7000));
}

/** Position d'un mobile au temps t (décalage le long de son axe), et actif ou non. */
export function moverOffset(m: Mover, t: number): { off: number; active: boolean } {
  const ph = t / m.period + m.phase;
  switch (m.mode) {
    case 'sine':
      return { off: m.amp * Math.sin(ph * Math.PI * 2), active: true };
    case 'loop': {
      const f = ph - Math.floor(ph);
      return { off: (f - 0.5) * m.amp, active: true };
    }
    case 'blink': {
      const f = ph - Math.floor(ph);
      return { off: 0, active: f < (m.duty ?? 0.5) };
    }
    case 'door': {
      // ouverte -> se ferme -> reste fermée -> se rouvre (0 = ouverte, amp = fermée)
      const f = ph - Math.floor(ph);
      const s = clamp(Math.sin(f * Math.PI * 2) * 1.6 + 0.3, 0, 1);
      return { off: m.amp * s, active: true };
    }
  }
}

/** Boîte courante d'un collider au temps t (null si inactif, ex. laser éteint). */
export function colliderBoxAt(c: Collider, t: number, out?: Box): Box | null {
  if (!c.mover) return c.box;
  const { off, active } = moverOffset(c.mover, t);
  if (!active) return null;
  const b = out ?? { ...c.box };
  b.minX = c.box.minX;
  b.maxX = c.box.maxX;
  b.minY = c.box.minY;
  b.maxY = c.box.maxY;
  b.minZ = c.box.minZ;
  b.maxZ = c.box.maxZ;
  if (c.mover.axis === 'x') {
    b.minX += off;
    b.maxX += off;
  } else {
    b.minY += off;
    b.maxY += off;
  }
  return b;
}

function sweptOf(box: Box, m: Mover): Box {
  let lo: number;
  let hi: number;
  if (m.mode === 'loop') {
    lo = -m.amp / 2;
    hi = m.amp / 2;
  } else if (m.mode === 'door') {
    lo = Math.min(0, m.amp);
    hi = Math.max(0, m.amp);
  } else if (m.mode === 'blink') {
    lo = 0;
    hi = 0;
  } else {
    lo = -Math.abs(m.amp);
    hi = Math.abs(m.amp);
  }
  const s = { ...box };
  if (m.axis === 'x') {
    s.minX += lo;
    s.maxX += hi;
  } else {
    s.minY += lo;
    s.maxY += hi;
  }
  return s;
}

// ---------------------------------------------------------------------------

export class World {
  readonly seed: number;
  private px: number[] = [];
  private py: number[] = [];
  private pathRng: Rng;
  private vx = 0;
  private vy = 0;
  private yTarget = 18;
  private yTargetUntil = 0;
  private chunks = new Map<number, Chunk>();
  private districtCache = new Map<number, District>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.pathRng = new Rng(hash2(this.seed, 1));
    this.px.push(0);
    this.py.push(16);
  }

  // ----- quartiers ---------------------------------------------------------

  districtIndexAt(z: number): District {
    const k = Math.max(0, Math.floor(z / DISTRICT_LEN));
    const cached = this.districtCache.get(k);
    if (cached !== undefined) return cached;
    let d: District;
    if (k === 0) d = District.Downtown;
    else {
      const block = Math.floor((k - 1) / 4);
      const perm = this.districtPerm(block);
      d = perm[(k - 1) % 4];
    }
    this.districtCache.set(k, d);
    return d;
  }

  private districtPerm(block: number): District[] {
    const rng = new Rng(hash2(this.seed, 7700 + block));
    const arr = [District.Industrial, District.Canyon, District.Metro, District.Port];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    // éviter deux fois le même quartier d'affilée entre deux blocs
    const prevLast = block === 0 ? District.Downtown : this.districtPerm(block - 1)[3];
    if (arr[0] === prevLast) [arr[0], arr[1]] = [arr[1], arr[0]];
    return arr;
  }

  districtDef(z: number): DistrictDef {
    return DISTRICTS[this.districtIndexAt(z)];
  }

  // ----- chemin navigable -----------------------------------------------------

  private extendPath(toZ: number): void {
    const need = Math.ceil(toZ / PATH_STEP) + 2;
    while (this.px.length < need) {
      const i = this.px.length;
      const z = i * PATH_STEP;
      const r = this.pathRng;
      // On anticipe le quartier à venir pour arriver à la bonne altitude (tunnels).
      const cur = this.districtDef(z);
      const ahead = this.districtDef(z + 320);
      const def = ahead.ceiling !== undefined ? ahead : cur.ceiling !== undefined ? cur : ahead;
      const slope = Math.min(cur.maxSlope, ahead.maxSlope);
      const gHalf = minGap(z + 320) / 2;
      const yLo = Math.max(def.yMin, gHalf + 1);
      const yHi = Math.max(yLo, def.ceiling !== undefined ? def.ceiling - gHalf - 0.5 : def.yMax);
      if (z >= this.yTargetUntil || this.yTarget < yLo || this.yTarget > yHi) {
        this.yTarget = r.range(yLo, yHi);
        this.yTargetUntil = z + r.range(120, 300);
      }
      const maxStep = slope * PATH_STEP;
      // marche aléatoire à courbure bornée
      this.vx += r.range(-1, 1) * 0.55 * (slope / 0.24);
      this.vx -= this.px[i - 1] * 0.004;
      this.vx = clamp(this.vx, -maxStep, maxStep);
      const x = this.px[i - 1] + this.vx;
      const targetVy = clamp((this.yTarget - this.py[i - 1]) * 0.12, -maxStep * 0.6, maxStep * 0.6);
      this.vy += clamp(targetVy - this.vy, -0.35, 0.35);
      let y = this.py[i - 1] + this.vy;
      y = clamp(y, Math.max(gHalf + 0.6, 4), 60);
      if (cur.ceiling !== undefined) y = Math.min(y, cur.ceiling - minGap(z) / 2 - 0.4);
      this.px.push(x);
      this.py.push(y);
    }
  }

  pathAt(z: number): { x: number; y: number } {
    const zz = Math.max(0, z);
    this.extendPath(zz + PATH_STEP * 2);
    const f = zz / PATH_STEP;
    const i = Math.floor(f);
    const t = f - i;
    return { x: lerp(this.px[i], this.px[i + 1], t), y: lerp(this.py[i], this.py[i + 1], t) };
  }

  /** Min/max du chemin sur [z0, z1]. */
  pathRange(z0: number, z1: number) {
    const a = this.pathAt(z0);
    const b = this.pathAt(z1);
    let minX = Math.min(a.x, b.x);
    let maxX = Math.max(a.x, b.x);
    let minY = Math.min(a.y, b.y);
    let maxY = Math.max(a.y, b.y);
    const i0 = Math.ceil(Math.max(0, z0) / PATH_STEP);
    const i1 = Math.floor(Math.max(0, z1) / PATH_STEP);
    for (let i = i0; i <= i1; i++) {
      minX = Math.min(minX, this.px[i]);
      maxX = Math.max(maxX, this.px[i]);
      minY = Math.min(minY, this.py[i]);
      maxY = Math.max(maxY, this.py[i]);
    }
    return { minX, maxX, minY, maxY };
  }

  /** Tube libre garanti autour du chemin pour un obstacle couvrant [z0, z1]. */
  safeBox(z0: number, z1: number): Box {
    const g = Math.max(minGap(z0), minGap(z1)) / 2;
    const r = this.pathRange(z0 - SAFE_MARGIN_Z, z1 + SAFE_MARGIN_Z);
    return makeBox(r.minX - g, r.minY - g, z0 - SAFE_MARGIN_Z, r.maxX + g, r.maxY + g, z1 + SAFE_MARGIN_Z);
  }

  // ----- tronçons --------------------------------------------------------------

  getChunk(index: number): Chunk {
    let c = this.chunks.get(index);
    if (!c) {
      c = this.generateChunk(index);
      this.chunks.set(index, c);
    }
    return c;
  }

  peekChunk(index: number): Chunk | undefined {
    return this.chunks.get(index);
  }

  /** Libère les tronçons hors de [minIndex, maxIndex]. */
  prune(minIndex: number, maxIndex: number): void {
    for (const k of this.chunks.keys()) if (k < minIndex || k > maxIndex) this.chunks.delete(k);
  }

  private generateChunk(index: number): Chunk {
    const z0 = index * CHUNK_LEN;
    const z1 = z0 + CHUNK_LEN;
    this.extendPath(z1 + 40);
    const rng = new Rng(hash2(this.seed, 100_000 + index));
    const district = this.districtIndexAt(z0 + 1);
    const chunk: Chunk = {
      index,
      z0,
      z1,
      district,
      colliders: [],
      decor: [],
      rings: [],
      pickups: [],
      grid: Array.from({ length: CELLS_PER_CHUNK }, () => []),
    };
    let nextId = index * 10000;
    const add = (kind: ObstacleKind, box: Box, mover?: Mover) => {
      if (box.maxZ > z1) box.maxZ = z1;
      if (box.minZ < z0) box.minZ = z0;
      if (box.maxZ - box.minZ < 0.3) return;
      const swept = mover ? sweptOf(box, mover) : box;
      chunk.colliders.push({ id: nextId++, kind, box, swept, mover, style: rng.float() });
    };

    this.buildWalls(chunk, rng, add);
    this.buildObstacles(chunk, rng, add, z0 + (index === 0 ? 260 : 0), z1);
    this.buildRings(chunk, rng, index === 0 ? 120 : 0);

    // grille spatiale
    chunk.colliders.forEach((c, i) => {
      const a = clamp(Math.floor((c.swept.minZ - z0) / CELL_LEN), 0, CELLS_PER_CHUNK - 1);
      const b = clamp(Math.floor((c.swept.maxZ - z0 - 1e-6) / CELL_LEN), 0, CELLS_PER_CHUNK - 1);
      for (let k = a; k <= b; k++) chunk.grid[k].push(i);
    });
    return chunk;
  }

  private buildWalls(chunk: Chunk, rng: Rng, add: (k: ObstacleKind, b: Box, m?: Mover) => void) {
    for (const side of [-1, 1]) {
      let z = chunk.z0;
      while (z < chunk.z1) {
        const def = this.districtDef(z);
        const tunnel = def.ceiling !== undefined;
        const len = tunnel ? Math.min(40, chunk.z1 - z) : rng.range(14, 42);
        const za = z;
        // on ne chevauche jamais une frontière de quartier (entrée/sortie de tunnel nette)
        const boundary = (Math.floor(z / DISTRICT_LEN) + 1) * DISTRICT_LEN;
        const zb = Math.min(chunk.z1, z + len, boundary);
        const defB = this.districtDef(zb - 0.01);
        const halfW = Math.min(def.halfW, defB.halfW);
        const pr = this.pathRange(za - 2, zb + 2);
        const h = tunnel ? def.ceiling! + 1 : rng.range(def.wallH[0], def.wallH[1]);
        const depth = rng.range(18, 36);
        if (side < 0) {
          const inner = pr.minX - halfW;
          add('wall', makeBox(inner - depth, 0, za, inner, h, zb));
          if (!tunnel) {
            const h2 = h * rng.range(0.9, 2.2) + 10;
            chunk.decor.push(makeBox(inner - depth - rng.range(25, 50), 0, za, inner - depth - 4, h2, zb));
          }
        } else {
          const inner = pr.maxX + halfW;
          add('wall', makeBox(inner, 0, za, inner + depth, h, zb));
          if (!tunnel) {
            const h2 = h * rng.range(0.9, 2.2) + 10;
            chunk.decor.push(makeBox(inner + depth + 4, 0, za, inner + depth + rng.range(25, 50), h2, zb));
          }
        }
        if (tunnel && side > 0) {
          add('ceiling', makeBox(pr.minX - halfW - 2, def.ceiling!, za, pr.maxX + halfW + 2, def.ceiling! + 4, zb));
        }
        // ruelles entre les immeubles (hors tunnel)
        z = zb + (tunnel ? 0 : rng.chance(0.55) ? rng.range(2, 6) : 0);
      }
    }
  }

  /** Découpe `box` pour qu'elle n'empiète pas sur `safe`. `axes` : axes de découpe autorisés. */
  private carve(box: Box, safe: Box, axes: 'x' | 'y' | 'xy', minThick = 0.6): Box | null {
    if (!boxesOverlap(box, safe)) return box;
    const options: { b: Box; loss: number }[] = [];
    if (axes !== 'y') {
      if (safe.minX - box.minX >= minThick) options.push({ b: { ...box, maxX: safe.minX }, loss: box.maxX - safe.minX });
      if (box.maxX - safe.maxX >= minThick) options.push({ b: { ...box, minX: safe.maxX }, loss: safe.maxX - box.minX });
    }
    if (axes !== 'x') {
      if (safe.minY - box.minY >= minThick) options.push({ b: { ...box, maxY: safe.minY }, loss: box.maxY - safe.minY });
      if (box.maxY - safe.maxY >= minThick) options.push({ b: { ...box, minY: safe.maxY }, loss: safe.maxY - box.minY });
    }
    if (!options.length) return null;
    options.sort((a, b) => a.loss - b.loss);
    return options[0].b;
  }

  private buildObstacles(
    chunk: Chunk,
    rng: Rng,
    add: (k: ObstacleKind, b: Box, m?: Mover) => void,
    zStart: number,
    zEnd: number,
  ) {
    let z = Math.max(zStart, chunk.z0 + rng.range(5, 25));
    while (z < zEnd - 12) {
      const def = this.districtDef(z);
      const diff = difficulty(z);
      const spacing = lerp(58, 24, diff) / def.density;
      const tpl = rng.weighted(def.weights) as ObstacleTemplate;
      const depth = this.placeTemplate(tpl, z, Math.min(zEnd, chunk.z1), def, rng, add);
      z += depth + spacing * rng.range(0.65, 1.35);
    }
  }

  /** Pose un gabarit d'obstacle à z. Retourne sa profondeur (m). */
  private placeTemplate(
    tpl: ObstacleTemplate,
    z: number,
    zMax: number,
    def: DistrictDef,
    rng: Rng,
    add: (k: ObstacleKind, b: Box, m?: Mover) => void,
  ): number {
    const p = this.pathAt(z);
    const halfW = def.halfW;
    const L = p.x - halfW - 6;
    const R = p.x + halfW + 6;
    const ceil = def.ceiling ?? 90;
    const put = (kind: ObstacleKind, b: Box, axes: 'x' | 'y' | 'xy') => {
      if (b.maxZ > zMax) b.maxZ = zMax;
      const safe = this.safeBox(b.minZ, b.maxZ);
      const c = this.carve(b, safe, axes);
      if (c) add(kind, c);
    };
    const putMover = (kind: ObstacleKind, b: Box, m: Mover) => {
      if (b.maxZ > zMax) b.maxZ = zMax;
      const safe = this.safeBox(b.minZ, b.maxZ);
      if (boxesOverlap(sweptOf(b, m), safe)) return false;
      add(kind, b, m);
      return true;
    };
    const g = minGap(z);

    switch (tpl) {
      case 'beam': {
        const d = rng.range(3, 9);
        const th = rng.range(1.8, 4);
        // hauteur : tantôt sous le chemin, tantôt dessus, tantôt en plein dedans (sera découpée)
        const y = clamp(p.y + rng.range(-12, 12), 1.5, ceil - th - 0.5);
        put('beam', makeBox(L, y, z, R, y + th, z + d), 'y');
        return d;
      }
      case 'pillar': {
        const d = rng.range(3, 7);
        const w = rng.range(2.5, 7);
        const cx = p.x + rng.range(-halfW * 0.9, halfW * 0.9);
        const h = def.ceiling ?? rng.range(30, 110);
        put('pillar', makeBox(cx - w / 2, 0, z, cx + w / 2, h, z + d), 'x');
        if (rng.chance(0.5)) {
          const cx2 = p.x + rng.range(-halfW * 0.9, halfW * 0.9);
          if (Math.abs(cx2 - cx) > w + 3) put('pillar', makeBox(cx2 - w / 2, 0, z, cx2 + w / 2, h, z + d), 'x');
        }
        return d;
      }
      case 'block': {
        const n = rng.int(1, 3);
        let d = 0;
        for (let i = 0; i < n; i++) {
          const w = rng.range(4, 11);
          const h = rng.range(2.5, 7);
          const dd = rng.range(2, 6);
          const cx = p.x + rng.range(-halfW, halfW);
          const top = def.ceiling !== undefined && rng.chance(0.6);
          const cy = top ? ceil - h / 2 : clamp(p.y + rng.range(-10, 10), h / 2 + 1, ceil - h / 2 - 1);
          const zz = z + rng.range(0, 6);
          put('block', makeBox(cx - w / 2, cy - h / 2, zz, cx + w / 2, cy + h / 2, zz + dd), 'xy');
          d = Math.max(d, zz + dd - z);
        }
        return d;
      }
      case 'slit': {
        // mur percé d'une ouverture qui contient le tube libre
        const d = rng.range(2, 4);
        const safe = this.safeBox(z, z + d);
        const extraX = rng.range(0, 5);
        const extraY = rng.range(0, 4);
        const hx0 = safe.minX - extraX * rng.float();
        const hx1 = safe.maxX + extraX * rng.float();
        const hy0 = Math.max(0, safe.minY - extraY * rng.float());
        const hy1 = safe.maxY + extraY * rng.float();
        const top = Math.min(ceil, hy1 + rng.range(4, 14));
        add('slit', makeBox(L, 0, z, hx0, top, z + d));
        add('slit', makeBox(hx1, 0, z, R, top, z + d));
        if (hy0 > 0.6) add('slit', makeBox(hx0, 0, z, hx1, hy0, z + d));
        if (top - hy1 > 0.6) add('slit', makeBox(hx0, hy1, z, hx1, top, z + d));
        return d;
      }
      case 'containers': {
        let d = 0;
        const rows = rng.int(2, 5);
        for (let i = 0; i < rows; i++) {
          const long = rng.chance(0.5);
          const w = long ? 2.5 : rng.chance(0.5) ? 6 : 12;
          const dd = long ? rng.chance(0.5) ? 6 : 12 : 2.5;
          const stack = rng.int(1, 4);
          const cx = p.x + rng.range(-halfW, halfW);
          const zz = z + rng.range(0, 14);
          put('container', makeBox(cx - w / 2, 0, zz, cx + w / 2, stack * 2.6, zz + dd), 'xy');
          d = Math.max(d, zz + dd - z);
        }
        return d;
      }
      case 'gantry': {
        const d = rng.range(3, 5);
        const legW = 2;
        const span = rng.range(10, 22);
        const cx = p.x + rng.range(-6, 6);
        const h = rng.range(14, 30);
        put('gantry', makeBox(cx - span / 2 - legW, 0, z, cx - span / 2, h, z + d), 'x');
        put('gantry', makeBox(cx + span / 2, 0, z, cx + span / 2 + legW, h, z + d), 'x');
        put('gantry', makeBox(cx - span / 2 - legW - 4, h, z, cx + span / 2 + legW + 4, h + 3, z + d), 'y');
        return d;
      }
      case 'drone': {
        const n = rng.int(1, 3);
        for (let i = 0; i < n; i++) {
          const s = rng.range(1.6, 2.6);
          const zz = z + i * rng.range(6, 14);
          const safe = this.safeBox(zz, zz + s);
          const axis = rng.chance(0.5) ? 'x' : 'y';
          const amp = rng.range(2, 6);
          // on place le drone d'un côté du tube libre, hors de son enveloppe
          let b: Box;
          if (axis === 'x') {
            const left = rng.chance(0.5);
            const cy = clamp(p.y + rng.range(-6, 6), s + 1, ceil - s - 1);
            const cx = left ? safe.minX - amp - s / 2 - 0.2 : safe.maxX + amp + s / 2 + 0.2;
            b = makeBox(cx - s / 2, cy - s / 2, zz, cx + s / 2, cy + s / 2, zz + s);
          } else {
            const below = rng.chance(0.4) && safe.minY > amp * 2 + s + 1;
            const cx = p.x + rng.range(-g, g);
            const cy = below ? safe.minY - amp - s / 2 - 0.2 : safe.maxY + amp + s / 2 + 0.2;
            b = makeBox(cx - s / 2, cy - s / 2, zz, cx + s / 2, cy + s / 2, zz + s);
          }
          if (b.maxY < ceil) putMover('drone', b, { axis, amp, period: rng.range(1.6, 3.2), phase: rng.float(), mode: 'sine' });
        }
        return n * 8;
      }
      case 'train': {
        const d = rng.range(3.2, 4);
        const h = 3.4;
        const safe = this.safeBox(z, z + d);
        let y0: number;
        if (safe.minY > h + 1.2) y0 = rng.range(0.8, safe.minY - h - 0.2);
        else y0 = safe.maxY + 1 + rng.range(0, 6);
        if (y0 + h > ceil) return 4;
        const len = rng.range(30, 60);
        const travel = (R - L) + len + 80;
        // rail aérien
        put('beam', makeBox(L - 20, y0 - 0.9, z + 0.6, R + 20, y0 - 0.3, z + d - 0.6), 'y');
        putMover('train', makeBox(p.x - len / 2, y0, z, p.x + len / 2, y0 + h, z + d), {
          axis: 'x',
          amp: travel,
          period: rng.range(2.5, 4.5),
          phase: rng.float(),
          mode: 'loop',
        });
        return d;
      }
      case 'laser': {
        const d = 0.5;
        const safe = this.safeBox(z, z + d);
        const levels = rng.int(3, 6);
        const step = rng.range(2.2, 3.4);
        const base = rng.range(1, 3);
        const period = rng.range(1.4, 2.2);
        for (let i = 0; i < levels; i++) {
          const y = base + i * step;
          if (y + 0.3 > ceil) break;
          const b = makeBox(L, y, z, R, y + 0.3, z + d);
          const phase = (i % 2) * 0.5;
          // les segments hors du tube libre : on coupe le laser autour du tube
          if (boxesOverlap(b, safe)) {
            const lb = makeBox(L, y, z, safe.minX, y + 0.3, z + d);
            const rb = makeBox(safe.maxX, y, z, R, y + 0.3, z + d);
            if (lb.maxX - lb.minX > 1) putMover('laser', lb, { axis: 'x', amp: 0, period, phase, mode: 'blink', duty: 0.5 });
            if (rb.maxX - rb.minX > 1) putMover('laser', rb, { axis: 'x', amp: 0, period, phase, mode: 'blink', duty: 0.5 });
          } else putMover('laser', b, { axis: 'x', amp: 0, period, phase, mode: 'blink', duty: 0.5 });
        }
        return d + 2;
      }
      case 'crane': {
        const d = 3;
        const tw = 3;
        const side = rng.chance(0.5) ? -1 : 1;
        const tx = p.x + side * (halfW + 3);
        const h = rng.range(26, 45);
        add('crane', makeBox(tx - tw / 2, 0, z, tx + tw / 2, h + 4, z + d));
        // flèche qui balaie le couloir au-dessus du tube libre (ou dessous si la place manque)
        const safe = this.safeBox(z - 2, z + d + 2);
        const jibY = Math.max(h, safe.maxY + 0.3);
        if (jibY + 2.5 > ceil) return d;
        const jibLen = halfW * 1.3;
        const jibMove: Mover = { axis: 'x', amp: halfW * 0.6, period: rng.range(5, 9), phase: rng.float(), mode: 'sine' };
        if (!putMover('crane', makeBox(p.x - jibLen / 2, jibY, z - 1, p.x + jibLen / 2, jibY + 2.2, z + d + 1), jibMove)) return d;
        // charge suspendue qui suit la flèche
        const hookLow = Math.max(safe.maxY + 0.3, jibY - rng.range(6, 14));
        if (jibY - hookLow > 1.5) putMover('crane', makeBox(p.x - 2, hookLow, z - 1, p.x + 2, jibY, z + d + 1), { ...jibMove });
        return d + 2;
      }
      case 'door': {
        const d = rng.range(1.5, 3);
        const safe = this.safeBox(z, z + d);
        const top = ceil;
        const period = rng.range(2.4, 3.6);
        const phase = rng.float();
        // panneau gauche : ouvert = rentré dans le mur, fermé = bord au tube libre
        const lw = halfW + 6;
        const leftClosedEdge = safe.minX;
        const lOpen = makeBox(leftClosedEdge - lw - (leftClosedEdge - L), 0, z, L, top, z + d);
        putMover('door', lOpen, { axis: 'x', amp: leftClosedEdge - L, period, phase, mode: 'door' });
        const rightClosedEdge = safe.maxX;
        const rOpen = makeBox(R, 0, z, R + lw + (R - rightClosedEdge), top, z + d);
        putMover('door', rOpen, { axis: 'x', amp: -(R - rightClosedEdge), period, phase, mode: 'door' });
        return d + 3;
      }
    }
  }

  private buildRings(chunk: Chunk, rng: Rng, startOffset: number) {
    let z = chunk.z0 + startOffset + rng.range(20, 60);
    let id = chunk.index * 1000;
    while (z < chunk.z1 - 5) {
      if (rng.chance(0.55)) {
        // petite rangée d'anneaux qui suit le chemin
        const n = rng.int(2, 5);
        for (let i = 0; i < n && z < chunk.z1 - 2; i++) {
          const p = this.pathAt(z);
          chunk.rings.push({ id: id++, x: p.x, y: p.y, z, r: 3.2 });
          z += 14;
        }
      } else if (rng.chance(0.12)) {
        const p = this.pathAt(z);
        const type = rng.pick<PickupType>(['shield', 'slowmo', 'magnet']);
        chunk.pickups.push({ id: id++, type, x: p.x, y: p.y, z });
      }
      z += rng.range(60, 130);
    }
  }

}
