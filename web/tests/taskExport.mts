// Export transport is a route fixture; it must never fall back to a workspace-wide export.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBundle, fragmentsFor, validateBundle } from '../../shared/transfer';

const base = 'http://127.0.0.1:4320', out = resolve('web/test-output'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const checks: string[] = [], errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
let fixedReceipts = true; const requests: { offset: number; limit: number }[] = [];
const makeBundle = (offset: number) => {
  const text = `固定旧快照正文 ${offset + 1}；不是当前头版本。`;
  return createBundle({ records: [{ source_key: { platform: 'zsxq', group_id: '100100', entity_type: 'topic', entity_id: String(200200 + offset) }, group_id: '100100', author_id: '300300', author_name: '隔离固定版本作者', title: `固定旧标题 ${offset + 1}`, text, created_at: '2026-10-01T00:00:00Z', source_url: `https://wx.zsxq.com/dweb2/index/topic_detail/${200200 + offset}`, captured_at: '2026-10-02T00:00:00Z', fragments: fragmentsFor(text), coverage: { body: 'complete', comments: 'partial', attachments: 'partial', reasons: ['UI 契约 fixture，未读取源站'] } }], coverage: { task_id: 'ui-fixed-export', task_state: 'partial', fixed_capture_revisions: true, offset, limit: 1, total: 2, next_offset: offset === 0 ? 1 : null, attachments: 'excluded_use_library_explicit_zip' } });
};
try {
  await page.goto(`${base}/register`); await page.getByLabel('称呼').fill('隔离任务导出验收'); await page.getByLabel('邮箱').fill(`task-export-${randomUUID()}@example.invalid`); await page.getByLabel('密码').fill(`Synthetic-${randomUUID()}!`); await page.getByRole('button', { name: '创建账号', exact: true }).click(); await page.waitForURL('**/inbox');
  await page.route('**/api/w/*/jobs/ui-fixed-export', route => route.fulfill({ json: { id: 'ui-fixed-export', kind: 'capture', state: 'partial', checkpoint: { saved_records: fixedReceipts ? [{ material_id: 'fixture-a', revision_id: 'fixed-a' }, { material_id: 'fixture-b', revision_id: 'fixed-b' }] : [] }, events: [] } }));
  await page.route('**/api/w/*/jobs/ui-fixed-export/export?**', route => {
    const url = new URL(route.request().url()), offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit')); requests.push({ offset, limit });
    return limit > 1 ? route.fulfill({ status: 413, json: { error: { code: 'export_too_large', message: '隔离 fixture 包体超过上限，请降低每批条数。' } } }) : route.fulfill({ json: makeBundle(offset) });
  });
  await page.goto(`${base}/tasks/ui-fixed-export`); await page.getByRole('button', { name: '导出已完成部分', exact: true }).click(); const dialog = page.getByRole('dialog'); await dialog.getByLabel('每批回执条数', { exact: false }).fill('1');
  const firstDownload = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出本批 JSON', exact: true }).click(); const first = await firstDownload, firstPath = resolve(out, '12-task-fixed-part.json'); await first.saveAs(firstPath);
  const firstBundle = validateBundle(JSON.parse(await readFile(firstPath, 'utf8'))); assert.match(firstBundle.records[0].text, /固定旧快照正文 1/); assert.equal(firstBundle.coverage.attachments, 'excluded_use_library_explicit_zip'); assert.equal(firstBundle.attachments.length, 0);
  assert.deepEqual(requests, [{ offset: 0, limit: 1 }]); checks.push('Downloaded part contains fixed historical body and explicit no-original coverage (export route fixture)');
  await dialog.getByRole('button', { name: '准备下一批 · 偏移 1', exact: true }).click(); assert.equal(requests.length, 1); assert.equal(await dialog.getByLabel('起始回执偏移', { exact: false }).inputValue(), '1');
  const secondDownload = page.waitForEvent('download'); await dialog.getByRole('button', { name: '导出本批 JSON', exact: true }).click(); const second = await secondDownload, secondPath = resolve(out, '13-task-next-part.json'); await second.saveAs(secondPath);
  const secondBundle = validateBundle(JSON.parse(await readFile(secondPath, 'utf8'))); assert.match(secondBundle.records[0].text, /固定旧快照正文 2/); assert.equal(secondBundle.coverage.next_offset, null); assert.deepEqual(requests, [{ offset: 0, limit: 1 }, { offset: 1, limit: 1 }]);
  checks.push('Next batch only requested after explicit export; coverage cursor respected (export route fixture)');
  await dialog.getByLabel('每批回执条数', { exact: false }).fill('1000'); await dialog.getByRole('button', { name: '导出本批 JSON', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '降低每批条数' }).waitFor();
  assert.equal(await dialog.getByLabel('每批回执条数', { exact: false }).inputValue(), '1000'); await dialog.getByLabel('每批回执条数', { exact: false }).fill('1'); assert.ok(await dialog.getByRole('button', { name: '导出本批 JSON', exact: true }).isEnabled());
  checks.push('Oversized part leaves local settings recoverable; no success receipt invented (export route fixture)');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click(); fixedReceipts = false; const refresh = page.waitForResponse(r => r.url().endsWith('/ui-fixed-export')); await page.getByRole('button', { name: '刷新', exact: true }).click(); await refresh; await page.getByText('没有可用的固定原文保存回执', { exact: false }).waitFor(); assert.equal(await page.getByRole('button', { name: '导出已完成部分', exact: true }).count(), 0);
  assert.equal(requests.length, 3); checks.push('Legacy/no-receipt task never becomes broad/current workspace export (export route fixture)');
  assert.deepEqual(errors, []); await writeFile(resolve(out, 'task-export-report.json'), JSON.stringify({ url: base, checks, pageErrors: errors, browser: await browser.version(), time: new Date().toISOString(), constraints: ['4320 isolated account only', 'job/detail/export are route fixtures, not runtime export proof', 'downloaded JSON digest/readback validated', 'no source login or model requests'] }, null, 2)); console.log(JSON.stringify({ checks, pageErrors: errors }));
} catch (error) { console.error(JSON.stringify({ passedBeforeFailure: checks, url: page.url() })); throw error; }
finally { await browser.close(); }
