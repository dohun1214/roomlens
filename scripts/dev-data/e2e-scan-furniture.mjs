// 3D 스캔 가구 실측: Scaniverse에서 GLB로 내보낸 가구 파일을 골라, 함께 찍힌 바닥을 지우고(높이 조절),
// 이름·치수(모델에서 잰 값)로 내 가구를 만들고, 방에 놓고 저장·다시 열기, 공유받은 사람의 복사, 지우기(R2 파일까지)를 본다.
// 보정 값은 secret key로 직접 넣으므로 운영 주소에서도 돌릴 수 있다. 다른 포트의 개발 서버를 위해 R2 CORS 머리말을 붙인다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog,
//       스캔 파일 ../roomlens-data/scans/fan.glb (SCAN_FILE로 바꿀 수 있음. 저장소에는 넣지 않는다)
// 실행: node --env-file=.env.local scripts/dev-data/e2e-scan-furniture.mjs
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scenePath = path.join(dataDir, 'samples', 'studio11_1m_up.sog');
const sceneBytes = statSync(scenePath).size;
const scanPath = process.env.SCAN_FILE ?? path.join(dataDir, 'scans', 'fan.glb');
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
const bucket = process.env.R2_BUCKET;
const listKeys = async (prefix) => (await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))).Contents?.map((o) => o.Key) ?? [];
const headSize = async (key) => {
  try {
    return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ContentLength ?? 0;
  } catch {
    return null;
  }
};
const readHead = async (key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-11' }))).Body.transformToByteArray());

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // 운영 외 주소(개발 서버의 다른 포트)에서도 R2를 쓰도록 CORS 머리말을 붙인다
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
      const res = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, url, body },
  );
const openRoom = async (page, roomId, query = '') => {
  await page.goto(`${appUrl}/rooms/${roomId}${query}`);
  await page.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
};

