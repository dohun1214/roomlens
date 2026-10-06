// 배치 저장 실측: 가구를 놓고 저장 → 다시 열면 그대로인지, 공개 방에서 다른 사람·로그인하지 않은 사람은 어떻게 되는지 본다.
// 보정 값은 secret key로 직접 넣으므로(탭 자동화 없음) 운영 주소에서도 돌릴 수 있다.
// 방을 공개로 바꾸므로 CC BY 샘플만 쓴다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-layout-save.mjs
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
const emails = { owner: `e2e-${stamp}-a@${domain}`, visitor: `e2e-${stamp}-b@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

// 시험용 방: 4 × 3 m 사각형 (파일 좌표를 그대로 방 좌표로 쓴다)
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];
const ITEM_KEYS = ['furnitureRef', 'id', 'kind', 'rotationDeg', 'x', 'z'];

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
const panelItems = async (page) => JSON.parse(await page.getByTestId('furniture-panel').getAttribute('data-json'));
const addFurniture = (page, name) => page.getByTestId('furniture-panel').getByRole('button', { name: `+ ${name}`, exact: true }).click();
const saveState = (page) => page.getByTestId('layout-save-state').getAttribute('data-state');
const saveAndWait = async (page) => {
  await page.getByTestId('layout-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
};
const layoutsOf = async (roomId) =>
  (await admin.from('layouts').select('id, owner_id, name, items, is_public, created_by').eq('room_id', roomId).order('created_at')).data ?? [];
const positions = (items) => items.map((i) => [i.id, i.furnitureRef, i.x, i.z, i.rotationDeg]);

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값 넣기
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '배치 저장 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: calibrationError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  check('준비: 방 업로드 완료, 보정 값 넣음', putStatus === 200 && done.status === 200 && !calibrationError, [putStatus, done.status]);

  // 1) 처음: 저장할 것이 없으면 저장 표시도 없다
  await openRoom(owner, roomId);
  check('처음 연 방: 가구 0개, 저장 표시 없음', (await panelItems(owner)).length === 0 && (await owner.getByTestId('layout-save-state').count()) === 0, null);

  // 2) 가구를 놓으면 "저장 안 됨"
  await addFurniture(owner, '책상');
  await addFurniture(owner, '옷장');
  check('가구 2개를 놓으면 "저장 안 됨", DB에는 아직 없음', (await saveState(owner)) === 'dirty' && (await layoutsOf(roomId)).length === 0, null);

  // 3) 저장
  const placed = await panelItems(owner);
  await saveAndWait(owner);
  check('저장 → "배치 저장됨", 저장 버튼 사라짐', (await owner.getByTestId('layout-save').count()) === 0, null);
  const first = await layoutsOf(roomId);
  const row = first[0];
  check('DB: 배치 1개, 주인은 나, 비공개, 사람이 만든 배치', first.length === 1 && row.is_public === false && row.created_by === 'user' && row.name === '내 배치', row && { name: row.name });
  check(
    'DB: 항목은 설계서 형식(id, furnitureRef, kind, x, z, rotationDeg)만 저장',
    row?.items.length === 2 && row.items.every((i) => JSON.stringify(Object.keys(i).sort()) === JSON.stringify(ITEM_KEYS)) && row.items.map((i) => i.furnitureRef).join() === 'desk,wardrobe',
    row?.items,
  );
  check('DB: 화면의 위치와 같음', JSON.stringify(positions(row.items)) === JSON.stringify(positions(placed)), positions(placed));

  // 4) 다시 열기
  await owner.reload();
  await owner.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  const reopened = await panelItems(owner);
  check('다시 열면: 같은 가구가 같은 자리에', JSON.stringify(positions(reopened)) === JSON.stringify(positions(placed)), positions(reopened));
  check('다시 열면: 이름·치수는 카탈로그에서 되살림', reopened[0].name === '책상' && reopened[0].w === 1.2 && reopened[1].name === '옷장' && reopened[1].h === 2, reopened.map((i) => [i.name, i.w, i.d, i.h]));
  check('다시 열면: "배치 저장됨"으로 시작, 문제 없음', (await saveState(owner)) === 'saved' && (await owner.getByTestId('layout-violations').getAttribute('data-count')) === '0', null);
  await owner.waitForTimeout(1500);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'layout-saved.png') });

  // 5) 고치기: 추가했다가 지우면 저장된 것과 같아지고, 추가한 채 저장하면 같은 배치가 바뀐다
  await addFurniture(owner, '의자');
  const dirtyAfterAdd = await saveState(owner);
  await owner.getByTestId('selection-bar').getByRole('button', { name: '삭제', exact: true }).click();
  check('추가했다가 지우면 다시 "배치 저장됨"', dirtyAfterAdd === 'dirty' && (await saveState(owner)) === 'saved', dirtyAfterAdd);
  await addFurniture(owner, '의자');
  check('새 가구 id는 이어서 붙음 (f3)', (await panelItems(owner)).map((i) => i.id).join() === 'f1,f2,f3', null);
  await saveAndWait(owner);
  const second = await layoutsOf(roomId);
  check('다시 저장: 배치는 여전히 1개(같은 id), 항목 3개', second.length === 1 && second[0].id === row.id && second[0].items.length === 3, second.map((l) => l.items.length));

  // 6) 공개 방에서 로그인하지 않은 사람
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  const guest = await newPage();
  await openRoom(guest, roomId);
  check('비로그인: 방 주인의 배치는 보이지 않음 (빈 방에서 시작)', (await panelItems(guest)).length === 0, null);
  await addFurniture(guest, '책장');
  check('비로그인: 가구는 놓을 수 있고, 저장 버튼 대신 로그인 안내', (await panelItems(guest)).length === 1 && (await guest.getByTestId('layout-login-hint').isVisible()) && (await guest.getByTestId('layout-save').count()) === 0, null);
  await guest.context().close();

  // 7) 공개 방에서 다른 사람: 자기 배치를 따로 저장한다
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  await openRoom(visitor, roomId);
  check('다른 사람: 빈 방에서 시작, 보정 도구는 없음', (await panelItems(visitor)).length === 0 && (await visitor.getByTestId('calibration-save-state').count()) === 0, null);
  await addFurniture(visitor, '싱글 침대');
  await saveAndWait(visitor);
  const third = await layoutsOf(roomId);
  const ownerRow = third.find((l) => l.id === row.id);
  const visitorRow = third.find((l) => l.id !== row.id);
  check('다른 사람이 저장: 배치 2개(주인 다름), 방 주인의 배치는 그대로', third.length === 2 && visitorRow?.owner_id !== ownerRow?.owner_id && ownerRow?.items.length === 3 && visitorRow?.items.length === 1 && visitorRow.items[0].furnitureRef === 'bed-single', third.map((l) => l.items.length));
  await visitor.reload();
  await visitor.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  const visitorItems = await panelItems(visitor);
  check('다른 사람이 다시 열면: 자기 배치(침대 1개)만 보임', visitorItems.length === 1 && visitorItems[0].name === '싱글 침대' && (await saveState(visitor)) === 'saved', visitorItems.map((i) => i.name));

  // 8) 공개 방이라도 비공개 배치는 로그인 없이 읽을 수 없다 (RLS)
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { data: leaked, error: anonError } = await anon.from('layouts').select('id').eq('room_id', roomId);
  check('로그인 없이 API로 이 방의 배치를 읽으면 0건', !anonError && leaked.length === 0, leaked?.length);
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
  const { count } = await admin.from('layouts').select('id', { count: 'exact', head: true }).in('owner_id', mine.map((u) => u.id));
  check('시험용 계정·방·배치·R2 파일 삭제', mine.length === 2 && count === 0, `계정 ${mine.length}, 지운 파일 ${removed}, 남은 배치 ${count}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
