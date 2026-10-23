// 계정 삭제 실측: 내 정보에서 확인 글을 적어야 지워지고, 내 방·R2 파일·배치·코멘트·내 가구가 함께 지워지는지.
// 남의 방과 남의 것은 그대로인지도 본다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-account-delete.mjs
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





try {
  // 남(방 주인): 공개 방 하나
  const other = await newPage();
  await signUp(other, emails.owner);
  await other.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const upload = async (page, title) => {
    const roomId = (await api(page, 'POST', '/api/rooms', { title, consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
    const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
    await page.evaluate(async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status, { url: signed.json.url, headers: signed.json.headers });
    await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
    await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
    return roomId;
  };
  const otherRoom = await upload(other, '남의 공개 방');
  await admin.from('rooms').update({ is_public: true }).eq('id', otherRoom);

  // 지울 사람: 방 하나, 남의 방에 배치·코멘트, 내 가구
  const me = await newPage();
  await signUp(me, emails.visitor);
  await me.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const myRoom = await upload(me, '지울 내 방');
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const myId = users.users.find((u) => u.email === emails.visitor).id;
  await admin.from('layouts').insert({ room_id: otherRoom, owner_id: myId, items: [] });
  await admin.from('comments').insert({ room_id: otherRoom, author_id: myId, body: '지워질 코멘트' });
  await admin.from('user_furniture').insert({ owner_id: myId, name: '내 책장', width_m: 1, depth_m: 0.3, height_m: 1.8 });
  const { data: otherComment } = await admin.from('comments').insert({ room_id: otherRoom, author_id: users.users.find((u) => u.email === emails.owner).id, body: '남는 코멘트' }).select('id').maybeSingle();
  check('준비: 내 방(파일 있음)·남의 방에 내 배치·코멘트·내 가구', (await listKeys(`rooms/${myRoom}/`)).length >= 1, null);

  // 1) API 권한·확인 글
  const anon = await newPage();
  await anon.goto(`${appUrl}/`);
  const del = (page, confirm) =>
    page.evaluate(async (confirm) => {
      const res = await fetch('/api/account', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) });
      return res.status;
    }, confirm);
  check('API: 비로그인 401', (await del(anon, '계정 삭제')) === 401, null);
  check('API: 확인 글이 틀리면 400 (계정 그대로)', (await del(me, '계정삭제')) === 400 && (await admin.auth.admin.getUserById(myId)).data.user !== null, null);

  // 2) 화면: 열고, 틀린 글이면 못 누르고, 취소하면 닫힘
  await me.goto(`${appUrl}/account`);
  const section = me.getByTestId('account-delete');
  check('내 정보 아래에 계정 삭제 (내 방 수 안내)', (await section.isVisible()) && (await section.innerText()).includes('내 방 1개'), null);
  await me.getByTestId('account-delete-open').click();
  await me.getByTestId('account-delete-input').fill('삭제');
  check('확인 글이 틀리면 버튼을 못 누름', await me.getByTestId('account-delete-yes').isDisabled(), null);
  await me.getByRole('button', { name: '취소' }).click();
  check('취소하면 닫힘', (await me.getByTestId('account-delete-input').count()) === 0, null);

  // 3) 지우기
  await me.getByTestId('account-delete-open').click();
  await me.getByTestId('account-delete-input').fill('계정 삭제');
  await me.getByTestId('account-delete-yes').click();
  await me.waitForURL(`${appUrl}/`, { timeout: 30000 });
  await me.waitForTimeout(1000);
  check('지우면 홈으로, 로그아웃 상태', (await me.getByRole('link', { name: '로그인' }).count()) >= 1, null);
  const gone = (await admin.auth.admin.getUserById(myId)).data.user;
  const counts = await Promise.all([
    admin.from('rooms').select('id', { count: 'exact', head: true }).eq('owner_id', myId),
    admin.from('layouts').select('id', { count: 'exact', head: true }).eq('owner_id', myId),
    admin.from('comments').select('id', { count: 'exact', head: true }).eq('author_id', myId),
    admin.from('user_furniture').select('id', { count: 'exact', head: true }).eq('owner_id', myId),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('id', myId),
  ]);
  check('계정·방·배치·코멘트·내 가구·프로필 모두 없음', !gone && counts.every((c) => c.count === 0), counts.map((c) => c.count));
  check('내 방의 R2 파일도 없음', (await listKeys(`rooms/${myRoom}/`)).length === 0, null);
  const { count: otherRooms } = await admin.from('rooms').select('id', { count: 'exact', head: true }).eq('id', otherRoom);
  const { data: kept } = await admin.from('comments').select('id').eq('id', otherComment.id).maybeSingle();
  check('남의 방과 남의 코멘트는 그대로', otherRooms === 1 && kept !== null && (await listKeys(`rooms/${otherRoom}/`)).length >= 1, null);
  // 지운 계정으로 다시 로그인할 수 없다
  await me.goto(`${appUrl}/login`);
  await me.getByLabel('이메일').fill(emails.visitor);
  await me.getByLabel(/비밀번호/).fill(password);
  await me.getByRole('button', { name: '로그인', exact: true }).last().click();
  await me.waitForTimeout(2500);
  check('지운 계정으로는 로그인 안 됨', me.url().includes('/login'), me.url());
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
  check('정리: 남은 시험 계정은 1개(남)만', mine.length === 1, `계정 ${mine.length}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
