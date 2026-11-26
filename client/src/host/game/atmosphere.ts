// Ambiance de chaque quartier : heure du jour, soleil, ciel, brouillard, teintes.
import { Color, Vector3 } from 'three';
import { District } from '../../../../shared/world';

export interface Atmosphere {
  skyTop: Color;
  skyHorizon: Color;
  haze: Color; // couleur du brouillard / perspective aérienne
  sunColor: Color;
  sunIntensity: number;
  sunDir: Vector3; // vers le soleil (repère three : -z = vers l'avant)
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  envIntensity: number;
  fogDensity: number;
  exposure: number;
  night: number; // 0 = jour (fenêtres éteintes), 1 = nuit
  neonA: Color;
  neonB: Color;
  window: Color;
  tints: Color[]; // teintes de façades
  clouds: number;
  water: number;
  asphalt: Color;
  grade: Color; // teinte d'étalonnage (multiplicatif léger)
}

const c = (h: string) => new Color(h);
const sun = (azDeg: number, elDeg: number) => {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
};

// Direction artistique « pastel premium » : lumière douce, matières mates, brume claire.
// La ville reste calme et désaturée ; seuls la fusée (vive) et les obstacles (encre + corail) ressortent.
export const ATMOS: Record<District, Atmosphere> = {
  // Golden hour : ciel pêche, façades crème
  [District.Downtown]: {
    skyTop: c('#9db7d9'),
    skyHorizon: c('#f7d9c4'),
    haze: c('#efdccd'),
    sunColor: c('#ffe3c4'),
    sunIntensity: 2.4,
    sunDir: sun(-25, 14),
    hemiSky: c('#dfe7f3'),
    hemiGround: c('#d9c8b8'),
    hemiIntensity: 1.6,
    envIntensity: 0.6,
    fogDensity: 0.0021,
    exposure: 1.0,
    night: 0,
    neonA: c('#ff6b4a'),
    neonB: c('#ffb199'),
    window: c('#fff4e4'),
    tints: [c('#f1ebe2'), c('#e8dccb'), c('#dfe6da'), c('#efd9cf'), c('#e4e1dc')],
    clouds: 0.35,
    water: 0,
    asphalt: c('#cfc8be'),
    grade: c('#fffaf5'),
  },
  // Quartier terracotta : argile, sable, après-midi chaud
  [District.Industrial]: {
    skyTop: c('#a8c3d6'),
    skyHorizon: c('#f4dfc6'),
    haze: c('#eedcc6'),
    sunColor: c('#fff0d8'),
    sunIntensity: 2.8,
    sunDir: sun(30, 30),
    hemiSky: c('#e2ebf2'),
    hemiGround: c('#d8b89c'),
    hemiIntensity: 1.5,
    envIntensity: 0.5,
    fogDensity: 0.0026,
    exposure: 1.0,
    night: 0,
    neonA: c('#ff6b4a'),
    neonB: c('#ffc27a'),
    window: c('#fff2e0'),
    tints: [c('#e3b9a0'), c('#d9a58b'), c('#ecd3bd'), c('#c98e74'), c('#f0e2d2')],
    clouds: 0.25,
    water: 0,
    asphalt: c('#d2c3b2'),
    grade: c('#fff8f2'),
  },
  // Verre et ciel : midi limpide, tours blanches
  [District.Canyon]: {
    skyTop: c('#7fb0e6'),
    skyHorizon: c('#e6f1fb'),
    haze: c('#dde9f4'),
    sunColor: c('#ffffff'),
    sunIntensity: 3.0,
    sunDir: sun(20, 55),
    hemiSky: c('#e8f1fb'),
    hemiGround: c('#cfd6de'),
    hemiIntensity: 1.6,
    envIntensity: 1.0,
    fogDensity: 0.0017,
    exposure: 0.95,
    night: 0,
    neonA: c('#ff6b4a'),
    neonB: c('#7fb0e6'),
    window: c('#ffffff'),
    tints: [c('#f4f6f8'), c('#e3e9ef'), c('#dfe7e3'), c('#eceff3'), c('#d7dee6')],
    clouds: 0.3,
    water: 0,
    asphalt: c('#cdd0d4'),
    grade: c('#f8fbff'),
  },
  // Tunnel : carrelage sauge, lumière blanche et douce
  [District.Metro]: {
    skyTop: c('#e9efe9'),
    skyHorizon: c('#eef2ec'),
    haze: c('#dfe6de'),
    sunColor: c('#000000'),
    sunIntensity: 0,
    sunDir: sun(0, 70),
    hemiSky: c('#f6faf5'),
    hemiGround: c('#cfd8cc'),
    hemiIntensity: 2.2,
    envIntensity: 0.4,
    fogDensity: 0.006,
    exposure: 1.0,
    night: 0.2,
    neonA: c('#ff6b4a'),
    neonB: c('#9db88a'),
    window: c('#ffffff'),
    tints: [c('#cfdccb'), c('#dfe8dc'), c('#c2d1bd')],
    clouds: 0,
    water: 0,
    asphalt: c('#c9cfc6'),
    grade: c('#fbfffb'),
  },
  // Port menthe : matin brumeux, eau turquoise pâle
  [District.Port]: {
    skyTop: c('#a9cfd8'),
    skyHorizon: c('#f3e7dc'),
    haze: c('#e3ece8'),
    sunColor: c('#fff1e4'),
    sunIntensity: 2.2,
    sunDir: sun(-35, 18),
    hemiSky: c('#e6f2f2'),
    hemiGround: c('#c9d8d3'),
    hemiIntensity: 1.6,
    envIntensity: 0.8,
    fogDensity: 0.0024,
    exposure: 1.0,
    night: 0,
    neonA: c('#ff6b4a'),
    neonB: c('#7cc7c3'),
    window: c('#ffffff'),
    tints: [c('#e9efe8'), c('#d4e4df'), c('#f0e6dc'), c('#e2dccf'), c('#cfe0e6')],
    clouds: 0.3,
    water: 1,
    asphalt: c('#cfd3cf'),
    grade: c('#f8fffd'),
  },
};