try {
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '스캔 가구 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const ownerId = (await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle()).data.owner_id;
  check('준비: 방 업로드 완료, 보정 값 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);

  const panel = page.getByTestId('furniture-panel');
  const items = async () => JSON.parse(await panel.getAttribute('data-json'));
  const mineRows = async (owner = ownerId) => (await admin.from('user_furniture').select('id, name, width_m, depth_m, height_m, source, model_key').eq('owner_id', owner).order('created_at')).data ?? [];
  const preview = page.getByTestId('scan-preview');
  const previewInfo = async () => ({
    floor: await preview.getAttribute('data-floor'),
    removed: Number(await preview.getAttribute('data-removed')),
    kept: Number(await preview.getAttribute('data-kept')),
    size: (await preview.getAttribute('data-size')).split(',').map(Number),
  });

  // 1) "3D 스캔 올리기" → GLB가 아닌 파일은 거부
  await openRoom(page, roomId);
  check('"내 가구"에 "3D 스캔 올리기 (GLB)" 버튼', await page.getByTestId('scan-open').isVisible(), null);
  await page.getByTestId('scan-open').click();
  await page.getByTestId('scan-file').setInputFiles({ name: 'not.glb', mimeType: 'model/gltf-binary', buffer: Buffer.from('this is not a glb file at all, just text') });
  await page.getByTestId('scan-message').waitFor({ timeout: 10000 });
  const badText = await page.getByTestId('scan-message').innerText();
  check('GLB가 아닌 파일: 이유를 보여 주고 미리보기·만들기 없음', badText.includes('GLB') && (await preview.count()) === 0 && (await page.getByTestId('scan-create').isDisabled()), badText);

  // 2) 스캔 파일 → 바닥을 찾아 빨갛게, 치수는 모델에서
  const started = Date.now();
  await page.getByTestId('scan-file').setInputFiles(scanPath);
  await preview.waitFor({ timeout: 60000 });
  await page.waitForTimeout(800);
  const first = await previewInfo();
  const dims = await Promise.all(['width', 'depth', 'height'].map((k) => page.getByTestId(`scan-${k}`).inputValue()));
  console.log('미리보기', first, dims, `${Date.now() - started}ms`);
  check('함께 찍힌 바닥을 찾고(빨간 부분), 남은 면이 더 많음', first.floor === 'found' && first.removed > 50 && first.kept > first.removed * 3, first);
  check('치수 칸이 모델에서 잰 값(cm)으로 채워짐 (선풍기: 높이 60~72cm, 가로·깊이 25~45cm)', Number(dims[2]) >= 60 && Number(dims[2]) <= 72 && dims.slice(0, 2).every((v) => Number(v) >= 25 && Number(v) <= 45) && dims.every((v, i) => Math.abs(Number(v) - first.size[[0, 1, 2][i]] * 100) <= 1), dims);
  check('이름은 파일 이름에서', (await page.getByTestId('scan-name').inputValue()) === 'fan', await page.getByTestId('scan-name').inputValue());

  // 3) 지우는 높이를 바꾸면 빨간 부분이 바뀐다
  await page.getByTestId('scan-cut').fill('0.04');
  await page.waitForTimeout(500);
  const higher = await previewInfo();
  await page.getByTestId('scan-cut').fill('0.015');
  await page.waitForTimeout(500);
  const back = await previewInfo();
  check('지우는 높이 4cm: 더 많이 지움 / 1.5cm로 되돌리면 처음과 같음', higher.removed > first.removed && back.removed === first.removed && (await page.getByTestId('scan-cut-label').innerText()) === '1.5cm', [first.removed, higher.removed, back.removed]);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'scan-furniture-preview.png') });

  // 4) 만들기 → 목록에 "3D" 표시, DB·R2
  await page.getByTestId('scan-name').fill('선풍기');
  await page.getByTestId('scan-create').click();
  await panel.getByRole('button', { name: '+ 선풍기', exact: true }).waitFor({ timeout: 60000 });
  const rows = await mineRows();
  const row = rows[0];
  const key = row?.model_key ?? '';
  const size = key ? await headSize(key) : null;
  const head = key ? await readHead(key) : Buffer.alloc(0);
  check('만들면 폼이 닫히고 "+ 선풍기"에 "3D" 표시', (await page.getByTestId('scan-furniture-form').count()) === 0 && (await page.getByTestId('user-furniture-3d').count()) === 1, null);
  check('DB: 출처 scan, 치수는 칸의 값, 모델은 furniture/user/{나}/{가구}.glb', rows.length === 1 && row.source === 'scan' && key === `furniture/user/${ownerId}/${row.id}.glb` && [row.width_m, row.depth_m, row.height_m].map((v) => Math.round(Number(v) * 100)).join() === dims.map(Number).join(), rows);
  check('R2: 다듬은 GLB (4MB 이하, 머리말 glTF v2)', size !== null && size > 10000 && size <= 4 * 1024 * 1024 && head.toString('ascii', 0, 4) === 'glTF' && head.readUInt32LE(4) === 2, size);

  // 5) 방에 놓으면 3D 모델로 그려진다 → 저장 → 다시 열어도 모델
  await panel.getByRole('button', { name: '+ 선풍기', exact: true }).click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=furniture-panel]')?.getAttribute('data-json') ?? '[]').some((i) => i.name === '선풍기' && i.model), null, { timeout: 30000 });
  const placed = (await items()).find((i) => i.name === '선풍기');
  check('놓으면 3D 모델로 그려짐, 크기는 내 가구 치수', placed?.model === true && Math.round(placed.h * 100) === Number(dims[2]), placed);
  await page.getByTestId('layout-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  await openRoom(page, roomId);
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=furniture-panel]')?.getAttribute('data-json') ?? '[]').some((i) => i.name === '선풍기' && i.model), null, { timeout: 30000 });
  check('다시 열어도 배치의 선풍기가 3D 모델로', (await items()).some((i) => i.name === '선풍기' && i.model), null);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'scan-furniture-room.png') });

  // 6) API 막기: 로그인 없이, GLB가 아닌 파일
  const guest = await newPage();
  await guest.goto(`${appUrl}/`);
  const anonPost = await guest.evaluate(async () => {
    const form = new FormData();
    form.set('name', 'x');
    form.set('w', '0.3');
    form.set('d', '0.3');
    form.set('h', '0.3');
    form.set('file', new Blob(['glTF']), 'a.glb');
    return (await fetch('/api/furniture/scan', { method: 'POST', body: form })).status;
  });
  const badPost = await page.evaluate(async () => {
    const form = new FormData();
    form.set('name', '나쁜 파일');
    form.set('w', '0.3');
    form.set('d', '0.3');
    form.set('h', '0.3');
    form.set('file', new Blob(['not a glb, but long enough to pass the length check']), 'a.glb');
    const res = await fetch('/api/furniture/scan', { method: 'POST', body: form });
    return [res.status, (await res.json()).error?.message];
  });
  check('API: 로그인 없이 401, GLB가 아니면 400 (DB에 안 생김)', anonPost === 401 && badPost[0] === 400 && (await mineRows()).length === 1, [anonPost, badPost]);

  // 7) 공유: 방과 배치를 공개하면 다른 사람이 링크로 보고, 내 배치로 저장하면 모델까지 복사된다
  const { data: layout } = await admin.from('layouts').select('id').eq('room_id', roomId).eq('owner_id', ownerId).maybeSingle();
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  await admin.from('layouts').update({ is_public: true }).eq('id', layout.id);
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  const visitorId = (await admin.auth.admin.listUsers({ perPage: 200 })).data.users.find((u) => u.email === emails.visitor)?.id;
  await openRoom(visitor, roomId, `?layout=${layout.id}`);
  await visitor.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=furniture-panel]')?.getAttribute('data-json') ?? '[]').some((i) => i.name === '선풍기' && i.model), null, { timeout: 30000 });
  check('공유 링크로 연 사람에게도 3D 모델로 보임', true, null);
  await visitor.getByTestId('layout-save').click();
  await visitor.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 20000 });
  const copies = await mineRows(visitorId);
  const copyKey = copies[0]?.model_key ?? '';
  check('내 배치로 저장: 내 가구로 복사(scan), 모델 파일도 내 폴더로', copies.length === 1 && copies[0].source === 'scan' && copyKey === `furniture/user/${visitorId}/${copies[0].id}.glb` && (await headSize(copyKey)) === size, copies);

  // 8) 지우기: 내 가구를 지우면 R2 파일도 지워지고, 복사한 사람의 것은 남는다
  await openRoom(page, roomId);
  await page.getByRole('button', { name: '선풍기 지우기' }).click();
  await page.getByTestId('user-furniture-confirm-yes').click();
  await page.waitForFunction(() => !document.querySelector('[data-testid=user-furniture-3d]'), null, { timeout: 15000 });
  check('지우면 DB 행과 R2 모델이 사라지고, 복사본은 남음', (await mineRows()).length === 0 && (await headSize(key)) === null && (await headSize(copyKey)) === size, null);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
} finally {
  await browser.close();
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => Object.values(emails).includes(u.email)) ?? [];
  let removed = 0;
  for (const u of mine) {
    const { data: rooms } = await admin.from('rooms').select('id').eq('owner_id', u.id);
    const prefixes = [...(rooms ?? []).map((r) => `rooms/${r.id}/`), `furniture/user/${u.id}/`];
    for (const prefix of prefixes) {
      const keys = await listKeys(prefix);
      if (keys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
        removed += keys.length;
      }
    }
    await admin.auth.admin.deleteUser(u.id);
  }
  check('시험용 계정·방·내 가구·R2 파일 삭제', mine.length === 2, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
