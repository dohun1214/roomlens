// 홈 실측: 내 방 목록(비공개·올리는 중 포함)과 공개 방 목록, 남에게 보이는 범위.
// 시험용 계정·방·R2 파일은 끝나면 지운다 (secret key, R2 키 필요).
// 준비: npm run dev, ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/converted 에 .sog 파일
// 실행: node --env-file=.env.local scripts/dev-data/e2e-home.mjs [장면 이름]
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scene = process.argv[2] ?? '0194_840128';
const scenePath = path.join(dataDir, 'converted', `${scene}.sog`);
const sceneBytes = statSync(scenePath).size;
const email = `e2e-${Date.now()}@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`;
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

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

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const newPage = async () => (await browser.newContext({ viewport: { width: 1000, height: 900 } })).newPage();
const page = await newPage(); // 방 주인
const anon = await newPage(); // 로그인하지 않은 사람

const api = (method, url, body) =>
  page.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, url, body },
  );
/** 홈의 목록에서 그 방 카드를 찾아 { 글자, 표시들 }을 돌려준다. 없으면 null */
const card = async (p, listTestId, roomId) => {
  const el = p.locator(`[data-testid=${listTestId}] [data-testid=room-card][data-room-id="${roomId}"]`);
  if ((await el.count()) === 0) return null;
  return { text: (await el.innerText()).replace(/\s+/g, ' '), badges: await el.getByTestId('room-badge').allInnerTexts() };
};
const home = (p) => p.goto(`${appUrl}/`, { waitUntil: 'domcontentloaded' });

try {
  // 1) 로그인 전 홈
  await home(anon);
  check('비로그인 홈: "내 방" 영역이 없고 공개된 방 영역은 있음', (await anon.getByRole('heading', { name: '내 방' }).count()) === 0 && (await anon.getByRole('heading', { name: '공개된 방' }).count()) === 1, null);

  // 2) 가입 → 방이 없을 때
  await page.goto(`${appUrl}/account`);
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });
  const nickname = (await page.getByTestId('header-nickname').textContent()) ?? '';
  await home(page);
  check('방이 없을 때: 안내 문구', await page.getByTestId('my-rooms-empty').isVisible(), null);

  // 3) 방 두 개: 다 올린 데이터셋 방, 올리다 만 방
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const readyId = (await api('POST', '/api/rooms', { title: '홈 실측 방', description: '목록에 보일 설명', consent: true, source: 'dataset', credit: 'InteriorGS (시험용)' })).json.room.id;
  const signed = await api('POST', '/api/upload-url', { roomId: readyId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api('PATCH', `/api/rooms/${readyId}`, { splatFormat: 'sog' });
  const pendingId = (await api('POST', '/api/rooms', { title: '올리다 만 방', consent: true })).json.room.id;
  check('준비: 방 업로드 완료', putStatus === 200 && done.status === 200, [putStatus, done.status]);

  // 4) 내 방 목록
  await home(page);
  const mineReady = await card(page, 'my-rooms', readyId);
  const minePending = await card(page, 'my-rooms', pendingId);
  check('내 방: 다 올린 방 — 제목·설명·닉네임, 표시 [비공개, 데이터셋]', mineReady?.text.includes('홈 실측 방') && mineReady.text.includes('목록에 보일 설명') && mineReady.text.includes(nickname) && mineReady.badges.join() === '비공개,데이터셋', mineReady);
  check('내 방: 올리다 만 방 — 표시 [비공개, 올리는 중]', minePending?.badges.join() === '비공개,올리는 중', minePending);
  const order = await page.locator('[data-testid=my-rooms] [data-testid=room-card]').evaluateAll((els) => els.map((el) => el.getAttribute('data-room-id')));
  check('내 방: 최근에 만든 방이 먼저', order.indexOf(pendingId) < order.indexOf(readyId), order);

  // 5) 비공개인 동안에는 공개 목록에 없다 (본인에게도, 남에게도)
  check('비공개 방: 본인 홈의 공개 목록에 없음', (await card(page, 'public-rooms', readyId)) === null, null);
  await home(anon);
  check('비공개 방: 남의 홈에 없음', (await card(anon, 'public-rooms', readyId)) === null && (await anon.locator(`[data-room-id="${readyId}"]`).count()) === 0, null);

  // 6) 카드를 누르면 방 화면으로 → 공개
  await page.locator(`[data-testid=my-rooms] [data-room-id="${readyId}"]`).click();
  await page.waitForURL(`**/rooms/${readyId}`, { timeout: 15000 });
  check('카드를 누르면 방 화면으로 이동', (await page.getByTestId('room-title').textContent()) === '홈 실측 방', null);
  await page.getByTestId('room-visibility-toggle').click();
  await page.getByTestId('room-confirm-yes').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=room-visibility]')?.textContent === '공개', null, { timeout: 8000 });

  // 7) 공개 후
  await home(anon);
  const publicCard = await card(anon, 'public-rooms', readyId);
  check('공개 방: 남의 홈 공개 목록에 표시 — 제목·닉네임, 표시 [데이터셋]', publicCard?.text.includes('홈 실측 방') && publicCard.text.includes(nickname) && publicCard.badges.join() === '데이터셋', publicCard);
  check('올리다 만 방은 남에게 보이지 않음', (await anon.locator(`[data-room-id="${pendingId}"]`).count()) === 0, null);
  await anon.locator(`[data-testid=public-rooms] [data-room-id="${readyId}"]`).click();
  await anon.waitForURL(`**/rooms/${readyId}`, { timeout: 15000 });
  check('남이 공개 방 카드를 누르면 방 화면이 열림', (await anon.getByTestId('room-title').textContent()) === '홈 실측 방', null);
  await home(page);
  check('내 방 목록의 표시가 [공개, 데이터셋]으로 바뀜', (await card(page, 'my-rooms', readyId))?.badges.join() === '공개,데이터셋', null);
  check('본인 홈의 공개 목록에도 표시', (await card(page, 'public-rooms', readyId)) !== null, null);

  // 8) 지우면 목록에서 사라진다
  const removed = await page.evaluate(async (id) => (await fetch(`/api/rooms/${id}`, { method: 'DELETE' })).status, readyId);
  await home(anon);
  check('방을 지우면 공개 목록에서 사라짐', removed === 200 && (await card(anon, 'public-rooms', readyId)) === null, removed);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'home-failure.png') }).catch(() => {});
} finally {
  await page.goto(`${appUrl}/`).catch(() => {});
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'home.png'), fullPage: true }).catch(() => {});
  await browser.close();
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => u.email === email) ?? [];
  let removedFiles = 0;
  for (const u of mine) {
    const { data: rooms } = await admin.from('rooms').select('id').eq('owner_id', u.id);
    for (const r of rooms ?? []) {
      const keys = await listKeys(`rooms/${r.id}/`);
      if (keys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
        removedFiles += keys.length;
      }
    }
    await admin.auth.admin.deleteUser(u.id);
  }
  check('시험용 계정 삭제', mine.length === 1, `계정 ${mine.length}, 정리 때 지운 파일 ${removedFiles}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
