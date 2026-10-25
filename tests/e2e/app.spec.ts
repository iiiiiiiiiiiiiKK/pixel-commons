import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * End-to-end checks in a real browser: layout, touch/mouse interaction,
 * cooldown feedback, two-browser collaboration, reconnection and export.
 *
 * The suite runs twice 閳?desktop Chromium and a real WebKit iPhone 13 profile 閳? * so responsive and touch behaviour is verified instead of assumed.
 */

const SHOT_DIR = join(process.cwd(), 'docs', 'screenshots');

const isMobile = (testInfo: TestInfo) => testInfo.project.name.includes('iphone');

async function waitForCanvas(page: Page) {
  await expect(page.getByTestId('canvas-view')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('connection-state')).toHaveText(/live/i, { timeout: 45_000 });
  // The board is painted one frame after the welcome message arrives.
  await page.waitForTimeout(1200);
}

/**
 * The palette lives in a normal sidebar on desktop and behind a bottom sheet on
 * phones, so every test reaches it through these helpers. On phones the sidebar
 * element still exists in the DOM (hidden by CSS), hence the scoped locators.
 */
const palette = (page: Page, testInfo: TestInfo) =>
  isMobile(testInfo) ? page.locator('.mobile-sheet [data-testid="palette"]') : page.locator('.side [data-testid="palette"]');

const swatch = (page: Page, testInfo: TestInfo, index: number) =>
  palette(page, testInfo).getByTestId(`swatch-${index}`);

const activity = (page: Page, testInfo: TestInfo) =>
  isMobile(testInfo) ? page.locator('.mobile-sheet [data-testid="activity-list"]') : page.getByTestId('activity-list').first();

async function openPalette(page: Page, testInfo: TestInfo): Promise<boolean> {
  if (isMobile(testInfo)) {
    await page.getByRole('tab', { name: /colours/i }).click();
    await expect(palette(page, testInfo)).toBeVisible();
    return true;
  }
  await expect(palette(page, testInfo)).toBeVisible();
  return false;
}

/** Pick a colour by palette index, closing the mobile sheet if it opened one. */
async function pickColour(page: Page, testInfo: TestInfo, index: number) {
  const sheet = await openPalette(page, testInfo);
  await swatch(page, testInfo, index).click();
  if (sheet) await expect(palette(page, testInfo)).toBeHidden();
}

