// Collisions : capsule (sphère balayée le long du déplacement) contre boîtes alignées.

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function makeBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Box {
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return (
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ
  );
}

/**
 * Teste le segment p0 -> p1 (capsule de rayon r) contre la boîte.
 * La boîte est dilatée de r (somme de Minkowski, coins traités comme carrés :
 * légèrement conservateur). Retourne la fraction t ∈ [0, 1] du premier contact,
 * ou -1 s'il n'y a pas de contact.
 */
export function sweptCapsuleBox(p0: Vec3, p1: Vec3, r: number, b: Box): number {
  let tMin = 0;
  let tMax = 1;
  const d = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
  const o = [p0.x, p0.y, p0.z];
  const mn = [b.minX - r, b.minY - r, b.minZ - r];
  const mx = [b.maxX + r, b.maxY + r, b.maxZ + r];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return -1;
    } else {
      const inv = 1 / d[i];
      let t1 = (mn[i] - o[i]) * inv;
      let t2 = (mx[i] - o[i]) * inv;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return -1;
    }
  }
  return tMin;
}

/** Distance euclidienne d'un point à une boîte (0 si le point est dedans). */
export function pointBoxDistance(p: Vec3, b: Box): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  const dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Distance minimale entre un segment et une boîte (échantillonnage + raffinement). */
export function segmentBoxDistance(p0: Vec3, p1: Vec3, b: Box): number {
  // La distance point-boîte est convexe le long d'un segment : recherche ternaire.
  let lo = 0;
  let hi = 1;
  const at = (t: number) =>
    pointBoxDistance({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t, z: p0.z + (p1.z - p0.z) * t }, b);
  for (let i = 0; i < 24; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (at(m1) < at(m2)) hi = m2;
    else lo = m1;
  }
  return at((lo + hi) / 2);
}
