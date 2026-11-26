// Simulation d'un missile (pas fixe). Pur TypeScript, sans dépendance au rendu.

import { Box, pointBoxDistance, segmentBoxDistance, sweptCapsuleBox, Vec3 } from './collision';
import {
  CELL_LEN,
  CELLS_PER_CHUNK,
  CHUNK_LEN,
  Collider,
  MISSILE_RADIUS,
  PickupType,
  SOFT_CEILING,
  World,
  baseSpeed,
  clamp,
  colliderBoxAt,
} from './world';

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;
export const GRAZE_DIST = 3;
export const COMBO_WINDOW = 3;
export const BOOST_MULT = 1.5;
export const LOW_ALT = 2.8;

export interface PilotInput {
  x: number; // -1 gauche .. 1 droite
  y: number; // -1 bas .. 1 haut
  boost: boolean;
  brake: boolean;
}

export type SimEvent =
  | { type: 'graze'; side: number; pts: number; ground?: boolean }
  | { type: 'ring'; perfect: boolean; pts: number }
  | { type: 'pickup'; kind: PickupType }
  | { type: 'shieldHit' }
  | { type: 'crash'; x: number; y: number; z: number }
  | { type: 'brake' };

const tmpBox: Box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

export class Pilot {
  x = 0;
  y = 16;
  z = 0;
  vx = 0;
  vy = 0;
  speed = 60;
  boost = 0.5;
  boosting = false;
  brakeT = 0;
  brakeCd = 0;
  shield = false;
  slowmoT = 0;
  magnetT = 0;
  invulnT = 0;
  combo = 1;
  comboT = 0;
  bestCombo = 1;
  grazes = 0;
  rings = 0;
  perfects = 0;
  maxSpeed = 0;
  score = 0;
  bonus = 0;
  time = 0;
  alive = true;
  lowT = 0;
  /** pour l'interpolation du rendu */
  prev = { x: 0, y: 16, z: 0 };
  private grazed = new Set<number>();
  private taken = new Set<number>();

  constructor(public world: World) {
    this.reset();
  }

  reset(): void {
    const p = this.world.pathAt(0);
    this.x = p.x;
    this.y = p.y;
    this.z = 0;
    this.vx = this.vy = 0;
    this.speed = baseSpeed(0);
    this.boost = 0.5;
    this.boosting = false;
    this.brakeT = this.brakeCd = 0;
    this.shield = false;
    this.slowmoT = this.magnetT = this.invulnT = 0;
    this.combo = 1;
    this.comboT = 0;
    this.bestCombo = 1;
    this.grazes = this.rings = this.perfects = 0;
    this.maxSpeed = 0;
    this.score = this.bonus = 0;
    this.time = 0;
    this.alive = true;
    this.lowT = 0;
    this.prev = { x: this.x, y: this.y, z: this.z };
    this.grazed.clear();
    this.taken.clear();
  }

  get timeScale(): number {
    return this.slowmoT > 0 ? 0.6 : 1;
  }
  get latMax(): number {
    return Math.min(0.6 * this.speed, 125);
  }
  get distance(): number {
    return this.z;
  }

  private addGraze(events: SimEvent[], side: number, ground = false) {
    this.combo = Math.min(this.combo + 1, 25);
    this.comboT = COMBO_WINDOW;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.grazes++;
    const pts = Math.round(50 * this.combo * (this.boosting ? 2 : 1));
    this.bonus += pts;
    this.boost = Math.min(1, this.boost + (ground ? 0.06 : 0.14));
    events.push({ type: 'graze', side, pts, ground });
  }

  /** Avance la simulation de dt secondes (dt déjà multiplié par timeScale). t = temps du monde. */
  step(dt: number, input: PilotInput, t: number, events: SimEvent[]): void {
    this.prev.x = this.x;
    this.prev.y = this.y;
    this.prev.z = this.z;
    if (!this.alive) return;
    this.time += dt;

    // minuteries
    this.brakeCd = Math.max(0, this.brakeCd - dt);
    this.brakeT = Math.max(0, this.brakeT - dt);
    this.slowmoT = Math.max(0, this.slowmoT - dt);
    this.magnetT = Math.max(0, this.magnetT - dt);
    this.invulnT = Math.max(0, this.invulnT - dt);
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 1;
    }

