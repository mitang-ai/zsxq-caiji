// Provider transport is explicitly mocked; only fixture account/config writes reach 4320.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const base = 'http://127.0.0.1:4320', out = resolve('web/test-output'); await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const checks: string[] = [], errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
const fakeKey = 'synthetic-discovery-key-not-real'; let failDiscovery = false, failTest = false;
const discoveryBodies: Record<string, unknown>[] = [];
try {
  await page.goto(`${base}/register`); await page.getByLabel('称呼').fill('隔离模型表单验收'); await page.getByLabel('邮箱').fill(`model-form-${randomUUID()}@example.invalid`); await page.getByLabel('密码').fill(`Synthetic-${randomUUID()}!`); await page.getByRole('button', { name: '创建账号', exact: true }).click(); await page.waitForURL('**/inbox');
  await page.route('**/api/providers/discover', route => {
    assert.equal(route.request().method(), 'POST'); const body = route.request().postDataJSON(); discoveryBodies.push(body);
    assert.equal(body.base_url, 'https://api.example.invalid/v1'); assert.equal(body.protocol, 'chat'); assert.equal(body.model, undefined); assert.equal(body.material_ids, undefined);
    return failDiscovery ? route.fulfill({ status: 503, json: { error: { code: 'provider_unreachable', message: '隔离 fixture 网络错误，配置没有保存。' } } }) : route.fulfill({ json: { models: ['fixture-model-a', 'fixture-model-b'], verified: false, saved: false } });
  });
  await page.goto(`${base}/settings/models`); await page.getByRole('button', { name: '添加服务', exact: true }).click(); let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Base URL').fill('https://api.example.invalid/v1'); await dialog.getByLabel('API Key', { exact: false }).fill(fakeKey);
  assert.equal(await dialog.getByLabel('默认模型 ID', { exact: false }).inputValue(), ''); assert.equal(await dialog.getByLabel('名称', { exact: false }).first().inputValue(), '');
  await dialog.getByRole('button', { name: '发现可用模型', exact: true }).click(); await dialog.getByText('已发现 2 个模型', { exact: false }).waitFor();
  assert.equal(discoveryBodies.length, 1); assert.equal(discoveryBodies[0].api_key, fakeKey); assert.equal(await dialog.getByLabel('默认模型 ID', { exact: false }).inputValue(), '');
  assert.deepEqual(await (await page.request.get(`${base}/api/providers`)).json(), []);
  checks.push('Discover before name/model/save; POST has no model/materials; no server config saved (transport fixture)');
  await dialog.getByLabel('从发现结果选择默认模型', { exact: false }).selectOption('fixture-model-b'); await dialog.getByLabel('名称', { exact: false }).first().fill('隔离发现配置');
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click(); await page.getByRole('heading', { name: '隔离发现配置', exact: true }).waitFor();
  const providers = await (await page.request.get(`${base}/api/providers`)).json(); assert.equal(providers.length, 1); assert.equal(providers[0].model, 'fixture-model-b'); assert.equal(providers[0].api_key, undefined);
  assert.ok(!(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].join('\n'))).includes(fakeKey));
  checks.push('Explicit discovered model selection saves actual isolated provider; Key absent in public response/local storage');
  await page.getByRole('button', { name: '编辑配置', exact: true }).click(); dialog = page.getByRole('dialog');
  assert.equal(await dialog.getByLabel('API Key', { exact: false }).inputValue(), ''); await dialog.getByRole('button', { name: '发现可用模型', exact: true }).click(); await dialog.getByText('已发现 2 个模型', { exact: false }).waitFor();
  assert.equal(discoveryBodies[1].provider_id, providers[0].id); assert.equal(discoveryBodies[1].api_key, undefined);
  await dialog.getByLabel('Base URL').fill('https://other.example.invalid/v1'); assert.ok(await dialog.getByRole('button', { name: '发现可用模型', exact: true }).isDisabled());
  assert.equal(await dialog.getByLabel('API Key · 新地址必须重新填写', { exact: false }).getAttribute('required'), ''); await dialog.getByText('不能把已保存的 Key 带往新地址', { exact: false }).waitFor();
  assert.equal(discoveryBodies.length, 2); checks.push('Existing own secret reference only at unchanged destination; new URL requires fresh Key without confirm bypass');
  await dialog.getByLabel('Base URL').fill('https://api.example.invalid/v1'); failDiscovery = true; await dialog.getByRole('button', { name: '发现可用模型', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '隔离 fixture 网络错误' }).waitFor(); assert.equal(await dialog.getByLabel('名称', { exact: false }).first().inputValue(), '隔离发现配置'); assert.equal(await dialog.getByLabel('默认模型 ID', { exact: false }).inputValue(), 'fixture-model-b');
  checks.push('Discovery errors remain same form and retain editable configuration (transport fixture)'); await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.route(`**/api/providers/${providers[0].id}/test`, route => {
    assert.deepEqual(route.request().postDataJSON(), { mode: 'call' });
    return failTest ? route.fulfill({ status: 502, json: { error: { code: 'provider_error', message: '隔离 fixture 调用失败，不能认定未计费。' } } }) : route.fulfill({ json: { text: '<script>window.__providerXss=true</script>\n隔离测试响应正文', model: 'fixture-model-b', usage: { input_tokens: 5, output_tokens: 3 }, capability: 'text' } });
  });
  failTest = true; await page.getByRole('button', { name: '实际测试', exact: true }).click(); dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: '执行测试', exact: true }).click(); await dialog.getByRole('alert').filter({ hasText: '隔离 fixture 调用失败' }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: '明确重试测试', exact: true }).isVisible()); failTest = false; await dialog.getByRole('button', { name: '明确重试测试', exact: true }).click(); await dialog.getByRole('heading', { name: '实际响应', exact: true }).waitFor();
  assert.match(await dialog.locator('.provider-test-text').innerText(), /隔离测试响应正文/); assert.equal(await page.evaluate(() => (window as any).__providerXss), undefined); await page.screenshot({ path: resolve(out, '11-model-test-response-ui-fixture.png') });
  await dialog.getByRole('button', { name: '关闭结果', exact: true }).click(); await page.getByRole('heading', { name: '真实测试结果 · 隔离发现配置', exact: true }).waitFor();
  checks.push('Test error explicitly recoverable; successful actual response remains visible in dialog and after close, raw HTML inert (transport fixture)');
  assert.deepEqual(errors, []); await writeFile(resolve(out, 'models-report.json'), JSON.stringify({ url: base, checks, pageErrors: errors, browser: await browser.version(), time: new Date().toISOString(), constraints: ['4320 isolated data only', 'discover/test provider transport explicitly mocked, not external connectivity proof', 'no real Key or materials used'] }, null, 2)); console.log(JSON.stringify({ checks, pageErrors: errors }));
} catch (error) { console.error(JSON.stringify({ passedBeforeFailure: checks, url: page.url() })); throw error; }
finally { await browser.close(); }
