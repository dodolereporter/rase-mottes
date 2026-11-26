import './pad.css';
import {
  BTN_BOOST,
  BTN_BRAKE,
  GameMode,
  HostToPad,
  MODE_LABEL,
  MSG_INPUT,
  PLAYER_NAMES_COLOR,
  Phase,
  ServerToPad,
  encodeInput,
  sanitizeName,
} from '../../../shared/protocol';
import { AxisSettings, angleDiff, gravityTilt, shapeAxis, upAngleFromGravity } from './orientation';

// ---------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const SIM = params.get('sim') === '1';
const app = document.getElementById('app')!;

interface Settings extends AxisSettings {
  vibrate: boolean;
}
const SETTINGS_KEY = 'rm_pad_settings';
const settings: Settings = { sensitivity: 1, deadZone: 0.05, invertY: false, vibrate: true };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
} catch {
  /* réglages par défaut */
}
const saveSettings = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* stockage indisponible */
  }
};

let playerName = '';
try {
  playerName = localStorage.getItem('rm_name') ?? '';
} catch {
  /* */
}

let ws: WebSocket | null = null;
let roomCode = (params.get('room') ?? '').toUpperCase();
let slot = -1;
let color = '#22e8ff';
let seq = 0;
let phase: Phase = 'lobby';
let mode: GameMode = 'solo';
let pilot = false;
let ready = false;
let lastRtt = 0;
let boostLevel = 0.5;
let reconnectDelay = 500;
let stopped = false;

// orientation
let tiltCur: { steer: number; pitch: number } | null = null;
let tiltRef: { steer: number; pitch: number } | null = null;
let gotSensor = false;
let pitch = 0; // [-1, 1] (+ = monter)
let roll = 0; // [-1, 1] (+ = droite)
let simX = 0;
let simY = 0;
let boostDown = false;
let brakeDown = false;

const screenAngle = () =>
  (screen.orientation && typeof screen.orientation.angle === 'number'
    ? screen.orientation.angle
    : ((window as unknown as { orientation?: number }).orientation ?? 0)) || 0;

// Angle d'écran figé : si le système fait pivoter l'écran en cours de jeu,
// les commandes ne bougent pas et l'interface est contre-tournée (fixe par rapport au téléphone).
let lockAngle = screenAngle();

function applyUiRotation() {
  const rot = (((lockAngle - screenAngle()) % 360) + 360) % 360;
  const st = app.style;
  if (rot === 0) {
    st.cssText = '';
    return;
  }
  const swap = rot === 90 || rot === 270;
  st.cssText = `position:fixed;left:50%;top:50%;inset:auto;width:${swap ? '100vh' : '100vw'};height:${swap ? '100vw' : '100vh'};transform:translate(-50%,-50%) rotate(${rot}deg);`;
}

// Repère de pilotage : on déduit « le haut de l'écran » de la gravité au calibrage,
// sans se fier à screen.orientation.angle (faux de 180° sur certains iPhone).
let raw: [number, number, number] | null = null;
let ctrlAngle = screenAngle();

function calibrateFrame() {
  if (!raw) return;
  const a = upAngleFromGravity(raw[0], raw[1], raw[2]);
  ctrlAngle = a ?? screenAngle();
}

function recenter() {
  if (raw) {
    calibrateFrame();
    tiltCur = gravityTilt(raw[0], raw[1], raw[2], ctrlAngle);
    tiltRef = { ...tiltCur };
  }
  vibrate(12);
}

function onOrientation(e: DeviceOrientationEvent) {
  if (e.beta === null || e.gamma === null) return;
  gotSensor = true;
  const first = !raw;
  raw = [e.alpha ?? 0, e.beta, e.gamma];
  if (first) recenter();
  tiltCur = gravityTilt(raw[0], raw[1], raw[2], ctrlAngle);
  if (!tiltRef) tiltRef = { ...tiltCur };
  roll = shapeAxis(angleDiff(tiltCur.steer, tiltRef.steer), settings);
  // haut de l'écran vers l'avant = piquer (axe vertical négatif), sauf inversion
  pitch = shapeAxis(-angleDiff(tiltCur.pitch, tiltRef.pitch), settings) * (settings.invertY ? -1 : 1);
}