    // boost / aérofrein
    this.boosting = input.boost && this.boost > 0.01;
    if (this.boosting) this.boost = Math.max(0, this.boost - 0.3 * dt);
    if (input.brake && this.brakeCd <= 0 && this.brakeT <= 0) {
      this.brakeT = 0.9;
      this.brakeCd = 3;
      events.push({ type: 'brake' });
    }
    const target = baseSpeed(this.z) * (this.boosting ? BOOST_MULT : 1) * (this.brakeT > 0 ? 0.55 : 1);
    const rate = target > this.speed ? 1.8 : 4.5;
    this.speed += (target - this.speed) * (1 - Math.exp(-rate * dt));
    this.maxSpeed = Math.max(this.maxSpeed, this.speed);

    // pilotage latéral / vertical : réponse quasi immédiate
    const lm = this.latMax;
    const k = 1 - Math.exp(-dt / 0.055);
    this.vx += (clamp(input.x, -1, 1) * lm - this.vx) * k;
    this.vy += (clamp(input.y, -1, 1) * lm * 0.75 - this.vy) * k;

    const p0: Vec3 = { x: this.x, y: this.y, z: this.z };
    let nx = this.x + this.vx * dt;
    let ny = this.y + this.vy * dt;
    const nz = this.z + this.speed * dt;

    // couloir : on reste entre les façades
    const path = this.world.pathAt(nz);
    const def = this.world.districtDef(nz);
    const hw = def.halfW + 1.5;
    if (nx < path.x - hw) {
      nx = path.x - hw;
      this.vx = Math.max(this.vx, 0);
    } else if (nx > path.x + hw) {
      nx = path.x + hw;
      this.vx = Math.min(this.vx, 0);
    }
    if (ny > SOFT_CEILING) {
      ny = SOFT_CEILING;
      this.vy = Math.min(this.vy, 0);
    }
    const p1: Vec3 = { x: nx, y: ny, z: nz };

    // sol
    if (ny - MISSILE_RADIUS <= 0 && this.invulnT <= 0) {
      if (this.shield) {
        this.shield = false;
        this.invulnT = 1;
        ny = MISSILE_RADIUS + 1.5;
        this.vy = Math.abs(this.vy);
        p1.y = ny;
        events.push({ type: 'shieldHit' });
      } else {
        this.crash(p1, events);
        return;
      }
    }

    // collisions balayées + frôlements
    const zLo = Math.min(p0.z, p1.z) - GRAZE_DIST - 1;
    const zHi = Math.max(p0.z, p1.z) + GRAZE_DIST + 1;
    let hitT = -1;
    for (const { c, box } of this.candidates(zLo, zHi, t)) {
      if (this.invulnT <= 0) {
        const h = sweptCapsuleBox(p0, p1, MISSILE_RADIUS, box);
        if (h >= 0) {
          if (hitT < 0 || h < hitT) hitT = h;
          continue;
        }
      }
      if (!this.grazed.has(c.id)) {
        // filtre grossier avant le calcul précis
        const m = GRAZE_DIST + MISSILE_RADIUS;
        if (
          box.maxX < Math.min(p0.x, p1.x) - m ||
          box.minX > Math.max(p0.x, p1.x) + m ||
          box.maxY < Math.min(p0.y, p1.y) - m ||
          box.minY > Math.max(p0.y, p1.y) + m ||
          box.maxZ < p0.z - m ||
          box.minZ > p1.z + m
        )
          continue;
        const dist = segmentBoxDistance(p0, p1, box) - MISSILE_RADIUS;
        if (dist < GRAZE_DIST) {
          this.grazed.add(c.id);
          const cx = (box.minX + box.maxX) / 2;
          this.addGraze(events, Math.sign(cx - p1.x) || 1);
        }
      }
    }
    if (hitT >= 0) {
      const hp = { x: p0.x + (p1.x - p0.x) * hitT, y: p0.y + (p1.y - p0.y) * hitT, z: p0.z + (p1.z - p0.z) * hitT };
      if (this.shield) {
        this.shield = false;
        this.invulnT = 1;
        events.push({ type: 'shieldHit' });
      } else {
        this.crash(hp, events);
        return;
      }
    }

