// UI contract fixtures only; never authorize a source session or execute a model.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Job } from '../src/types';

const base = 'http://127.0.0.1:4320';
const out = resolve('web/test-output'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const checks: string[] = [], errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
let state = 'partial', kind = 'capture', failures: unknown[] = [{ topic_id: '234234', stages: ['detail', 'comments'], at: '2026-10-03T00:00:00Z' }];
let retryCalls = 0; let requestBody: unknown;
function fixture(): Job { return { id: 'ui-known-failures', kind, state, created_at: '2026-10-03T00:00:00Z', checkpoint: { failures, seen: ['111111'], page: 2 }, scope: { group_id: '123123', max_pages: 2 }, events: [{ type: 'partial', at: '2026-10-03T00:00:00Z', message: '仅 UI 契约 fixture；不调用第三方' }] }; }
try {
  await page.goto(`${base}/register`);
  await page.getByLabel('称呼').fill('隔离恢复验收');
  await page.getByLabel('邮箱').fill(`recovery-${randomUUID()}@example.invalid`);
  await page.getByLabel('密码').fill(`Synthetic-${randomUUID()}!`);
  await page.getByRole('button', { name: '创建账号', exact: true }).click(); await page.waitForURL('**/inbox');
  await page.route('**/api/w/*/jobs/ui-known-failures', route => route.fulfill({ json: fixture() }));
  await page.route('**/api/w/*/jobs/ui-known-failures/retry_failed', route => {
    assert.equal(route.request().method(), 'POST'); retryCalls++; requestBody = route.request().postDataJSON(); state = 'queued'; return route.fulfill({ json: fixture() });
  });
  await page.goto(`${base}/tasks/ui-known-failures`);
  await page.getByRole('heading', { name: '已知失败项 · 1', exact: true }).waitFor();
  await page.getByRole('button', { name: '仅重试失败项', exact: true }).waitFor();
  assert.match(await page.locator('.capture-failures').innerText(), /详情、讨论/);
  assert.equal(await page.locator('details').filter({ hasText: '已保存断点' }).getAttribute('open'), null);
  await page.screenshot({ path: resolve(out, '09-capture-failures-ui-fixture.png') });
  page.once('dialog', dialog => {
    assert.match(dialog.message(), /同一已核验账号/); assert.match(dialog.message(), /不重扫列表、不增加分页预算/); return dialog.accept();
  });
  await page.getByRole('button', { name: '仅重试失败项', exact: true }).click();
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
  assert.equal(retryCalls, 1); assert.deepEqual(requestBody, {}); assert.equal(await page.getByRole('button', { name: '仅重试失败项', exact: true }).count(), 0);
  checks.push('Known failed capture items: explicit narrow confirmation / POST {} / queued state readback (UI fixture)');
  for (const next of ['failed', 'partial', 'completed', 'login_required', 'rate_limited', 'paused']) {
    state = next; await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('button', { name: '仅重试失败项', exact: true }).waitFor();
  }
  for (const next of ['running', 'queued', 'cancelled']) {
    state = next; const refreshResponse = page.waitForResponse(r => r.url().endsWith('/ui-known-failures')); await page.getByRole('button', { name: '刷新', exact: true }).click(); await refreshResponse;
    assert.equal(await page.getByRole('button', { name: '仅重试失败项', exact: true }).count(), 0);
  }
  checks.push('Retry button allowed stopped states only; hidden running/queued/cancelled (UI fixture)');
  state = 'failed'; failures = []; await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('button', { name: '继续断点采集', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '仅重试失败项', exact: true }).count(), 0);
  kind = 'process'; failures = [{ topic_id: '234234', stages: ['detail'] }]; state = 'budget_paused';
  await page.getByRole('button', { name: '刷新', exact: true }).click(); await page.getByRole('link', { name: '建立新预算计划', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '仅重试失败项', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: '从断点恢复', exact: true }).count(), 0);
  checks.push('No retry for empty/process failure data; budget exhausted never offers invalid resume (UI fixture)');
  await page.goto(`${base}/settings/appearance`);
  for (const theme of ['纸白', '暖灰', '石墨', '雾蓝']) {
    await page.getByRole('button', { name: theme, exact: true }).click();
    await page.keyboard.press('Tab'); assert.ok(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle !== 'none'));
  }
  checks.push('Four themes keyboard focus visible in actual Edge');
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `No overflow at ${width}`);
    if (width < 768) assert.ok(await page.locator('.mobile-bottom').isVisible()); if (width < 1024) assert.ok(await page.getByLabel('切换空间', { exact: true }).isVisible());
  }
  await page.setViewportSize({ width: 390, height: 900 }); assert.equal(await page.locator('.sidebar').getAttribute('inert'), '');
  await page.getByRole('button', { name: '打开导航', exact: true }).click(); await page.waitForFunction(() => document.querySelector('.sidebar')?.contains(document.activeElement));
  for (let n = 0; n < 18; n++) { await page.keyboard.press('Tab'); assert.ok(await page.locator('.sidebar').evaluate(el => el.contains(document.activeElement))); }
  await page.keyboard.press('Escape'); await page.waitForFunction(() => document.querySelector('.sidebar')?.hasAttribute('inert')); assert.ok(await page.getByRole('button', { name: '打开导航', exact: true }).evaluate(el => el === document.activeElement));
  checks.push('Closed mobile sidebar inert; opened drawer focus trapped / Escape restores visible trigger in actual Edge');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.locator('html').evaluate(el => { el.style.zoom = '2'; });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  checks.push('320/390/768/1024/1440/1920 + 200 percent CSS zoom have no outer horizontal overflow in actual Edge');
  assert.deepEqual(errors, []);
  await writeFile(resolve(out, 'recovery-report.json'), JSON.stringify({ url: base, checks, browser: await browser.version(), pageErrors: errors, time: new Date().toISOString(), constraints: ['4320 isolated account only', 'job API is Playwright route fixture, not runtime proof', 'no source or provider calls', '200 percent CSS zoom is not OS DPI or browser native zoom'] }, null, 2));
  console.log(JSON.stringify({ checks, pageErrors: errors }));
} catch (error) { console.error(JSON.stringify({ passedBeforeFailure: checks, url: page.url() })); throw error; }
finally { await browser.close(); }