function vibrate(p: number | number[]) {
  if (!settings.vibrate) return;
  try {
    navigator.vibrate?.(p);
  } catch {
    /* iOS Safari : non supporté */
  }
}

// ---------------------------------------------------------------------------
// Écran de connexion
// ---------------------------------------------------------------------------

function renderJoin(message = '', bad = false) {
  app.innerHTML = `
    <div class="join">
      <h1>RASE-MOTTES</h1>
      <div class="hint">Tiens le téléphone à l'horizontale, à deux mains. Penche-le comme un volant pour tourner, bascule-le vers l'avant pour piquer.</div>
      <div class="row">
        <div class="field"><label for="room">Code du salon</label>
          <input id="room" maxlength="4" autocapitalize="characters" autocomplete="off" value="${roomCode}" /></div>
        <div class="field"><label for="name">Pseudo</label>
          <input id="name" maxlength="12" autocomplete="nickname" value="${escapeHtml(playerName)}" placeholder="3 à 12 car." /></div>
      </div>
      <button class="primary go" id="go">${SIM ? 'Rejoindre (manette simulée)' : 'Activer le gyroscope'}</button>
      <div class="msg ${bad ? 'bad' : ''}" id="msg">${message}</div>
      ${SIM ? '' : '<div class="hint">Pas de gyroscope ? <a href="?sim=1&room=' + roomCode + '" style="color:#22e8ff">manette simulée</a></div>'}
    </div>`;
  const go = document.getElementById('go') as HTMLButtonElement;
  go.onclick = () => start();
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

async function start() {
  const roomInput = document.getElementById('room') as HTMLInputElement;
  const nameInput = document.getElementById('name') as HTMLInputElement;
  const msg = document.getElementById('msg')!;
  roomCode = roomInput.value.trim().toUpperCase();
  const name = sanitizeName(nameInput.value) ?? (nameInput.value.trim() ? null : 'Pilote');
  if (!name) {
    msg.textContent = 'Pseudo : 3 à 12 caractères (lettres, chiffres).';
    msg.className = 'msg bad';
    return;
  }
  playerName = name;
  try {
    localStorage.setItem('rm_name', name);
  } catch {
    /* */
  }
  if (!/^[A-Z]{4}$/.test(roomCode)) {
    msg.textContent = 'Code du salon : 4 lettres affichées sur le PC.';
    msg.className = 'msg bad';
    return;
  }

  if (!SIM) {
    if (!window.isSecureContext) {
      msg.textContent = 'Le gyroscope exige une connexion HTTPS.';
      msg.className = 'msg bad';
      return;
    }
    // iOS 13+ : la permission doit être demandée depuis un geste utilisateur
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    if (!DOE) {
      msg.innerHTML = `Aucun capteur d'orientation détecté sur cet appareil. <a href="?sim=1&room=${roomCode}" style="color:#22e8ff">Utiliser la manette simulée</a>`;
      msg.className = 'msg bad';
      return;
    }
    if (typeof DOE.requestPermission === 'function') {
      try {
        const res = await DOE.requestPermission();
        if (res !== 'granted') {
          msg.textContent =
            "Accès au gyroscope refusé. Ferme l'onglet, rouvre la page et accepte « Mouvement et orientation » (Réglages > Safari > Avancé si besoin).";
          msg.className = 'msg bad';
          return;
        }
      } catch {
        msg.textContent = "Impossible de demander l'accès au gyroscope. Recharge la page et réessaie.";
        msg.className = 'msg bad';
        return;
      }
    }
    window.addEventListener('deviceorientation', onOrientation);
  }
  enterFullscreen();
  requestWakeLock();
  connect();
  renderPad();
  if (!SIM) {
    setTimeout(() => {
      if (!gotSensor) warn("Aucune donnée du gyroscope. Capteur absent ou bloqué ? Essaie la manette simulée (?sim=1).", 6000);
    }, 1500);
  }
}

function enterFullscreen() {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    const p = el.requestFullscreen?.({ navigationUI: 'hide' });
    p?.then(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => {});
    if (!p) el.webkitRequestFullscreen?.();
  } catch {
    /* pas de plein écran (iPhone) */
  }
}

