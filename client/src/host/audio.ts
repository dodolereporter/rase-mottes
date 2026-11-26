// Tout le son est synthétisé en WebAudio : moteur, souffles, bonus, crash, musique générative.

const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

// Progression en la mineur : Am F C G (racines MIDI)
const CHORDS = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
const ARP = [0, 1, 2, 1, 0, 2, 1, 2];

export class AudioEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private music!: GainNode;
  private musicFilter!: BiquadFilterNode;
  private engineOsc: OscillatorNode[] = [];
  private engineGain!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private noiseBuf!: AudioBuffer;
  private nextBeat = 0;
  private beat = 0;
  private intensity = 0;
  private running = false;
  private enginesOn = false;
  muted = false;

  get started() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** À appeler depuis un geste utilisateur (clic / touche). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.build();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private build() {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.music = ctx.createGain();
    this.music.gain.value = 0.32;
    this.musicFilter = ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 900;
    this.music.connect(this.musicFilter).connect(this.master);

    // bruit blanc partagé
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // moteur : deux dents de scie désaccordées + filtre
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 4;
    this.engineFilter.connect(this.engineGain).connect(this.sfx);
    for (const det of [-7, 7, -1200]) {
      const o = ctx.createOscillator();
      o.type = det === -1200 ? 'square' : 'sawtooth';
      o.frequency.value = 60;
      o.detune.value = det;
      o.connect(this.engineFilter);
      o.start();
      this.engineOsc.push(o);
    }
    // souffle continu (vitesse)
    const wind = ctx.createBufferSource();
    wind.buffer = this.noiseBuf;
    wind.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 800;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    wind.connect(this.windFilter).connect(this.windGain).connect(this.sfx);
    wind.start();
    this.nextBeat = ctx.currentTime + 0.1;
    this.running = true;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  /** Mise à jour continue : vitesse normalisée 0..1, boost, en vol ou non, échelle de temps. */
  update(speed01: number, boosting: boolean, flying: boolean, timeScale: number) {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    this.enginesOn = flying;
    const base = 55 + speed01 * 110 + (boosting ? 25 : 0);
    for (const o of this.engineOsc) o.frequency.setTargetAtTime(base * timeScale, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime((300 + speed01 * 1800 + (boosting ? 1500 : 0)) * timeScale, t, 0.05);
    this.engineGain.gain.setTargetAtTime(flying ? 0.09 + (boosting ? 0.05 : 0) : 0, t, 0.08);
    this.windGain.gain.setTargetAtTime(flying ? 0.05 + speed01 * 0.16 : 0, t, 0.1);
    this.windFilter.frequency.setTargetAtTime(500 + speed01 * 2500, t, 0.1);
    this.intensity = flying ? speed01 : Math.max(0, this.intensity - 0.01);
    this.musicFilter.frequency.setTargetAtTime(700 + this.intensity * 6000 + (boosting ? 2000 : 0), t, 0.2);
    this.scheduleMusic();
  }

  // ----- musique générative --------------------------------------------------

  private scheduleMusic() {
    const ctx = this.ctx!;
    const bpm = 108 + this.intensity * 24;
    const step = 60 / bpm / 4; // doubles croches
    while (this.nextBeat < ctx.currentTime + 0.12) {
      this.playStep(this.beat, this.nextBeat, step);
      this.nextBeat += step;
      this.beat++;
    }
  }

  private playStep(i: number, t: number, step: number) {
    const bar = Math.floor(i / 16) % 4;
    const s = i % 16;
    const chord = CHORDS[bar];
    const lvl = this.intensity;
    // basse à chaque croche
    if (s % 2 === 0) this.bass(NOTE(chord[0] - 24 + (s % 8 === 6 ? 12 : 0)), t, step * 1.8);
    // nappe au début de chaque mesure
    if (s === 0) for (const n of chord) this.pad(NOTE(n), t, step * 16);
    // batterie selon l'intensité
    if (lvl > 0.12 && s % 4 === 0) this.kick(t);
    if (lvl > 0.35 && (s === 4 || s === 12)) this.snare(t);
    if (lvl > 0.25 && s % 2 === 1) this.hat(t, 0.25 + lvl * 0.3);
    // arpège lead
    if (lvl > 0.55) {
      const n = chord[ARP[s % 8]] + 12 + (s >= 8 ? 12 : 0);
      this.lead(NOTE(n), t, step * 0.9);
    }
  }

  private env(g: GainNode, t: number, a: number, peak: number, dur: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  }

  private bass(f: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const fl = ctx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.setValueAtTime(900, t);
    fl.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = ctx.createGain();
    this.env(g, t, 0.005, 0.35, dur);
    o.connect(fl).connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private pad(f: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const det of [-9, 9]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    g.connect(this.music);
  }

  private lead(f: number, t: number, dur: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = f;
    const g = ctx.createGain();
    this.env(g, t, 0.004, 0.06, dur);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private kick(t: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain();
    this.env(g, t, 0.002, 0.7, 0.25);
    o.connect(g).connect(this.music);
    o.start(t);
    o.stop(t + 0.3);
  }

  private noise(t: number, dur: number, type: BiquadFilterType, freq: number, gain: number, dest: AudioNode, pan = 0) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.frequency.value = freq;
    const g = ctx.createGain();
    this.env(g, t, 0.003, gain, dur);
    let node: AudioNode = src.connect(fl).connect(g);
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      node = node.connect(p);
    }
    node.connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
    return fl;
  }

  private snare(t: number) {
    this.noise(t, 0.16, 'highpass', 1500, 0.35, this.music);
  }
  private hat(t: number, v: number) {
    this.noise(t, 0.04, 'highpass', 7000, 0.12 * v, this.music);
  }

  // ----- effets ---------------------------------------------------------------

  graze(side: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = this.noise(t, 0.35, 'bandpass', 1200, 0.5, this.sfx, Math.max(-1, Math.min(1, side)) * 0.9);
    f.frequency.setValueAtTime(3000, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.3);
    f.Q.value = 1.5;
  }

  blip(freqs: number[], type: OscillatorType = 'sine', gap = 0.06, vol = 0.18) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    freqs.forEach((f, i) => {
      const t = ctx.currentTime + i * gap;
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = ctx.createGain();
      this.env(g, t, 0.005, vol, 0.25);
      o.connect(g).connect(this.sfx);
      o.start(t);
      o.stop(t + 0.3);
    });
  }

  ring(perfect: boolean) {
    this.blip(perfect ? [NOTE(84), NOTE(88), NOTE(91), NOTE(96)] : [NOTE(81), NOTE(88)], 'triangle', 0.045);
  }
  pickup() {
    this.blip([NOTE(72), NOTE(76), NOTE(79), NOTE(84), NOTE(88)], 'square', 0.05, 0.08);
  }
  shieldHit() {
    this.blip([NOTE(60), NOTE(48)], 'sawtooth', 0.08, 0.2);
  }
  brake() {
    if (!this.ctx) return;
    this.noise(this.ctx.currentTime, 0.5, 'lowpass', 600, 0.4, this.sfx);
  }
  countdown(final: boolean) {
    this.blip([final ? NOTE(84) : NOTE(72)], 'square', 0, 0.12);
  }

  crash() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const f = this.noise(t, 1.6, 'lowpass', 3000, 0.9, this.sfx);
    f.frequency.setValueAtTime(4000, t);
    f.frequency.exponentialRampToValueAtTime(80, t + 1.4);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(90, t);
    o.frequency.exponentialRampToValueAtTime(25, t + 0.8);
    const g = ctx.createGain();
    this.env(g, t, 0.005, 0.9, 0.9);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + 1);
  }
}
