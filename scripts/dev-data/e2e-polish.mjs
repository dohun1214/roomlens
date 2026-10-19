// 다듬기 실측: 방 이름·설명 고치기, 찾을 수 없는 화면(404), 저장하지 않고 나갈 때 묻기.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-polish.mjs
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

const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const listKeys = async (prefix) =>
  (await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: prefix }))).Contents?.map((o) => o.Key) ?? [];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const newPage = async (viewport = { width: 1280, height: 800 }) => {
  const context = await browser.newContext({ viewport });
  // R2의 CORS는 정해진 주소만 허락한다. 다른 포트의 개발 서버로 열 때를 위해 허락 머리말을 붙인다
  await context.route(/r2\.cloudflarestorage\.com/, async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS', 'access-control-expose-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
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



/** 창을 닫거나 다른 주소로 갈 때 브라우저가 물을지 (beforeunload를 막는지) */
const wouldAsk = (page) => page.evaluate(() => {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

try {
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '다듬기 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, is_public: true }).eq('id', roomId);
  check('준비: 방 업로드·보정·공개', putStatus === 200 && done.status === 200, [putStatus, done.status]);

  // 1) 방 이름·설명 고치기
  await owner.goto(`${appUrl}/rooms/${roomId}`);
  await owner.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  await owner.getByTestId('room-info-edit').click();
  check('연필을 누르면 지금 이름이 들어 있는 칸', (await owner.getByTestId('room-info-title').inputValue()) === '다듬기 실측 방', null);
  await owner.getByTestId('room-info-title').fill('   ');
  await owner.getByTestId('room-info-save').click();
  check('이름을 비우면 저장하지 않고 안내', (await owner.getByTestId('room-info-error').innerText()).includes('방 이름'), null);
  await owner.getByTestId('room-info-title').fill('  남향 원룸 (고침)  ');
  await owner.getByTestId('room-info-description').fill('창이 큰 방');
  await owner.getByTestId('room-info-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=room-title]')?.textContent === '남향 원룸 (고침)', null, { timeout: 10000 });
  const { data: saved } = await admin.from('rooms').select('title, description').eq('id', roomId).maybeSingle();
  check('저장하면 머리말이 바뀌고 DB에도 (앞뒤 공백 없이)', saved?.title === '남향 원룸 (고침)' && saved?.description === '창이 큰 방' && !(await owner.getByTestId('room-info-form').count()), saved);
  check('문서 제목도 바뀐 이름', (await owner.title()) === '남향 원룸 (고침) | RoomLens', await owner.title());

  // 2) 저장하지 않은 배치가 있으면 나갈 때 묻는다
  check('처음에는 묻지 않음', !(await wouldAsk(owner)), null);
  await owner.getByTestId('furniture-panel').getByRole('button', { name: /^\+ 의자/ }).first().click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'dirty', null, { timeout: 5000 });
  check('가구를 놓고 저장하지 않으면 나갈 때 물음', await wouldAsk(owner), null);
  await owner.getByTestId('layout-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  await owner.waitForTimeout(300);
  check('저장하면 다시 묻지 않음', !(await wouldAsk(owner)), null);

  // 3) 남: 연필 없음, 로그인 안 한 사람이 가구를 놓아도(저장할 수 없음) 묻지 않음
  const anon = await newPage();
  await anon.goto(`${appUrl}/rooms/${roomId}`);
  await anon.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  check('남에게는 이름 고치기 버튼 없음', (await anon.getByTestId('room-info-edit').count()) === 0, null);
  await anon.getByTestId('furniture-panel').getByRole('button', { name: /^\+ 의자/ }).first().click();
  check('비로그인은 저장할 수 없으므로 묻지 않음', !(await wouldAsk(anon)), null);
  const visitorDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const steal = await visitorDb.from('rooms').update({ title: '남이 바꿈' }).eq('id', roomId).select('id');
  check('DB: 비로그인은 방 이름을 못 바꿈', (steal.data?.length ?? 0) === 0, steal.error?.code);

  // 4) 찾을 수 없는 화면
  const res404 = await anon.goto(`${appUrl}/rooms/00000000-0000-4000-8000-000000000000`);
  check('없는 방: 404와 안내 화면, 홈으로 가는 길', res404?.status() === 404 && (await anon.getByTestId('not-found').isVisible()) && (await anon.getByRole('link', { name: '홈으로' }).count()) === 1, res404?.status());
  const resNope = await anon.goto(`${appUrl}/no-such-page`);
  check('없는 주소: 404와 안내 화면', resNope?.status() === 404 && (await anon.getByTestId('not-found').isVisible()), resNope?.status());
  await admin.from('rooms').update({ is_public: false }).eq('id', roomId);
  const resPriv = await anon.goto(`${appUrl}/rooms/${roomId}`);
  check('비공개로 바꾼 방: 남에게는 같은 404 화면', resPriv?.status() === 404 && (await anon.getByTestId('not-found').isVisible()), resPriv?.status());
  await anon.getByRole('link', { name: '홈으로' }).click();
  await anon.waitForURL(`${appUrl}/`);
  check('"홈으로"를 누르면 홈', true, null);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 400));
} finally {
  await browser.close();
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => Object.values(emails).includes(u.email)) ?? [];
  for (const u of mine) {
    const { data: rooms } = await admin.from('rooms').select('id').eq('owner_id', u.id);
    for (const r of rooms ?? []) {
      const keys = await listKeys(`rooms/${r.id}/`);
      if (keys.length) await s3.send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
    }
    await admin.auth.admin.deleteUser(u.id);
  }
  check('시험용 계정·방·R2 파일 삭제', mine.length === 1, `계정 ${mine.length}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
