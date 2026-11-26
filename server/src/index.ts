import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_MODES, GameMode } from '../../shared/protocol';
import { RoomManager } from './rooms';
import { IpLimiter, ScoreStore } from './scores';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const PROD = process.env.NODE_ENV === 'production';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.DEV_PAD_ORIGIN || '').replace(/\/$/, '') || null;
const DATA_DIR = process.env.DATA_DIR ?? (PROD ? '/data' : resolve('data'));
let SCORE_SECRET = process.env.SCORE_SECRET ?? '';
if (!SCORE_SECRET) {
  SCORE_SECRET = randomBytes(32).toString('hex');
  console.warn('[rase-mottes] SCORE_SECRET absent : secret aléatoire (les jetons en cours seront invalidés au redémarrage)');
}

const here = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = [join(here, 'public'), resolve('dist/public')].find((p) => existsSync(p));

const app = Fastify({ logger: { level: PROD ? 'info' : 'warn' }, trustProxy: true, bodyLimit: 16 * 1024 });

const publicHost = PUBLIC_URL ? new URL(PUBLIC_URL).host : null;
function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return !PROD; // les navigateurs envoient toujours Origin pour un WebSocket
  try {
    const o = new URL(origin).host;
    if (o === host || o === publicHost) return true;
    return !PROD;
  } catch {
    return false;
  }
}

const rooms = new RoomManager({
  maxRooms: Number(process.env.MAX_ROOMS ?? 500),
  publicUrl: PUBLIC_URL,
  allowedOrigins: originAllowed,
  log: (m) => app.log.info(m),
});
const scores = new ScoreStore(DATA_DIR, SCORE_SECRET);
const scoreLimiter = new IpLimiter(20, 60_000);
const tokenLimiter = new IpLimiter(60, 60_000);

app.get('/healthz', async () => ({ ok: scores.ping(), rooms: rooms.roomCount, uptime: Math.round(process.uptime()) }));

app.post('/api/run', async (req, reply) => {
  if (!tokenLimiter.allow(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
  const body = (req.body ?? {}) as { mode?: string; seed?: number };
  const mode = body.mode as GameMode;
  if (!GAME_MODES.includes(mode) || !Number.isInteger(body.seed)) return reply.code(400).send({ error: 'bad_request' });
  return { token: scores.issueToken(mode, Number(body.seed)) };
});

app.post('/api/scores', async (req, reply) => {
  if (!scoreLimiter.allow(req.ip)) return reply.code(429).send({ error: 'rate_limited' });
  const res = scores.submit(req.body);
  if (!res.ok) return reply.code(400).send({ error: res.error });
  return { id: res.id, rank: res.rank };
});

app.get('/api/leaderboard', async (req) => {
  const q = req.query as { mode?: string; seed?: string; limit?: string };
  const seed = q.seed !== undefined && q.seed !== '' && /^\d+$/.test(q.seed) ? Number(q.seed) : undefined;
  return { entries: scores.leaderboard(q.mode, seed, Number(q.limit ?? 20) || 20) };
});

if (STATIC_DIR) {
  await app.register(fastifyStatic, {
    root: STATIC_DIR,
    index: ['index.html'],
    setHeaders(res, path) {
      if (path.includes(`${'/'}assets${'/'}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  });
  app.get('/pad', (_req, reply) => reply.header('Cache-Control', 'no-cache').sendFile('pad/index.html'));
} else {
  app.get('/', async () => 'Rase-Mottes : client non construit (npm run build) ou utilisez npm run dev.');
}

app.server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0];
  if (path === '/ws') rooms.handleUpgrade(req, socket, head);
  else socket.destroy();
});

const shutdown = async () => {
  rooms.close();
  await app.close();
  scores.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: PORT, host: HOST });
console.log(`[rase-mottes] serveur prêt sur http://${HOST}:${PORT} (données : ${DATA_DIR})`);
