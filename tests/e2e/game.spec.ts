import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __game: any;
    __padSim: any;
  }
}

test('un hôte et une manette simulée jouent une manche complète', async ({ browser, baseURL }) => {
  const host = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  host.on('pageerror', (e) => errors.push(e.message));
  await host.goto('/');
  const codeEl = host.getByTestId('room-code');
  await expect(codeEl).toHaveText(/^[A-Z]{4}$/, { timeout: 20_000 });
  const code = (await codeEl.textContent())!;

  // la manette rejoint le salon
  const pad = await browser.newPage({ viewport: { width: 844, height: 390 } });
  pad.on('pageerror', (e) => errors.push(e.message));
  await pad.goto(`/pad?sim=1&room=${code}`);
  const name = `E2E${Math.floor(Math.random() * 1e6)}`.slice(0, 12);
  await pad.fill('#name', name);
  await pad.click('#go');
  await expect.poll(() => pad.evaluate(() => window.__padSim.state().slot)).toBe(0);
  await expect(host.locator('.slot.on')).toHaveCount(1);

  // prêt -> compte à rebours -> en vol
  await pad.click('#mready');
  await expect.poll(() => host.evaluate(() => window.__game.phase), { timeout: 60_000 }).toBe('playing');

  // les entrées de la manette font bouger le missile
  const x0 = await host.evaluate(() => window.__game.pilots[0].x);
  await pad.evaluate(() => window.__padSim.set(1, 0));
  await expect.poll(() => host.evaluate(() => window.__game.pilots[0].x), { timeout: 15_000 }).toBeGreaterThan(x0 + 2);

  // on pique vers le sol : crash et fin de manche
  await pad.evaluate(() => window.__padSim.set(0, -1));
  await expect.poll(() => host.evaluate(() => window.__game.phase), { timeout: 60_000 }).toBe('over');

  // le score arrive au classement
  await expect
    .poll(
      async () => {
        const r = await host.request.get(`${baseURL}/api/leaderboard?mode=solo&limit=100`);
        const j = await r.json();
        return j.entries.some((e: { name: string }) => e.name === name);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await expect(host.locator('.card')).toContainText('Distance');
  // la manette voit l'écran de fin et peut relancer
  await expect(pad.locator('#mreplay')).toBeVisible();
  await pad.click('#mreplay');
  await expect.poll(() => host.evaluate(() => window.__game.phase), { timeout: 30_000 }).not.toBe('over');
  expect(errors).toEqual([]);
});

test('le WebSocket refuse un salon inexistant', async ({ page }) => {
  await page.goto('/pad?sim=1&room=ZZZZ');
  await page.fill('#name', 'Testeur');
  await page.click('#go');
  await expect(page.locator('#msg')).toContainText('introuvable');
});
