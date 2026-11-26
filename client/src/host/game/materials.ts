import { AdditiveBlending, BackSide, Color, DoubleSide, ShaderMaterial, Vector3 } from 'three';

/** Uniformes d'ambiance partagés (mis à jour avant le rendu de chaque vue). */
export const ambient = {
  fogColor: { value: new Color('#1b0935') },
  fogNear: { value: 60 },
  fogFar: { value: 700 },
  uTime: { value: 0 },
  uNeonA: { value: new Color('#22e8ff') },
  uNeonB: { value: new Color('#ff3ea5') },
  uWindow: { value: new Color('#ffcf7a') },
  // lumière du missile (éclaire les murs et le sol quand on les frôle)
  uLightPos: { value: new Vector3() },
  uLightCol: { value: new Color('#22e8ff') },
};

const fogChunk = /* glsl */ `
  float fogF = smoothstep(fogNear, fogFar, vDepth);
  col = mix(col, fogColor, fogF);
`;

/**
 * Matériau des structures (bâtiments et obstacles, tous des boîtes instanciées).
 * aStyle : x = code de type, y = aléa, z = intensité néon, w = actif (lasers)
 */
export function createStructureMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...ambient },
    vertexShader: /* glsl */ `
      attribute vec4 aStyle;
      attribute vec3 aColor;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vObjN;
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec4 vStyle;
      varying vec3 vColor;
      varying float vDepth;
      void main() {
        vObjN = normal;
        vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vNormal = normalize(mat3(instanceMatrix) * normal);
        vLocal = position;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vStyle = aStyle;
        vColor = aColor;
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 fogColor;
      uniform float fogNear;
      uniform float fogFar;
      uniform float uTime;
      uniform vec3 uNeonA;
      uniform vec3 uNeonB;
      uniform vec3 uWindow;
      uniform vec3 uLightPos;
      uniform vec3 uLightCol;
      varying vec3 vWorld;
      varying vec3 vNormal;
      varying vec3 vObjN;
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec4 vStyle;
      varying vec3 vColor;
      varying float vDepth;

      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

      void main() {
        int kind = int(vStyle.x + 0.5);
        vec3 n = normalize(vNormal);
        // éclairage simple : lune + ciel + rebond
        float diff = 0.35 + 0.45 * max(dot(n, normalize(vec3(0.4, 0.8, 0.3))), 0.0) + 0.15 * n.y;
        vec3 col = vColor * diff;

        // distance aux arêtes (en mètres) pour les liserés néon
        // (l'axe de la normale est ignoré : on mesure la distance aux bords de la face)
        vec3 d = (0.5 - abs(vLocal)) * vSize + abs(vObjN) * 1e4;
        float edgeDist = min(d.x, min(d.y, d.z));
        float aa = max(0.04, vDepth * 0.0016);
        float edge = 1.0 - smoothstep(0.06, 0.06 + aa * 2.0, edgeDist);

        vec3 neon = mix(uNeonA, uNeonB, step(0.5, vStyle.y));

        if (kind == 0) {
          // immeubles : fenêtres procédurales sur les faces latérales
          if (abs(n.y) < 0.5) {
            float u = abs(n.x) > 0.5 ? vWorld.z : vWorld.x;
            vec2 cell = floor(vec2(u / 2.6, vWorld.y / 3.4));
            vec2 f = fract(vec2(u / 2.6, vWorld.y / 3.4));
            float win = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.78);
            float h = hash(cell + vStyle.y * 91.0);
            float lit = step(0.72, h);
            vec3 wc = mix(uWindow, vec3(0.55, 0.85, 1.0), step(0.85, h));
            col += win * lit * wc * (0.18 + 0.32 * hash(cell * 1.7));
            col += win * (1.0 - lit) * vec3(0.02, 0.03, 0.06);
          }
          // liseré néon au sommet
          float top = (0.5 - vLocal.y) * vSize.y;
          col += neon * (1.0 - smoothstep(0.0, 0.4, top)) * 0.9 * step(0.35, vStyle.z);
          col += neon * edge * 0.18 * vStyle.z;
        } else if (kind == 9) {
          // enseigne néon animée
          vec3 nc = mix(uNeonA, uNeonB, fract(vStyle.y * 7.0));
          float bands = step(0.5, fract((vWorld.y + vWorld.x + vWorld.z) * 0.6 - uTime * (0.5 + vStyle.y)));
          float flick = step(0.04, fract(sin(floor(uTime * 8.0) + vStyle.y * 50.0) * 43758.5));
          col = nc * (0.5 + 0.6 * bands) * (0.4 + 0.6 * flick) + nc * edge * 0.8;
        } else if (kind == 10) {
          // balise de toit
          col = vec3(1.6, 0.08, 0.1) * step(0.55, fract(uTime * 0.7 + vStyle.y));
        } else if (kind == 12) {
          // mur percé : panneaux, liseré épais très lisible autour des ouvertures
          float edgeW = 1.0 - smoothstep(0.25, 0.25 + aa * 3.0, edgeDist);
          vec2 pg = (abs(n.z) > 0.5) ? vWorld.xy : (abs(n.x) > 0.5 ? vWorld.zy : vWorld.xz);
          vec2 gq = abs(fract(pg / 4.0) - 0.5);
          float panel = 1.0 - smoothstep(0.46, 0.49, max(gq.x, gq.y));
          col = vColor * diff * (0.75 + 0.25 * panel) + neon * 0.06;
          col += neon * edgeW * 1.6;
        } else if (kind == 11) {
          // barre tournante : rayures de danger + arêtes
          float stripe = step(0.5, fract(vLocal.x * vSize.x * 0.25));
          col = mix(vec3(0.35, 0.03, 0.05), vec3(0.9, 0.75, 0.1), stripe) + vec3(1.0, 0.3, 0.2) * edge * 1.4;
        } else if (kind == 3) {
          // cubes holographiques
          vec3 g3 = abs(fract(vLocal * 3.0) - 0.5);
          float grid = 1.0 - smoothstep(0.42, 0.48, max(max(g3.x, g3.y), g3.z) * (1.0 - abs(n.x) * 0.0));
          col = vColor * diff * 0.8 + uNeonB * (edge * 1.4 + grid * 0.15);
        } else if (kind == 7) {
          // laser : émissif, clignotant (w = actif)
          float on = vStyle.w;
          col = mix(vec3(0.25, 0.02, 0.05), vec3(1.8, 0.15, 0.22), on);
          col *= 0.8 + 0.2 * sin(uTime * 40.0 + vWorld.x);
        } else if (kind == 1) {
          // plafond de tunnel : bandes lumineuses
          float s = step(0.92, fract(vWorld.z / 12.0));
          col = vColor * 0.5 + neon * s * 1.4;
        } else {
          // obstacles : corps sombre, arêtes néon, bandes de danger
          vec3 hz = kind == 6 ? vec3(1.0, 0.45, 0.1) : kind == 5 ? vec3(1.0, 0.85, 0.2) : kind == 8 ? vec3(1.0, 0.2, 0.25) : neon;
          col += hz * edge * 1.3;
          if (kind == 4) {
            // conteneurs : nervures
            float rib = step(0.8, fract((abs(n.x) > 0.5 ? vWorld.z : vWorld.x) * 1.6));
            col *= 0.85 + 0.3 * rib;
          }
          if (kind == 8 || kind == 6) {
            float stripe = step(0.5, fract((vWorld.x + vWorld.y) * 0.35));
            col += hz * stripe * 0.25;
          }
          if (kind == 5) col += hz * 0.6 * (0.6 + 0.4 * sin(uTime * 12.0 + vStyle.y * 20.0));
        }
        // lumière du missile
        vec3 lv = uLightPos - vWorld;
        float ld = dot(lv, lv);
        col += uLightCol * max(dot(normalize(vNormal), normalize(lv)), 0.0) * 9.0 / (9.0 + ld);
        ${fogChunk}
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createSkyMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {
      uTop: { value: new Color() },
      uBottom: { value: new Color() },
      uHorizon: { value: new Color() },
      uSkyline: { value: new Color() },
      uWindow: ambient.uWindow,
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
      uniform vec3 uBottom;
      uniform vec3 uHorizon;
      uniform vec3 uSkyline;
      uniform vec3 uWindow;
      uniform float uTime;
      varying vec3 vDir;
      float hash(float p) { return fract(sin(p * 127.1) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;
        vec3 col = mix(uBottom, uTop, smoothstep(-0.05, 0.6, e));
        col += uHorizon * exp(-abs(e - 0.02) * 18.0) * 0.3;
        // étoiles
        vec2 sp = floor(d.xz / max(0.2, d.y + 0.25) * 140.0);
        float st = step(0.997, fract(sin(dot(sp, vec2(12.9898, 78.233))) * 43758.5453));
        col += st * smoothstep(0.15, 0.5, e) * 0.8;
        // soleil synthwave à l'horizon
        vec3 sd = normalize(vec3(0.0, 0.1, -1.0));
        float sa = acos(clamp(dot(d, sd), -1.0, 1.0));
        float sunR = 0.19;
        col += uHorizon * exp(-sa * 5.0) * 0.22;
        if (sa < sunR) {
          float yy = clamp((d.y - (sd.y - sunR)) / (2.0 * sunR), 0.0, 1.0);
          vec3 sc = mix(uHorizon * 1.1, vec3(1.0, 0.82, 0.38), smoothstep(0.15, 0.95, yy));
          float gap = step(fract(yy * 9.0 + uTime * 0.05), (0.55 - yy) * 0.9);
          col = mix(col, sc * 0.9, (1.0 - gap) * smoothstep(sunR, sunR - 0.004, sa));
        }
        // silhouettes de la ville lointaine (deux couches)
        float a = atan(d.x, d.z);
        for (int layer = 0; layer < 2; layer++) {
          float fl = float(layer);
          float cells = 70.0 + fl * 50.0;
          float id = floor(a * cells);
          float h = (0.02 + 0.1 * pow(hash(id + fl * 31.0), 2.0)) * (1.0 - fl * 0.35);
          if (e < h) {
            vec3 sk = mix(uSkyline, uBottom, 0.35 + fl * 0.35);
            // quelques fenêtres
            float wx = fract(a * cells * 6.0);
            float wy = fract(e * 260.0);
            float w = step(0.6, wx) * step(0.5, wy) * step(0.88, hash(floor(a * cells * 6.0) * 3.1 + floor(e * 260.0)));
            col = sk + uWindow * w * 0.18 * (1.0 - fl * 0.5);
          }
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createGroundMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: {
      ...ambient,
      uGround: { value: new Color() },
      uGrid: { value: new Color() },
      uWater: { value: 0 },
    },
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
      uniform vec3 fogColor;
      uniform float fogNear;
      uniform float fogFar;
      uniform float uTime;
      uniform vec3 uGround;
      uniform vec3 uGrid;
      uniform float uWater;
      uniform vec3 uNeonA;
      uniform vec3 uNeonB;
      uniform vec3 uLightPos;
      uniform vec3 uLightCol;
      varying vec3 vWorld;
      varying float vDepth;
      void main() {
        vec2 p = vWorld.xz;
        float aa = max(0.02, vDepth * 0.0012);
        vec2 g = abs(fract(p / 10.0 - 0.5) - 0.5) * 10.0;
        float line = 1.0 - smoothstep(0.05, 0.05 + aa * 6.0, min(g.x, g.y));
        vec3 col = uGround + uGrid * line * 0.3;
        // vaguelettes (port)
        float wave = sin(p.x * 0.35 + uTime * 1.3) * sin(p.y * 0.21 - uTime * 0.9);
        col = mix(col, uGround * 1.6 + uGrid * (0.08 + 0.12 * smoothstep(0.6, 1.0, wave)), uWater);
        // flaques : reflets néon et du brouillard (sol mouillé)
        float puddle = smoothstep(0.25, 0.6, sin(p.x * 0.11 + sin(p.y * 0.05) * 2.0) * sin(p.y * 0.083 + p.x * 0.02));
        float streak = 0.5 + 0.5 * sin(p.x * 0.9 + sin(p.y * 0.01));
        col += (fogColor * 0.5 + mix(uNeonA, uNeonB, streak) * 0.12) * puddle * (1.0 - uWater);
        vec3 lv = uLightPos - vWorld;
        col += uLightCol * 14.0 / (14.0 + dot(lv, lv)) * 0.7;
        ${fogChunk}
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createGlowMaterial(color: Color, opacity = 1): ShaderMaterial {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    uniforms: { uColor: { value: color }, uOpacity: { value: opacity }, ...ambient },
    vertexShader: /* glsl */ `
      varying float vDepth;
      varying vec3 vN;
      void main() {
        #ifdef USE_INSTANCING
          vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
        #else
          vec4 wp = modelMatrix * vec4(position, 1.0);
        #endif
        vec4 mv = viewMatrix * wp;
        vDepth = -mv.z;
        vN = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float fogNear;
      uniform float fogFar;
      varying float vDepth;
      varying vec3 vN;
      void main() {
        float f = 1.0 - smoothstep(fogNear, fogFar * 1.1, vDepth);
        gl_FragColor = vec4(uColor * 1.1 * f * uOpacity, 1.0);
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
        float a = line * (0.05 + uNear * local * 0.9) * (1.0 - smoothstep(fogFar * 0.25, fogFar * 0.6, vDepth));
        gl_FragColor = vec4(uNeonA * a, 1.0);
      }
    `,
  });
}
