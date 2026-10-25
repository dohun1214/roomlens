// 방에 원래 있는 가구 실측: 평면도에 그려 넣고 → 이름·높이·치울 가구를 고쳐 저장하고 → 새 가구가 피하는지, 겹치면 알리는지,
// AI 추천이 피하는지, 다른 사람에게는 보기만 되는지 본다. 3D에서 두 모서리 찍기는 e2e-fixtures-tap.mjs 가 본다.
// 방은 6 × 5 m 시험용 방(Studio 11 샘플 파일)을 비공개로 만들었다가 끝나면 지운다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-fixtures.mjs   (APP_URL로 운영 주소도 가능)
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

// 6 × 5 m 방 (파일 좌표를 그대로 방 좌표로 쓴다). 문은 아래쪽 벽(z = -2.5)의 x -2.5 ~ -1.6
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-3, -2.5], [3, -2.5], [3, 2.5], [-3, 2.5]];
const DOOR = { type: 'door', wallIndex: 0, from: 0.5, to: 1.4, widthM: 0.9 };

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const listKeys = async (prefix) =>
  (await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix }))).Contents?.map((o) => o.Key) ?? [];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // 운영 외 주소(개발 서버의 다른 포트)에서도 R2를 쓰도록 CORS 머리말을 붙인다
  await context.route(/r2\.cloudflarestorage\.com/, async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS', 'access-control-expose-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    try {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
    } catch {
      // 창을 닫는 중이면 받던 것을 버린다
      await route.abort().catch(() => {});
    }
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
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
const openRoom = async (page, roomId) => {
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await page.getByTestId('furniture-panel').waitFor({ state: 'attached', timeout: 120000 });
};
/** 평면도의 방 좌표 → 화면(px) */
const planToScreen = (page, x, z) =>
  page.evaluate(
    ([x, z]) => {
      const svg = document.querySelector('[data-testid=floor-plan]');
      const p = new DOMPoint(x, z).matrixTransform(svg.getScreenCTM());
      return { x: p.x, y: p.y };
    },
    [x, z],
  );
/** 평면도에서 (x1, z1)부터 (x2, z2)까지 끈다 */
const dragPlan = async (page, [x1, z1], [x2, z2], { midCheck } = {}) => {
  const a = await planToScreen(page, x1, z1);
  const b = await planToScreen(page, x2, z2);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  const mid = midCheck ? await midCheck() : null;
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  return mid;
};
const fixturesOf = async (page) => JSON.parse(await page.getByTestId('fixtures').getAttribute('data-json'));
const itemsOf = async (page) => JSON.parse(await page.getByTestId('furniture-panel').getAttribute('data-json'));
const near = (a, b, tolerance = 0.011) => Math.abs(a - b) <= tolerance;
/** 키 순서와 상관없이 같은지 (DB의 jsonb는 키 순서를 바꾼다) */
const sameJson = (a, b) => {
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
};
const overlaps = (a, b) => Math.min(a.x + a.w / 2, b.x + b.w / 2) - Math.max(a.x - a.w / 2, b.x - b.w / 2) > 0.02 && Math.min(a.z + a.d / 2, b.z + b.d / 2) - Math.max(a.z - a.d / 2, b.z - b.d / 2) > 0.02;
/** 저장 형식의 가구(x, z, rotationDeg)를 카탈로그 치수로 바닥 사각형으로 */
const SIZES = { desk: [1.25, 0.6], wardrobe: [1.0, 0.6], sofa: [1.7, 0.96] };
const boxOf = (i) => {
  const [w, d] = SIZES[i.furnitureRef];
  const turned = Math.round(i.rotationDeg / 90) % 2 !== 0;
  return { x: i.x, z: i.z, w: turned ? d : w, d: turned ? w : d };
};

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값·문 넣기
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '원래 가구 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, openings: [DOOR] }).eq('id', roomId);
  check('준비: 방 업로드 완료, 보정 값·문 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status, setupError?.message]);

  // 1) 처음: 원래 가구 도구가 있고 비어 있다
  await openRoom(owner, roomId);
  await owner.getByTestId('fixtures-toggle').click();
  check('도구 줄에 "원래 가구", 처음에는 0개와 안내', (await owner.getByTestId('fixtures').getAttribute('data-count')) === '0' && (await owner.getByTestId('fixtures').innerText()).includes('새 가구를 놓을 때와 AI 추천이 그 자리를 피합니다'), null);

  // 2) 평면도에 그리기: 오른쪽 벽의 침대(1 × 2 m), 방 가운데 식탁, 왼쪽 위 모서리의 상자(치울 가구)
  await owner.getByTestId('fixtures-draw').click();
  await owner.getByTestId('floor-plan').waitFor();
  check('"평면도에 그리기"를 누르면 평면도가 열리고 그리기 상태', (await owner.getByTestId('plan-overlay').count()) === 1 && (await owner.getByTestId('floor-plan').getAttribute('data-drawing')) === 'true', null);
  const sketching = await dragPlan(owner, [2.0, -1.0], [3.0, 1.0], { midCheck: () => owner.getByTestId('plan-fixture-sketch').count() });
  let list = await fixturesOf(owner);
  check(
    '끌어서 그리면 그리는 동안 점선 사각형, 놓으면 원래 가구 1개 (가운데 2.5, 0 · 1 × 2 m · 기본 높이 0.8 m)',
    sketching === 1 && list.length === 1 && list[0].id === 'x1' && near(list[0].x, 2.5) && near(list[0].z, 0) && near(list[0].w, 1) && near(list[0].d, 2) && list[0].h === 0.8 && list[0].rotationDeg === 0 && (await owner.getByTestId('fixtures-message').innerText()).includes('평면도에 그린'),
    list,
  );
  await owner.getByTestId('fixture-label').first().selectOption('침대');
  await owner.getByTestId('fixture-height').first().fill('0.45');
  await dragPlan(owner, [-0.5, -0.4], [0.5, 0.4]);
  await dragPlan(owner, [-3.0, 1.9], [-2.4, 2.5]);
  await dragPlan(owner, [1.0, 1.0], [1.08, 1.05]); // 너무 작으면 넣지 않는다
  await owner.getByTestId('fixture-label').nth(1).selectOption('식탁');
  await owner.getByTestId('fixture-height').nth(1).fill('0.75');
  await owner.getByTestId('fixture-label').nth(2).selectOption('수납장');
  await owner.getByTestId('fixture-remove').nth(2).check();
  list = await fixturesOf(owner);
  check(
    '세 개를 그리고 이름·높이·치울 가구를 고침 (너무 작게 그린 것은 넣지 않음)',
    list.length === 3 && list[0].label === '침대' && list[0].h === 0.45 && list[1].label === '식탁' && list[1].h === 0.75 && near(list[1].x, 0) && list[2].label === '수납장' && list[2].remove === true && list[0].remove === false,
    list.map((f) => [f.id, f.label, f.x, f.z, f.w, f.d, f.h, f.remove]),
  );
  check('평면도에 빗금 사각형 3개 (치울 가구 1개)', (await owner.getByTestId('plan-fixture').count()) === 3 && (await owner.locator('[data-testid=plan-fixture][data-remove=true]').count()) === 1, null);
  check('저장 전: 도구 줄에 "저장 안 됨" 점', (await owner.getByTestId('fixtures-toggle').getAttribute('data-mark')) === 'warn' && (await owner.getByTestId('fixtures-save-state').getAttribute('data-state')) === 'dirty', null);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'fixtures-plan.png') });

  await owner.getByTestId('fixtures-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=fixtures-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  const { data: savedRow } = await admin.from('rooms').select('fixtures').eq('id', roomId).maybeSingle();
  check('저장: DB에 3개 그대로, 도구 줄의 점이 사라짐', sameJson(savedRow?.fixtures, list) && (await owner.getByTestId('fixtures-toggle').getAttribute('data-mark')) === '', savedRow?.fixtures?.length);

  // 3) 가구 도구: 새 가구는 원래 가구를 피하고, 겹치게 끌면 문제로 알린다
  await owner.getByTestId('tool-furniture').click();
  const stopped = await owner
    .waitForFunction(() => document.querySelector('[data-testid=floor-plan]')?.getAttribute('data-drawing') === 'false', null, { timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  check('다른 도구로 가면 그리기가 멈춤', stopped, null);
  await owner.getByTestId('furniture-panel').getByRole('button', { name: '+ 소파 · 화이트', exact: true }).click();
  const [sofa] = await itemsOf(owner);
  const sofaBox = { x: sofa.x, z: sofa.z, w: sofa.w, d: sofa.d };
  check('새 소파는 방 가운데의 원래 식탁을 피해서 놓임 (문제 없음)', !overlaps(sofaBox, list[1]) && !overlaps(sofaBox, list[0]) && (await owner.getByTestId('layout-violations').getAttribute('data-errors')) === '0', [sofa.x, sofa.z]);
  const sofaScreen = await planToScreen(owner, sofa.x, sofa.z);
  const bedScreen = await planToScreen(owner, 2.5, 0);
  await owner.mouse.move(sofaScreen.x, sofaScreen.y);
  await owner.mouse.down();
  await owner.mouse.move(bedScreen.x, bedScreen.y, { steps: 8 });
  await owner.mouse.up();
  await owner.waitForTimeout(300);
  const overlapText = await owner.getByTestId('layout-violations').innerText();
  check('원래 침대 위로 끌면 "소파: 원래 있던 침대와(과) 겹칩니다" (고쳐야 하는 문제)', overlapText.includes('소파: 원래 있던 침대와(과) 겹칩니다') && (await owner.getByTestId('layout-violations').getAttribute('data-errors')) === '1', overlapText);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'fixtures-overlap.png') });
  // 치울 가구로 바꾸면(저장 전에도) 바로 문제가 사라진다
  await owner.getByTestId('fixtures-toggle').click();
  await owner.waitForTimeout(500);
  check('원래 가구 도구로 돌아와도 그리기는 꺼진 채', (await owner.getByTestId('fixtures').getAttribute('data-mode')) === '' && (await owner.getByTestId('floor-plan').getAttribute('data-drawing')) === 'false', null);
  await owner.getByTestId('fixture-remove').first().check();
  check('그 침대를 "치울 가구"로 바꾸면 겹침 문제가 바로 사라짐', (await owner.getByTestId('layout-violations').getAttribute('data-errors')) === '0', await owner.getByTestId('layout-violations').innerText());
  await owner.getByTestId('fixture-remove').first().uncheck();
  check('다시 되돌리면 문제가 다시 나옴', (await owner.getByTestId('layout-violations').getAttribute('data-errors')) === '1', null);

  // 4) 3D: 원래 가구를 상자 테두리로 보여 준다 (개발 서버에서만 그림을 남긴다)
  if (await owner.evaluate(() => Boolean(window.__roomlens))) {
    await owner.getByRole('switch', { name: '평면도로 보기' }).click();
    const boxes = await owner.evaluate(async () => {
      const e = window.__roomlens;
      e.freeCamera = true;
      e.camera.position.set(0, 4.2, 4.6);
      e.controls.target.set(0.5, 0.3, 0);
      e.controls.update();
      await new Promise((r) => setTimeout(r, 1200));
      const group = e.scene.children.find((c) => c.userData?.fixtures);
      return group ? group.children.filter((c) => c.isLineSegments).length : -1;
    });
    check('3D에 원래 가구 3개의 상자 테두리', boxes === 3, boxes);
    await owner.screenshot({ path: path.join(dataDir, '_e2e', 'fixtures-3d.png') });
  }

  // 5) 다시 열면 저장한 그대로 (저장하지 않은 "치울 가구" 바꾸기는 사라짐)
  await openRoom(owner, roomId);
  await owner.getByTestId('fixtures-toggle').click();
  check('다시 열면 저장한 3개 그대로', sameJson(await fixturesOf(owner), list), null);

  // 6) AI 추천: 원래 가구 자리를 피한다
  const suggested = await api(owner, 'POST', `/api/rooms/${roomId}/layout-suggest`, {
    items: [
      { id: 'f1', furnitureRef: 'desk', kind: 'catalog' },
      { id: 'f2', furnitureRef: 'wardrobe', kind: 'catalog' },
      { id: 'f3', furnitureRef: 'sofa', kind: 'catalog' },
    ],
    request: '책상은 오른쪽 벽에 두고 싶어요',
  });
  const aiItems = suggested.json?.layout?.items ?? [];
  const aiBoxes = aiItems.map(boxOf);
  const active = list.filter((f) => !f.remove);
  check(
    'AI 추천: 3개 모두 놓고, 원래 침대·식탁과 겹치지 않음 (치울 가구 자리는 써도 됨)',
    suggested.status === 200 && aiItems.length === 3 && aiBoxes.every((b) => active.every((f) => !overlaps(b, f))),
    { status: suggested.status, items: aiItems, unmet: suggested.json?.unmet, error: suggested.json?.error },
  );

  // 7) 다른 사람: 공개 방이면 원래 가구를 볼 수만 있다
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  await openRoom(visitor, roomId);
  await visitor.getByTestId('fixtures-toggle').click();
  check(
    '다른 사람: 원래 가구 3개가 보이지만 넣기·고치기·저장은 없음',
    (await visitor.getByTestId('fixtures').getAttribute('data-count')) === '3' &&
      (await visitor.getByTestId('fixtures-draw').count()) === 0 &&
      (await visitor.getByTestId('fixture-label').count()) === 0 &&
      (await visitor.getByTestId('fixtures-save').count()) === 0,
    null,
  );
  // 다른 사람의 권한(RLS)으로 직접 고쳐 본다
  const asVisitor = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  await asVisitor.auth.signInWithPassword({ email: emails.visitor, password });
  const sneaky = await asVisitor.from('rooms').update({ fixtures: [] }).eq('id', roomId).select('id');
  const { data: afterSneaky } = await admin.from('rooms').select('fixtures').eq('id', roomId).maybeSingle();
  check('다른 사람이 DB를 직접 고치려 해도 그대로 (3개)', afterSneaky?.fixtures?.length === 3 && (sneaky.data?.length ?? 0) === 0, [sneaky.error?.message, sneaky.data]);

  // 8) DB 제한: 31개 이상이면 거절
  const tooMany = Array.from({ length: 31 }, (_, i) => ({ ...list[1], id: `x${i + 1}` }));
  const { error: limitError } = await admin.from('rooms').update({ fixtures: tooMany }).eq('id', roomId);
  check('DB 제한: 원래 가구 31개는 거절', Boolean(limitError) && /rooms_fixtures_check/.test(limitError.message), limitError?.message);
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

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