let wakeLock: { release: () => Promise<void> } | null = null;
async function requestWakeLock() {
  try {
    wakeLock = await (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof wakeLock> } }).wakeLock?.request('screen') ?? null;
  } catch {
    /* non supporté */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && slot >= 0) requestWakeLock();
});
void wakeLock;

// ---------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------

function tokenKey() {
  return 'rm_token_' + roomCode;
}

function connect() {
  stopped = false;
  let token = '';
  try {
    token = sessionStorage.getItem(tokenKey()) ?? '';
  } catch {
    /* */
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws?role=pad&room=${roomCode}&token=${encodeURIComponent(token)}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  setStatus('Connexion…');
  sock.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let m: ServerToPad;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    onServerMessage(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (stopped) return;
    setStatus('Connexion perdue, reconnexion…');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 4000);
  };
}

function sendJson(m: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}

function onServerMessage(m: ServerToPad | HostToPad) {
  switch (m.t) {
    case 'joined':
      slot = m.slot;
      color = m.color;
      reconnectDelay = 500;
      try {
        sessionStorage.setItem(tokenKey(), m.token);
      } catch {
        /* */
      }
      document.documentElement.style.setProperty('--player', color);
      sendJson({ t: 'hello', name: playerName });
      updateBar();
      break;
    case 'error':
      if (m.code === 'room_not_found' || m.code === 'room_full') {
        stopped = true;
        try {
          sessionStorage.removeItem(tokenKey());
        } catch {
          /* */
        }
        renderJoin(m.code === 'room_full' ? 'Salon complet (4 manettes max).' : 'Salon introuvable. Vérifie le code affiché sur le PC.', true);
      }
      break;
    case 'hostLeft':
      stopped = true;
      renderJoin("L'écran de jeu s'est fermé. Rescanne le QR code.", true);
      break;
    case 'state':
      {
        const prev = phase;
        phase = m.phase;
        mode = m.mode;
        pilot = m.pilot;
        ready = m.ready;
        // calibration automatique au début de chaque manche
        if (m.phase === 'countdown' && prev !== 'countdown') recenter();
        if (!inGame() && lockAngle !== screenAngle()) {
          lockAngle = screenAngle();
          recenter();
          applyUiRotation();
        }
        updateMenu(m.info);
        updateBar();
      }
      break;
    case 'calibrate':
      recenter();
      break;
    case 'boost':
      boostLevel = m.v;
      updateGauge();
      break;
    case 'haptic':
      vibrate(m.p === 'crash' ? [180, 60, 260] : m.p === 'bonus' ? [20, 40, 20] : m.p === 'ring' ? 12 : 18);
      break;
    case 'ping':
      sendJson({ t: 'pong', ts: m.ts });
      break;
    case 'net':
      lastRtt = m.rtt;
      updatePing();
      break;
    case 'result':
      lastResult = m;
      updateMenu();
      break;
  }
}
let lastResult: Extract<HostToPad, { t: 'result' }> | null = null;

// Envoi des entrées à 60 Hz
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN || slot < 0) return;
  if (!SIM && !gotSensor) return;
  // en arrière-plan, on n'envoie rien : l'hôte mettra en pause
  if (document.visibilityState !== 'visible') return;
  const p = SIM ? simY : pitch;
  const r = SIM ? simX : roll;
  const buf = encodeInput({
    type: MSG_INPUT,
    seq: (seq = (seq + 1) & 0xffff),
    ts: Math.floor(performance.now()),
    pitch: p,
    roll: r,
    buttons: (boostDown ? BTN_BOOST : 0) | (brakeDown ? BTN_BRAKE : 0),
  });
  ws.send(buf);
  updateTilt(r, p);
}, 1000 / 60);