export function cloneAtmos(a: Atmosphere): Atmosphere {
  return {
    ...a,
    skyTop: a.skyTop.clone(),
    skyHorizon: a.skyHorizon.clone(),
    haze: a.haze.clone(),
    sunColor: a.sunColor.clone(),
    sunDir: a.sunDir.clone(),
    hemiSky: a.hemiSky.clone(),
    hemiGround: a.hemiGround.clone(),
    neonA: a.neonA.clone(),
    neonB: a.neonB.clone(),
    window: a.window.clone(),
    tints: a.tints.map((t) => t.clone()),
    asphalt: a.asphalt.clone(),
    grade: a.grade.clone(),
  };
}

/** Mélange a -> b dans out (transition entre quartiers). */
export function mixAtmos(a: Atmosphere, b: Atmosphere, t: number, out: Atmosphere): Atmosphere {
  for (const k of ['skyTop', 'skyHorizon', 'haze', 'sunColor', 'hemiSky', 'hemiGround', 'neonA', 'neonB', 'window', 'asphalt', 'grade'] as const)
    out[k].copy(a[k]).lerp(b[k], t);
  out.sunDir.copy(a.sunDir).lerp(b.sunDir, t).normalize();
  for (const k of ['sunIntensity', 'hemiIntensity', 'envIntensity', 'fogDensity', 'exposure', 'night', 'clouds', 'water'] as const)
    out[k] = a[k] + (b[k] - a[k]) * t;
  out.tints = t < 0.5 ? a.tints : b.tints;
  return out;
}

/** Code de style par type d'objet (lu par le shader des structures). */
export const KIND_CODE: Record<string, number> = {
  wall: 0,
  decor: 0,
  ceiling: 1,
  beam: 2,
  pillar: 14,
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
  roofbox: 15,
  palm: 16,
};
