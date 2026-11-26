// Lance le serveur (tsx watch) et Vite en HTTPS sur le réseau local, puis affiche l'URL à ouvrir.
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';

const lan =
  Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? 'localhost';
const VITE_PORT = 5173;
const API_PORT = process.env.API_PORT ?? '3000';
const origin = process.env.PUBLIC_URL ?? `https://${lan}:${VITE_PORT}`;

const env = { ...process.env, PORT: API_PORT, API_PORT, DEV_PAD_ORIGIN: origin, HOST: '127.0.0.1' };
const procs = [
  spawn('npx', ['tsx', 'watch', 'server/src/index.ts'], { stdio: 'inherit', env }),
  spawn('npx', ['vite', '--host', '--port', String(VITE_PORT), '--strictPort'], { stdio: 'inherit', env }),
];

setTimeout(() => {
  console.log('\n\x1b[36m━━━ Rase-Mottes (dev) ━━━\x1b[0m');
  console.log(`  Ouvre sur le PC   : \x1b[1m${origin}/\x1b[0m`);
  console.log('  (accepte le certificat auto-signé, puis scanne le QR code avec le téléphone,');
  console.log('   qui devra lui aussi accepter le certificat)');
  console.log('  Manette simulée   : ' + origin + '/pad?sim=1&room=XXXX');
  console.log('  iOS refuse le certificat ? cloudflared tunnel --url https://localhost:5173 --no-tls-verify');
  console.log('                           puis PUBLIC_URL=https://xxx.trycloudflare.com npm run dev\n');
}, 1500);

const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) { stop(); process.exit(code); } }));
