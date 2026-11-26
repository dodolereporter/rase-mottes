// Matériaux procéduraux (aucune texture) : PBR de three.js enrichi par injection de GLSL.

import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  MeshStandardMaterial,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three';

/** Uniformes partagés, mis à jour avant le rendu de chaque vue. */
export const ambient = {
  uTime: { value: 0 },
  uNight: { value: 0.5 },
  uNeonA: { value: new Color('#38e8ff') },
  uNeonB: { value: new Color('#ff4fa8') },
  uWindow: { value: new Color('#ffcf8a') },
  fogFar: { value: 700 },
  // lumière du missile (éclaire ce qu'il frôle)
  uLightPos: { value: new Vector3() },
  uLightCol: { value: new Color('#22e8ff') },
};

const NOISE = /* glsl */ `
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + 1.0), f.x), f.y);
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return v;
  }
`;

// ---------------------------------------------------------------------------
// Structures : immeubles et obstacles (boîtes instanciées)
// ---------------------------------------------------------------------------

const STRUCT_PROC = /* glsl */ `
  int kind = int(vStyle.x + 0.5);
  vec3 on = normalize(vObjN);
  vec3 dE = (0.5 - abs(vLocal)) * vSize + abs(on) * 1e4;
  float edgeDist = min(dE.x, min(dE.y, dE.z));
  float pxw = max(length(fwidth(vWPos)), 1e-3);
  float edge = 1.0 - smoothstep(0.06, 0.06 + pxw * 1.5, edgeDist);
  float rnd = vStyle.y;
  vec2 fc = abs(on.x) > 0.5 ? vWPos.zy : (abs(on.z) > 0.5 ? vWPos.xy : vWPos.xz);
  float grime = vnoise(fc * 0.35) * 0.5 + vnoise(fc * 2.3) * 0.25 + 0.25;
  vec3 alb = vColor;
  float pRough = 0.8;
  float pMetal = 0.0;
  vec3 pEmis = vec3(0.0);
  vec3 neon = mix(uNeonA, uNeonB, step(0.5, fract(rnd * 3.7)));
  vec3 hazard = vec3(0.95, 0.62, 0.05);

  if (kind == 0) {
    // ---------------- immeubles ----------------
    float bt = fract(rnd * 7.13);
    float bid = floor(rnd * 997.0);
    float isGlass = step(0.35, bt) * step(bt, 0.62);
    alb = vColor * (0.78 + 0.35 * grime);
    pRough = 0.88;
    if (abs(on.y) < 0.5) {
      vec2 cs = bt < 0.35 ? vec2(2.4, 3.5) : bt < 0.62 ? vec2(3.3, 3.7) : bt < 0.85 ? vec2(1.9, 3.1) : vec2(7.5, 3.9);
      vec2 fill = bt < 0.35 ? vec2(0.6, 0.56) : bt < 0.62 ? vec2(0.94, 0.88) : bt < 0.85 ? vec2(0.5, 0.52) : vec2(0.97, 0.44);
      vec2 uv = vec2(fc.x, vWPos.y - 0.4) / cs;
      vec2 cell = floor(uv);
      vec2 f = fract(uv) - 0.5;
      vec2 fw = fwidth(uv);
      float wx = 1.0 - smoothstep(fill.x * 0.5 - fw.x, fill.x * 0.5 + fw.x, abs(f.x));
      float wy = 1.0 - smoothstep(fill.y * 0.5 - fw.y, fill.y * 0.5 + fw.y, abs(f.y));
      float win = wx * wy;
      float far = smoothstep(0.25, 0.8, max(fw.x, fw.y));
      win = mix(win, fill.x * fill.y, far);
      float slab = 1.0 - smoothstep(0.0, 0.07 + fw.y, abs(f.y + 0.5));
      alb *= 1.0 + slab * 0.3 * (1.0 - far);
      float hWin = hash12(cell + bid * 0.37);
      vec3 paneAlb = isGlass > 0.5 ? mix(vec3(0.32, 0.4, 0.5), vColor, 0.25) : vec3(0.09, 0.1, 0.12);
      float paneRough = 0.12 + 0.2 * hash12(cell * 0.71 + bid);
      float paneMetal = isGlass > 0.5 ? 1.0 : 0.75;
      float hFloor = hash12(vec2(cell.y, bid));
      float litRate = (0.18 + 0.45 * fract(rnd * 3.7));
      float lit = isGlass > 0.5 ? step(1.0 - litRate, hFloor) * step(0.12, hWin) : step(1.0 - litRate, hWin);
      lit = mix(lit, litRate, far) * uNight;
      vec3 wc = hWin > 0.92 ? vec3(0.65, 0.85, 1.0) : hWin > 0.86 ? neon : uWindow;
      float blinds = 0.82 + 0.18 * step(0.5, fract(uv.y * 9.0));
      float inner = 0.55 + 0.45 * smoothstep(-0.5, 0.5, f.y);
      float tv = hWin > 0.985 ? 0.6 + 0.4 * sin(uTime * 9.0 + bid) : 1.0;
      vec3 paneEm = wc * lit * (0.7 + 1.1 * hash12(cell * 1.7)) * blinds * inner * tv;
      alb = mix(alb, paneAlb * (1.0 - lit * 0.7), win);
      pRough = mix(pRough, paneRough, win);
      pMetal = mix(pMetal, paneMetal * (1.0 - lit * 0.6), win);
      pEmis += paneEm * win;
      if (vWPos.y < 4.6) {
        float seg = floor(fc.x / 9.0);
        float sf = fract(fc.x / 9.0);
        float shopOn = step(0.3, hash12(vec2(seg, bid)));
        vec3 shopCol = mix(mix(uNeonA, uNeonB, hash12(vec2(seg * 1.3, bid))), uWindow, 0.55);
        float shopWin = step(0.07, sf) * step(sf, 0.93) * step(0.35, vWPos.y) * step(vWPos.y, 3.7);
        alb = mix(alb * 0.6, vec3(0.06), shopWin);
        pRough = mix(pRough, 0.08, shopWin);
        pMetal = mix(pMetal, 0.5, shopWin);
        pEmis += shopCol * shopWin * shopOn * (0.5 + 1.8 * uNight);
        float awn = 1.0 - smoothstep(0.0, 0.15 + fw.y, abs(vWPos.y - 4.2));
        pEmis += mix(uNeonA, uNeonB, hash12(vec2(seg, bid + 3.0))) * awn * shopOn * (0.6 + 2.0 * uNight);
      }
      float dh = abs(on.x) > 0.5 ? dE.z : dE.x;
      float corner = (1.0 - smoothstep(0.08, 0.25, dh)) * step(0.7, fract(rnd * 11.3));
      pEmis += neon * corner * (0.4 + 2.5 * uNight);
    } else if (on.y > 0.5) {
      vec2 rg = abs(fract(vWPos.xz / 3.0) - 0.5);
      alb = vColor * 0.42 * (0.8 + 0.4 * grime) * (0.9 + 0.1 * step(0.46, max(rg.x, rg.y)));
      pRough = 0.95;
    }
    float topD = (0.5 - vLocal.y) * vSize.y;
    float trim = (1.0 - smoothstep(0.0, 0.35, topD)) * step(abs(on.y), 0.5);
    alb = mix(alb, vec3(0.7), trim * 0.5);
    pEmis += neon * trim * step(0.4, vStyle.z) * 3.0 * uNight;
    alb *= 0.45 + 0.55 * smoothstep(0.0, 9.0, vWPos.y);
  } else if (kind == 1) {
    alb = vec3(0.32) * (0.8 + 0.4 * grime);
    pRough = 0.9;
    float strip = step(0.9, fract(vWPos.z / 12.0)) * step(abs(fract(vWPos.x / 6.0) - 0.5), 0.12);
    pEmis += uWindow * strip * 4.0;
  } else if (kind == 2 || kind == 14) {
    bool concrete = kind == 14;
    alb = concrete ? vec3(0.52, 0.5, 0.48) * (0.75 + 0.45 * grime) : vec3(0.3, 0.32, 0.35) * (0.75 + 0.5 * grime);
    pRough = concrete ? 0.9 : 0.42;
    pMetal = concrete ? 0.0 : 0.85;
    vec2 pg = abs(fract(fc / 2.0) - 0.5);
    alb *= 0.9 + 0.1 * step(0.47, max(pg.x, pg.y));
    float band = 1.0 - smoothstep(0.25, 0.25 + pxw * 2.0, edgeDist);
    alb = mix(alb, hazard, band * (concrete ? 0.0 : 0.85));
    if (concrete) {
      float stripes = step(0.5, fract((fc.x + fc.y) * 0.5));
      alb = mix(alb, mix(vec3(0.05), hazard, stripes), step(vWPos.y, 2.0));
    }
    pEmis += neon * edge * (0.3 + 1.5 * uNight);
  } else if (kind == 3) {
    alb = vec3(0.12, 0.13, 0.15) * (0.8 + 0.4 * grime);
    pRough = 0.35;
    pMetal = 0.8;
    vec3 g3 = abs(fract(vLocal * 3.0) - 0.5);
    float seam = 1.0 - smoothstep(0.43, 0.48, max(max(g3.x * (1.0 - abs(on.x)), g3.y * (1.0 - abs(on.y))), g3.z * (1.0 - abs(on.z))));
    pEmis += uNeonA * (seam * 0.15 + edge * 1.4) * (0.8 + 0.2 * sin(uTime * 3.0 + rnd * 20.0));
  } else if (kind == 4) {
    float rib = step(0.5, fract(fc.x * 1.6));
    alb = vColor * (0.75 + 0.2 * rib) * (0.8 + 0.35 * grime);
    alb = mix(alb, vec3(0.32, 0.18, 0.1), smoothstep(0.65, 0.95, grime) * 0.5);
    pRough = 0.6;
    pMetal = 0.45;
  } else if (kind == 5) {
    alb = vec3(0.08);
    pRough = 0.3;
    pMetal = 0.8;
    float eye = step(length(vLocal.xy), 0.22) * step(0.4, abs(vLocal.z));
    pEmis += vec3(1.0, 0.6, 0.1) * (edge * 2.0 + eye * 6.0) * (0.6 + 0.4 * sin(uTime * 10.0 + rnd * 30.0));
  } else if (kind == 6) {
    alb = vec3(0.86, 0.87, 0.9);
    pRough = 0.3;
    pMetal = 0.25;
    float band = step(abs(vLocal.y - 0.12), 0.16) * step(abs(on.y), 0.5);
    float stripe = step(abs(vLocal.y + 0.25), 0.05);
    alb = mix(alb, vec3(0.05, 0.06, 0.08), band);
    alb = mix(alb, vec3(1.0, 0.4, 0.05), stripe);
    pEmis += uWindow * band * step(0.15, fract(vWPos.x / 2.5)) * 2.0 + vec3(1.0, 0.35, 0.05) * stripe * 1.5;
  } else if (kind == 7) {
    float on1 = vStyle.w;
    alb = vec3(0.0);
    pEmis = mix(vec3(0.6, 0.02, 0.04), vec3(14.0, 0.8, 1.0), on1) * (0.85 + 0.15 * sin(uTime * 50.0 + vWPos.x * 3.0));
  } else if (kind == 8) {
    float chev = step(0.5, fract((fc.x + abs(fc.y - 6.0)) * 0.25));
    alb = mix(vec3(0.05), vec3(0.95, 0.72, 0.05), chev) * (0.8 + 0.3 * grime);
    pRough = 0.5;
    pMetal = 0.5;
    pEmis += vec3(4.0, 0.2, 0.2) * edge;
  } else if (kind == 9) {
    vec3 nc = mix(uNeonA, uNeonB, fract(rnd * 7.0));
    float bands = step(0.5, fract((vWPos.y + vWPos.x + vWPos.z) * 0.6 - uTime * (0.5 + rnd)));
    float flick = step(0.04, fract(sin(floor(uTime * 8.0) + rnd * 50.0) * 43758.5));
    alb = vec3(0.02);
    pRough = 0.2;
    pEmis = nc * (0.6 + 0.7 * bands) * (0.3 + 0.7 * flick) * (1.2 + 2.0 * uNight) + nc * edge * 2.0;
  } else if (kind == 10) {
    alb = vec3(0.1);
    pEmis = vec3(8.0, 0.4, 0.4) * step(0.55, fract(uTime * 0.7 + rnd));
  } else if (kind == 11) {
    float stripe = step(0.5, fract(vLocal.x * vSize.x * 0.22));
    alb = mix(vec3(0.04), vec3(0.95, 0.7, 0.05), stripe);
    pRough = 0.35;
    pMetal = 0.6;
    float tip = step(0.47, abs(vLocal.x));
    pEmis += vec3(6.0, 0.5, 0.3) * (tip + edge * 0.6);
  } else if (kind == 12) {
    vec2 pg = abs(fract(fc / vec2(4.0, 3.0)) - 0.5);
    float joint = step(0.47, max(pg.x, pg.y));
    alb = vec3(0.46, 0.47, 0.5) * (0.7 + 0.45 * grime) * (1.0 - joint * 0.35);
    pRough = 0.85;
    float rim = 1.0 - smoothstep(0.7, 0.7 + pxw * 2.0, edgeDist);
    float chev = step(0.5, fract((fc.x + fc.y) * 0.45));
    alb = mix(alb, mix(vec3(0.03), hazard, chev), rim);
    float glow = 1.0 - smoothstep(0.12, 0.12 + pxw * 2.0, edgeDist);
    pEmis += uNeonA * glow * 5.0;
  } else if (kind == 13) {
    alb = vec3(0.9);
    pEmis = uWindow * 6.0;
  } else if (kind == 15) {
    alb = vec3(0.55, 0.56, 0.58) * (0.7 + 0.5 * grime);
    pRough = 0.55;
    pMetal = 0.6;
    alb *= 0.85 + 0.15 * step(0.5, fract(fc.y * 4.0));
  }
  vec3 lv = uLightPos - vWPos;
  pEmis += uLightCol * alb * 30.0 / (30.0 + dot(lv, lv)) * max(dot(on, normalize(lv)), 0.0);
`;

