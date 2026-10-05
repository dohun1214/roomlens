// 문 앞·통로·창문 가림 검사 실측: 배치와 문·창문을 DB에 넣고 방을 열어 가구 패널에 나오는 문제를 본다.
// 보정 값은 secret key로 직접 넣으므로(탭 자동화 없음) 운영 주소에서도 돌릴 수 있다.
// 방은 비공개로만 만든다. 가구 위치를 정확히 정하려고 배치를 DB에 직접 넣는다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-access.mjs
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
/** 종류·벽·시작·폭을 넣고 "추가"를 누른다 */
const addOpening = async (page, type, wall, from, width) => {
  await page.getByTestId('openings-type').selectOption(type);
  await page.getByTestId('openings-wall').selectOption(String(wall - 1));
  await page.getByTestId('openings-from').fill(String(from));
  await page.getByTestId('openings-width').fill(String(width));
  await page.getByTestId('openings-add').click();
};
const DOOR = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
const WINDOW = { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const piece = (id, furnitureRef, x, z, rotationDeg = 0) => ({ id, furnitureRef, kind: 'catalog', x, z, rotationDeg });
// 방 4 × 3 m. 문은 아래쪽 벽의 왼쪽(x -1.8 ~ -0.9), 창문은 위쪽 벽(x -0.2 ~ 1)
const GOOD = [piece('f1', 'bed-single', 1.5, 0.5), piece('f2', 'desk', 0.3, -1.2)];
// 위쪽 벽(z=1.5)에 붙인 옷장·서랍장은 180° 돌려 앞이 방 안쪽을 보게 한다
const BLOCKING = [piece('f1', 'desk', -1.3, -1.2), piece('f2', 'wardrobe', 0.4, 1.2, 180), piece('f3', 'drawer', 1.5, 1.25, 180)];
// 책상을 180° 돌려 앞이 벽을 보게 한 배치
const FACING_WALL = [piece('f1', 'bed-single', 1.5, 0.5), piece('f2', 'desk', 0.3, -1.2, 180)];
// 싱글 침대(1.0 × 2.0) 둘을 90° 돌려 방을 가로로 막고(벽에서 벽까지), 그 뒤(창문 쪽)에 의자를 둔다
const WALLED = [piece('f1', 'bed-single', -1, 0, 90), piece('f2', 'bed-single', 1, 0, 90), piece('f3', 'chair', 0, 1.25)];

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값 넣기
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '통로 검사 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: calibrationError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const { data: ownerRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const { data: layout, error: layoutError } = await admin.from('layouts').insert({ room_id: roomId, owner_id: ownerRow.owner_id, items: BLOCKING }).select('id').maybeSingle();
  check('준비: 방 업로드 완료, 보정 값·배치 넣음', putStatus === 200 && done.status === 200 && !calibrationError && !layoutError, [putStatus, done.status]);

  /** 배치와 문·창문을 DB에 넣고 방을 다시 연 뒤, 가구 패널의 검사 결과를 읽는다 */
  const load = async (items, openings) => {
    await admin.from('layouts').update({ items }).eq('id', layout.id);
    await admin.from('rooms').update({ openings }).eq('id', roomId);
    await openRoom(owner, roomId);
    return readPanel();
  };
  const readPanel = async () => {
    const box = owner.getByTestId('layout-violations');
    return {
      messages: await box.locator('li').allInnerTexts(),
      warnings: await box.locator('li.text-amber-300').allInnerTexts(),
      errors: Number(await box.getAttribute('data-errors')),
      ok: (await box.innerText()).includes('배치에 문제가 없습니다'),
      doorHint: (await owner.getByTestId('layout-door-hint').count()) === 1,
    };
  };

  // 1) 문·창문이 없으면 겹침·방 밖만 본다
  const noOpenings = await load(BLOCKING, []);
  check('문·창문이 없으면: 문제 없음, "문을 넣으면…" 안내', noOpenings.ok && noOpenings.doorHint, noOpenings.messages);

  // 2) 문·창문을 화면에서 넣으면(저장 전) 바로 검사에 반영된다
  await owner.getByTestId('openings-toggle').click();
  await addOpening(owner, 'door', 1, 0.2, 0.9);
  const withDoor = await readPanel();
  check('문을 넣자마자(저장 전): "책상: 문 앞을 막습니다", 안내는 사라짐', same(withDoor.messages, ['책상: 문 앞을 막습니다']) && withDoor.errors === 1 && !withDoor.doorHint, withDoor.messages);
  await addOpening(owner, 'window', 3, 1, 1.2);
  const withWindow = await readPanel();
  check('창문을 넣으면: "옷장: 창문을 가립니다"가 경고(노랑)로 추가, 낮은 서랍장은 괜찮음', same(withWindow.messages, ['책상: 문 앞을 막습니다', '옷장: 창문을 가립니다']) && same(withWindow.warnings, ['옷장: 창문을 가립니다']) && withWindow.errors === 1, withWindow.messages);
  await owner.waitForTimeout(1000);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'access-blocking.png') });
  await owner.getByRole('button', { name: /^문 · 벽 1 .* 삭제$/ }).click();
  const doorRemoved = await readPanel();
  check('문을 지우면: 문 앞 문제는 사라지고 창문 경고만 남음', same(doorRemoved.messages, ['옷장: 창문을 가립니다']) && doorRemoved.errors === 0 && doorRemoved.doorHint, doorRemoved.messages);

  // 3) 저장된 문·창문으로 열기
  const blocking = await load(BLOCKING, [DOOR, WINDOW]);
  check('저장된 문·창문으로 열어도 같은 결과', same(blocking.messages, ['책상: 문 앞을 막습니다', '옷장: 창문을 가립니다']) && blocking.errors === 1, blocking.messages);

  // 4) 통로: 침대 둘이 방을 가로막으면 그 뒤의 의자는 문에서 갈 수 없다
  const walled = await load(WALLED, [DOOR, WINDOW]);
  check('방을 가로막은 침대 뒤의 의자: "문에서 갈 수 없습니다 (통로 60cm 부족)", 침대는 괜찮음', same(walled.messages, ['의자: 문에서 갈 수 없습니다 (통로 60cm 부족)']) && walled.errors === 1, walled.messages);
  await owner.waitForTimeout(1000);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'access-walled.png') });
  // 뒤쪽 벽에 문을 하나 더 내면 갈 수 있다
  await owner.getByTestId('openings-toggle').click();
  await addOpening(owner, 'door', 3, 3, 0.9);
  const secondDoor = await readPanel();
  check('뒤쪽 벽에 문을 하나 더 넣으면 문제 없음', secondDoor.ok, secondDoor.messages);

  // 5) 문제 없는 배치
  const good = await load(GOOD, [DOOR, WINDOW]);
  check('침대를 오른쪽 벽에, 책상을 문 옆 벽에: 문제 없음', good.ok && !good.doorHint, good.messages);

  // 5-1) 쓰는 쪽: 책상의 앞이 벽에 막히면 경고(노랑), 고쳐야 하는 문제는 아님
  const facingWall = await load(FACING_WALL, [DOOR, WINDOW]);
  check('책상의 앞이 벽을 보면: "책상: 앞이 막혀 있습니다"가 경고(노랑)', same(facingWall.messages, ['책상: 앞이 막혀 있습니다 (앞에 70cm 필요)']) && same(facingWall.warnings, facingWall.messages) && facingWall.errors === 0, facingWall.messages);

  // 6) 새 가구는 문 앞을 피해 놓인다: 방 가운데를 문 앞으로 만들기 위해 문을 가운데 아래에 둔다
  const centerDoor = { type: 'door', wallIndex: 0, from: 1.2, to: 2.8, widthM: 1.6 };
  await admin.from('layouts').update({ items: [] }).eq('id', layout.id);
  await admin.from('rooms').update({ openings: [centerDoor] }).eq('id', roomId);
  await openRoom(owner, roomId);
  await owner.getByTestId('furniture-panel').getByRole('button', { name: '+ 의자', exact: true }).click();
  const placed = JSON.parse(await owner.getByTestId('furniture-panel').getAttribute('data-json'))[0];
  const after = await readPanel();
  // 문 앞 구역: x -0.8 ~ 0.8, z -1.5 ~ 0.1. 방 가운데(0, 0)는 그 안이다
  const inDoorZone = Math.abs(placed.x) < 0.8 + 0.25 && placed.z < 0.1 + 0.25;
  check('방 가운데가 문 앞이면 새 가구는 그 밖에 놓이고 문제 없음', !inDoorZone && after.ok, [placed.x, placed.z]);
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
  check('시험용 계정·방·R2 파일 삭제', mine.length === 1, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
