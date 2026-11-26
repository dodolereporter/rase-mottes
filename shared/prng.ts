/** PRNG mulberry32 : rapide, 32 bits, déterministe. Retourne des flottants dans [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hachage 32 bits (FNV-1a + mélange final) d'une chaîne. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix32(h);
}

/** Mélange deux entiers en un nouvel entier 32 bits (graine dérivée). */
export function hash2(a: number, b: number): number {
  return mix32((Math.imul(a >>> 0, 0x9e3779b1) ^ (b >>> 0)) >>> 0);
}

export function mix32(x: number): number {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Date du jour à Paris au format AAAA-MM-JJ. */
export function parisDateString(date = new Date()): string {
  // en-CA formate en AAAA-MM-JJ
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function dailySeed(date = new Date()): number {
  return hashString('rase-mottes/daily/' + parisDateString(date));
}

export class Rng {
  private next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  weighted<T extends string>(table: Partial<Record<T, number>>): T {
    let total = 0;
    for (const k in table) total += table[k] ?? 0;
    let r = this.next() * total;
    for (const k in table) {
      r -= table[k] ?? 0;
      if (r <= 0) return k;
    }
    return Object.keys(table)[0] as T;
  }
}
