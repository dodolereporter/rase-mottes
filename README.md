# Rase-Mottes

Jeu d'arcade web : **le PC affiche le jeu, le téléphone sert de manette gyroscopique.**
Scanne le QR code affiché sur le PC, tiens ton téléphone à l'horizontale comme un volant, et file au ras d'une ville néon.

## Jouer en local

```bash
npm install
npm run dev
```

`npm run dev` lance le serveur (port 3000) et Vite en **HTTPS sur le réseau local** (port 5173), puis affiche l'URL à ouvrir sur le PC (`https://<ip-locale>:5173`). Accepte le certificat auto-signé sur le PC **et** sur le téléphone (le gyroscope exige HTTPS).

Si iOS refuse le certificat auto-signé, passe par un tunnel :

```bash
cloudflared tunnel --url https://localhost:5173 --no-tls-verify
PUBLIC_URL=https://xxxx.trycloudflare.com npm run dev   # le QR code pointera vers le tunnel
```

Sans téléphone :
- clavier : flèches ou ZQSD, `Espace` boost, `Maj` aérofrein, `Entrée` jouer, `P` pause, `1/2/3` mode, `M` muet. Une manette (Gamepad API) marche aussi.
- `/pad?sim=1&room=XXXX` : fausse manette avec joystick à l'écran ;
- `/?debug=1` : fps, ping, paquets perdus, boîtes de collision.

## Tests

```bash
npm test          # Vitest : protocole, PRNG, équité de la ville (1000 graines), collisions
npm run build && npm run e2e   # Playwright : hôte + manette simulée, partie complète, classement
```

## Déployer (Dokploy)

Service de type **Compose**, dépôt GitHub, branche `main`, chemin `./docker-compose.yml`. Chaque push sur `main` redéploie.

- Variables : `NODE_ENV=production`, `PORT=3000`, `PUBLIC_URL=https://rasemottes.cyber-dodo.fr`, `SCORE_SECRET=<openssl rand -hex 32>` (voir `.env.example`).
- Domaine : `rasemottes.cyber-dodo.fr`, service **`app`**, port **3000**, HTTPS Let's Encrypt.
- Le classement SQLite vit dans le volume nommé `rase-mottes-data` monté sur `/data` : il survit aux redéploiements.

## Architecture en dix lignes

1. `shared/` : protocole (paquets binaires 12 octets), PRNG `mulberry32`, génération de ville, collisions, simulation : du TypeScript pur, testé.
2. `server/` : un seul process Node (Fastify + `ws`) qui sert le build statique, le WebSocket `/ws`, l'API `/api` et `/healthz`.
3. Le serveur ne simule rien : il crée des salons (code de 4 lettres), relaie les entrées des manettes à l'hôte et gère le classement SQLite.
4. Les entrées partent du téléphone à 60 Hz en binaire. Le serveur inscrit le numéro de manette dans l'octet de type et relaie sans rien analyser d'autre.
5. Le PC est l'hôte : il ignore les paquets en retard, lisse les axes (filtre One Euro), simule à 120 Hz à pas fixe et interpole le rendu.
6. La manette construit un quaternion (ZXY, W3C), le corrige selon l'orientation de l'écran et calcule `q_rel = inverse(q_ref) * q` pour en tirer tangage et roulis.
7. La ville est générée par tronçons de 200 m à partir d'une graine. Un chemin navigable est tracé d'abord, puis les obstacles sont découpés pour toujours laisser un passage.
8. Le rendu (Three.js) utilise des `InstancedMesh` recyclés, des fenêtres en shader, du bloom et un post-traitement maison, avec une qualité adaptative.
9. Le son est entièrement synthétisé en WebAudio : moteur, souffles, effets, musique synthwave générative.
10. Les scores passent par un jeton de manche signé (HMAC), une vérification de cohérence distance/durée et une limite par IP.
