// Two real browser tabs on a real Hibira (or any Pusher-compatible) server,
// with htmx 2 and htmx 4. Skipped unless HIBIRA_E2E_KEY is set and Playwright
// is installed:
//
//   HIBIRA_E2E_HOST=127.0.0.1 HIBIRA_E2E_PORT=6001 HIBIRA_E2E_TLS=0 \
//   HIBIRA_E2E_APP_ID=... HIBIRA_E2E_KEY=... HIBIRA_E2E_SECRET=... npm run test:e2e
//
// SHOTS=dir also saves the README screenshots there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startApp } from './app.mjs';

const env = process.env;
let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  /* not installed */
}
const skip = (!env.HIBIRA_E2E_KEY && 'set HIBIRA_E2E_KEY to run') || (!chromium && 'install playwright to run');

for (const v of [2, 4]) {
  test(`[htmx ${v}] two tabs stay in sync through the server`, { skip }, async () => {
    const app = await startApp({
      appId: env.HIBIRA_E2E_APP_ID,
      key: env.HIBIRA_E2E_KEY,
      secret: env.HIBIRA_E2E_SECRET,
      host: env.HIBIRA_E2E_HOST ?? '127.0.0.1',
      port: Number(env.HIBIRA_E2E_PORT ?? 6001),
      tls: env.HIBIRA_E2E_TLS === '1',
    });
    const browser = await chromium.launch();
    try {
      const errors = [];
      const open = async (theme = 'light', viewport = { width: 1000, height: 540 }) => {
        const tab = await browser.newPage({ viewport, colorScheme: theme, deviceScaleFactor: 2 });
        tab.on('pageerror', (e) => errors.push(e.message));
        await tab.goto(`${app.url}/?htmx=${v}&theme=${theme}`);
        await tab.waitForSelector('main[hibira-state=connected]');
        return tab;
      };
      const a = await open();
      const b = await open('dark', { width: 390, height: 700 });
      await a.waitForTimeout(300); // let both subscriptions settle

      // A swap: the new row reaches both tabs, the open count updates out of band.
      await a.fill('input[name=item]', 'Yuzu soda');
      await a.fill('input[name=table]', 'Table 2');
      await a.click('form button');
      for (const tab of [a, b]) {
        await tab.waitForSelector('#orders li:first-child >> text=Yuzu soda');
        assert.equal(await tab.textContent('#open-count'), '2');
      }
      assert.equal(await a.inputValue('input[name=item]'), '', 'form reset after the request');

      // The server picks target and swap: tab B marks it ready, tab A's row is replaced.
      await b.click('#order-3 button');
      await a.waitForSelector('#order-3.ready');
      assert.equal(await a.locator('#order-3 button').count(), 0);

      // hx-trigger on a private channel: the stats line refetches itself over HTTP.
      await a.waitForFunction(() => document.querySelector('#stats').textContent.includes('2 ready'));

      if (env.SHOTS) {
        await a.waitForTimeout(700);
        await b.waitForTimeout(700);
        if (v === 4) await a.screenshot({ path: `${env.SHOTS}/board-htmx4-en-desktop-light.png` });
        if (v === 2) await b.screenshot({ path: `${env.SHOTS}/board-htmx2-en-mobile-dark.png` });
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await app.close();
    }
  });
}
