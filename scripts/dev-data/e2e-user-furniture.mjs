// 내 가구 실측: 이름과 치수를 넣어 가구를 만들고, 방에 놓고 저장하고, 지우는 흐름을 본다.
// 보정 값은 secret key로 직접 넣으므로(탭 자동화 없음) 운영 주소에서도 돌릴 수 있다.
// 방을 잠깐 공개로 바꾸므로 CC BY 샘플만 쓴다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-user-furniture.mjs
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
const emails = { owner: `e2e-${stamp}-o@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

// 시험용 방: 4 × 3 m 사각형 (파일 좌표를 그대로 방 좌표로 쓴다)
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];

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
const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
/** 방을 열고 가구 패널이 뜰 때까지 기다린다 */
const openRoom = async (page, roomId) => {
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await page.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
};
const near = (a, b, tolerance = 0.001) => Math.abs(a - b) <= tolerance;

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값 넣기 (방 4 × 3 m)
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '내 가구 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const { data: roomRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const ownerId = roomRow.owner_id;
  check('준비: 방 업로드 완료, 보정 값 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);

  const panel = page.getByTestId('furniture-panel');
  const items = async () => JSON.parse(await panel.getAttribute('data-json'));
  const mineRows = async () => (await admin.from('user_furniture').select('id, name, category, width_m, depth_m, height_m, source, owner_id').eq('owner_id', ownerId).order('created_at')).data ?? [];
  const layoutRows = async () => (await admin.from('layouts').select('items').eq('room_id', roomId)).data ?? [];
  const messageText = async () => ((await page.getByTestId('user-furniture-message').count()) ? page.getByTestId('user-furniture-message').innerText() : null);
  const fillForm = async ({ name, width, depth, height }) => {
    await page.getByTestId('user-furniture-name').fill(name);
    await page.getByTestId('user-furniture-width').fill(width);
    await page.getByTestId('user-furniture-depth').fill(depth);
    await page.getByTestId('user-furniture-height').fill(height);
    await page.getByTestId('user-furniture-create').click();
  };
  const saveLayout = async () => {
    await page.getByTestId('layout-save').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  };

  // 1) 처음: "내 가구" 칸은 있고 목록은 비어 있다
  await openRoom(page, roomId);
  check('처음: "내 가구" 칸과 "직접 만들기" 버튼, 목록은 없음', (await page.getByTestId('user-furniture').isVisible()) && (await page.getByTestId('user-furniture-open').isVisible()) && (await page.getByTestId('user-furniture-list').count()) === 0, null);

  // 2) 잘못된 값은 이유와 함께 거부
  await page.getByTestId('user-furniture-open').click();
  await fillForm({ name: '', width: '80', depth: '40', height: '120' });
  const noName = await messageText();
  await fillForm({ name: '수납장', width: '5', depth: '40', height: '120' });
  const tooSmall = await messageText();
  await fillForm({ name: '수납장', width: '80', depth: '넓게', height: '120' });
  const notNumber = await messageText();
  check('이름 없음·너무 작은 값·숫자가 아닌 값은 거부, DB에 아무것도 없음', noName === '이름을 넣어 주세요.' && tooSmall === '가로는 10~500 cm 사이여야 합니다.' && notNumber === '깊이를 숫자(cm)로 넣어 주세요.' && (await mineRows()).length === 0, [noName, tooSmall, notNumber]);

  // 3) 만들기
  await fillForm({ name: '수납장', width: '80', depth: '40', height: '120' });
  await panel.getByRole('button', { name: '+ 수납장', exact: true }).waitFor({ timeout: 10000 });
  const created = await mineRows();
  check('만들면 "+ 수납장" 버튼이 생기고 폼이 닫힘', (await page.getByTestId('user-furniture-form').count()) === 0 && (await messageText()) === null, null);
  check('DB: 80 × 40 × 120 cm가 m로 저장, 주인은 나, 직접 입력(manual)', created.length === 1 && created[0].name === '수납장' && near(Number(created[0].width_m), 0.8) && near(Number(created[0].depth_m), 0.4) && near(Number(created[0].height_m), 1.2) && created[0].source === 'manual' && created[0].owner_id === ownerId, created.map((r) => [r.name, r.width_m, r.depth_m, r.height_m, r.category]));

  // 4) 방에 놓고 저장
  await panel.getByRole('button', { name: '+ 수납장', exact: true }).click();
  await panel.getByRole('button', { name: '+ 책상', exact: true }).click();
  const placed = await items();
  check("놓은 가구: 수납장은 kind 'user', 넣은 치수 그대로", placed.length === 2 && placed[0].kind === 'user' && placed[0].furnitureRef === created[0].id && placed[0].name === '수납장' && near(placed[0].w, 0.8) && near(placed[0].d, 0.4) && near(placed[0].h, 1.2) && placed[1].kind === 'catalog', placed.map((i) => [i.name, i.kind, i.w, i.d, i.h]));
  check('카탈로그 가구와 겹치지 않는 자리에 놓임', (await page.getByTestId('layout-violations').getAttribute('data-count')) === '0', null);
  await saveLayout();
  const savedItems = (await layoutRows())[0]?.items ?? [];
  check("배치 저장: { kind: 'user', furnitureRef: 내 가구 id }", savedItems.length === 2 && savedItems[0].kind === 'user' && savedItems[0].furnitureRef === created[0].id && !('w' in savedItems[0]), savedItems.map((i) => [i.kind, i.furnitureRef]));

  // 5) 다시 열기
  await page.reload();
  await panel.waitFor({ timeout: 120000 });
  const reopened = await items();
  check('다시 열면: 내 가구가 같은 자리에 같은 치수로, 목록에도 남아 있음', reopened.length === 2 && reopened[0].name === '수납장' && near(reopened[0].x, placed[0].x) && near(reopened[0].z, placed[0].z) && near(reopened[0].h, 1.2) && (await panel.getByRole('button', { name: '+ 수납장', exact: true }).count()) === 1 && (await page.getByTestId('layout-save-state').getAttribute('data-state')) === 'saved', reopened.map((i) => [i.name, i.x, i.z]));
  await page.getByTestId('plan-toggle').click();
  const planNames = await page.getByTestId('floor-plan').locator('text').allTextContents();
  check('평면도에도 내 가구가 이름과 함께 나옴', (await page.getByTestId('plan-item').count()) === 2 && planNames.includes('수납장'), planNames);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'user-furniture.png') });
  await page.getByTestId('plan-toggle').click();

  // 6) 키 큰 내 가구는 창문 가림 경고에도 쓰인다 (높이를 검사에 넘기는지)
  await page.getByTestId('user-furniture-open').click();
  await fillForm({ name: '키 큰 장', width: '390', depth: '290', height: '190' });
  await panel.getByRole('button', { name: '+ 키 큰 장', exact: true }).waitFor({ timeout: 10000 });
  await admin.from('rooms').update({ openings: [{ type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 }] }).eq('id', roomId);
  await admin.from('layouts').update({ items: [{ id: 'f1', furnitureRef: (await mineRows())[1].id, kind: 'user', x: 0, z: 0, rotationDeg: 0 }] }).eq('room_id', roomId);
  await page.reload();
  await panel.waitFor({ timeout: 120000 });
  const warnings = await page.getByTestId('layout-violations').locator('li').allInnerTexts();
  check('방을 거의 채우는 190cm 내 가구: "키 큰 장: 창문을 가립니다"', warnings.join() === '키 큰 장: 창문을 가립니다', warnings);

  // 7) 지우기: 확인 뒤 목록과 방에서 함께 사라진다
  await panel.getByRole('button', { name: '키 큰 장 지우기' }).click();
  const confirmText = await page.getByTestId('user-furniture-confirm').innerText();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  const afterCancel = (await mineRows()).length;
  await panel.getByRole('button', { name: '키 큰 장 지우기' }).click();
  await page.getByTestId('user-furniture-confirm-yes').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=user-furniture-confirm]'), null, { timeout: 10000 });
  const afterDelete = await mineRows();
  check('지우기 전에 확인을 묻고, 취소하면 그대로', confirmText.includes('키 큰 장') && confirmText.includes('방에 놓인 것도 사라집니다') && afterCancel === 2, confirmText.replace(/\s+/g, ' '));
  check('지우면: 목록에서 사라지고 방에 놓였던 것도 치워짐, DB에서도 삭제, 배치는 "저장 안 됨"', afterDelete.length === 1 && afterDelete[0].name === '수납장' && (await panel.getByRole('button', { name: '+ 키 큰 장', exact: true }).count()) === 0 && (await items()).length === 0 && (await page.getByTestId('layout-save-state').getAttribute('data-state')) === 'dirty', afterDelete.map((r) => r.name));

  // 8) 배치에 남아 있는, 이미 지운 내 가구는 건너뛰고 알려준다
  await page.reload();
  await panel.waitFor({ timeout: 120000 });
  check('지운 내 가구가 든 배치를 열면: 0개로 시작, "불러오지 못했습니다" 안내', (await items()).length === 0 && (await page.getByTestId('layout-missing').innerText()).includes('1개'), await page.getByTestId('layout-missing').innerText());

  // 9) 남의 내 가구는 보이지 않는다: 공개 방을 로그인 없이 열면 안내만
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  const guest = await newPage();
  await openRoom(guest, roomId);
  check('비로그인: "내 가구" 칸 대신 로그인 안내, 방 주인의 내 가구 버튼은 없음', (await guest.getByTestId('user-furniture').count()) === 0 && (await guest.getByTestId('user-furniture-login-hint').isVisible()) && (await guest.getByTestId('furniture-panel').getByRole('button', { name: '+ 수납장', exact: true }).count()) === 0, null);
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { data: leaked } = await anon.from('user_furniture').select('id');
  check('로그인 없이 API로 내 가구를 읽으면 0건', (leaked ?? []).length === 0, leaked?.length);
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
  const { count: leftFurniture } = await admin.from('user_furniture').select('id', { count: 'exact', head: true }).in('owner_id', mine.map((u) => u.id));
  check('시험용 계정·방·내 가구·R2 파일 삭제', mine.length === 1 && leftFurniture === 0, `계정 ${mine.length}, 지운 파일 ${removed}, 남은 내 가구 ${leftFurniture}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