    // rase-mottes : voler très bas rapporte
    if (ny < LOW_ALT + MISSILE_RADIUS) {
      this.lowT += dt;
      if (this.lowT >= 0.5) {
        this.lowT -= 0.5;
        this.addGraze(events, 0, true);
      }
    } else this.lowT = 0;

    this.collectables(p0, p1, events);

    // score : distance (x2 en boost) + bonus
    this.score += (nz - this.z) * (this.boosting ? 2 : 1);
    this.x = nx;
    this.y = ny;
    this.z = nz;
  }

  private crash(p: Vec3, events: SimEvent[]) {
    this.alive = false;
    this.x = p.x;
    this.y = Math.max(p.y, 0.5);
    this.z = p.z;
    this.speed = 0;
    this.boosting = false;
    events.push({ type: 'crash', x: this.x, y: this.y, z: this.z });
  }

  get totalScore(): number {
    return Math.floor(this.score + this.bonus);
  }

  /** Obstacles susceptibles de toucher l'intervalle [zLo, zHi], avec leur boîte au temps t. */
  *candidates(zLo: number, zHi: number, t: number): Generator<{ c: Collider; box: Box }> {
    const c0 = Math.floor(Math.max(0, zLo) / CHUNK_LEN);
    const c1 = Math.floor(Math.max(0, zHi) / CHUNK_LEN);
    for (let ci = c0; ci <= c1; ci++) {
      const chunk = this.world.getChunk(ci);
      const k0 = clamp(Math.floor((zLo - chunk.z0) / CELL_LEN), 0, CELLS_PER_CHUNK - 1);
      const k1 = clamp(Math.floor((zHi - chunk.z0) / CELL_LEN), 0, CELLS_PER_CHUNK - 1);
      const seen = k1 > k0 ? new Set<number>() : null;
      for (let k = k0; k <= k1; k++) {
        for (const idx of chunk.grid[k]) {
          if (seen) {
            if (seen.has(idx)) continue;
            seen.add(idx);
          }
          const c = chunk.colliders[idx];
          if (c.swept.maxZ < zLo || c.swept.minZ > zHi) continue;
          const box = colliderBoxAt(c, t, tmpBox);
          if (box) yield { c, box };
        }
      }
    }
  }

  private collectables(p0: Vec3, p1: Vec3, events: SimEvent[]) {
    const ci = Math.floor(p1.z / CHUNK_LEN);
    for (let k = Math.max(0, ci - 1); k <= ci; k++) {
      const chunk = this.world.getChunk(k);
      for (const r of chunk.rings) {
        if (this.taken.has(r.id) || r.z <= p0.z || r.z > p1.z) continue;
        const f = (r.z - p0.z) / (p1.z - p0.z || 1);
        const x = p0.x + (p1.x - p0.x) * f;
        const y = p0.y + (p1.y - p0.y) * f;
        const d = Math.hypot(x - r.x, y - r.y);
        if (d <= r.r || (this.magnetT > 0 && d < 14)) {
          this.taken.add(r.id);
          const perfect = d < 1.1;
          this.rings++;
          if (perfect) this.perfects++;
          const pts = Math.round((perfect ? 250 : 100) * this.combo * (this.boosting ? 2 : 1));
          this.bonus += pts;
          this.boost = Math.min(1, this.boost + (perfect ? 0.35 : 0.2));
          events.push({ type: 'ring', perfect, pts });
        }
      }
      for (const pk of chunk.pickups) {
        if (this.taken.has(pk.id) || pk.z <= p0.z || pk.z > p1.z) continue;
        const f = (pk.z - p0.z) / (p1.z - p0.z || 1);
        const d = Math.hypot(p0.x + (p1.x - p0.x) * f - pk.x, p0.y + (p1.y - p0.y) * f - pk.y);
        if (d < 4.5) {
          this.taken.add(pk.id);
          if (pk.type === 'shield') this.shield = true;
          if (pk.type === 'slowmo') this.slowmoT = 4;
          if (pk.type === 'magnet') this.magnetT = 8;
          events.push({ type: 'pickup', kind: pk.type });
        }
      }
    }
  }

  /** Taken ids exposés au rendu (anneaux / bonus déjà ramassés). */
  isTaken(id: number): boolean {
    return this.taken.has(id);
  }
}

export { pointBoxDistance };
