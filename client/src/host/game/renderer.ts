// Moteur de rendu : scène, lumière, ombres, reflets, vues (1 à 4), caméras, effets, qualité adaptative.

import {
  NeutralToneMapping,
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  MeshBasicMaterial,
  RingGeometry,
  DirectionalLight,
  FogExp2,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Points,
  PointsMaterial,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Box } from '../../../../shared/collision';
import { Pilot } from '../../../../shared/sim';
import { CHUNK_LEN, DISTRICT_COUNT, DISTRICT_LEN, World, clamp } from '../../../../shared/world';
import { ATMOS, Atmosphere, cloneAtmos, mixAtmos } from './atmosphere';
import { CityRenderer } from './city';
import {
  PATH_SAMPLES,
  PATH_STEP_SHADER,
  ambient,
  createCeilingMaterial,
  createGroundMaterial,
  createSkyMaterial,
} from './materials';
import { createMissile } from './missile';
import { Particles } from './particles';
import { Trail } from './trail';
import { PostFX, View } from './post';

export interface PilotView {
  pilot: Pilot;
  color: string;
  missile: Group;
  camera: PerspectiveCamera;
  camX: number;
  camY: number;
  lookX: number;
  lookY: number;
  bank: number;
  shake: number;
  shakeT: number;
  flash: number;
  flashColor: [number, number, number];
  fov: number;
  atmos: Atmosphere;
  label?: string;
  crashT: number;
  lastTail: Vector3 | null;
  trail: Trail;
  blob: Mesh;
  reticle: Mesh;
  ghost?: Group;
  ghostPos?: { x: number; y: number; z: number } | null;
}

const QUALITY_LEVELS = [
  { pr: 2, bloom: true, shadows: 2048 },
  { pr: 1.5, bloom: true, shadows: 2048 },
  { pr: 1.25, bloom: true, shadows: 2048 },
  { pr: 1, bloom: true, shadows: 2048 },
  { pr: 1, bloom: true, shadows: 1024 },
  { pr: 0.85, bloom: true, shadows: 0 },
  { pr: 0.75, bloom: false, shadows: 0 },
  { pr: 0.6, bloom: false, shadows: 0 },
];

/** Caméra posée sur le décor : elle suit l'axe de la rue, le missile se déplace dans l'écran. */
const CAM_BACK = 13;
const CAM_UP = 3.6;
const CAM_FOLLOW_X = 0.62; // part du déplacement latéral du missile suivie par la caméra
const CAM_FOLLOW_Y = 0.55;