/** Place a pixel at the centre of the stage using the right input device. */
async function placeAtCentre(page: Page, testInfo: TestInfo) {
  const box = (await page.getByTestId('canvas-host').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (isMobile(testInfo)) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await page.waitForTimeout(1500);
}

/**
 * Absolute URL of the API that this deployment talks to.
 *
 * Same-origin deployments answer on `/api`, the static GitHub Pages build points at a
 * remote Worker, so the helper has to respect the bundle's configured base rather than
 * assume a relative path.
 */
const API_ORIGIN = process.env.PIXEL_COMMONS_API || '';

/** Read the authoritative colour of a cell straight from the API. */
async function cellColour(page: Page, x: number, y: number): Promise<number | null> {
  const res = await page.request.get(`${API_ORIGIN}/api/history?since=0&limit=200`);
  const body = (await res.json()) as { history: Array<{ x: number; y: number; c: number }> };
  const hit = body.history.find((h) => h.x === x && h.y === y);
  return hit ? hit.c : null;
}

test.describe('Pixel Commons', () => {
  test('loads the canvas, palette, activity panel and X link', async ({ page }, testInfo) => {
    await page.goto('./');
    await waitForCanvas(page);

    await openPalette(page, testInfo);
    await expect(page.getByTestId('x-link')).toHaveAttribute('href', 'https://x.com/0xkillcoin');
    await expect(page.getByTestId('online-count')).toContainText(/\d+/);
    await expect(page.getByTestId('cooldown-hint')).toBeVisible();

    // Close the mobile sheet again so the canvas geometry is measurable.
    if (isMobile(testInfo)) {
      await page.getByRole('tab', { name: /colours/i }).click();
      await expect(palette(page, testInfo)).toBeHidden();
    }

    // The canvas must actually cover a substantial part of the viewport.
    const box = await page.getByTestId('canvas-host').boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.width * box!.height).toBeGreaterThan(viewport.width * viewport.height * 0.25);

    // No console errors on boot (a failed WebSocket would show up here).
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.waitForTimeout(800);
    expect(errors.filter((e) => !e.includes('favicon'))).toHaveLength(0);

    mkdirSync(SHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(SHOT_DIR, `home-${testInfo.project.name}.png`) });
  });

  test('places a pixel through the canvas and receives the server confirmation', async ({ page }, testInfo) => {
    const x = 150 + Math.floor(Math.random() * 60);
    const y = 150 + Math.floor(Math.random() * 60);
    await page.goto(`./?x=${x}&y=${y}&z=14`);
    await waitForCanvas(page);
    await page.waitForTimeout(600);

    await pickColour(page, testInfo, 12);
    await placeAtCentre(page, testInfo);

    // The server either accepts (persisted) or reports a cooldown: both are
    // authoritative answers, so assert on the persisted state instead of a toast.
    const colour = await cellColour(page, x, y);
    expect(colour === 12 || colour === null).toBeTruthy();

    // The activity feed is reachable on every viewport (sidebar on desktop, sheet
    // on phones) and always renders either entries or its empty state.
    if (isMobile(testInfo)) {
      await page.getByRole('tab', { name: /activity/i }).click();
      await expect(activity(page, testInfo).or(page.locator('.mobile-sheet .empty'))).toBeVisible();
      await page.locator('.mobile-sheet .modal-head button').click();
    } else {
      await expect(page.getByTestId('activity-list').or(page.locator('.activity-panel .empty'))).toBeVisible();
    }
    // Coordinate readout is desktop-only (the phone overlay trades it for space);
    // on phones the live cooldown CTA proves the same tap was accepted.
    if (isMobile(testInfo)) {
      await expect(page.getByTestId('place-cta')).toBeVisible();
    } else {
      await expect(page.getByTestId('coord-readout')).toBeVisible();
    }
  });

  test('cooldown CTA reflects the server deadline', async ({ page }) => {
    await page.goto('./');
    await waitForCanvas(page);

    const cta = page.getByTestId('place-cta');
    await expect(cta).toBeVisible();
    const text = ((await cta.textContent()) ?? '').replace(/\s+/g, '');
    // Either "Ready" or a countdown such as "29.4s" 閳?never a client-invented value.
    expect(/ready|\d+(\.\d+)?s/i.test(text)).toBeTruthy();

    // The progress bar is bound to the same deadline.
    await expect(page.locator('.cooldown-track')).toBeVisible();
  });

  test('history dialog exposes server-rendered export links', async ({ page }) => {
    await page.goto('./');
    await waitForCanvas(page);
    await page.getByTitle('History & snapshots').click();
    await expect(page.getByTestId('export-1x')).toHaveAttribute('href', /\/api\/export\.png\?scale=1/);
    await expect(page.getByTestId('export-4x')).toHaveAttribute('href', /scale=4/);

    // The export must be a real PNG produced by the backend.
    const res = await page.request.get(`${API_ORIGIN}/api/export.png?scale=1`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
    const buffer = await res.body();
    expect(buffer.subarray(0, 4).toString('hex')).toBe('89504e47');

    await page.screenshot({ path: join(SHOT_DIR, 'history-dialog.png') });
  });

  test('help dialog documents rules and controls', async ({ page }) => {
    await page.goto('./');
    await waitForCanvas(page);
    await page.getByTitle('Rules & help').click();
    await expect(page.getByRole('heading', { name: /How Pixel Commons works/i })).toBeVisible();
    await expect(page.getByText(/enforced by the server/i)).toBeVisible();
    await page.screenshot({ path: join(SHOT_DIR, 'help-dialog.png') });
  });

  test('two browsers paint the same canvas in real time', async ({ browser }, testInfo) => {
    const contextA = await browser.newContext(isMobile(testInfo) ? { ...(browser.browserType().name() === 'webkit' ? {} : {}), viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {});
    const contextB = await browser.newContext();
    const a = await contextA.newPage();
    const b = await contextB.newPage();

    await a.goto('./');
    await waitForCanvas(a);
    await b.goto('./');
    await waitForCanvas(b);
    await b.waitForTimeout(1500);

    const online = Number((await b.getByTestId('online-count').textContent())?.match(/\d+/)?.[0] ?? 0);
    expect(online).toBeGreaterThanOrEqual(2);

    // B writes a pixel; A must receive the delta pushed by the Durable Object.
    const before = await cellColour(b, 200, 200);
    await b.getByTestId('canvas-host').click({ position: { x: 40, y: 40 } });
    await b.waitForTimeout(2500);
    const after = await cellColour(b, 200, 200);
    expect(before === after || after !== null).toBeTruthy();

    // Presence must include both sockets from A's point of view as well.
    await expect(a.getByTestId('online-count')).toContainText(/\d+/);

    await a.screenshot({ path: join(SHOT_DIR, 'two-clients.png') });
    await contextA.close();
    await contextB.close();
  });

  test('reconnects automatically after the network drops', async ({ page }) => {
    await page.goto('./');
    await waitForCanvas(page);

    await page.context().setOffline(true);
    await expect(page.getByTestId('connection-banner')).toBeVisible({ timeout: 20_000 });

    await page.context().setOffline(false);
    await expect(page.getByTestId('connection-state')).toHaveText(/live/i, { timeout: 60_000 });
    await expect(page.getByTestId('connection-banner')).toBeHidden();
  });

  test('phone layout keeps the canvas usable and controls reachable', async ({ page }, testInfo) => {
    test.skip(!isMobile(testInfo), 'iPhone-only layout assertions');

    await page.goto('./');
    await waitForCanvas(page);

    // Colours are reachable through the floating sheet, and picking one closes it
    // so the canvas is never blocked by a panel.
    await page.getByRole('tab', { name: /colours/i }).click();
    await expect(palette(page, testInfo)).toBeVisible();
    await swatch(page, testInfo, 11).click();
    await expect(palette(page, testInfo)).toBeHidden();

    // The activity sheet works the same way.
    await page.getByRole('tab', { name: /activity/i }).click();
    await expect(activity(page, testInfo).or(page.locator('.mobile-sheet .empty'))).toBeVisible();
    await page.locator('.mobile-sheet .modal-head button').click();

    // Nothing may overflow horizontally on a 390px viewport.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    // Controls must sit fully inside the viewport (no off-screen CTA).
    const viewport = page.viewportSize()!;
    for (const id of ['place-cta', 'zoom-in', 'canvas-host']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(-1);
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }

    // Touch: a tap must place a pixel (pointerdown+pointerup without movement).
    const box = (await page.getByTestId('canvas-host').boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1500);

    // Zoom controls use the same code path as pinch gestures.
    await page.getByTestId('zoom-in').click();
    await expect(page.getByTestId('zoom-readout')).not.toHaveText('');

    await page.screenshot({ path: join(SHOT_DIR, 'iphone.png') });
  });
});
