import { Color } from 'three';
import { District } from '../../../../shared/world';

export interface Palette {
  skyTop: Color;
  skyBottom: Color;
  horizon: Color;
  fog: Color;
  fogNear: number;
  fogFar: number;
  building: Color;
  window: Color;
  neonA: Color;
  neonB: Color;
  ground: Color;
  grid: Color;
  water: number;
  skyline: Color;
}

const c = (hex: string) => new Color(hex);

export const PALETTES: Record<District, Palette> = {
  [District.Downtown]: {
    skyTop: c('#05021a'),
    skyBottom: c('#2c0b4d'),
    horizon: c('#ff3ea5'),
    fog: c('#1b0935'),
    fogNear: 60,
    fogFar: 720,
    building: c('#141230'),
    window: c('#ffcf7a'),
    neonA: c('#22e8ff'),
    neonB: c('#ff3ea5'),
    ground: c('#08061a'),
    grid: c('#ff3ea5'),
    water: 0,
    skyline: c('#0c0820'),
  },
  [District.Industrial]: {
    skyTop: c('#0a0805'),
    skyBottom: c('#3d220c'),
    horizon: c('#ff8a2e'),
    fog: c('#2a180b'),
    fogNear: 40,
    fogFar: 560,
    building: c('#221d18'),
    window: c('#ff9a40'),
    neonA: c('#ffb02e'),
    neonB: c('#ff5a2e'),
    ground: c('#120d08'),
    grid: c('#ffb02e'),
    water: 0,
    skyline: c('#140e08'),
  },
  [District.Canyon]: {
    skyTop: c('#010612'),
    skyBottom: c('#0a3050'),
    horizon: c('#5cf2ff'),
    fog: c('#061a2c'),
    fogNear: 90,
    fogFar: 850,
    building: c('#0f1b2c'),
    window: c('#a8ecff'),
    neonA: c('#5cf2ff'),
    neonB: c('#9b5cff'),
    ground: c('#040a14'),
    grid: c('#5cf2ff'),
    water: 0,
    skyline: c('#06101c'),
  },
  [District.Metro]: {
    skyTop: c('#000000'),
    skyBottom: c('#060806'),
    horizon: c('#7dff5a'),
    fog: c('#070a08'),
    fogNear: 15,
    fogFar: 260,
    building: c('#17181c'),
    window: c('#d8ffd0'),
    neonA: c('#7dff5a'),
    neonB: c('#ffd23e'),
    ground: c('#0a0b0c'),
    grid: c('#7dff5a'),
    water: 0,
    skyline: c('#050605'),
  },
  [District.Port]: {
    skyTop: c('#020c16'),
    skyBottom: c('#0f3a52'),
    horizon: c('#ff7a3e'),
    fog: c('#0a2636'),
    fogNear: 80,
    fogFar: 900,
    building: c('#1a2533'),
    window: c('#ffd2a0'),
    neonA: c('#ff5a3e'),
    neonB: c('#3effd2'),
    ground: c('#031620'),
    grid: c('#3effd2'),
    water: 1,
    skyline: c('#071520'),
  },
};

/** Mélange deux palettes (transition entre quartiers). */
export function mixPalette(a: Palette, b: Palette, t: number, out?: Palette): Palette {
  const o: Palette =
    out ??
    ({
      skyTop: new Color(),
      skyBottom: new Color(),
      horizon: new Color(),
      fog: new Color(),
      building: new Color(),
      window: new Color(),
      neonA: new Color(),
      neonB: new Color(),
      ground: new Color(),
      grid: new Color(),
      skyline: new Color(),
      fogNear: 0,
      fogFar: 0,
      water: 0,
    } as Palette);
  for (const k of ['skyTop', 'skyBottom', 'horizon', 'fog', 'building', 'window', 'neonA', 'neonB', 'ground', 'grid', 'skyline'] as const)
    o[k].copy(a[k]).lerp(b[k], t);
  o.fogNear = a.fogNear + (b.fogNear - a.fogNear) * t;
  o.fogFar = a.fogFar + (b.fogFar - a.fogFar) * t;
  o.water = a.water + (b.water - a.water) * t;
  return o;
}

/** Couleur de base et code de style d'un type d'obstacle. */
export const KIND_CODE: Record<string, number> = {
  wall: 0,
  decor: 0,
  ceiling: 1,
  beam: 2,
  pillar: 2,
  block: 3,
  cube: 3,
  slit: 12,
  rotor: 11,
  hub: 2,
  sign: 9,
  beacon: 10,
  lamp: 13,
  container: 4,
  gantry: 2,
  drone: 5,
  train: 6,
  laser: 7,
  crane: 2,
  door: 8,
};