/** Circulation aérienne lointaine : files de feux entre les tours (décor). */
class Traffic {
  readonly points: Points;
  private n = 360;
  private lane = new Float32Array(this.n * 4);
  private pos = new Float32Array(this.n * 3);
  private col = new Float32Array(this.n * 3);
  constructor() {
    for (let i = 0; i < this.n; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const dir = Math.random() < 0.5 ? -1 : 1;
      this.lane[i * 4] = side * (45 + Math.floor(Math.random() * 5) * 22);
      this.lane[i * 4 + 1] = 40 + Math.floor(Math.random() * 5) * 16;
      this.lane[i * 4 + 2] = dir * (40 + Math.random() * 25);
      this.lane[i * 4 + 3] = Math.random() * 1200;
      const c = dir > 0 ? new Color('#ff3a30').multiplyScalar(3) : new Color('#fff2d0').multiplyScalar(4);
      this.col.set([c.r, c.g, c.b], i * 3);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new BufferAttribute(this.col, 3));
    this.points = new Points(
      geo,
      new PointsMaterial({ size: 1.6, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false }),
    );
    this.points.frustumCulled = false;
  }
  update(dt: number, baseZ: number, world: World) {
    for (let i = 0; i < this.n; i++) {
      let rz = this.lane[i * 4 + 3] + this.lane[i * 4 + 2] * dt;
      rz = ((rz % 1200) + 1200) % 1200;
      this.lane[i * 4 + 3] = rz;
      const z = baseZ - 100 + rz;
      const p = world.pathAt(Math.max(0, z));
      this.pos[i * 3] = p.x + this.lane[i * 4];
      this.pos[i * 3 + 1] = this.lane[i * 4 + 1];
      this.pos[i * 3 + 2] = -z;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

const tmpV = new Vector3();
const blobMat = new ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uOpacity: { value: 0.5 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float uOpacity; varying vec2 vUv; void main(){ float d = length(vUv - 0.5) * 2.0; gl_FragColor = vec4(0.05, 0.06, 0.1, uOpacity * (1.0 - smoothstep(0.2, 1.0, d))); }',
});
const tmpC = new Color();
const WHITE = new Color('#ffffff');

export class GameRenderer {
  renderer: WebGLRenderer;
  scene = new Scene();
  city: CityRenderer;
  post: PostFX;
  particles = new Particles();
  views: PilotView[] = [];
  private sky: Mesh;
  private skyMat = createSkyMaterial();
  private ground: Mesh;
  private groundMat = createGroundMaterial();
  private ceiling: Mesh;
  private ceilingMat = createCeilingMaterial();
  private traffic = new Traffic();
  private sun = new DirectionalLight(0xffffff, 3);
  private hemi = new HemisphereLight(0xffffff, 0x444444, 1);
  private fog = new FogExp2(0x888888, 0.002);
  private envMaps: Texture[] = [];
  private debugLines: LineSegments | null = null;
  private width = 1;
  private height = 1;
  quality = 0;
  private frameTimes: number[] = [];
  private lastQualityChange = 0;
  fps = 60;

  constructor(
    private canvas: HTMLCanvasElement,
    private world: World,
    debug: boolean,
  ) {
    this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    const maxPr = Math.min(window.devicePixelRatio || 1, 2);
    this.quality = Math.max(0, QUALITY_LEVELS.findIndex((q) => q.pr <= maxPr + 0.01));

    this.scene.fog = this.fog;

    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -90;
    sc.right = 90;
    sc.top = 90;
    sc.bottom = -90;
    sc.near = 1;
    sc.far = 700;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.city = new CityRenderer(world);
    this.scene.add(this.city.group);

    this.sky = new Mesh(new SphereGeometry(50, 32, 16), this.skyMat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);

    this.ground = new Mesh(new PlaneGeometry(3000, 3000), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.frustumCulled = false;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.scene.add(this.particles.points);
    this.scene.add(this.traffic.points);

    this.ceiling = new Mesh(new PlaneGeometry(300, 1400), this.ceilingMat);
    this.ceiling.rotation.x = -Math.PI / 2;
    this.ceiling.frustumCulled = false;
    this.ceiling.renderOrder = 5;
    this.scene.add(this.ceiling);

    if (debug) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(400 * 24 * 3), 3));
      this.debugLines = new LineSegments(geo, new LineBasicMaterial({ color: '#00ff88', fog: false }));
      this.debugLines.frustumCulled = false;
      this.scene.add(this.debugLines);
    }

    this.buildEnvMaps();
    this.post = new PostFX(this.renderer, this.scene);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** Cartes d'environnement (reflets du ciel) précalculées pour chaque quartier. */
  private buildEnvMaps() {
    const pmrem = new PMREMGenerator(this.renderer);
    for (let d = 0; d < DISTRICT_COUNT; d++) {
      const mat = createSkyMaterial();
      this.applySky(mat, ATMOS[d as 0]);
      const s = new Scene();
      s.add(new Mesh(new SphereGeometry(50, 32, 16), mat));
      this.envMaps.push(pmrem.fromScene(s, 0, 0.1, 200).texture);
      mat.dispose();
    }
    pmrem.dispose();
  }

  private applySky(mat: ShaderMaterial, a: Atmosphere) {
    const u = mat.uniforms;
    u.uTop.value.copy(a.skyTop);
    u.uHorizon.value.copy(a.skyHorizon);
    u.uHaze.value.copy(a.haze);
    u.uSunDir.value.copy(a.sunDir);
    u.uSunColor.value.copy(a.sunColor).multiplyScalar(a.sunIntensity > 0 ? 1 : 0);
    u.uClouds.value = a.clouds;
    u.uNightSky.value = a.night > 0.9 ? 1 : 0;
  }

  setWorld(world: World) {
    this.world = world;
    this.city.setWorld(world);
    this.particles.clear();
    for (const v of this.views) {
      v.lastTail = null;
      v.trail.reset();
    }
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    const q = QUALITY_LEVELS[this.quality];
    const pr = Math.min(q.pr, window.devicePixelRatio > 1 ? 2 : 1.25);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.post?.setSize(this.width, this.height, pr);
    if (this.post) this.post.bloom.enabled = q.bloom;
    this.applyShadowQuality();
    this.particles.setViewportHeight(this.height * pr);
    this.particles.scale = this.quality >= 6 ? 0.5 : 1;
    this.layoutViews();
  }

  private applyShadowQuality() {
    const size = QUALITY_LEVELS[this.quality].shadows;
    const on = size > 0 && this.views.length <= 2;
    this.sun.castShadow = on;
    if (on && this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as unknown as { map: null }).map = null;
    }
  }