// ---------------------------------------------------------------------------
// Interface manette
// ---------------------------------------------------------------------------

let els: Record<string, HTMLElement> = {};

function renderPad() {
  app.innerHTML = `
    <div class="pad">
      <div class="bar">
        <div class="dot"></div>
        <div class="name" id="pname"></div>
        <div class="status" id="status"></div>
        <div class="ping" id="ping">-- ms</div>
        <button id="recenter">⊕ Recentrer</button>
        <button id="pause">⏸</button>
        <button id="gear">⚙</button>
      </div>
      <div class="zones ${SIM ? 'sim' : ''}">
        ${SIM ? '<div class="stick" id="stick"><div class="knob" id="knob"></div></div>' : ''}
        <div class="zone boost" id="zboost">BOOST<small>pouce gauche, maintenu</small><div class="gauge"><div id="gauge"></div></div></div>
        <div class="zone brake" id="zbrake">FREIN<small>pouce droit</small></div>
        ${SIM ? '' : '<div class="tilt"><div id="tiltdot"></div></div>'}
      </div>
      <div class="overlay-warn" id="warn" hidden></div>
      <div class="menu" id="menu"></div>
      <div class="settings" id="settings" hidden></div>
    </div>`;
  els = Object.fromEntries(
    ['pname', 'status', 'ping', 'recenter', 'pause', 'gear', 'zboost', 'zbrake', 'gauge', 'tiltdot', 'menu', 'settings', 'warn', 'stick', 'knob'].map(
      (id) => [id, document.getElementById(id)!],
    ),
  );
  els.recenter.onclick = () => recenter();
  els.pause.onclick = () => sendJson({ t: 'pause' });
  els.gear.onclick = () => openSettings();
  holdZone(els.zboost, (on) => {
    boostDown = on;
    els.zboost.classList.toggle('on', on);
  });
  holdZone(els.zbrake, (on) => {
    brakeDown = on;
    els.zbrake.classList.toggle('on', on);
    if (on) vibrate(8);
  });
  if (SIM) setupStick();
  updateBar();
  updateMenu();
  updateGauge();
}

/** Zone tactile « maintenue » robuste au multitouch. */
function holdZone(el: HTMLElement, cb: (on: boolean) => void) {
  const active = new Set<number>();
  const update = () => cb(active.size > 0);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    active.add(e.pointerId);
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* */
    }
    update();
  });
  const up = (e: PointerEvent) => {
    active.delete(e.pointerId);
    update();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}

function setupStick() {
  const stick = els.stick;
  const knob = els.knob;
  let id = -1;
  const move = (e: PointerEvent) => {
    const r = stick.getBoundingClientRect();
    const rad = Math.min(r.width, r.height) * 0.4;
    const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / rad));
    const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / rad));
    simX = dx;
    simY = -dy;
    knob.style.left = `${50 + dx * 40}%`;
    knob.style.top = `${50 + dy * 40}%`;
  };
  const release = () => {
    id = -1;
    simX = simY = 0;
    knob.style.left = knob.style.top = '50%';
  };
  stick.addEventListener('pointerdown', (e) => {
    id = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    move(e);
  });
  stick.addEventListener('pointermove', (e) => e.pointerId === id && move(e));
  stick.addEventListener('pointerup', release);
  stick.addEventListener('pointercancel', release);
  // clavier, pratique sur ordinateur
  const keys = new Set<string>();
  const applyKeys = () => {
    if (id >= 0) return;
    simX = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
    simY = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
    boostDown = keys.has(' ');
    brakeDown = keys.has('Shift');
  };
  window.addEventListener('keydown', (e) => {
    keys.add(e.key);
    applyKeys();
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.key);
    applyKeys();
  });
}

