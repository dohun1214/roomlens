// 배치 되돌리기·다시하기 실측: 가구 추가·끌기(평면도)·회전·삭제를 한 단계씩 되돌리고 다시 하며, 버튼과 단축키,
// 입력 칸에서의 Ctrl+Z, 저장 상태와의 관계를 본다.
// 보정 값은 secret key로 직접 넣으므로(탭 자동화 없음) 운영 주소에서도 돌릴 수 있다. 방은 비공개로만 만든다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-layout-history.mjs
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
const pageErrors = [];
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
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  // R2의 CORS는 정해진 주소만 허락한다. 다른 포트의 개발 서버로 열 때를 위해 허락 머리말을 붙인다
  await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS', 'access-control-expose-headers': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const response = await route.fetch();
    return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
  });
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

try {
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '되돌리기 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  check('준비: 방 업로드 완료, 보정 값 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);

  const panel = page.getByTestId('furniture-panel');
  const items = async () => JSON.parse(await panel.getAttribute('data-json'));
  const brief = async () => (await items()).map((i) => `${i.id}:${i.x.toFixed(2)},${i.z.toFixed(2)},${i.rotationDeg}`).join(' ');
  const steps = async () => [Number(await page.getByTestId('layout-undo').getAttribute('data-steps')), Number(await page.getByTestId('layout-redo').getAttribute('data-steps'))];
  const disabled = async (id) => page.getByTestId(id).isDisabled();
  const planItem = (id) => page.locator(`[data-testid=plan-item][data-id=${id}]`);
  const toScreen = async (x, z) => {
    const box = await page.getByTestId('plan-room').boundingBox();
    const scale = (box.width - 5) / 4;
    return { x: box.x + box.width / 2 + x * scale, y: box.y + box.height / 2 + z * scale };
  };
  const dragTo = async (id, x, z) => {
    const box = await planItem(id).boundingBox();
    const target = await toScreen(x, z);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
  };

  await openRoom(page, roomId);
  check('처음: 되돌리기·다시하기 버튼이 있고 둘 다 꺼져 있음', (await page.getByTestId('layout-history').isVisible()) && (await disabled('layout-undo')) && (await disabled('layout-redo')), await steps());

  // 1) 추가 → 끌기(평면도) → 회전 → 추가 → 삭제: 동작마다 한 단계
  await panel.getByRole('button', { name: '+ 책상 · 서랍형', exact: true }).click();
  await page.getByTestId('plan-toggle').click();
  await dragTo('f1', 1, 0.5);
  const afterDrag = await steps();
  await page.getByTestId('selection-bar').getByRole('button', { name: '90° 회전', exact: true }).click();
  await panel.getByRole('button', { name: '+ 옷장 · 원목', exact: true }).click();
  const withWardrobe = await brief();
  await page.getByTestId('selection-bar').getByRole('button', { name: '삭제', exact: true }).click();
  const final = await brief();
  check('동작 다섯 번 = 되돌릴 단계 5 (끄는 동안의 움직임은 한 단계)', afterDrag[0] === 2 && (await steps())[0] === 5 && (await steps())[1] === 0, { afterDrag, now: await steps(), final });

  // 2) 버튼으로 되돌리기
  await page.getByTestId('layout-undo').click();
  check('되돌리기 1: 지운 옷장이 다시 생김', (await brief()) === withWardrobe, await brief());
  await page.getByTestId('layout-undo').click();
  await page.getByTestId('layout-undo').click();
  const unrotated = (await items())[0];
  check('되돌리기 3: 옷장이 사라지고 책상의 회전이 0°로', (await items()).length === 1 && unrotated.rotationDeg === 0 && Math.abs(unrotated.x - 1) < 0.011, await brief());
  check('되돌린 만큼 다시하기가 켜짐 (2단계 남음 / 3단계 다시)', JSON.stringify(await steps()) === '[2,3]' && !(await disabled('layout-redo')), await steps());
  await page.getByTestId('layout-redo').click();
  check('다시하기: 회전 90°가 돌아옴', (await items())[0].rotationDeg === 90, await brief());

  // 3) 단축키 (3D 화면에서)
  await page.getByTestId('plan-toggle').click();
  await page.mouse.click(900, 300);
  await page.keyboard.press('Control+KeyZ');
  const keyUndo = (await items())[0].rotationDeg;
  await page.keyboard.press('Control+Shift+KeyZ');
  const keyRedo = (await items())[0].rotationDeg;
  await page.keyboard.press('Control+KeyY');
  check('Ctrl+Z 되돌리기, Ctrl+Shift+Z·Ctrl+Y 다시하기', keyUndo === 0 && keyRedo === 90 && (await items()).length === 2, { keyUndo, keyRedo, now: await brief() });

  // 4) 입력 칸에서의 Ctrl+Z는 배치를 되돌리지 않는다
  const beforeTyping = await brief();
  await page.getByTestId('user-furniture-open').click();
  await page.getByTestId('user-furniture-name').fill('수납');
  await page.getByTestId('user-furniture-name').press('Control+KeyZ');
  check('입력 칸에서 Ctrl+Z: 배치는 그대로', (await brief()) === beforeTyping, await brief());
  await page.getByRole('button', { name: '취소', exact: true }).click();

  // 5) 저장 상태: 저장한 배치로 되돌아오면 "저장됨"
  await page.getByTestId('layout-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  await page.getByTestId('layout-undo').click();
  const dirtyAfterUndo = await page.getByTestId('layout-save-state').getAttribute('data-state');
  await page.getByTestId('layout-redo').click();
  check('저장 뒤 되돌리면 "저장 안 됨", 다시 하면 "저장됨"', dirtyAfterUndo === 'dirty' && (await page.getByTestId('layout-save-state').getAttribute('data-state')) === 'saved', dirtyAfterUndo);

  // 6) 되돌린 뒤 새로 바꾸면 다시하기는 사라진다
  await page.getByTestId('layout-undo').click();
  await panel.getByRole('button', { name: '+ 의자 · 원목', exact: true }).click();
  check('되돌린 뒤 새 가구를 놓으면 다시하기 꺼짐', (await disabled('layout-redo')) && (await steps())[1] === 0, await steps());

  // 7) 다른 도구로 가면 버튼이 사라지고 단축키도 배치를 건드리지 않는다
  const beforeOther = await brief();
  await page.getByTestId('openings-toggle').click();
  await page.mouse.click(900, 300);
  await page.keyboard.press('Control+KeyZ');
  check('문·창문 도구에서는 버튼이 없고 Ctrl+Z가 배치를 바꾸지 않음', (await page.getByTestId('layout-history').count()) === 0 && (await brief()) === beforeOther, null);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'layout-history.jpg'), type: 'jpeg', quality: 70 });
  check('화면 오류 없음', pageErrors.length === 0, pageErrors);
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
