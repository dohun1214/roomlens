// 보정을 다시 했을 때 실측: 저장하면 문·창문·원래 가구와 이 방의 모든 배치(다른 사람 것 포함)가 새 방 좌표로 옮겨져
// 3D 안의 같은 자리에 남는지. 보정 값은 API로 바로 보낸다 (화면에서 찍는 것은 e2e-calibration-save가 본다).
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-recalibrate.mjs
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




const near = (a, b, eps = 0.002) => Math.abs(a - b) <= eps;
const S = Math.SQRT1_2;
// 새 보정: 원본을 위(+Y)축으로 90° 더 돌리고 옮김 → 예전 방의 (x, z)는 새 방의 (z + 0.5, -x - 0.25), 방향은 +90°
const mapPoint = ([x, z]) => [z + 0.5, -x - 0.25];
const NEW_TRANSFORM = { s: 1, q: [0, S, 0, S], t: [0.5, 0, -0.25], flipX: false };
const NEW_FLOOR = FLOOR.map(mapPoint);
const putCalibration = (page, roomId, body) =>
  page.evaluate(
    async ({ roomId, body }) => {
      const res = await fetch(`/api/rooms/${roomId}/calibration`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { roomId, body },
  );

try {
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '다시 보정 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const DOOR = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
  const SOFA = { id: 'x1', label: '소파', x: -1, z: 1, w: 1.8, d: 0.8, h: 0.8, rotationDeg: 0, remove: false };
  await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, openings: [DOOR], fixtures: [SOFA], is_public: true }).eq('id', roomId);
  const { data: row } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const visitorId = users.users.find((u) => u.email === emails.visitor).id;
  const DESK = { id: 'f1', furnitureRef: 'desk', kind: 'catalog', x: 0.3, z: -1.1, rotationDeg: 0 };
  const BED = { id: 'f1', furnitureRef: 'bed-single', kind: 'catalog', x: 1.5, z: 0.4, rotationDeg: 90 };
  const { data: mine } = await admin.from('layouts').insert({ room_id: roomId, owner_id: row.owner_id, items: [DESK] }).select('id').maybeSingle();
  const { data: theirs } = await admin.from('layouts').insert({ room_id: roomId, owner_id: visitorId, items: [BED] }).select('id').maybeSingle();
  check('준비: 보정·문·원래 가구·내 배치·남의 배치', putStatus === 200 && done.status === 200 && mine && theirs, [putStatus, done.status]);

  // 1) 권한
  const anon = await newPage();
  await anon.goto(`${appUrl}/`);
  check('API: 비로그인 401', (await putCalibration(anon, roomId, { transform: NEW_TRANSFORM, floorPolygon: NEW_FLOOR })).status === 401, null);
  check('API: 남의 방 404 (공개 방이어도)', (await putCalibration(visitor, roomId, { transform: NEW_TRANSFORM, floorPolygon: NEW_FLOOR })).status === 404, null);
  check('API: 잘못된 값 400', (await putCalibration(owner, roomId, { transform: { ...NEW_TRANSFORM, q: [0, 0, 0, 0] }, floorPolygon: NEW_FLOOR })).status === 400, null);
  check('API: 평면도가 없으면 400', (await putCalibration(owner, roomId, { transform: NEW_TRANSFORM })).status === 400, null);

  // 2) 같은 보정을 다시 저장하면 아무것도 옮기지 않는다
  const same = await putCalibration(owner, roomId, { transform: TRANSFORM, floorPolygon: FLOOR });
  check('같은 보정이면 배치를 옮기지 않음', same.status === 200 && same.json.movedLayouts === 0 && same.json.openings.length === 1, same.json);

  // 3) 새 보정: 모두 3D 안의 같은 자리로
  const res = await putCalibration(owner, roomId, { transform: NEW_TRANSFORM, floorPolygon: NEW_FLOOR });
  const { data: after } = await admin.from('rooms').select('transform, floor_polygon, openings, fixtures').eq('id', roomId).maybeSingle();
  const { data: layouts } = await admin.from('layouts').select('id, items').eq('room_id', roomId);
  const byId = Object.fromEntries(layouts.map((l) => [l.id, l.items[0]]));
  const [dx, dz] = mapPoint([DESK.x, DESK.z]);
  const [bx, bz] = mapPoint([BED.x, BED.z]);
  check('저장: 보정 값과 평면도가 바뀜, 배치 2개를 옮김', res.status === 200 && res.json.movedLayouts === 2 && after.transform.q[1] > 0.7 && JSON.stringify(after.floor_polygon) === JSON.stringify(NEW_FLOOR), res.json?.movedLayouts);
  check('내 배치: 책상이 같은 자리로 (방향 +90°)', near(byId[mine.id].x, dx) && near(byId[mine.id].z, dz) && byId[mine.id].rotationDeg === 90, byId[mine.id]);
  check('다른 사람 배치도: 침대가 같은 자리로 (90° → 180°)', near(byId[theirs.id].x, bx) && near(byId[theirs.id].z, bz) && byId[theirs.id].rotationDeg === 180, byId[theirs.id]);
  check('응답에는 내 배치만', res.json.layouts.length === 1 && res.json.layouts[0].id === mine.id, res.json.layouts.map((l) => l.id));
  const [sx, sz] = mapPoint([SOFA.x, SOFA.z]);
  const sofa = after.fixtures[0];
  check('원래 가구도 같은 자리로 (크기 그대로, 방향 +90°)', after.fixtures.length === 1 && near(sofa.x, sx) && near(sofa.z, sz) && sofa.w === 1.8 && near(sofa.rotationDeg, 90, 0.01), sofa);
  check('문은 같은 벽의 같은 구간에 남음', after.openings.length === 1 && ['type', 'wallIndex', 'from', 'to', 'widthM'].every((k) => after.openings[0][k] === DOOR[k]), after.openings);

  // 4) 방을 다시 열면 옮긴 배치로
  await owner.goto(`${appUrl}/rooms/${roomId}`);
  await owner.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  const shown = JSON.parse(await owner.getByTestId('furniture-panel').getAttribute('data-json'));
  check('다시 열면 책상이 옮긴 자리에', shown.length === 1 && near(shown[0].x, dx) && near(shown[0].z, dz) && shown[0].rotationDeg === 90, shown.map((i) => [i.x, i.z, i.rotationDeg]));

  // 5) 크기를 고친 보정: 자리는 배율만큼, 가구 치수는 그대로, 원래 가구 크기는 배율만큼
  const SCALED = { ...NEW_TRANSFORM, s: 1.1, t: NEW_TRANSFORM.t.map((v) => v * 1.1) };
  const scaled = await putCalibration(owner, roomId, { transform: SCALED, floorPolygon: NEW_FLOOR.map(([x, z]) => [x * 1.1, z * 1.1]) });
  const { data: afterScale } = await admin.from('rooms').select('fixtures').eq('id', roomId).maybeSingle();
  const { data: mineScaled } = await admin.from('layouts').select('items').eq('id', mine.id).maybeSingle();
  check('크기 고침: 배치 자리는 1.1배, 원래 가구 크기도 1.1배', scaled.status === 200 && near(mineScaled.items[0].x, dx * 1.1) && near(mineScaled.items[0].z, dz * 1.1) && near(afterScale.fixtures[0].w, 1.98, 0.011), [mineScaled.items[0], afterScale.fixtures[0].w]);
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
  check('시험용 계정·방·R2 파일 삭제', mine.length === 2, `계정 ${mine.length}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
