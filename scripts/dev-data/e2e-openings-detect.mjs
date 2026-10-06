// 문·창문 AI로 찾기 실측: Studio 11 집 전체에서 "AI로 찾기"를 눌러 실제 Gemini가 찾은 후보를 정답과 비교하고,
// 후보를 확인·수정·저장하는 흐름과 권한을 본다. Gemini를 실제로 한 번 부른다 (그림 18장).
// AI의 답은 실행마다 조금씩 달라지므로 "몇 개 이상 맞는지"로 본다. 자세한 결과는 출력에 남긴다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-openings-detect.mjs
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scenePath = path.join(dataDir, 'samples', 'studio11_1m_up.sog');
const sceneBytes = statSync(scenePath).size;
const stamp = Date.now();
const domain = process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test';
const emails = { owner: `e2e-${stamp}-o@${domain}`, visitor: `e2e-${stamp}-v@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

// Studio 11 집 전체 (파일 좌표를 그대로 방 좌표로 쓴다). 벽 i = i번째 → 다음 꼭짓점
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [
  [2.78, -3.05], [6.33, -3.05], [6.33, 2.75], [2.63, 2.75], [2.63, 1.75], [2.42, 1.75], [2.42, 2.68], [-0.75, 2.68], [-0.75, 0.87],
  [-1.75, 0.87], [-1.75, 2.2], [-3.62, 2.2], [-3.62, 1.2], [-4.22, 1.2], [-4.22, 0], [-2.25, 0], [-2.25, -0.4], [-1.22, -0.4],
  [-1.22, -0.15], [1.3, -0.15], [1.3, -0.47], [2.42, -0.47], [2.42, 0.22], [2.63, 0.22], [2.63, -1.87], [2.78, -1.87],
];
// 정답 (10/6 운영 화면에서 하나씩 확인한 값). 부엌 발코니 문은 유리문이라 AI가 창문으로 볼 수 있어 종류는 따지지 않는다
const TRUTH = [
  { name: '현관문', type: 'door', wallIndex: 20, from: 0.15, to: 1.0 },
  { name: '욕실 문', type: 'door', wallIndex: 16, from: 0.08, to: 1.03 },
  { name: '거실 방문', type: 'door', wallIndex: 23, from: 0.79, to: 1.64 },
  { name: '부엌 발코니 문', type: 'any', wallIndex: 13, from: 0.03, to: 0.78 },
  { name: '거실 창', type: 'window', wallIndex: 1, from: 1.23, to: 4.73 },
  { name: '식당 창', type: 'window', wallIndex: 6, from: 0.88, to: 2.42 },
];

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const listKeys = async (prefix) =>
  (await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix }))).Contents?.map((o) => o.Key) ?? [];

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const pageErrors = [];
const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  return page;
};
const signUp = async (page, email) => {
  await page.goto(`${appUrl}/account`);
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });
};
const api = (page, method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, url, body },
  );
const r2 = (v) => Math.round(v * 100) / 100;

try {
  // 준비: 가입 → 방 만들고 파일 올리기
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '문·창문 찾기 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { data: ownerRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const ownerId = ownerRow.owner_id;
  check('준비: 방 업로드 완료', putStatus === 200 && done.status === 200, [putStatus, done.status]);
  const suggestUrl = `/api/rooms/${roomId}/openings-suggest`;
  const callsOf = async () => (await admin.from('ai_calls').select('kind, status, input_tokens').eq('owner_id', ownerId).order('created_at')).data ?? [];
  const tiny = { images: [{ data: `/9j/${'A'.repeat(200)}` }], views: [{ position: [0, 1.5, 0], target: [1, 1.4, 0] }], aspect: 1.6, fovDeg: 60 };

  // 1) 보정 전·잘못된 요청은 Gemini를 부르지 않는다
  const notCalibrated = await api(page, 'POST', suggestUrl, tiny);
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const mismatch = await api(page, 'POST', suggestUrl, { ...tiny, views: [...tiny.views, ...tiny.views] });
  const notJpeg = await api(page, 'POST', suggestUrl, { ...tiny, images: [{ data: `iVBORw0KGgo${'A'.repeat(200)}` }] });
  check('보정하지 않은 방 400, 그림 수와 자리 수가 다름 400, JPEG가 아님 400 — 횟수를 쓰지 않음', notCalibrated.json?.error?.code === 'NOT_CALIBRATED' && mismatch.status === 400 && notJpeg.status === 400 && !setupError && (await callsOf()).length === 0, [notCalibrated.status, mismatch.json?.error?.message, notJpeg.json?.error?.message]);

  // 2) 다른 사람은 쓸 수 없다
  const anonymous = await newPage();
  await anonymous.goto(`${appUrl}/`);
  const anon = await api(anonymous, 'POST', suggestUrl, tiny);
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  const stranger = await api(visitor, 'POST', suggestUrl, tiny);
  check('로그인하지 않으면 401, 다른 사람은 404', anon.status === 401 && stranger.status === 404, [anon.status, stranger.status]);

  // 3) 화면에서 "AI로 찾기"
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await page.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  await page.waitForTimeout(2000);
  await page.getByTestId('openings-toggle').click();
  const box = page.getByTestId('openings');
  const detectBox = page.getByTestId('openings-detect');
  check('문·창문 도구에 "AI로 찾기"와 안내(틀릴 수 있으니 확인), 남은 횟수 10', (await page.getByTestId('openings-detect-run').innerText()) === 'AI로 찾기' && (await detectBox.innerText()).includes('꼭 확인하세요') && (await detectBox.getAttribute('data-remaining')) === '10', await detectBox.innerText());
  const started = Date.now();
  await page.getByTestId('openings-detect-run').click();
  await page.waitForFunction(() => /화면 캡처 중 \(\d+\/18\)/.test(document.querySelector('[data-testid=openings-detect-run]')?.textContent ?? ''), null, { timeout: 15000 });
  const capturingText = await page.getByTestId('openings-detect-run').innerText();
  await page.waitForFunction(() => document.querySelector('[data-testid=openings-detect]')?.getAttribute('data-busy') === 'false', null, { timeout: 180000 });
  console.log(`찾기까지 ${Date.now() - started}ms`);
  const message = await page.getByTestId('openings-message').innerText();
  const found = JSON.parse(await box.getAttribute('data-json'));
  console.log(message);
  const rows = TRUTH.map((t) => {
    const match = found.find((o) => o.wallIndex === t.wallIndex && (t.type === 'any' || o.type === t.type) && Math.min(o.to, t.to) - Math.max(o.from, t.from) > 0.5 * (t.to - t.from));
    if (match) match.matched = true;
    // 자리는 맞지만 일부만 본 것 (그림 가장자리에서 잘린 창 등). 사용자가 폭만 고치면 된다
    const partial = match ? null : found.find((o) => !o.matched && o.wallIndex === t.wallIndex && Math.min(o.to, t.to) - Math.max(o.from, t.from) > 0.3);
    if (partial) partial.matched = true;
    return { name: t.name, found: Boolean(match), error: match ? Math.max(Math.abs(match.from - t.from), Math.abs(match.to - t.to)) : null, text: match ? `O ${t.name}: 정답 ${t.from}~${t.to} → ${match.type} ${match.from}~${match.to} (오차 ${r2(match.from - t.from)}, ${r2(match.to - t.to)} m)` : partial ? `△ ${t.name}: 정답 ${t.from}~${t.to} → ${partial.type} ${partial.from}~${partial.to} (일부만 찾음)` : `X ${t.name}: 못 찾음`, partial: Boolean(partial) };
  });
  const extras = found.filter((o) => !o.matched);
  console.log(rows.map((r) => r.text).join('\n'));
  console.log(`정답에 없는 후보 ${extras.length}개: ${extras.map((o) => `${o.type} 벽 ${o.wallIndex + 1} ${o.from}~${o.to}`).join(', ')}`);
  check('누르면 "화면 캡처 중 (n/18)", 끝나면 무엇을 넣었는지와 "확인하고 … 저장하세요" 안내', /화면 캡처 중 \(\d+\/18\)/.test(capturingText) && /AI가 문 \d+개, 창문 \d+개를 찾아 넣었습니다/.test(message) && message.includes('저장하세요'), [capturingText, message]);
  const hits = rows.filter((r) => r.found);
  // AI의 답은 실행마다 달라진다(같은 방에서 온전히 찾는 것이 2~6개, 나머지는 일부만 찾거나 놓친다).
  // 후보를 넣어 주는 기능이므로 "절반 이상의 자리"를 기준으로 삼는다
  check('정답 6개 가운데 3개 이상의 자리를 맞는 벽에서 찾음 (일부만 찾은 것 포함)', rows.filter((r) => r.found || r.partial).length >= 3, rows.map((r) => `${r.name}:${r.found ? r2(r.error) : r.partial ? '일부' : 'X'}`));
  check('찾은 것 가운데 2개 이상은 양 끝의 오차가 20cm 이내', hits.filter((r) => r.error <= 0.2).length >= 2, hits.map((r) => r2(r.error)));
  check('정답에 없는 후보는 5개 이하', extras.length <= 5, extras.length);
  const tags = await page.getByTestId('openings-ai-tag').count();
  check('후보는 목록에 "AI" 표시와 함께 들어가고, 아직 저장되지 않음 (DB는 비어 있음), 남은 횟수 9', tags === found.length && (await page.getByTestId('openings-save-state').getAttribute('data-state')) === 'dirty' && ((await admin.from('rooms').select('openings').eq('id', roomId).maybeSingle()).data.openings ?? []).length === 0 && (await detectBox.getAttribute('data-remaining')) === '9', [tags, found.length]);
  const calls = await callsOf();
  check('DB: 호출 기록 1건 (openings, done)', calls.length === 1 && calls[0].kind === 'openings' && calls[0].status === 'done' && calls[0].input_tokens > 5000, calls);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'openings-detect.png') });
  await page.getByTestId('plan-toggle').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'openings-detect-plan.png') });
  await page.getByTestId('plan-toggle').click();

  // 4) 확인·수정: 종류 바꾸기, 지우기, 저장
  const list = page.getByTestId('openings-list');
  const first = found[0];
  await list.locator('li').first().getByRole('button', { name: /종류 바꾸기$/ }).click();
  const switched = JSON.parse(await box.getAttribute('data-json'));
  check('"창문으로/문으로"를 누르면 종류만 바뀜', switched.length === found.length && switched[0].type !== first.type && switched[0].wallIndex === first.wallIndex && switched[0].from === first.from && switched[0].to === first.to, [first.type, switched[0].type]);
  await list.locator('li').first().getByRole('button', { name: /삭제$/ }).click();
  const afterRemove = JSON.parse(await box.getAttribute('data-json'));
  await page.getByTestId('openings-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=openings-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  const saved = (await admin.from('rooms').select('openings').eq('id', roomId).maybeSingle()).data.openings;
  check('하나를 지우고 저장하면: 남은 후보가 DB에 저장되고 "AI" 표시가 사라짐', afterRemove.length === found.length - 1 && saved.length === afterRemove.length && (await page.getByTestId('openings-ai-tag').count()) === 0, [found.length, saved.length]);

  // 5) 다시 찾으면 이미 있는 것과 겹치는 후보는 넣지 않는다 (Gemini를 부르지 않게 응답을 흉내 낸다)
  await page.route('**/openings-suggest', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [saved[0], { type: 'window', wallIndex: 2, from: 0.5, to: 1.5, widthM: 1 }], detected: 2, remaining: 8 }) }));
  await page.getByTestId('openings-detect-run').click();
  await page.waitForFunction(() => (document.querySelector('[data-testid=openings-message]')?.textContent ?? '').includes('겹치는 1개는 뺌'), null, { timeout: 60000 });
  const again = JSON.parse(await box.getAttribute('data-json'));
  check('다시 찾으면: 이미 있는 것과 겹치는 후보는 빼고 새것만 넣음', again.length === saved.length + 1 && (await page.getByTestId('openings-ai-tag').count()) === 1 && (await detectBox.getAttribute('data-remaining')) === '8', await page.getByTestId('openings-message').innerText());
  await page.unroute('**/openings-suggest');
  check('화면 오류 없음', pageErrors.length === 0, pageErrors);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  await browser.close();
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => Object.values(emails).includes(u.email)) ?? [];
  let removed = 0;
  for (const u of mine) {
    const { data: rooms } = await admin.from('rooms').select('id').eq('owner_id', u.id);
    for (const r of rooms ?? []) {
      const keys = await listKeys(`rooms/${r.id}/`);
      if (keys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
        removed += keys.length;
      }
    }
    await admin.auth.admin.deleteUser(u.id);
  }
  check('시험용 계정·방·R2 파일 삭제', mine.length === 2, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail).slice(0, 500) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