export function createStructureMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ambient);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aStyle;
        attribute vec3 aColor;
        varying vec4 vStyle;
        varying vec3 vColor;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying vec3 vObjN;
        varying vec3 vWPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vLocal = position;
        vObjN = normal;
        vStyle = aStyle;
        vColor = aColor;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vWPos = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uNight;
        uniform vec3 uNeonA;
        uniform vec3 uNeonB;
        uniform vec3 uWindow;
        uniform vec3 uLightPos;
        uniform vec3 uLightCol;
        varying vec4 vStyle;
        varying vec3 vColor;
        varying vec3 vLocal;
        varying vec3 vSize;
        varying vec3 vObjN;
        varying vec3 vWPos;
        ${NOISE}`,
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n${STRUCT_PROC}\ndiffuseColor.rgb = alb;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = pRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = pMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance = pEmis;');
  };
  return m;
}

// ---------------------------------------------------------------------------
// Sol : asphalte, marquages qui suivent le tracé, trottoirs, flaques ; eau au port
// ---------------------------------------------------------------------------

export const PATH_SAMPLES = 64;
export const PATH_STEP_SHADER = 10;

export function createGroundMaterial(): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
  const uniforms = {
    uPath: { value: Array.from({ length: PATH_SAMPLES }, () => new Vector2(0, 20)) },
    uPathZ0: { value: 0 },
    uWater: { value: 0 },
    uAsphalt: { value: new Color('#2a2b30') },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ambient, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform float uNight;
        uniform vec3 uNeonA;
        uniform vec3 uNeonB;
        uniform vec3 uLightPos;
        uniform vec3 uLightCol;
        uniform vec2 uPath[${PATH_SAMPLES}];
        uniform float uPathZ0;
        uniform float uWater;
        uniform vec3 uAsphalt;
        varying vec3 vWPos;
        ${NOISE}
        float gRough = 0.8;
        vec3 gEmis = vec3(0.0);
        vec3 gWaterN = vec3(0.0, 1.0, 0.0);`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float zg = -vWPos.z;
          float fi = clamp((zg - uPathZ0) / ${PATH_STEP_SHADER}.0, 0.0, ${PATH_SAMPLES - 1}.0 - 0.001);
          int i0 = int(fi);
          vec2 s = mix(uPath[i0], uPath[i0 + 1], fract(fi));
          float lx = vWPos.x - s.x;
          float hw = s.y;
          float px = max(fwidth(vWPos.x), 1e-3);
          vec2 wp = vWPos.xz;
          float n1 = vnoise(wp * 0.15);
          float n2 = vnoise(wp * 1.7);
          vec3 alb = uAsphalt * (0.75 + 0.35 * n1 + 0.15 * n2);
          float puddle = smoothstep(0.58, 0.72, vnoise(wp * 0.07 + 3.0) * 0.7 + n1 * 0.3);
          gRough = mix(0.82, 0.05, puddle);
          alb *= 1.0 - puddle * 0.35;
          float dashZ = step(0.45, fract(zg / 9.0));
          float center = (1.0 - smoothstep(0.1, 0.1 + px * 1.5, abs(abs(lx) - 0.22)));
          float lane = (1.0 - smoothstep(0.08, 0.08 + px * 1.5, abs(abs(lx) - hw * 0.5))) * dashZ;
          float edgeL = 1.0 - smoothstep(0.1, 0.1 + px * 1.5, abs(abs(lx) - (hw - 3.4)));
          alb = mix(alb, vec3(0.85, 0.65, 0.12), center * 0.9);
          alb = mix(alb, vec3(0.85), max(lane, edgeL) * 0.85);
          gRough = mix(gRough, 0.6, max(center, max(lane, edgeL)));
          float side = step(hw - 3.0, abs(lx));
          vec2 tg = abs(fract(wp / 1.5) - 0.5);
          vec3 sw = vec3(0.42, 0.41, 0.4) * (0.8 + 0.3 * n2) * (1.0 - step(0.46, max(tg.x, tg.y)) * 0.25);
          alb = mix(alb, sw, side);
          gRough = mix(gRough, 0.85, side);
          if (uWater > 0.5) {
            float t = uTime;
            float wx = sin(wp.x * 0.35 + t * 1.3) * 0.5 + sin(wp.x * 1.1 - wp.y * 0.4 + t * 2.1) * 0.25 + (vnoise(wp * 0.6 + t * 0.4) - 0.5) * 0.6;
            float wz = sin(wp.y * 0.28 - t * 1.1) * 0.5 + sin(wp.y * 0.9 + wp.x * 0.3 - t * 1.7) * 0.25 + (vnoise(wp * 0.6 - t * 0.3 + 9.0) - 0.5) * 0.6;
            gWaterN = normalize(vec3(-wx * 0.12, 1.0, -wz * 0.12));
            alb = vec3(0.015, 0.05, 0.07);
            gRough = 0.03;
          }
          vec3 lv = uLightPos - vWPos;
          gEmis += uLightCol * 40.0 / (40.0 + dot(lv, lv)) * 0.25;
          diffuseColor.rgb = alb;
        }`,
      )
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gRough;')
      .replace(
        '#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\nif (uWater > 0.5) normal = normalize((viewMatrix * vec4(gWaterN, 0.0)).xyz);',
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmis;');
  };
  return m;
}

// ---------------------------------------------------------------------------
// Ciel : dégradé, soleil, nuages, relief lointain
// ---------------------------------------------------------------------------

export function createSkyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new Color() },
      uHorizon: { value: new Color() },
      uHaze: { value: new Color() },
      uSunDir: { value: new Vector3(0, 0.2, -1).normalize() },
      uSunColor: { value: new Color() },
      uClouds: { value: 0.5 },
      uNightSky: { value: 0 },
      uTime: ambient.uTime,
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uHaze;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform float uClouds;
      uniform float uNightSky;
      uniform float uTime;
      varying vec3 vDir;
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;
        vec3 col = mix(uHorizon, uTop, pow(smoothstep(-0.02, 0.75, e), 0.55));
        float sd = max(dot(d, uSunDir), 0.0);
        col += uSunColor * (pow(sd, 5.0) * 0.28 + pow(sd, 48.0) * 0.6);
        col += uSunColor * smoothstep(0.9992, 0.99965, sd) * 14.0;
        if (e > 0.0 && uClouds > 0.0) {
          vec2 cp = d.xz / (e + 0.1) * 0.9 + vec2(uTime * 0.006, uTime * 0.002);
          float n = fbm(cp);
          float m = smoothstep(0.62 - uClouds * 0.3, 0.92, n) * smoothstep(0.0, 0.18, e);
          vec3 lit = mix(uHaze * 1.05, uSunColor * 1.1 + uHorizon * 0.2, pow(sd, 2.5) * 0.9 + 0.1);
          vec3 cc = mix(lit, uTop * 0.85, smoothstep(0.5, 1.0, n) * 0.4);
          col = mix(col, cc, m * 0.9);
        }
        float a = atan(d.x, -d.z);
        float h1 = 0.018 + 0.05 * fbm(vec2(a * 2.2, 1.7));
        float h2 = 0.01 + 0.03 * fbm(vec2(a * 5.0, 7.3)) + step(0.6, vnoise(vec2(a * 60.0, 0.0))) * 0.012;
        col = mix(col, mix(uHaze, uTop, 0.18) * 0.85, step(e, h1) * 0.85);
        col = mix(col, uHaze * 0.92, step(e, h2) * 0.9);
        col = mix(col, uHaze, smoothstep(0.0, -0.06, e));
        vec2 sp = floor(d.xz / max(0.2, d.y + 0.25) * 160.0);
        col += step(0.996, hash12(sp)) * smoothstep(0.2, 0.5, e) * uNightSky;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------

export function createGlowMaterial(color: Color, opacity = 1): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uColor: { value: color }, uOpacity: { value: opacity }, ...ambient },
    vertexShader: /* glsl */ `
      varying float vDepth;
      void main() {
        #ifdef USE_INSTANCING
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        #else
          vec4 wp = modelMatrix * vec4(position, 1.0);
        #endif
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float fogFar;
      varying float vDepth;
      void main() {
        float f = 1.0 - smoothstep(fogFar * 0.4, fogFar, vDepth);
        gl_FragColor = vec4(uColor * 3.0 * f * uOpacity, 1.0);
      }
    `,
  });
}

/** Plafond du couloir : grille laser translucide, plus visible quand le missile s'en approche. */
export function createCeilingMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { ...ambient, uNear: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uNeonA;
      uniform vec3 uLightPos;
      uniform float uNear;
      uniform float fogFar;
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec2 p = vWorld.xz;
        float aa = max(0.03, vDepth * 0.002);
        vec2 g = abs(fract(p / 6.0 - 0.5) - 0.5) * 6.0;
        float line = 1.0 - smoothstep(0.04, 0.04 + aa * 4.0, min(g.x, g.y));
        float d = length(vWorld.xz - uLightPos.xz);
        float local = exp(-d * d / 300.0);
        float a = line * (0.04 + uNear * local * 1.6) * (1.0 - smoothstep(fogFar * 0.15, fogFar * 0.4, vDepth));
        gl_FragColor = vec4(uNeonA * a, 1.0);
      }
    `,
  });
}
