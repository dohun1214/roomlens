// 배치 공유 실측: 방 주인이 배치를 "링크로 공개"하고, 다른 사용자·비로그인이 그 링크로 배치를 보고 내 배치로 저장한다.
// 공개 여부와 남의 가구 읽기 권한은 RLS가 정하므로 화면과 함께 Supabase에 직접 요청해서도 확인한다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-layout-share.mjs
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
const publicClient = () => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
const asUser = async (email) => {
  const client = publicClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`로그인 실패: ${error.message}`);
  return client;
};
const anonDb = publicClient();
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
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appUrl });
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
/** 방(또는 공유 링크)을 열고 가구 패널이 뜰 때까지 기다린다. 응답 코드를 돌려준다 */
const open = async (page, url) => {
  const res = await page.goto(url);
  if (res?.status() !== 200) return res?.status() ?? 0;
  await page.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  return 200;
};
const placed = async (page) => JSON.parse((await page.getByTestId('furniture-panel').getAttribute('data-json')) ?? '[]');
const visible = async (page, testId) => (await page.getByTestId(testId).count()) > 0 && (await page.getByTestId(testId).first().isVisible());

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값 넣기 (아직 비공개)
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '배치 공유 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const { data: room } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const ownerId = room.owner_id;
  const { data: nick } = await admin.from('profiles').select('nickname').eq('id', ownerId).maybeSingle();
  // 방 주인의 "내 가구" 하나와, 그것과 카탈로그 책상을 놓은 배치
  const { data: shelf } = await admin.from('user_furniture').insert({ owner_id: ownerId, name: '긴 책장', width_m: 1.2, depth_m: 0.35, height_m: 1.9 }).select('id').maybeSingle();
  const { data: unused } = await admin.from('user_furniture').insert({ owner_id: ownerId, name: '안 쓴 가구', width_m: 0.5, depth_m: 0.5, height_m: 0.5 }).select('id').maybeSingle();
  const ITEMS = [
    { id: 'f1', furnitureRef: 'desk', kind: 'catalog', x: 0.3, z: -1.1, rotationDeg: 0 },
    { id: 'f2', furnitureRef: shelf.id, kind: 'user', x: 1.2, z: 1.3, rotationDeg: 180 },
  ];
  const { data: layout } = await admin.from('layouts').insert({ room_id: roomId, owner_id: ownerId, name: '책상 배치', items: ITEMS }).select('id').maybeSingle();
  const link = `${appUrl}/rooms/${roomId}?layout=${layout.id}`;
  check('준비: 방·내 가구·배치', putStatus === 200 && done.status === 200 && shelf && layout, [putStatus, done.status]);

  // 1) 방 주인: 공유 칸에서 링크로 공개 (방은 아직 비공개)
  await open(owner, `${appUrl}/rooms/${roomId}`);
  check('주인: 저장된 배치에 "공유" 버튼, 처음에는 닫혀 있고 비공개', (await visible(owner, 'layout-share')) && !(await visible(owner, 'layout-share-box')) && (await owner.getByTestId('layout-share').getAttribute('data-public')) === 'false', null);
  check('비공개 방에는 "링크 복사"(방) 버튼 없음', (await owner.getByTestId('room-share').count()) === 0, null);
  await owner.getByTestId('layout-share').click();
  check('공유 칸을 열면 아직 링크 없음', (await visible(owner, 'layout-share-box')) && !(await visible(owner, 'layout-share-url')), null);
  await owner.getByTestId('layout-share-public').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=layout-share-box]')?.getAttribute('data-public') === 'true', null, { timeout: 8000 });
  const { data: afterOn } = await admin.from('layouts').select('is_public').eq('id', layout.id).maybeSingle();
  const shownUrl = await owner.getByTestId('layout-share-url').inputValue();
  check('켜면 DB에서도 공개, 링크는 ?layout=배치', afterOn?.is_public === true && shownUrl === link, shownUrl);
  check('방이 비공개라는 안내', await visible(owner, 'layout-share-room-private'), null);
  await owner.getByTestId('layout-share-copy').click();
  await owner.getByTestId('layout-share-message').waitFor({ timeout: 5000 });
  const clip = await owner.evaluate(() => navigator.clipboard.readText());
  check('"링크 복사"는 클립보드에 링크를 넣음', clip === link && (await owner.getByTestId('layout-share-message').innerText()).includes('복사했습니다'), clip);
  await owner.waitForTimeout(800);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'layout-share-owner.png') });

  // 2) 방이 비공개면 링크가 있어도 남은 못 본다
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  check('비공개 방: 다른 사용자는 공유 링크도 404', (await open(visitor, link)) === 404, null);
  const anonLayoutPriv = await anonDb.from('layouts').select('id').eq('id', layout.id);
  const anonShelfPriv = await anonDb.from('user_furniture').select('id').eq('id', shelf.id);
  check('비공개 방: 비로그인은 배치·가구를 DB에서도 못 읽음', anonLayoutPriv.data?.length === 0 && anonShelfPriv.data?.length === 0, [anonLayoutPriv.data?.length, anonShelfPriv.data?.length]);

  // 3) 방을 공개하면 방 링크 복사 버튼이 생기고, 안내가 사라진다
  await owner.getByTestId('room-visibility-toggle').click();
  await owner.getByTestId('room-confirm-yes').click();
  await owner.getByTestId('room-share').waitFor({ timeout: 8000 });
  check('방을 공개하면 비공개 안내가 사라짐', !(await visible(owner, 'layout-share-room-private')), null);
  await owner.getByTestId('room-share').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=room-share]')?.getAttribute('data-state') === 'copied', null, { timeout: 5000 });
  check('방 "링크 복사"는 방 주소를 복사', (await owner.evaluate(() => navigator.clipboard.readText())) === `${appUrl}/rooms/${roomId}`, null);

  // 4) 비로그인: 링크로 배치를 본다 (남의 가구 치수까지)
  const anon = await newPage();
  check('공개 방: 비로그인이 공유 링크를 엶', (await open(anon, link)) === 200, null);
  const anonItems = await placed(anon);
  const anonShelf = anonItems.find((i) => i.furnitureRef === shelf.id);
  check('비로그인: 책상과 주인의 "긴 책장"(120×35)이 놓임', anonItems.length === 2 && anonShelf && anonShelf.w === 1.2 && anonShelf.d === 0.35 && anonShelf.name === '긴 책장', anonItems.map((i) => [i.furnitureRef, i.w, i.d]));
  const card = await anon.getByTestId('shared-layout-card').innerText();
  check('비로그인: "OO님이 공유한 배치" 카드, 로그인 안내', card.includes(`${nick.nickname}님이 공유한 배치`) && card.includes('책상 배치') && card.includes('로그인하면'), card.replace(/\s+/g, ' '));
  check('비로그인: 저장 버튼·공유 버튼 없음', !(await visible(anon, 'layout-save')) && !(await visible(anon, 'layout-share')), null);
  const loginHref = await anon.getByRole('link', { name: '로그인', exact: true }).first().getAttribute('href');
  check('머리말 로그인은 공유 링크로 돌아옴', loginHref === `/login?next=${encodeURIComponent(`/rooms/${roomId}?layout=${layout.id}`)}`, loginHref);
  const anonShelfPub = await anonDb.from('user_furniture').select('id, name, width_m').in('id', [shelf.id, unused.id]);
  const anonModelKey = await anonDb.from('user_furniture').select('model_key').eq('id', shelf.id);
  check('DB: 비로그인은 공개 배치에 쓰인 가구만 읽음 (안 쓴 가구 X)', anonShelfPub.data?.length === 1 && anonShelfPub.data[0].id === shelf.id, anonShelfPub.data);
  check('DB: 비로그인은 가구의 model_key 열을 못 읽음', Boolean(anonModelKey.error), anonModelKey.error?.code);

  // 5) 다른 사용자: 링크로 보고, 둘러본 것만으로는 저장되지 않으며, "내 배치로 저장"하면 내 배치가 된다
  await open(visitor, link);
  check('다른 사용자: 공유 카드, "내 배치로 저장" 버튼, 저장 안 됨 표시', (await visible(visitor, 'shared-layout-card')) && (await visitor.getByTestId('layout-save').innerText()).includes('내 배치로 저장') && (await visitor.getByTestId('layout-save-state').getAttribute('data-state')) === 'dirty', null);
  check('다른 사용자: 남의 배치에는 공유 버튼 없음', !(await visible(visitor, 'layout-share')), null);
  const visitorDb = await asUser(emails.visitor);
  const steal = await visitorDb.from('layouts').update({ is_public: false }).eq('id', layout.id).select('id');
  check('DB: 다른 사용자는 주인 배치의 공개 여부를 못 바꿈', (steal.data?.length ?? 0) === 0, steal.error?.code);
  await visitor.getByTestId('layout-save').click();
  await visitor.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved' || document.querySelector('[data-testid=layout-chooser]'), null, { timeout: 15000 });
  await visitor.getByTestId('layout-chooser').waitFor({ timeout: 15000 });
  const { data: copies } = await admin.from('layouts').select('id, name, items, owner_id, is_public').eq('room_id', roomId).neq('owner_id', ownerId);
  const copy = copies?.[0];
  const { data: myShelf } = copy ? await admin.from('user_furniture').select('id, owner_id, name, width_m, depth_m, height_m').eq('owner_id', copy.owner_id) : { data: [] };
  const copyShelfRef = copy?.items.find((i) => i.kind === 'user')?.furnitureRef;
  check(
    '저장하면 "OO님의 배치"로 내 배치가 생기고 비공개',
    copies?.length === 1 && copy.name === `${nick.nickname}님의 배치` && copy.is_public === false && copy.items.length === 2,
    copies?.map((c) => [c.name, c.items.length, c.is_public]),
  );
  check(
    '남의 가구는 내 가구 사본(같은 치수)으로 바뀌어 저장',
    myShelf?.length === 1 && myShelf[0].name === '긴 책장' && Number(myShelf[0].width_m) === 1.2 && copyShelfRef === myShelf[0].id && copyShelfRef !== shelf.id,
    [myShelf, copyShelfRef],
  );
  check('저장 뒤에는 공유 카드가 사라지고 내 배치를 고름', !(await visible(visitor, 'shared-layout-card')) && (await visitor.getByTestId('layout-chooser').getAttribute('data-current')) === copy?.id, null);
  const visitorItems = await placed(visitor);
  check('저장 뒤 화면의 가구도 내 사본을 가리킴', visitorItems.length === 2 && visitorItems.some((i) => i.furnitureRef === copyShelfRef), visitorItems.map((i) => i.furnitureRef));
  // 내 가구 목록에 사본이 보인다
  check('내 가구 목록에 "긴 책장" 사본', (await visitor.getByTestId('furniture-panel').innerText()).includes('긴 책장'), null);

  // 6) 주인이 자기 링크를 열면 그 배치로 시작하고 카드는 없다
  await open(owner, link);
  check('주인: 내 공유 링크는 내 배치로 열림 (카드 없음)', !(await visible(owner, 'shared-layout-card')) && (await owner.getByTestId('layout-chooser').getAttribute('data-current')) === layout.id, null);

  // 7) 주인이 링크 공개를 끄면 링크로 볼 수 없다
  await owner.getByTestId('layout-share').click();
  await owner.getByTestId('layout-share-public').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=layout-share-box]')?.getAttribute('data-public') === 'false', null, { timeout: 8000 });
  check('끄면 링크 칸이 사라짐', !(await visible(owner, 'layout-share-url')), null);
  await open(anon, link);
  check('끈 뒤 비로그인이 링크를 열면 "볼 수 없습니다" 안내, 가구 없음', (await visible(anon, 'shared-layout-missing')) && (await placed(anon)).length === 0, null);
  const anonShelfOff = await anonDb.from('user_furniture').select('id').eq('id', shelf.id);
  check('DB: 끈 뒤에는 가구도 못 읽음', anonShelfOff.data?.length === 0, anonShelfOff.data?.length);

  // 8) 잘못된 배치 값은 무시
  await open(anon, `${appUrl}/rooms/${roomId}?layout=abc`);
  check('잘못된 ?layout= 값은 무시 (안내 없음)', !(await visible(anon, 'shared-layout-missing')) && !(await visible(anon, 'shared-layout-card')), null);

  // 9) 폰: 공유 칸이 화면 안에 들어간다
  const phone = await newPage({ width: 390, height: 844 });
  await phone.context().addCookies(await owner.context().cookies());
  await open(phone, `${appUrl}/rooms/${roomId}`);
  await phone.getByTestId('layout-share').click();
  const box = await phone.getByTestId('layout-share-box').boundingBox();
  check('폰: 공유 칸이 화면 너비 안', box && box.x >= 0 && box.x + box.width <= 390, box);
  await phone.waitForTimeout(800);
  await phone.screenshot({ path: path.join(dataDir, '_e2e', 'layout-share-phone.png') });
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
  check('시험용 계정·방·R2 파일 삭제', mine.length === 2, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
