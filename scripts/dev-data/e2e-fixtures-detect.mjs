// 원래 가구 AI로 찾기 실측: 정답 상자(labels.json)가 있는 InteriorGS 장면을 비공개 방으로 올리고 "AI로 찾기"를 눌러
// 실제 Gemini가 찾은 후보를 정답과 비교하고, 후보를 확인·수정·저장하는 흐름과 권한을 본다. Gemini를 실제로 한 번 부른다.
// AI의 답은 실행마다 조금씩 달라질 수 있으므로 "몇 개 이상 맞는지"로 본다. 자세한 결과는 출력에 남긴다.
// 준비: npm run dev, ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/converted/<장면>.sog, interiorgs/<장면>/labels.json·structure.json
// 실행: node --env-file=.env.local scripts/dev-data/e2e-fixtures-detect.mjs [장면]
import { createRequire } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scene = process.argv[2] ?? '0056_839909';
const scenePath = path.join(dataDir, 'converted', `${scene}.sog`);
const sceneBytes = statSync(scenePath).size;
const stamp = Date.now();
const domain = process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test';
const emails = { owner: `e2e-${stamp}-o@${domain}`, visitor: `e2e-${stamp}-v@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const r2 = (v) => Math.round(v * 100) / 100;

// 장면 좌표를 그대로 방 좌표로 쓴다: (x, y, 높이 z) → (x, 높이, -y). 방은 structure.json의 첫 방
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const structure = JSON.parse(readFileSync(path.join(dataDir, 'interiorgs', scene, 'structure.json'), 'utf8'));
const FLOOR = structure.rooms[0].profile.map(([x, y]) => [r2(x), r2(-y) + 0]);
// 정답: 바닥에 놓인 가구 (작은 소품·문·창문·화분·조명 등은 뺀다)
const SKIP = /door|window|plant|curtain|carpet|rug|lamp|book|painting|mirror|decor|chandelier|light|pillow|cushion|towel|clothes|toy|bag|box|vase|ornament/i;
const TRUTH = JSON.parse(readFileSync(path.join(dataDir, 'interiorgs', scene, 'labels.json'), 'utf8'))
  .filter((o) => o.bounding_box && !SKIP.test(o.label))
  .map((o) => {
    const xs = o.bounding_box.map((p) => p.x);
    const zs = o.bounding_box.map((p) => -p.y);
    const hs = o.bounding_box.map((p) => p.z);
    return { name: `${o.ins_id}:${o.label}`, minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs), bottom: Math.min(...hs), top: Math.max(...hs) };
  })
  .filter((t) => t.bottom < 0.15 && (t.maxX - t.minX) * (t.maxZ - t.minZ) >= 0.09 && t.top - t.bottom >= 0.25);

/** 원래 가구(벽과 나란한 사각형)의 범위. 이 장면들은 벽이 x·z 축과 나란하다 */
const extent = (f) => {
  const turned = Math.round(f.rotationDeg / 90) % 2 === 1;
  const [w, d] = turned ? [f.d, f.w] : [f.w, f.d];
  return { minX: f.x - w / 2, maxX: f.x + w / 2, minZ: f.z - d / 2, maxZ: f.z + d / 2 };
};
const iou = (a, b) => {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const d = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (w <= 0 || d <= 0) return 0;
  return (w * d) / ((a.maxX - a.minX) * (a.maxZ - a.minZ) + (b.maxX - b.minX) * (b.maxZ - b.minZ) - w * d);
};

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const listKeys = async (prefix) => (await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix }))).Contents?.map((o) => o.Key) ?? [];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
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

try {
  console.log(`정답 ${TRUTH.length}개: ${TRUTH.map((t) => t.name).join(', ')}`);
  // 준비: 가입 → 방 만들고 파일 올리기
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '원래 가구 찾기 실측 방', consent: true, source: 'dataset', credit: `InteriorGS ${scene} (시험용, 비공개)` })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status, {
    url: signed.json.url,
    headers: signed.json.headers,
  });
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { data: ownerRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const ownerId = ownerRow.owner_id;
  check('준비: 방 업로드 완료', putStatus === 200 && done.status === 200, [putStatus, done.status]);
  const suggestUrl = `/api/rooms/${roomId}/fixtures-suggest`;
  const callsOf = async () => (await admin.from('ai_calls').select('kind, status, input_tokens').eq('owner_id', ownerId).order('created_at')).data ?? [];
  const tiny = { images: [{ data: `/9j/${'A'.repeat(200)}` }] };

  // 1) 보정 전·잘못된 요청은 Gemini를 부르지 않는다
  const notCalibrated = await api(page, 'POST', suggestUrl, tiny);
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const tooMany = await api(page, 'POST', suggestUrl, { images: [...tiny.images, ...tiny.images] });
  const notJpeg = await api(page, 'POST', suggestUrl, { images: [{ data: `iVBORw0KGgo${'A'.repeat(200)}` }] });
  check(
    '보정하지 않은 방 400, 그림 수가 방 크기(1칸)와 다름 400, JPEG가 아님 400 — 횟수를 쓰지 않음',
    notCalibrated.json?.error?.code === 'NOT_CALIBRATED' && tooMany.status === 400 && notJpeg.status === 400 && !setupError && (await callsOf()).length === 0,
    [notCalibrated.status, tooMany.json?.error?.message, notJpeg.json?.error?.message],
  );

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
  await page.getByTestId('fixtures-toggle').click();
  const box = page.getByTestId('fixtures');
  const detectBox = page.getByTestId('fixtures-detect');
  check(
    '원래 가구 도구에 "AI로 찾기"와 안내(틀릴 수 있으니 확인), 남은 횟수 10',
    (await page.getByTestId('fixtures-detect-run').innerText()) === 'AI로 찾기' && (await detectBox.innerText()).includes('꼭 확인하세요') && (await detectBox.getAttribute('data-remaining')) === '10',
    await detectBox.innerText(),
  );
  const started = Date.now();
  await page.getByTestId('fixtures-detect-run').click();
  await page.waitForFunction(() => /위에서 캡처 중 \(0\/1\)|AI가 찾는 중/.test(document.querySelector('[data-testid=fixtures-detect-run]')?.textContent ?? ''), null, { timeout: 15000 });
  const busyText = await page.getByTestId('fixtures-detect-run').innerText();
  await page.waitForFunction(() => document.querySelector('[data-testid=fixtures-detect]')?.getAttribute('data-busy') === 'false', null, { timeout: 180000 });
  console.log(`찾기까지 ${Date.now() - started}ms`);
  const message = await page.getByTestId('fixtures-message').innerText();
  const found = JSON.parse(await box.getAttribute('data-json'));
  console.log(message);

  // 정답과 짝짓기: IoU가 큰 쌍부터
  const pairs = [];
  for (const [i, f] of found.entries()) for (const [j, t] of TRUTH.entries()) pairs.push({ i, j, v: iou(extent(f), t) });
  pairs.sort((a, b) => b.v - a.v);
  const usedF = new Set();
  const usedT = new Set();
  const matches = [];
  for (const p of pairs) {
    if (p.v < 0.4 || usedF.has(p.i) || usedT.has(p.j)) continue;
    usedF.add(p.i);
    usedT.add(p.j);
    const f = found[p.i];
    const t = TRUTH[p.j];
    const e = extent(f);
    matches.push({
      truth: t.name,
      ai: f.label,
      iou: r2(p.v),
      center: r2(Math.hypot((e.minX + e.maxX - t.minX - t.maxX) / 2, (e.minZ + e.maxZ - t.minZ - t.maxZ) / 2)),
      h: f.h,
      top: r2(t.top),
      dh: r2(f.h - t.top),
    });
  }
  for (const m of matches) console.log(' ', JSON.stringify(m));
  const missed = TRUTH.filter((_, j) => !usedT.has(j)).map((t) => t.name);
  const extras = found.filter((_, i) => !usedF.has(i));
  console.log(`  놓침: ${missed.join(', ') || '없음'}`);
  console.log(`  정답에 없는 후보 ${extras.length}개: ${extras.map((f) => `${f.label} ${f.w}×${f.d} @(${f.x}, ${f.z})`).join(', ')}`);
  check('누르면 "위에서 캡처 중"·"AI가 찾는 중", 끝나면 몇 개를 넣었는지와 "확인하고 … 저장하세요" 안내', /AI가 원래 가구 \d+개를 찾아 넣었습니다/.test(message) && message.includes('저장하세요'), [
    busyText,
    message,
  ]);
  const need = Math.ceil(TRUTH.length * 0.7);
  check(`정답 ${TRUTH.length}개 가운데 ${need}개 이상을 찾음 (IoU 0.4 이상)`, matches.length >= need, `${matches.length}/${TRUTH.length}`);
  const centers = matches.map((m) => m.center).sort((a, b) => a - b);
  check('찾은 것의 가운데 오차: 가운뎃값 10cm 이내', centers.length > 0 && centers[Math.floor(centers.length / 2)] <= 0.1, centers);
  const goodHeights = matches.filter((m) => Math.abs(m.dh) <= 0.25).length;
  check(
    '높이를 스플랫에서 잼: 찾은 것의 70% 이상이 정답 높이와 25cm 이내',
    goodHeights >= Math.ceil(matches.length * 0.7),
    matches.map((m) => `${m.truth}:${m.h}/${m.top}`),
  );
  check('정답에 없는 후보는 3개 이하', extras.length <= 3, extras.length);
  const tags = await page.getByTestId('fixtures-ai-tag').count();
  const dbBefore = (await admin.from('rooms').select('fixtures').eq('id', roomId).maybeSingle()).data.fixtures ?? [];
  check(
    '후보는 목록에 "AI" 표시와 함께 들어가고, 아직 저장되지 않음 (DB는 비어 있음), 남은 횟수 9',
    tags === found.length &&
      (await page.getByTestId('fixtures-save-state').getAttribute('data-state')) === 'dirty' &&
      dbBefore.length === 0 &&
      (await detectBox.getAttribute('data-remaining')) === '9',
    [tags, found.length, dbBefore.length],
  );
  const calls = await callsOf();
  check('DB: 호출 기록 1건 (fixtures, done)', calls.length === 1 && calls[0].kind === 'fixtures' && calls[0].status === 'done' && calls[0].input_tokens > 500, calls);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'fixtures-detect.png') });
  await page.getByTestId('plan-toggle').click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'fixtures-detect-plan.png') });
  check('평면도에 후보가 원래 가구로 그려짐', (await page.getByTestId('plan-fixture').count()) === found.length, await page.getByTestId('plan-fixture').count());
  await page.getByTestId('plan-toggle').click();

  // 4) 확인·수정: 이름 바꾸기, 지우기, 저장
  const list = page.getByTestId('fixtures-list');
  await list.locator('li').first().getByTestId('fixture-label').selectOption('가구');
  const renamed = JSON.parse(await box.getAttribute('data-json'));
  await list.locator('li').last().getByRole('button', { name: /삭제$/ }).click();
  const afterRemove = JSON.parse(await box.getAttribute('data-json'));
  await page.getByTestId('fixtures-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=fixtures-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  const saved = (await admin.from('rooms').select('fixtures').eq('id', roomId).maybeSingle()).data.fixtures;
  check(
    '이름을 바꾸고 하나를 지운 뒤 저장하면: 남은 후보가 DB에 저장되고 "AI" 표시가 사라짐',
    renamed[0].label === '가구' &&
      afterRemove.length === found.length - 1 &&
      saved.length === afterRemove.length &&
      saved[0].label === '가구' &&
      (await page.getByTestId('fixtures-ai-tag').count()) === 0,
    [found.length, saved.length],
  );

  // 5) 다시 찾으면 이미 있는 것과 겹치는 후보는 넣지 않는다 (Gemini를 부르지 않게 응답을 흉내 낸다)
  // 새 후보: 방 안에서 저장된 원래 가구와 떨어진 빈 곳
  const xs = FLOOR.map((p) => p[0]);
  const zs = FLOOR.map((p) => p[1]);
  const spots = [];
  for (let x = Math.min(...xs) + 0.4; x < Math.max(...xs) - 0.4; x += 0.2) for (let z = Math.min(...zs) + 0.4; z < Math.max(...zs) - 0.4; z += 0.2) spots.push([r2(x), r2(z)]);
  const inside = ([x, z]) =>
    FLOOR.reduce((odd, [x1, z1], i) => {
      const [x2, z2] = FLOOR[(i + 1) % FLOOR.length];
      return z1 > z !== z2 > z && x < x1 + ((z - z1) * (x2 - x1)) / (z2 - z1) ? !odd : odd;
    }, false);
  const clear = spots.find(
    ([x, z]) =>
      [
        [x, z],
        [x - 0.4, z - 0.4],
        [x + 0.4, z + 0.4],
        [x - 0.4, z + 0.4],
        [x + 0.4, z - 0.4],
      ].every(inside) && saved.every((f) => iou(extent(f), { minX: x - 0.4, maxX: x + 0.4, minZ: z - 0.4, maxZ: z + 0.4 }) === 0),
  );
  const fresh = { id: 'x2', label: '의자', x: clear[0], z: clear[1], w: 0.3, d: 0.3, rotationDeg: saved[0].rotationDeg, h: 0.9, remove: false };
  await page.route('**/fixtures-suggest', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [{ ...saved[0], id: 'x1' }, fresh], detected: 2, remaining: 8 }) }),
  );
  await page.getByTestId('fixtures-detect-run').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=fixtures-detect]')?.getAttribute('data-busy') === 'false', null, { timeout: 60000 });
  const again = JSON.parse(await box.getAttribute('data-json'));
  const ids = again.map((f) => f.id);
  check(
    '다시 찾으면: 이미 있는 것과 겹치는 후보는 빼고 새것만 새 id로 넣음',
    (await page.getByTestId('fixtures-message').innerText()).includes('넘치는 1개는 뺌') &&
      again.length === saved.length + 1 &&
      new Set(ids).size === ids.length &&
      (await page.getByTestId('fixtures-ai-tag').count()) === 1 &&
      (await detectBox.getAttribute('data-remaining')) === '8',
    await page.getByTestId('fixtures-message').innerText(),
  );
  await page.unroute('**/fixtures-suggest');
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

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail).slice(0, 600) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