// API de test (Playwright) pour la manette simulée
(window as unknown as Record<string, unknown>).__padSim = {
  set(x: number, y: number) {
    simX = x;
    simY = y;
  },
  boost(on: boolean) {
    boostDown = on;
  },
  state: () => ({ slot, phase, mode, pilot, ready, rtt: lastRtt }),
  send: (m: unknown) => sendJson(m),
};

function setStatus(s: string) {
  if (els.status) els.status.textContent = s;
}

const PHASE_TEXT: Record<Phase, string> = {
  lobby: 'Salon',
  countdown: 'Prépare-toi…',
  playing: 'En vol',
  paused: 'Pause',
  over: 'Crash !',
  roundOver: 'Fin de manche',
  partyOver: 'Fin de soirée',
};

function updateBar() {
  if (!els.pname) return;
  els.pname.textContent = slot >= 0 ? `${playerName} · ${PLAYER_NAMES_COLOR[slot]}` : playerName;
  const role = phase === 'playing' || phase === 'countdown' ? (pilot ? '' : ' · spectateur') : '';
  setStatus(`${MODE_LABEL[mode]} · ${PHASE_TEXT[phase]}${role}`);
}

function updatePing() {
  if (!els.ping) return;
  els.ping.textContent = `${Math.round(lastRtt)} ms`;
  els.ping.classList.toggle('warn', lastRtt > 120);
  if (lastRtt > 120) warn(`Latence élevée (${Math.round(lastRtt)} ms) : rapproche-toi du Wi-Fi`, 1500);
}

function updateGauge() {
  if (els.gauge) els.gauge.style.width = `${Math.round(boostLevel * 100)}%`;
}

function updateTilt(x: number, y: number) {
  if (!els.tiltdot) return;
  els.tiltdot.style.transform = `translate(${x * 24}px, ${-y * 24}px)`;
}

let warnTimer = 0;
function warn(text: string, ms: number) {
  if (!els.warn) return;
  els.warn.textContent = text;
  els.warn.hidden = false;
  clearTimeout(warnTimer);
  warnTimer = window.setTimeout(() => (els.warn.hidden = true), ms);
}

function updateMenu(info?: string) {
  const menu = els.menu;
  if (!menu) return;
  const show = phase === 'lobby' || phase === 'over' || phase === 'roundOver' || phase === 'partyOver' || phase === 'paused';
  menu.hidden = !show;
  if (!show) return;
  const modeButtons = `<div class="modes">${(['solo', 'daily', 'party'] as GameMode[])
    .map((md) => `<button data-mode="${md}" class="${md === mode ? 'sel' : ''}">${MODE_LABEL[md]}</button>`)
    .join('')}</div>`;
  let html = '';
  if (phase === 'lobby') {
    html = `<h2>Choisis le mode</h2>${modeButtons}
      <button class="primary big" id="mready">${ready ? '✓ Prêt — en attente' : 'PRÊT'}</button>
      <div class="hint">${info ?? (mode === 'party' ? 'Soirée : 2 à 4 joueurs, 3 manches. Tout le monde appuie sur Prêt.' : 'Tiens le téléphone comme un volant. Calibrage automatique au départ.')}</div>`;
  } else if (phase === 'paused') {
    html = `<h2>Pause</h2><button class="primary big" id="mresume">Reprendre</button><button id="mmenu">Menu</button>
      <div class="hint">${info ?? ''}</div>`;
  } else if (phase === 'over' || phase === 'partyOver') {
    const r = lastResult;
    html = `<h2>${phase === 'partyOver' ? 'Fin de la soirée' : 'Crash !'}</h2>
      ${r ? `<div class="result"><b>${Math.floor(r.distance)} m</b>Score ${r.score.toLocaleString('fr-FR')}${r.rank ? ` · rang #${r.rank}` : ''}${r.best ? ' · record perso !' : ''}</div>` : ''}
      <button class="primary big" id="mreplay">REJOUER</button>
      ${modeButtons}
      <div class="namerow"><input id="mname" maxlength="12" value="${escapeHtml(playerName)}" /><button id="msave">OK</button></div>
      <div class="hint">${info ?? ''}</div>`;
  } else if (phase === 'roundOver') {
    html = `<h2>Fin de manche</h2><div class="hint">${info ?? 'Manche suivante dans un instant…'}</div>`;
  }
  menu.innerHTML = html;
  menu.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    b.onclick = () => {
      mode = b.dataset.mode as GameMode;
      sendJson({ t: 'mode', mode });
      updateMenu(info);
    };
  });
  const on = (id: string, fn: () => void) => {
    const el = document.getElementById(id);
    if (el) el.onclick = fn;
  };
  on('mready', () => {
    recenter();
    sendJson({ t: 'ready' });
  });
  on('mreplay', () => {
    recenter();
    sendJson({ t: 'replay' });
  });
  on('mresume', () => sendJson({ t: 'pause' }));
  on('mmenu', () => sendJson({ t: 'menu' }));
  on('msave', () => {
    const v = sanitizeName((document.getElementById('mname') as HTMLInputElement).value);
    if (!v) return warn('Pseudo : 3 à 12 caractères', 2000);
    playerName = v;
    try {
      localStorage.setItem('rm_name', v);
    } catch {
      /* */
    }
    sendJson({ t: 'name', name: v });
    updateBar();
    warn('Pseudo enregistré', 1200);
  });
}

