import { Camera, Color, Scene, ShaderMaterial, Vector2, Vector4, WebGLRenderer, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

export interface View {
  camera: Camera;
  /** rectangle normalisé (origine en bas à gauche) */
  rect: { x: number; y: number; w: number; h: number };
  before?: () => void;
  speed: number; // 0..1 : lignes de vitesse
  aberration: number; // 0..1 : aberration chromatique (boost)
  flash: number; // 0..1 : flash (crash / frôlement)
  flashColor?: [number, number, number];
}

/** Rend la scène dans plusieurs vues (écran partagé) dans une seule cible, avant le post-traitement. */
class MultiViewPass extends Pass {
  views: View[] = [];
  constructor(private scene: Scene) {
    super();
    this.needsSwap = false;
  }
  render(renderer: WebGLRenderer, _write: WebGLRenderTarget, read: WebGLRenderTarget) {
    const target = this.renderToScreen ? null : read;
    const W = target ? target.width : renderer.domElement.width;
    const H = target ? target.height : renderer.domElement.height;
    const oldAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(target);
    renderer.clear();
    for (const v of this.views) {
      const x = Math.round(v.rect.x * W);
      const y = Math.round(v.rect.y * H);
      const w = Math.round(v.rect.w * W);
      const h = Math.round(v.rect.h * H);
      if (target) {
        target.viewport.set(x, y, w, h);
        target.scissor.set(x, y, w, h);
        target.scissorTest = true;
        renderer.setRenderTarget(target);
      } else {
        const pr = renderer.getPixelRatio();
        renderer.setViewport(x / pr, y / pr, w / pr, h / pr);
        renderer.setScissor(x / pr, y / pr, w / pr, h / pr);
        renderer.setScissorTest(true);
      }
      renderer.clear();
      v.before?.();
      renderer.render(this.scene, v.camera);
    }
    if (target) {
      target.viewport.set(0, 0, W, H);
      target.scissor.set(0, 0, W, H);
      target.scissorTest = false;
    } else renderer.setScissorTest(false);
    renderer.autoClear = oldAuto;
  }
}

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uCount: { value: 1 },
    uRects: { value: [new Vector4(0, 0, 1, 1), new Vector4(), new Vector4(), new Vector4()] },
    uFx: { value: [new Vector4(), new Vector4(), new Vector4(), new Vector4()] }, // speed, aberration, flash, -
    uFlashCol: { value: [new Vector4(1, 1, 1, 0), new Vector4(1, 1, 1, 0), new Vector4(1, 1, 1, 0), new Vector4(1, 1, 1, 0)] },
    uAspect: { value: 1 },
    uGrade: { value: new Color(1, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform int uCount;
    uniform vec4 uRects[4];
    uniform vec4 uFx[4];
    uniform vec4 uFlashCol[4];
    uniform float uAspect;
    uniform vec3 uGrade;
    varying vec2 vUv;
    float hash(float p) { return fract(sin(p * 91.345) * 47453.5453); }
    void main() {
      vec4 rect = uRects[0];
      vec4 fx = uFx[0];
      vec4 fc = uFlashCol[0];
      for (int i = 1; i < 4; i++) {
        if (i >= uCount) break;
        vec4 r = uRects[i];
        if (vUv.x >= r.x && vUv.x <= r.x + r.z && vUv.y >= r.y && vUv.y <= r.y + r.w) { rect = r; fx = uFx[i]; fc = uFlashCol[i]; }
      }
      vec2 local = (vUv - rect.xy) / rect.zw;
      vec2 c = local - vec2(0.5, 0.55);
      c.x *= uAspect * rect.z / rect.w;
      float rad = length(c);
      vec2 dir = rad > 0.0001 ? c / rad : vec2(0.0);
      // aberration chromatique radiale (boost)
      float ab = fx.y * 0.004 * rad + fx.z * 0.003;
      vec2 off = normalize(vUv - (rect.xy + rect.zw * vec2(0.5, 0.55)) + 1e-5) * ab;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      // lignes de vitesse
      float ang = atan(dir.y, dir.x);
      float id = floor(ang * 64.0);
      float h = hash(id);
      float streak = step(0.72, h) * smoothstep(0.32, 0.95, rad);
      float moving = step(0.55, fract(rad * 2.2 - uTime * (2.5 + h * 3.0) * (0.6 + fx.x)));
      col += vec3(1.0) * streak * moving * fx.x * 0.08 * (1.0 - abs(fract(ang * 64.0) - 0.5) * 2.0);
      // flash
      col = mix(col, fc.rgb * 2.0, fx.z * 0.5);
      // étalonnage léger + grain
      col *= uGrade;
      col *= 1.0 + (hash(dot(vUv, vec2(12.9898, 78.233)) + uTime) - 0.5) * 0.03;
      // vignette
      col *= 1.0 - smoothstep(0.7, 1.4, rad) * (0.22 + fx.x * 0.12);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class PostFX {
  composer: EffectComposer;
  multi: MultiViewPass;
  bloom: UnrealBloomPass;
  final: ShaderPass;
  fxaa: ShaderPass;

  constructor(
    private renderer: WebGLRenderer,
    scene: Scene,
  ) {
    this.composer = new EffectComposer(renderer);
    this.multi = new MultiViewPass(scene);
    this.composer.addPass(this.multi);
    const size = renderer.getSize(new Vector2());
    this.bloom = new UnrealBloomPass(new Vector2(size.x / 2, size.y / 2), 0.28, 0.5, 1.1);
    this.composer.addPass(this.bloom);
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.composer.addPass(new OutputPass());
    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);
  }

  setGrade(c: Color) {
    (this.final.material as ShaderMaterial).uniforms.uGrade.value.copy(c);
  }

  setSize(w: number, h: number, pixelRatio: number) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    this.bloom.resolution.set((w * pixelRatio) / 2, (h * pixelRatio) / 2);
    (this.final.material as ShaderMaterial).uniforms.uAspect.value = w / h;
    (this.fxaa.material as ShaderMaterial).uniforms.resolution.value.set(1 / (w * pixelRatio), 1 / (h * pixelRatio));
  }

  render(views: View[], time: number) {
    this.multi.views = views;
    const u = (this.final.material as ShaderMaterial).uniforms;
    u.uTime.value = time;
    u.uCount.value = views.length;
    views.forEach((v, i) => {
      u.uRects.value[i].set(v.rect.x, v.rect.y, v.rect.w, v.rect.h);
      u.uFx.value[i].set(v.speed, v.aberration, v.flash, 0);
      const fc = v.flashColor ?? [1, 1, 1];
      u.uFlashCol.value[i].set(fc[0], fc[1], fc[2], 1);
    });
    this.composer.render();
  }
}
