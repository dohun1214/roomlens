// 2D 평면도 실측: 평면도를 열어 가구를 실제로 끌어 보고, 3D와 같은 상태를 쓰는지·저장되는지 본다.
// 보정 값은 secret key로 직접 넣으므로(탭 자동화 없음) 운영 주소에서도 돌릴 수 있다.
// 방은 비공개로만 만든다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-plan.mjs
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
const DOOR = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
const WINDOW = { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 };
const near = (a, b, tolerance = 0.011) => Math.abs(a - b) <= tolerance;

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값과 문·창문 넣기 (방 4 × 3 m, 가운데가 원점)
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '평면도 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, openings: [DOOR, WINDOW] }).eq('id', roomId);
  check('준비: 방 업로드 완료, 보정 값·문·창문 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);

  const panel = page.getByTestId('furniture-panel');
  const items = async () => JSON.parse(await panel.getAttribute('data-json'));
  const planItem = (id) => page.locator(`[data-testid=plan-item][data-id=${id}]`);
  const messages = () => page.getByTestId('layout-violations').locator('li').allInnerTexts();
  /** 방 좌표(m) → 화면 위치(px). 방 가운데가 원점이고 가로가 4m */
  const toScreen = async (x, z) => {
    const box = await page.getByTestId('plan-room').boundingBox();
    const scale = (box.width - 4) / 4; // 벽 선 두께 4px 제외
    return { x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + z * scale, scale };
  };
  /** 평면도에서 가구의 가운데를 잡아 (x, z)로 끈다 */
  const dragTo = async (id, x, z) => {
    const box = await planItem(id).boundingBox();
    const target = await toScreen(x, z);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
  };

  // 1) 평면도 열기
  await openRoom(page, roomId);
  check('처음에는 3D, 평면도 버튼이 있음', (await page.getByTestId('plan-overlay').count()) === 0 && (await page.getByTestId('plan-toggle').innerText()) === '평면도', null);
  await page.getByTestId('plan-toggle').click();
  const openingTypes = await page.getByTestId('plan-opening').evaluateAll((els) => els.map((el) => el.getAttribute('data-type')));
  const wallTexts = await page.getByTestId('floor-plan').locator('text').allTextContents();
  check('평면도: 방, 문·창문, 벽 번호가 보이고 버튼은 "3D로 보기"', (await page.getByTestId('plan-room').isVisible()) && openingTypes.join() === 'door,window' && ['벽 1', '벽 2', '벽 3', '벽 4'].every((w) => wallTexts.includes(w)) && (await page.getByTestId('plan-toggle').innerText()) === '3D로 보기', [openingTypes, wallTexts]);
  const room = await page.getByTestId('plan-room').boundingBox();
  check('방 그림의 가로세로 비율이 4:3', near((room.width - 4) / (room.height - 4), 4 / 3, 0.02), [Math.round(room.width), Math.round(room.height)]);

  // 2) 가구를 추가하면 평면도에 나온다
  await panel.getByRole('button', { name: '+ 책상', exact: true }).click();
  const added = (await items())[0];
  /** 평면도에 그려진 가구의 가로·세로 (m): 다각형 꼭짓점에서 계산 */
  const drawnSize = (id) =>
    planItem(id).evaluate((el) => {
      const points = el.getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
      const span = (k) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]));
      return [span(0), span(1)];
    });
  const deskSize = await drawnSize('f1');
  const deskBox = await planItem('f1').boundingBox();
  const { scale } = await toScreen(0, 0);
  check('책상이 방 가운데에 실제 크기(1.2 × 0.6 m)로 그려짐', near(added.x, 0) && near(added.z, 0) && near(deskSize[0], 1.2) && near(deskSize[1], 0.6) && near(deskBox.width / scale, 1.2, 0.1), deskSize);

  // 3) 끌어서 옮기기
  await dragTo('f1', 1, 0.5);
  const moved = (await items())[0];
  check('평면도에서 끌면 그 자리로 옮겨짐 (1.00, 0.50), "저장 안 됨"', near(moved.x, 1) && near(moved.z, 0.5) && (await page.getByTestId('layout-save-state').getAttribute('data-state')) === 'dirty', [moved.x, moved.z]);
  await dragTo('f1', 0.83, -0.38);
  const snapped = (await items())[0];
  check('5cm 격자에 맞음 (0.83, -0.38 → 0.85, -0.40)', near(snapped.x, 0.85) && near(snapped.z, -0.4), [snapped.x, snapped.z]);
  await dragTo('f1', 2.3, 0);
  const walled = (await items())[0];
  check('벽 너머로 끌면 벽에 붙음 (x = 2.0 − 0.6 = 1.40)', near(walled.x, 1.4) && near(walled.z, 0), [walled.x, walled.z]);

  // 4) 검사 결과가 평면도에도 나온다
  await dragTo('f1', -1.35, -1.2);
  check('문 앞으로 끌면: 평면도에서 빨강, "책상: 문 앞을 막습니다"', (await planItem('f1').getAttribute('data-state')) === 'error' && (await messages()).includes('책상: 문 앞을 막습니다'), await messages());
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'plan-door.png') });
  await dragTo('f1', 1.4, -1.2);
  check('문 옆 벽으로 옮기면 문제 없음', (await planItem('f1').getAttribute('data-state')) === 'ok' && (await page.getByTestId('layout-violations').getAttribute('data-count')) === '0', null);
  await panel.getByRole('button', { name: '+ 옷장', exact: true }).click();
  await dragTo('f2', 0.4, 1.2);
  check('옷장을 창문 앞으로 끌면: 평면도에서 노랑, "옷장: 창문을 가립니다"', (await planItem('f2').getAttribute('data-state')) === 'warning' && (await messages()).includes('옷장: 창문을 가립니다'), await messages());

  // 5) 선택: 누르면 선택, 빈 곳을 누르면 해제, 선택한 가구를 패널에서 돌리기
  const empty = await toScreen(-1.5, 1.0);
  await page.mouse.click(empty.x, empty.y);
  const noneSelected = (await planItem('f1').getAttribute('data-selected')) === 'false' && (await planItem('f2').getAttribute('data-selected')) === 'false';
  const f1 = await planItem('f1').boundingBox();
  await page.mouse.click(f1.x + f1.width / 2, f1.y + f1.height / 2);
  const before = (await items())[0];
  check('빈 곳을 누르면 선택 해제, 가구를 누르면(끌지 않고) 선택만 되고 움직이지 않음', noneSelected && (await planItem('f1').getAttribute('data-selected')) === 'true' && near(before.x, 1.4) && near(before.z, -1.2), [before.x, before.z]);
  await panel.getByRole('button', { name: '90° 회전', exact: true }).click();
  const rotated = (await items())[0];
  const rotatedSize = await drawnSize('f1');
  check('패널의 90° 회전이 평면도에 반영됨 (가로 0.6 × 세로 1.2로 보임)', rotated.rotationDeg === 90 && near(rotatedSize[0], 0.6) && near(rotatedSize[1], 1.2), rotatedSize);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'plan.png') });

  // 6) 3D와 같은 상태, 저장 후 다시 열기
  const inPlan = await items();
  await page.getByTestId('plan-toggle').click();
  check('3D로 돌아가도 가구 위치는 그대로', (await page.getByTestId('plan-overlay').count()) === 0 && JSON.stringify(await items()) === JSON.stringify(inPlan), null);
  await page.getByTestId('layout-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  await page.reload();
  await panel.waitFor({ timeout: 120000 });
  await page.getByTestId('plan-toggle').click();
  const reopened = await items();
  check('저장하고 다시 열면: 평면도에 같은 자리·같은 회전으로 나옴', reopened.length === 2 && near(reopened[0].x, rotated.x) && near(reopened[0].z, rotated.z) && reopened[0].rotationDeg === 90 && near(reopened[1].x, inPlan[1].x) && (await page.getByTestId('plan-item').count()) === 2, reopened.map((i) => [i.name, i.x, i.z, i.rotationDeg]));

  // 7) 폰 크기 화면에서도 끌 수 있다
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(500);
  await page.getByTestId('panel-compact').click();
  const catalogHidden = !(await page.getByTestId('furniture-catalog').isVisible());
  const phonePanel = await panel.boundingBox();
  const phoneRoom = await page.getByTestId('plan-room').boundingBox();
  check('폰 크기(390px): 패널을 접으면 가구 목록이 숨고 방 그림을 가리지 않음', catalogHidden && phonePanel.y + phonePanel.height <= phoneRoom.y + 2, [Math.round(phonePanel.y + phonePanel.height), Math.round(phoneRoom.y)]);
  await dragTo('f2', -1.5, 0.8);
  const onPhone = (await items())[1];
  check('폰 크기(390px) 화면의 평면도에서도 끌림', near(onPhone.x, -1.5, 0.06) && near(onPhone.z, 0.8, 0.06), [onPhone.x, onPhone.z]);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'plan-phone.png') });
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
