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

export const ATMOS: Record<District, Atmosphere> = {
  // Coucher de soleil sur le centre-ville : soleil rasant droit devant, néons qui s'allument
  [District.Downtown]: {
    skyTop: c('#203a78'),
    skyHorizon: c('#ff9b62'),
    haze: c('#d98d74'),
    sunColor: c('#ffb26e'),
    sunIntensity: 2.6,
    sunDir: sun(-18, 7),
    hemiSky: c('#8fa4d8'),
    hemiGround: c('#6a4038'),
    hemiIntensity: 0.9,
    envIntensity: 0.9,
    fogDensity: 0.0024,
    exposure: 1.0,
    night: 0.55,
    neonA: c('#38e8ff'),
    neonB: c('#ff4fa8'),
    window: c('#ffcf8a'),
    tints: [c('#8b8f99'), c('#6c7b8f'), c('#a3897a'), c('#5d6470'), c('#b4ada3')],
    clouds: 0.55,
    water: 0,
    asphalt: c('#2a2b30'),
    grade: c('#fff0e6'),
  },
  // Zone industrielle : après-midi brumeux et ambré
  [District.Industrial]: {
    skyTop: c('#5f7690'),
    skyHorizon: c('#f0c48a'),
    haze: c('#c9a57e'),
    sunColor: c('#ffd7a0'),
    sunIntensity: 3.0,
    sunDir: sun(35, 22),
    hemiSky: c('#a9b6c6'),
    hemiGround: c('#7a6450'),
    hemiIntensity: 1.0,
    envIntensity: 0.8,
    fogDensity: 0.0042,
    exposure: 0.95,
    night: 0.1,
    neonA: c('#ffb02e'),
    neonB: c('#ff6a2e'),
    window: c('#ffd29a'),
    tints: [c('#7d5b48'), c('#8c4f3c'), c('#6e6e6c'), c('#9a8a6c'), c('#545a5e')],
    clouds: 0.35,
    water: 0,
    asphalt: c('#34322f'),
    grade: c('#fff2dc'),
  },
  // Canyon de verre : plein jour, tours miroirs
  [District.Canyon]: {
    skyTop: c('#2f6fd6'),
    skyHorizon: c('#cfe6ff'),
    haze: c('#a9c7e6'),
    sunColor: c('#fff6e8'),
    sunIntensity: 3.6,
    sunDir: sun(25, 48),
    hemiSky: c('#bcd6ff'),
    hemiGround: c('#5b6470'),
    hemiIntensity: 1.1,
    envIntensity: 1.25,
    fogDensity: 0.0016,
    exposure: 0.95,
    night: 0,
    neonA: c('#5cf2ff'),
    neonB: c('#a678ff'),
    window: c('#d8f0ff'),
    tints: [c('#5e7c9c'), c('#9aa6b4'), c('#c9cdd3'), c('#47607a'), c('#7f8fa0')],
    clouds: 0.4,
    water: 0,
    asphalt: c('#303338'),
    grade: c('#f2f8ff'),
  },
  // Tunnel de métro : nuit artificielle
  [District.Metro]: {
    skyTop: c('#05070a'),
    skyHorizon: c('#141a20'),
    haze: c('#0d1216'),
    sunColor: c('#000000'),
    sunIntensity: 0,
    sunDir: sun(0, 60),
    hemiSky: c('#6a7a86'),
    hemiGround: c('#2a2622'),
    hemiIntensity: 0.55,
    envIntensity: 0.3,
    fogDensity: 0.011,
    exposure: 1.15,
    night: 1,
    neonA: c('#7dff7a'),
    neonB: c('#ffd23e'),
    window: c('#e6ffe0'),
    tints: [c('#6a6e74'), c('#5a5c60'), c('#7a746a')],
    clouds: 0,
    water: 0,
    asphalt: c('#26272a'),
    grade: c('#eefff2'),
  },
  // Le port à l'aube : ciel rose, mer calme
  [District.Port]: {
    skyTop: c('#2c3f74'),
    skyHorizon: c('#ffb3a8'),
    haze: c('#a59ab8'),
    sunColor: c('#ffc2a6'),
    sunIntensity: 2.0,
    sunDir: sun(-40, 4),
    hemiSky: c('#9aa8d8'),
    hemiGround: c('#3a4658'),
    hemiIntensity: 0.95,
    envIntensity: 1.1,
    fogDensity: 0.0028,
    exposure: 1.0,
    night: 0.35,
    neonA: c('#3effd2'),
    neonB: c('#ff7a4a'),
    window: c('#ffd8b0'),
    tints: [c('#8a3a2e'), c('#2e5a8a'), c('#3a7a4a'), c('#c8a03a'), c('#6a6e78')],
    clouds: 0.5,
    water: 1,
    asphalt: c('#2c3038'),
    grade: c('#fff0f0'),
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
};
