import { describe, expect, it } from 'vitest';
import { boxesOverlap, makeBox } from '../../shared/collision';
import { CHUNK_LEN, World, minGap } from '../../shared/world';

/** Vérifie qu'en tout point du chemin, le tube libre de largeur minGap n'empiète sur aucun obstacle. */
function checkSeed(seed: number, chunks: number): string | null {
  const w = new World(seed);
  for (let ci = 0; ci < chunks; ci++) {
    const c = w.getChunk(ci);
    for (let z = c.z0; z < c.z1; z += 1) {
      const p = w.pathAt(z);
      const g = minGap(z) / 2 - 1e-6;
      const tube = makeBox(p.x - g, p.y - g, z, p.x + g, p.y + g, z + 1e-3);
      if (tube.minY < 0) return `seed ${seed} z=${z}: tube sous le sol (y=${p.y.toFixed(2)})`;
      for (const col of c.colliders) {
        if (boxesOverlap(tube, col.swept))
          return `seed ${seed} z=${z}: ${col.kind} bloque le passage (${JSON.stringify(col.swept)}) path=${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      }
    }
  }
  return null;
}

describe('ville procédurale', () => {
  it('est déterministe pour une graine donnée', () => {
    const a = new World(42).getChunk(3);
    const b = new World(42).getChunk(3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = new World(43).getChunk(3);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('respecte toujours la largeur de passage minimale (1000 graines)', () => {
    const errors: string[] = [];
    for (let s = 1; s <= 1000; s++) {
      // 1000 graines sur 2 km, et une graine sur 20 jusqu'à 12 km (tous les quartiers, difficulté max)
      const err = checkSeed(s * 7919, s % 20 === 0 ? 12000 / CHUNK_LEN : 2000 / CHUNK_LEN);
      if (err) errors.push(err);
      if (errors.length > 5) break;
    }
    expect(errors).toEqual([]);
  });

  it('borne la pente du chemin', () => {
    const w = new World(1234);
    let prev = w.pathAt(0);
    for (let z = 1; z < 15000; z++) {
      const p = w.pathAt(z);
      expect(Math.abs(p.x - prev.x)).toBeLessThan(0.3);
      prev = p;
    }
  });
});