  setPilots(list: { pilot: Pilot; color: string; label?: string }[], ghost = false) {
    for (const v of this.views) {
      this.scene.remove(v.missile, v.trail.mesh, v.blob, v.reticle);
      if (v.ghost) this.scene.remove(v.ghost);
    }
    this.views = list.map(({ pilot, color, label }) => {
      const missile = createMissile(color);
      const trail = new Trail(new Color(color).lerp(new Color('#ffffff'), 0.55));
      // ombre portée douce au sol (lecture de la hauteur) et réticule de visée
      const blob = new Mesh(new CircleGeometry(1.6, 24), blobMat.clone());
      blob.rotation.x = -Math.PI / 2;
      blob.renderOrder = 2;
      const reticle = new Mesh(
        new RingGeometry(0.9, 1.15, 32),
        new MeshBasicMaterial({ color: new Color(color), transparent: true, opacity: 0.85, depthWrite: false, fog: false }),
      );
      reticle.renderOrder = 6;
      this.scene.add(missile, trail.mesh, blob, reticle);
      const camera = new PerspectiveCamera(62, 1, 0.3, 3000);
      const pp = this.world.pathAt(Math.max(0, pilot.z - CAM_BACK));
      const v: PilotView = {
        pilot,
        color,
        missile,
        camera,
        camX: pp.x,
        camY: pp.y + CAM_UP,
        lookX: pp.x,
        lookY: pp.y,
        bank: 0,
        shake: 0,
        shakeT: 0,
        flash: 0,
        flashColor: [1, 1, 1],
        fov: 62,
        atmos: cloneAtmos(ATMOS[0]),
        label,
        crashT: 0,
        lastTail: null,
        trail,
        blob,
        reticle,
      };
      if (ghost) {
        v.ghost = createMissile('#ffffff', true);
        v.ghost.visible = false;
        this.scene.add(v.ghost);
      }
      return v;
    });
    this.applyShadowQuality();
    this.layoutViews();
  }

