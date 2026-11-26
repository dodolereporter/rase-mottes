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
  float bevel = 1.0 - smoothstep(0.0, 0.22 + pxw, edgeDist);
  float rnd = vStyle.y;
  vec2 fc = abs(on.x) > 0.5 ? vWPos.zy : (abs(on.z) > 0.5 ? vWPos.xy : vWPos.xz);
  float grain = vnoise(fc * 1.7) * 0.5 + vnoise(fc * 9.0) * 0.5;
  vec3 alb = vColor;
  float pRough = 0.9;
  float pMetal = 0.0;
  vec3 pEmis = vec3(0.0);
  // encre (obstacles) et corail (signal) : les deux seules couleurs fortes du décor
  vec3 INK = vec3(0.085, 0.1, 0.14);
  vec3 CORAL = uNeonA;

  if (kind == 0) {
    // ---------------- immeubles : matière mate, couleurs pastel ----------------
    float bt = fract(rnd * 7.13);
    float bid = floor(rnd * 997.0);
    float isGlass = step(0.4, bt) * step(bt, 0.62);
    alb = vColor * (0.96 + 0.06 * grain);
    pRough = 0.92;
    if (abs(on.y) < 0.5) {
      vec2 cs = bt < 0.4 ? vec2(2.6, 3.6) : bt < 0.62 ? vec2(3.4, 3.8) : bt < 0.85 ? vec2(2.0, 3.2) : vec2(8.0, 3.9);
      vec2 fill = bt < 0.4 ? vec2(0.56, 0.52) : bt < 0.62 ? vec2(0.95, 0.9) : bt < 0.85 ? vec2(0.46, 0.5) : vec2(0.96, 0.42);
      vec2 uv = vec2(fc.x, vWPos.y - 0.4) / cs;
      vec2 cell = floor(uv);
      vec2 f = fract(uv) - 0.5;
      vec2 fw = fwidth(uv);
      float wx = 1.0 - smoothstep(fill.x * 0.5 - fw.x, fill.x * 0.5 + fw.x, abs(f.x));
      float wy = 1.0 - smoothstep(fill.y * 0.5 - fw.y, fill.y * 0.5 + fw.y, abs(f.y));
      float win = wx * wy;
      float far = smoothstep(0.25, 0.8, max(fw.x, fw.y));
      win = mix(win, fill.x * fill.y, far);
      // vitrage : bleu-gris doux, légèrement réfléchissant
      float hWin = hash12(cell + bid * 0.37);
      vec3 pane = isGlass > 0.5 ? vec3(0.62, 0.72, 0.8) : mix(vec3(0.42, 0.48, 0.55), vColor * 0.6, 0.35);
      pane *= 0.92 + 0.12 * hWin;
      // stores clairs sur certaines fenêtres
      float blind = step(0.78, hWin) * step(f.y, 0.1);
      pane = mix(pane, vec3(0.95, 0.93, 0.9), blind);
      alb = mix(alb, pane, win);
      pRough = mix(pRough, isGlass > 0.5 ? 0.12 : 0.3, win);
      pMetal = mix(pMetal, isGlass > 0.5 ? 0.55 : 0.15, win);
      // bandeau d'étage clair (balcons)
      float slab = 1.0 - smoothstep(0.0, 0.06 + fw.y, abs(f.y + 0.5));
      alb = mix(alb, vec3(0.98, 0.97, 0.95), slab * 0.5 * (1.0 - far) * step(bt, 0.85));
      // rez-de-chaussée : vitrines et auvents rayés pastel
      if (vWPos.y < 4.8) {
        float seg = floor(fc.x / 9.0);
        float sf = fract(fc.x / 9.0);
        float h = hash12(vec2(seg, bid));
        float shopWin = step(0.06, sf) * step(sf, 0.94) * step(0.3, vWPos.y) * step(vWPos.y, 3.7);
        alb = mix(alb, vec3(0.38, 0.47, 0.5), shopWin);
        pRough = mix(pRough, 0.1, shopWin);
        pMetal = mix(pMetal, 0.4, shopWin);
        pEmis += vec3(1.0, 0.92, 0.8) * shopWin * 0.12;
        vec3 awnCol = h < 0.33 ? vec3(0.62, 0.74, 0.58) : h < 0.66 ? vec3(0.95, 0.72, 0.64) : vec3(0.97, 0.94, 0.88);
        float awn = step(3.8, vWPos.y) * step(vWPos.y, 4.6);
        float stripes = step(0.5, fract(fc.x * 1.2));
        alb = mix(alb, mix(awnCol, vec3(0.98), stripes * 0.6), awn);
      }
    } else if (on.y > 0.5) {
      alb = vColor * 0.86;
      pRough = 0.95;
    }
    // biseau clair sur les arêtes : rendu « maquette »
    alb = mix(alb, min(alb * 1.12 + 0.03, vec3(1.0)), bevel);
    // occlusion douce au pied
    alb *= 0.78 + 0.22 * smoothstep(0.0, 7.0, vWPos.y);
  } else if (kind == 1) {
    // plafond du tunnel : panneaux blancs et rampes lumineuses
    vec2 pg = abs(fract(fc / vec2(3.0, 3.0)) - 0.5);
    alb = vec3(0.93, 0.95, 0.92) * (1.0 - step(0.47, max(pg.x, pg.y)) * 0.08);
    pRough = 0.6;
    float strip = step(0.88, fract(vWPos.z / 10.0)) * step(abs(fract(vWPos.x / 6.0) - 0.5), 0.14);
    pEmis += vec3(1.0, 0.98, 0.94) * strip * 2.2;
  } else if (kind == 2 || kind == 14 || kind == 3) {
    // obstacles : encre satinée, biseaux lumineux, liseré corail
    alb = INK * (0.9 + 0.2 * grain);
    pRough = 0.42;
    pMetal = 0.25;
    alb = mix(alb, INK * 2.6, bevel * 0.8);
    float rimC = 1.0 - smoothstep(0.1, 0.1 + pxw * 1.5, edgeDist);
    alb = mix(alb, CORAL, rimC * 0.9);
    pEmis += CORAL * rimC * 0.35;
    if (kind == 14) {
      // colonne : bague corail à hauteur de vol
      float ring = step(abs(fract(vWPos.y / 9.0) - 0.5), 0.04);
      alb = mix(alb, CORAL, ring);
      pEmis += CORAL * ring * 0.3;
    }
  } else if (kind == 4) {
    // conteneurs : teintes profondes et nervures (lisibles comme obstacles)
    float rib = step(0.5, fract(fc.x * 1.6));
    alb = vColor * (0.85 + 0.15 * rib) * (0.92 + 0.12 * grain);
    pRough = 0.55;
    pMetal = 0.35;
    alb = mix(alb, alb * 1.8, bevel * 0.6);
  } else if (kind == 5) {
    alb = INK;
    pRough = 0.3;
    pMetal = 0.6;
    float eye = step(length(vLocal.xy), 0.22) * step(0.4, abs(vLocal.z));
    pEmis += CORAL * (edge * 0.8 + eye * 3.0) * (0.6 + 0.4 * sin(uTime * 10.0 + rnd * 30.0));
  } else if (kind == 6) {
    // train : blanc, bandeau vitré encre, liseré corail
    alb = vec3(0.95, 0.95, 0.94);
    pRough = 0.35;
    pMetal = 0.1;
    float band = step(abs(vLocal.y - 0.12), 0.16) * step(abs(on.y), 0.5);
    float stripe = step(abs(vLocal.y + 0.25), 0.05);
    alb = mix(alb, INK, band);
    alb = mix(alb, CORAL, stripe);
  } else if (kind == 7) {
    float on1 = vStyle.w;
    alb = vec3(0.0);
    pEmis = mix(CORAL * 0.25, CORAL * 6.0, on1) * (0.9 + 0.1 * sin(uTime * 50.0 + vWPos.x * 3.0));
  } else if (kind == 8) {
    float chev = step(0.5, fract((fc.x + abs(fc.y - 6.0)) * 0.25));
    alb = mix(INK, CORAL, chev * 0.85);
    pRough = 0.5;
    pMetal = 0.2;
  } else if (kind == 9) {
    // panneaux d'affichage pastel (décor)
    float g = fract((vWPos.y + fc.x * 0.3) * 0.08 + rnd);
    vec3 a1 = mix(vec3(0.98, 0.78, 0.7), vec3(0.7, 0.82, 0.68), step(0.5, fract(rnd * 5.0)));
    alb = mix(a1, vec3(0.98, 0.96, 0.92), smoothstep(0.3, 0.7, g));
    pRough = 0.7;
    pEmis += alb * 0.15;
  } else if (kind == 10) {
    alb = vec3(0.2);
    pEmis = CORAL * 4.0 * step(0.55, fract(uTime * 0.7 + rnd));
  } else if (kind == 11) {
    // barre tournante : encre, bandes et embouts corail
    float stripe = step(0.72, fract(vLocal.x * vSize.x * 0.2));
    alb = mix(INK, CORAL, stripe);
    pRough = 0.4;
    pMetal = 0.25;
    float tip = step(0.46, abs(vLocal.x));
    alb = mix(alb, CORAL, tip);
    pEmis += CORAL * (tip * 1.5 + stripe * 0.2);
  } else if (kind == 12) {
    // mur percé : panneaux encre, cadre corail épais autour de l'ouverture
    vec2 pg = abs(fract(fc / vec2(4.0, 3.0)) - 0.5);
    float joint = step(0.48, max(pg.x, pg.y));
    alb = INK * (1.0 + 0.25 * grain) * (1.0 - joint * 0.3);
    pRough = 0.5;
    pMetal = 0.15;
    float rim = 1.0 - smoothstep(0.55, 0.55 + pxw * 2.0, edgeDist);
    alb = mix(alb, CORAL, rim);
    pEmis += CORAL * rim * 0.8;
  } else if (kind == 13) {
    alb = vec3(1.0);
    pEmis = vec3(1.0, 0.96, 0.88) * 2.0;
  } else if (kind == 15) {
    alb = vec3(0.86, 0.86, 0.85) * (0.9 + 0.1 * grain);
    pRough = 0.6;
    pMetal = 0.3;
    alb *= 0.9 + 0.1 * step(0.5, fract(fc.y * 4.0));
  } else if (kind == 16) {
    // palmier : tronc
    alb = vec3(0.55, 0.45, 0.36) * (0.85 + 0.25 * step(0.5, fract(vWPos.y * 2.5)));
    pRough = 0.9;
  }
  vec3 lv = uLightPos - vWPos;
  pEmis += uLightCol * alb * 20.0 / (20.0 + dot(lv, lv)) * max(dot(on, normalize(lv)), 0.0);
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
          vec3 alb0 = uAsphalt * (0.94 + 0.08 * n1 + 0.04 * n2);
          alb = alb0;
          gRough = 0.9;
          float dashZ = step(0.45, fract(zg / 9.0));
          float center = (1.0 - smoothstep(0.1, 0.1 + px * 1.5, abs(abs(lx) - 0.22)));
          float lane = (1.0 - smoothstep(0.08, 0.08 + px * 1.5, abs(abs(lx) - hw * 0.5))) * dashZ;
          float edgeL = 1.0 - smoothstep(0.1, 0.1 + px * 1.5, abs(abs(lx) - (hw - 3.4)));
          alb = mix(alb, vec3(1.0, 0.55, 0.42), center * 0.9);
          alb = mix(alb, vec3(0.98), max(lane, edgeL) * 0.9);
          gRough = mix(gRough, 0.6, max(center, max(lane, edgeL)));
          float side = step(hw - 3.0, abs(lx));
          vec2 tg = abs(fract(wp / 1.5) - 0.5);
          vec3 sw = vec3(0.93, 0.9, 0.85) * (0.95 + 0.06 * n2) * (1.0 - step(0.47, max(tg.x, tg.y)) * 0.06);
          alb = mix(alb, sw, side);
          gRough = mix(gRough, 0.85, side);
          if (uWater > 0.5) {
            float t = uTime;
            float wx = sin(wp.x * 0.35 + t * 1.3) * 0.5 + sin(wp.x * 1.1 - wp.y * 0.4 + t * 2.1) * 0.25 + (vnoise(wp * 0.6 + t * 0.4) - 0.5) * 0.6;
            float wz = sin(wp.y * 0.28 - t * 1.1) * 0.5 + sin(wp.y * 0.9 + wp.x * 0.3 - t * 1.7) * 0.25 + (vnoise(wp * 0.6 - t * 0.3 + 9.0) - 0.5) * 0.6;
            gWaterN = normalize(vec3(-wx * 0.12, 1.0, -wz * 0.12));
            alb = vec3(0.42, 0.72, 0.72);
            gRough = 0.08;
          }
          vec3 lv = uLightPos - vWPos;
          gEmis += uLightCol * 30.0 / (30.0 + dot(lv, lv)) * 0.08;
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
        col += uSunColor * (pow(sd, 4.0) * 0.18 + pow(sd, 40.0) * 0.25);
        col += uSunColor * smoothstep(0.9990, 0.9996, sd) * 1.6;
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
        float a = line * uNear * local * 0.55 * (1.0 - smoothstep(fogFar * 0.15, fogFar * 0.4, vDepth));
        gl_FragColor = vec4(uNeonA, a);
      }
    `,
  });
}