function openSettings() {
  const s = els.settings;
  s.hidden = false;
  s.innerHTML = `
    <h2 style="margin:0">Réglages</h2>
    <div class="opt"><span>Sensibilité</span><span id="vsens">${settings.sensitivity.toFixed(2)}</span>
      <input type="range" id="sens" min="0.5" max="2" step="0.05" value="${settings.sensitivity}" /></div>
    <div class="opt"><span>Zone morte</span><span id="vdz">${Math.round(settings.deadZone * 100)} %</span>
      <input type="range" id="dz" min="0" max="0.25" step="0.01" value="${settings.deadZone}" /></div>
    <label class="opt"><span>Inverser l'axe vertical</span><input type="checkbox" id="inv" ${settings.invertY ? 'checked' : ''} /></label>
    <label class="opt"><span>Vibrations ${'vibrate' in navigator ? '' : '(non disponibles ici)'}</span><input type="checkbox" id="vib" ${settings.vibrate ? 'checked' : ''} /></label>
    <button class="primary big" id="close">Fermer</button>`;
  const sens = document.getElementById('sens') as HTMLInputElement;
  const dz = document.getElementById('dz') as HTMLInputElement;
  sens.oninput = () => {
    settings.sensitivity = Number(sens.value);
    document.getElementById('vsens')!.textContent = settings.sensitivity.toFixed(2);
    saveSettings();
  };
  dz.oninput = () => {
    settings.deadZone = Number(dz.value);
    document.getElementById('vdz')!.textContent = `${Math.round(settings.deadZone * 100)} %`;
    saveSettings();
  };
  (document.getElementById('inv') as HTMLInputElement).onchange = (e) => {
    settings.invertY = (e.target as HTMLInputElement).checked;
    saveSettings();
  };
  (document.getElementById('vib') as HTMLInputElement).onchange = (e) => {
    settings.vibrate = (e.target as HTMLInputElement).checked;
    saveSettings();
  };
  document.getElementById('close')!.onclick = () => (s.hidden = true);
}

// l'orientation d'écran change : les axes changent, on recentre
const inGame = () => phase === 'countdown' || phase === 'playing' || phase === 'paused';
const onRotate = () =>
  setTimeout(() => {
    // hors manche, on suit l'écran normalement ; en manche, tout reste figé
    if (!inGame() && lockAngle !== screenAngle()) {
      lockAngle = screenAngle();
      recenter();
    }
    applyUiRotation();
  }, 50);
screen.orientation?.addEventListener?.('change', onRotate);
window.addEventListener('orientationchange', onRotate);
window.addEventListener('resize', onRotate);
// pas de zoom par geste (iOS)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());

renderJoin();