  private rects: View['rect'][] = [];
  private layoutViews() {
    const n = this.views.length;
    if (n <= 1) this.rects = [{ x: 0, y: 0, w: 1, h: 1 }];
    else if (n === 2)
      this.rects = [
        { x: 0, y: 0, w: 0.5, h: 1 },
        { x: 0.5, y: 0, w: 0.5, h: 1 },
      ];
    else
      this.rects = [
        { x: 0, y: 0.5, w: 0.5, h: 0.5 },
        { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
        { x: 0, y: 0, w: 0.5, h: 0.5 },
        { x: 0.5, y: 0, w: 0.5, h: 0.5 },
      ];
    this.views.forEach((v, i) => {
      const r = this.rects[i];
      v.camera.aspect = (r.w * this.width) / (r.h * this.height);
      v.camera.updateProjectionMatrix();
    });
  }

  viewRectsCss() {
    return this.rects.slice(0, this.views.length).map((r) => ({
      left: r.x * this.width,
      top: (1 - r.y - r.h) * this.height,
      width: r.w * this.width,
      height: r.h * this.height,
    }));
  }

  private atmosAt(z: number, out: Atmosphere) {
    const k = Math.floor(z / DISTRICT_LEN);
    const into = z - k * DISTRICT_LEN;
    const cur = ATMOS[this.world.districtIndexAt(z)];
    if (into < 220 && k > 0) mixAtmos(ATMOS[this.world.districtIndexAt(z - 230)], cur, into / 220, out);
    else mixAtmos(cur, cur, 0, out);
  }

  kick(i: number, shake: number, flash = 0, color: [number, number, number] = [1, 1, 1]) {
    const v = this.views[i];
    if (!v) return;
    v.shake = Math.max(v.shake, shake);
    if (flash > v.flash) {
      v.flash = flash;
      v.flashColor = color;
    }
  }

  explode(i: number) {
    const v = this.views[i];
    if (!v) return;
    const p = v.pilot;
    const c = new Color(v.color);
    this.particles.burst(p.x, p.y, -p.z, 260, 45, new Color('#ffb347').multiplyScalar(4), 1.8, 1.2);
    this.particles.burst(p.x, p.y, -p.z, 160, 70, c.clone().multiplyScalar(4), 1.0, 0.9);
    this.particles.burst(p.x, p.y, -p.z, 80, 20, new Color('#ffffff').multiplyScalar(3), 2.6, 0.5);
    v.missile.visible = false;
    v.crashT = 0.001;
    this.kick(i, 1.4, 0.8, [1, 0.6, 0.35]);
  }

  sparks(i: number, side: number) {
    const v = this.views[i];
    if (!v) return;
    const p = v.pilot;
    const c = new Color('#ffd27a').multiplyScalar(5);
    for (let k = 0; k < 18 * this.particles.scale; k++)
      this.particles.emit(p.x + side * 0.8, p.y, -p.z, side * (8 + Math.random() * 15), (Math.random() - 0.5) * 12, (Math.random() - 0.5) * 10, c, 0.35, 0.3, 2);
  }

  render(alpha: number, realDt: number, t: number, ghostFrame?: (i: number) => { x: number; y: number; z: number } | null) {
    // qualité adaptative
    this.frameTimes.push(realDt);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.fps = 1 / Math.max(avg, 1e-3);
    const now = performance.now();
    if (this.frameTimes.length >= 90 && now - this.lastQualityChange > 2500 && document.visibilityState === 'visible') {
      if (this.fps < 55 && this.quality < QUALITY_LEVELS.length - 1) {
        this.quality++;
        this.lastQualityChange = now;
        this.frameTimes = [];
        this.resize();
      } else if (this.fps > 59.5 && avg < 1 / 75 && this.quality > 0 && now - this.lastQualityChange > 15000) {
        this.quality--;
        this.lastQualityChange = now;
        this.frameTimes = [];
        this.resize();
      }
    }

    ambient.uTime.value = t;
    const ranges: [number, number][] = this.views.map((v) => {
      const c = Math.floor(v.pilot.z / CHUNK_LEN);
      return [c - 1, c + 5];
    });
    this.city.update(ranges, t);

    const views: View[] = [];
    this.views.forEach((v, i) => {
      const p = v.pilot;
      const x = p.prev.x + (p.x - p.prev.x) * alpha;
      const y = p.prev.y + (p.y - p.prev.y) * alpha;
      const z = p.prev.z + (p.z - p.prev.z) * alpha;
      const lm = p.latMax || 1;
      const fwd = Math.max(p.speed, 1);
      const smooth = (rate: number) => 1 - Math.exp(-realDt * rate);

      // ---- missile : cap et assiette = direction de vol, roulis dans les virages
      const headYaw = Math.atan2(p.vx, fwd);
      const headPitch = Math.atan2(p.vy, fwd);
      v.bank += (-clamp(p.vx / lm, -1, 1) * 0.9 - v.bank) * smooth(10);
      v.missile.position.set(x, y, -z);
      v.missile.rotation.set(headPitch * 1.5, -headYaw * 1.5, v.bank, 'YXZ');
      v.missile.updateMatrixWorld();
      const flame = v.missile.getObjectByName('flame');
      if (flame) flame.scale.set(1, (p.boosting ? 2.0 : 1) * (0.9 + Math.sin(t * 90) * 0.1), 1);
      const sh = v.missile.getObjectByName('shield');
      if (sh) sh.visible = p.shield;

      // ---- ombre au sol + réticule (où la fusée sera dans ~0,45 s)
      v.blob.visible = p.alive;
      v.blob.position.set(x, 0.04, -z);
      const hgt = Math.max(0, y);
      v.blob.scale.setScalar(0.7 + hgt * 0.03);
      (v.blob.material as ShaderMaterial).uniforms.uOpacity.value = clamp(0.55 - hgt * 0.012, 0.12, 0.55);
      v.reticle.visible = p.alive;
      const la = 0.45;
      v.reticle.position.set(x + p.vx * la, y + p.vy * la, -(z + p.speed * la));
      v.reticle.scale.setScalar(1 + p.speed * la * 0.012);

      // ---- traînée : ruban continu + quelques étincelles chaudes près de la tuyère
      if (p.alive && v.missile.visible) {
        const tail = v.missile.localToWorld(tmpV.set(0, 0, 1.9)).clone();
        v.trail.width = p.boosting ? 0.75 : 0.5;
        v.trail.push(tail);
        if (Math.random() < 0.6) {
          const hot = tmpC.set(v.color).lerp(WHITE, 0.5).multiplyScalar(3);
          this.particles.emit(tail.x, tail.y, tail.z, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, 4 + Math.random() * 4, hot, 0.35, 0.18, 4);
        }
        v.lastTail = tail;
      } else {
        v.lastTail = null;
        if (v.crashT > 0) {
          v.crashT += realDt;
          if (v.crashT < 2.5 && Math.random() < 0.7)
            this.particles.emit(x + (Math.random() - 0.5) * 3, y, -z, (Math.random() - 0.5) * 3, 6 + Math.random() * 6, (Math.random() - 0.5) * 3, new Color('#ff8a40').multiplyScalar(2.5), 2.5, 1.2, 1);
        }
      }

      // ---- caméra posée sur le décor : suit l'axe de la rue, le missile se balade dans l'image
      const speed01 = clamp((p.speed - 60) / 240, 0, 1);
      const axisZ = z - (this.views.length > 1 ? CAM_BACK + 5 : CAM_BACK);
      const axis = this.world.pathAt(Math.max(0, axisZ));
      const ahead = this.world.pathAt(z + 70);
      // la caméra suit juste assez pour que le missile reste dans l'image, même en écran partagé
      const multi = this.views.length > 1;
      const camBack = multi ? CAM_BACK + 5 : CAM_BACK;
      const visHalfW = Math.tan(((v.fov * Math.PI) / 180) / 2) * v.camera.aspect * camBack * 0.7;
      const maxOff = this.world.districtDef(z).halfW + 1.5;
      const followX = clamp(1 - visHalfW / maxOff, CAM_FOLLOW_X, 0.9);
      const tx = axis.x + (x - axis.x) * followX;
      const ty = Math.max(3, axis.y + (multi ? CAM_UP + 1.5 : CAM_UP) + (y - axis.y) * (multi ? 0.5 : CAM_FOLLOW_Y));
      const k = smooth(p.alive ? 7 : 2);
      v.camX += (tx - v.camX) * k;
      v.camY += (ty - v.camY) * k;
      v.lookX += (ahead.x + (x - ahead.x) * followX - v.lookX) * smooth(4);
      v.lookY += (ahead.y + (y - ahead.y) * CAM_FOLLOW_Y * 0.5 - v.lookY) * smooth(4);
      v.shake = Math.max(0, v.shake - realDt * 2.5);
      v.shakeT += realDt;
      v.flash = Math.max(0, v.flash - realDt * 2.5);
      const sk = v.shake * v.shake * 0.6;
      const shx = (Math.sin(v.shakeT * 37) + Math.sin(v.shakeT * 61) * 0.5) * sk;
      const shy = (Math.sin(v.shakeT * 43 + 1) + Math.sin(v.shakeT * 71) * 0.5) * sk;
      const cam = v.camera;
      cam.position.set(v.camX + shx, v.camY + shy, -(z - camBack));
      cam.up.set(0, 1, 0);
      cam.lookAt(v.lookX, v.lookY, -(z + 70));
      const fovTarget = 60 + speed01 * 14 + (p.boosting ? 6 : 0) - (p.brakeT > 0 ? 4 : 0);
      v.fov += (fovTarget - v.fov) * smooth(4);
      cam.fov = v.fov;
      cam.updateProjectionMatrix();

      this.atmosAt(z, v.atmos);

      if (v.ghost && ghostFrame) {
        const gp = ghostFrame(i);
        v.ghostPos = gp;
        if (gp) v.ghost.position.set(gp.x, gp.y, -gp.z);
      }

      views.push({
        camera: cam,
        rect: this.rects[i],
        speed: p.alive ? speed01 * 0.6 + (p.boosting ? 0.4 : 0) : 0,
        aberration: p.boosting ? 1 : p.slowmoT > 0 ? 0.4 : 0,
        flash: v.flash,
        flashColor: v.flashColor,
        before: () => this.beforeView(v, t),
      });
    });

    this.particles.update(realDt);
    const v0 = this.views[0];
    if (v0) {
      this.traffic.update(realDt, v0.pilot.z, this.world);
      this.traffic.points.visible = this.world.districtDef(v0.pilot.z).ceiling === undefined;
      this.renderer.toneMappingExposure = v0.atmos.exposure;
      this.post.setGrade(v0.atmos.grade);
    }
    if (this.debugLines && v0) this.updateDebug(v0.pilot, t);
    this.post.render(views, t);
  }

  private beforeView(v: PilotView, t: number) {
    const a = v.atmos;
    const pz = v.pilot.z;
    this.fog.color.copy(a.haze);
    this.fog.density = a.fogDensity;
    ambient.fogFar.value = 2.5 / a.fogDensity;
    this.sun.color.copy(a.sunColor);
    this.sun.intensity = a.sunIntensity;
    this.hemi.color.copy(a.hemiSky);
    this.hemi.groundColor.copy(a.hemiGround);
    this.hemi.intensity = a.hemiIntensity;
    const focus = tmpV.set(v.pilot.x, 0, -(pz + 60));
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(a.sunDir, 300);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    if (this.sun.castShadow) this.renderer.shadowMap.needsUpdate = true;
    this.scene.environment = this.envMaps[this.world.districtIndexAt(pz)];
    this.scene.environmentIntensity = a.envIntensity;
    this.applySky(this.skyMat, a);
    this.sky.position.copy(v.camera.position);
    for (const o of this.views) o.trail.orient(v.camera);
    ambient.uNight.value = a.night;
    ambient.uNeonA.value.copy(a.neonA);
    ambient.uNeonB.value.copy(a.neonB);
    ambient.uWindow.value.copy(a.window);
    const gu = this.groundMat.userData.uniforms;
    const z0 = Math.floor(pz / PATH_STEP_SHADER) * PATH_STEP_SHADER - 60;
    gu.uPathZ0.value = z0;
    for (let k = 0; k < PATH_SAMPLES; k++) {
      const zz = Math.max(0, z0 + k * PATH_STEP_SHADER);
      gu.uPath.value[k].set(this.world.pathAt(zz).x, this.world.districtDef(zz).halfW);
    }
    gu.uWater.value = a.water > 0.5 ? 1 : 0;
    gu.uAsphalt.value.copy(a.asphalt);
    this.ground.position.set(Math.round(v.camera.position.x / 10) * 10, 0, Math.round(v.camera.position.z / 10) * 10);
    this.city.prepareView(t, (id) => v.pilot.isTaken(id));
    ambient.uLightPos.value.copy(v.missile.position);
    ambient.uLightPos.value.z += 1.5;
    ambient.uLightCol.value.set(v.color).multiplyScalar(v.pilot.alive ? (v.pilot.boosting ? 1.0 : 0.5) : 0);
    const tunnel = this.world.districtDef(pz).ceiling !== undefined;
    this.ceiling.visible = !tunnel;
    if (!tunnel) {
      const cy = this.world.ceilingAt(pz + 20);
      this.ceiling.position.set(v.pilot.x, cy, -(pz + 600));
      this.ceilingMat.uniforms.uNear.value = clamp(1 - (cy - v.pilot.y) / 7, 0, 1);
    }
    for (const o of this.views) if (o.ghost) o.ghost.visible = o === v && !!o.ghostPos;
  }

  private updateDebug(p: Pilot, t: number) {
    const lines = this.debugLines!;
    const pos = lines.geometry.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    let n = 0;
    const pushBox = (b: Box) => {
      if (n >= 400) return;
      const xs = [b.minX, b.maxX];
      const ys = [b.minY, b.maxY];
      const zs = [-b.minZ, -b.maxZ];
      const corners: number[][] = [];
      for (const X of xs) for (const Y of ys) for (const Z of zs) corners.push([X, Y, Z]);
      const edges = [
        [0, 1], [2, 3], [4, 5], [6, 7],
        [0, 2], [1, 3], [4, 6], [5, 7],
        [0, 4], [1, 5], [2, 6], [3, 7],
      ];
      let o = n * 72;
      for (const [a, b2] of edges) {
        arr.set(corners[a], o);
        arr.set(corners[b2], o + 3);
        o += 6;
      }
      n++;
    };
    for (const { box } of p.candidates(p.z - 5, p.z + 120, t)) pushBox({ ...box });
    lines.geometry.setDrawRange(0, n * 24);
    pos.needsUpdate = true;
  }
}
