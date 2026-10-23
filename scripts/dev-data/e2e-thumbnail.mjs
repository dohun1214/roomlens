// 방 대표 사진 실측: 방 주인이 방을 처음 열면 첫 화면이 대표 사진이 되고, "대표 사진"으로 바꿀 수 있다.
// 홈 카드·미리보기(og:image)에 쓰이고, 사진 주소는 방을 볼 수 있는 사람에게만 열린다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-thumbnail.mjs
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


const listThumbs = async (roomId) => (await listKeys(`rooms/${roomId}/`)).filter((k) => k.includes('thumbnail-'));
const thumbKey = async (roomId) => (await admin.from('rooms').select('thumbnail_key').eq('id', roomId).maybeSingle()).data?.thumbnail_key ?? null;
/** 같은 문맥(로그인 상태)으로 주소를 요청한다 (넘겨주기는 따라가지 않음) */
const head = (page, url) => page.evaluate(async (url) => {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, type: res.type };
}, url);
const putThumb = (page, roomId, bytes, type = 'image/jpeg') => page.evaluate(async ({ roomId, bytes, type }) => {
  const res = await fetch(`/api/rooms/${roomId}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': type }, body: new Uint8Array(bytes) });
  return { status: res.status, json: await res.json().catch(() => null) };
}, { roomId, bytes, type });

try {
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '대표 사진 실측 방', description: '창가가 밝은 원룸', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  check('준비: 방 업로드 완료, 대표 사진 없음', putStatus === 200 && done.status === 200 && (await thumbKey(roomId)) === null, [putStatus, done.status]);

  // 1) 처음 열면 저절로 대표 사진이 생긴다
  await owner.goto(`${appUrl}/rooms/${roomId}`);
  await owner.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  let key = null;
  for (let i = 0; i < 40 && !key; i += 1) {
    await owner.waitForTimeout(500);
    key = await thumbKey(roomId);
  }
  check('주인이 처음 열면 몇 초 안에 대표 사진이 저절로 생김', key && /^rooms\/.+\/thumbnail-\d+\.jpg$/.test(key) && (await listThumbs(roomId)).length === 1, key);
  await owner.waitForFunction(() => document.querySelector('[data-testid=thumbnail-capture]')?.getAttribute('data-has') === 'true', null, { timeout: 10000 }).catch(() => undefined);
  check('"대표 사진" 버튼이 있고 사진이 있다고 표시', (await owner.getByTestId('thumbnail-capture').getAttribute('data-has')) === 'true', null);

  // 2) 홈의 내 방 카드에 사진, 크기 960×600
  await owner.goto(`${appUrl}/`);
  const img = owner.locator(`[data-room-id="${roomId}"] [data-testid=room-thumbnail]`);
  await img.waitFor({ timeout: 15000 });
  await owner.waitForFunction((id) => {
    const el = document.querySelector(`[data-room-id="${id}"] [data-testid=room-thumbnail]`);
    return el && el.complete && el.naturalWidth > 0;
  }, roomId, { timeout: 15000 });
  const natural = await img.evaluate((el) => [el.naturalWidth, el.naturalHeight]);
  check('홈 카드에 대표 사진 (960×600)', natural[0] === 960 && natural[1] === 600, natural);
  await owner.locator(`[data-room-id="${roomId}"]`).screenshot({ path: path.join(dataDir, '_e2e', 'thumbnail-card.png') });

  // 3) 비공개 방의 사진은 남이 못 본다
  const anon = await newPage();
  await anon.goto(`${appUrl}/`);
  check('비공개 방: 비로그인은 사진 주소 404', (await head(anon, `/rooms/${roomId}/thumbnail`)).status === 404, null);
  check('비공개 방: 주인은 사진 주소가 넘겨주기(302)', (await head(owner, `/rooms/${roomId}/thumbnail`)).type === 'opaqueredirect', null);
  const anonHtml = await (await fetch(`${appUrl}/rooms/${roomId}`)).text();
  check('비공개 방: 미리보기에 방 이름이 드러나지 않음', !anonHtml.includes('대표 사진 실측 방'), null);

  // 4) "대표 사진" 버튼으로 바꾸면 새 사진, 예전 사진은 지워짐
  await owner.goto(`${appUrl}/rooms/${roomId}`);
  await owner.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  await owner.waitForTimeout(2500);
  await owner.getByTestId('thumbnail-capture').click();
  await owner.getByTestId('thumbnail-message').waitFor({ timeout: 20000 });
  const msg = await owner.getByTestId('thumbnail-message').innerText();
  const key2 = await thumbKey(roomId);
  const objects = await listThumbs(roomId);
  check('"대표 사진"을 누르면 새 사진으로 바뀌고 예전 것은 지워짐', msg.includes('대표 사진으로 정했습니다') && key2 && key2 !== key && objects.length === 1 && objects[0] === key2, { msg, objects });
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'thumbnail-owner.png') });

  // 5) API 권한·형식
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  const fake = Array.from({ length: 20000 }, (_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : i % 251));
  check('API: 비로그인 401', (await putThumb(anon, roomId, fake)).status === 401, null);
  check('API: 남의 방 404', (await putThumb(visitor, roomId, fake)).status === 404, null);
  const png = [0x89, 0x50, 0x4e, 0x47, ...Array(20000).fill(1)];
  check('API: JPEG가 아니면 400', (await putThumb(owner, roomId, png)).status === 400, null);
  check('API: 너무 작으면 400', (await putThumb(owner, roomId, [0xff, 0xd8, 0xff, 1, 2, 3])).status === 400, null);
  check('API: 다른 형식 머리말이면 400', (await putThumb(owner, roomId, fake, 'image/png')).status === 400, null);
  check('API 거부 뒤에도 사진은 그대로', (await thumbKey(roomId)) === key2, null);

  // 6) 공개하면 남도 보고, 미리보기(og:image)에 쓰인다
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  check('공개 방: 비로그인도 사진 주소가 넘겨주기(302)', (await head(anon, `/rooms/${roomId}/thumbnail`)).type === 'opaqueredirect', null);
  const html = await (await fetch(`${appUrl}/rooms/${roomId}`)).text();
  const og = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? '';
  const ogTitle = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] ?? '';
  check('공개 방: og:title·og:image(대표 사진 주소)', ogTitle === '대표 사진 실측 방' && og.endsWith(`/rooms/${roomId}/thumbnail?v=${key2.match(/thumbnail-(\d+)/)[1]}`), [ogTitle, og]);
  check('공개 방: 문서 제목 "방 이름 | RoomLens"', html.includes('<title>대표 사진 실측 방 | RoomLens</title>'), null);
  const imgRes = await fetch(`${appUrl}/rooms/${roomId}/thumbnail`);
  check('공개 방: 사진 주소를 따라가면 JPEG', imgRes.ok && (imgRes.headers.get('content-type') ?? '').includes('jpeg'), imgRes.status);
  await anon.goto(`${appUrl}/`);
  check('홈 공개 방 목록에 사진', (await anon.locator(`[data-testid=public-rooms] [data-room-id="${roomId}"] [data-testid=room-thumbnail]`).count()) === 1, null);
  // 남이 열면 사진을 만들지 않는다 (버튼도 없음)
  await anon.goto(`${appUrl}/rooms/${roomId}`);
  await anon.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  await anon.waitForTimeout(5000);
  check('남이 열면 대표 사진 버튼이 없고 사진도 그대로', (await anon.getByTestId('thumbnail-capture').count()) === 0 && (await thumbKey(roomId)) === key2, null);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 400));
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
  check('시험용 계정·방·R2 파일(3D·사진) 삭제', mine.length === 2 && removed === 2, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
