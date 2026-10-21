// 가구 자유 회전·끄는 동안 검사·방 분석 → AI 배치 추천 실측.
// 회전은 고른 가구 띠(15°씩·각도 입력·90°)와 R 키, 평면도의 회전 손잡이로. 끄는 동안의 검사는 평면도에서 겹치게 끌어 확인한다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-rotation.mjs
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






try {
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '자유 회전 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const { data: row } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  // 방 가운데 책상, 오른쪽에 침대
  const DESK = { id: 'f1', furnitureRef: 'desk', kind: 'catalog', x: 0, z: 0, rotationDeg: 0 };
  const BED = { id: 'f2', furnitureRef: 'bed-single', kind: 'catalog', x: 1.4, z: 0.3, rotationDeg: 0 };
  const { data: layout } = await admin.from('layouts').insert({ room_id: roomId, owner_id: row.owner_id, items: [DESK, BED] }).select('id').maybeSingle();
  check('준비: 방·배치(책상·침대)', putStatus === 200 && done.status === 200 && layout, [putStatus, done.status]);

  await owner.goto(`${appUrl}/rooms/${roomId}`);
  const panel = owner.getByTestId('furniture-panel');
  await panel.waitFor({ timeout: 120000 });
  const items = async () => JSON.parse(await panel.getAttribute('data-json'));
  const deg = async (id) => (await items()).find((i) => i.id === id).rotationDeg;
  const planItem = (id) => owner.locator(`[data-testid=plan-item][data-id=${id}]`);
  /** 평면도의 방 좌표 → 화면 위치 */
  const toScreen = (x, z) =>
    owner.evaluate(
      ([x, z]) => {
        const svg = document.querySelector('[data-testid=plan-overlay] svg');
        const p = new DOMPoint(x, z).matrixTransform(svg.getScreenCTM());
        return { x: p.x, y: p.y };
      },
      [x, z],
    );

  // 1) 고른 가구 띠의 회전
  await owner.getByTestId('plan-toggle').click();
  await planItem('f1').click();
  const bar = owner.getByTestId('selection-bar');
  check('가구를 고르면 띠에 회전 칸 (지금 0°)', (await bar.getAttribute('data-id')) === 'f1' && (await owner.getByTestId('rotate-input').inputValue()) === '0', null);
  await owner.getByTestId('rotate-right').click();
  check('오른쪽 버튼: 15°', (await deg('f1')) === 15 && (await owner.getByTestId('selection-rotation').getAttribute('data-deg')) === '15', await deg('f1'));
  await owner.getByTestId('rotate-input').fill('37');
  await owner.getByTestId('rotate-input').press('Enter');
  check('각도 칸에 37을 넣고 Enter: 37°', (await deg('f1')) === 37, await deg('f1'));
  await owner.getByTestId('rotate-left').click();
  check('왼쪽 버튼: 22°', (await deg('f1')) === 22, await deg('f1'));
  await owner.getByTestId('rotate-input').fill('-30');
  await owner.getByTestId('rotate-input').press('Enter');
  check('음수는 0~359로: -30 → 330°', (await deg('f1')) === 330, await deg('f1'));
  await owner.getByTestId('rotate-input').fill('abc');
  await owner.getByTestId('rotate-input').press('Enter');
  check('숫자가 아니면 그대로', (await deg('f1')) === 330 && (await owner.getByTestId('rotate-input').inputValue()) === '330', null);
  await owner.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => undefined);
  await planItem('f1').click();
  await owner.keyboard.press('KeyR');
  check('R 키: 15° 더 (345°)', (await deg('f1')) === 345, await deg('f1'));
  await owner.keyboard.press('Shift+KeyR');
  await owner.keyboard.press('Shift+KeyR');
  check('Shift+R 두 번: 315°', (await deg('f1')) === 315, await deg('f1'));
  await bar.getByRole('button', { name: '90° 회전', exact: true }).click();
  check('90° 버튼: 45°', (await deg('f1')) === 45, await deg('f1'));
  await owner.keyboard.press('Control+KeyZ');
  check('되돌리기도 한 단계씩 (315°)', (await deg('f1')) === 315, await deg('f1'));

  // 2) 평면도 회전 손잡이: 가구 왼쪽으로 끌면 뒤쪽이 왼쪽 = 90°, 4° 이내는 90°에 붙음
  const handle = owner.getByTestId('plan-rotate-handle');
  const hx = Number(await handle.getAttribute('data-x'));
  const hz = Number(await handle.getAttribute('data-z'));
  const from = await toScreen(hx, hz);
  const desk = (await items()).find((i) => i.id === 'f1');
  const left = await toScreen(desk.x - 1, desk.z + 0.05); // 약 3° 비뚤게
  await owner.mouse.move(from.x, from.y);
  await owner.mouse.down();
  await owner.mouse.move(left.x, left.y, { steps: 10 });
  const during = await owner.getByTestId('plan-rotate-handle').getAttribute('data-deg');
  check('손잡이를 끄는 동안 각도가 바뀌고 검사 띠가 보임', during === '90' && (await owner.getByTestId('live-check').isVisible()), during);
  await owner.mouse.up();
  check('손잡이를 놓으면 90° (90°에 붙음)', (await deg('f1')) === 90, await deg('f1'));
  const free = await toScreen(desk.x - 1, desk.z + 0.5); // 약 27°
  const from2 = await toScreen(Number(await handle.getAttribute('data-x')), Number(await handle.getAttribute('data-z')));
  await owner.mouse.move(from2.x, from2.y);
  await owner.mouse.down();
  await owner.mouse.move(free.x, free.y, { steps: 10 });
  await owner.mouse.up();
  const freeDeg = await deg('f1');
  check('비스듬히 끌면 1° 단위 자유 각도 (90°의 배수가 아님)', freeDeg % 90 !== 0 && freeDeg > 100 && freeDeg < 130, freeDeg);

  // 3) 끄는 동안 검사: 책상을 침대 위로 끄는 동안 빨간 띠, 놓으면 그대로 문제로 남음
  const target = await toScreen(BED.x, BED.z);
  const box = await planItem('f1').boundingBox();
  await owner.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await owner.mouse.down();
  await owner.mouse.move(target.x, target.y, { steps: 12 });
  await owner.waitForTimeout(150);
  const liveState = await owner.getByTestId('live-check').getAttribute('data-state');
  const liveText = await owner.getByTestId('live-check').innerText();
  const planState = await planItem('f1').getAttribute('data-state');
  const panelCount = await owner.getByTestId('layout-violations').getAttribute('data-errors');
  check('끄는 동안: 띠가 빨갛고 "겹칩니다", 평면도 가구도 빨강 (패널 목록은 놓기 전 그대로)', liveState === 'error' && liveText.includes('겹') && planState === 'error' && panelCount === '0', { liveState, liveText, planState, panelCount });
  await owner.mouse.up();
  check('놓으면 띠는 사라지고 패널에 문제로', (await owner.getByTestId('live-check').count()) === 0 && Number(await owner.getByTestId('layout-violations').getAttribute('data-errors')) >= 1, null);
  await owner.keyboard.press('Control+KeyZ');
  // 빈 곳으로 끄는 동안에는 "괜찮습니다"
  const empty = await toScreen(-0.8, 0);
  const box2 = await planItem('f1').boundingBox();
  await owner.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await owner.mouse.down();
  await owner.mouse.move(empty.x, empty.y, { steps: 10 });
  await owner.waitForTimeout(150);
  check('빈 곳으로 끄는 동안: 초록 "괜찮습니다"', (await owner.getByTestId('live-check').getAttribute('data-state')) === 'ok', await owner.getByTestId('live-check').innerText());
  await owner.mouse.up();

  // 4) 저장하면 자유 각도 그대로
  await owner.getByTestId('layout-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  const { data: saved } = await admin.from('layouts').select('items').eq('id', layout.id).maybeSingle();
  check('저장: DB에 자유 각도 그대로', saved.items.find((i) => i.id === 'f1').rotationDeg === (await deg('f1')), saved.items.map((i) => i.rotationDeg));
  await owner.getByTestId('plan-toggle').click();

  // 5) 방 분석 → AI 배치 추천 (리포트는 DB에 바로 넣는다: AI 호출 없이)
  const REPORT = {
    options: [{ name: '에어컨', status: 'present', evidence: '그림 1' }],
    storage: { level: 'low', notes: '수납장이 없음' },
    naturalLight: { level: 'high', notes: '큰 창' },
    issues: [],
    summary: '밝은 원룸입니다.',
    layoutTips: ['책상은 밝은 창가 벽에', '옷장은 문 옆 긴 벽에'],
  };
  await admin.from('room_reports').insert({ room_id: roomId, model: 'e2e', report: REPORT });
  await owner.reload();
  await panel.waitFor({ timeout: 120000 });
  await owner.getByTestId('analysis-toggle').click();
  check('리포트에 배치 조언 2개와 추천 버튼', (await owner.getByTestId('analysis-tips').getAttribute('data-count')) === '2' && (await owner.getByTestId('analysis-to-suggest').isVisible()), null);
  await owner.getByTestId('analysis-to-suggest').click();
  await owner.getByTestId('ai-form').waitFor({ timeout: 5000 });
  check(
    '버튼: 가구 도구로 가서 AI 요청 칸이 열리고 조언이 들어감 (아직 보내지 않음)',
    (await owner.getByTestId('tool-rail').getAttribute('data-active')) === 'furniture' && (await owner.getByTestId('ai-request').inputValue()) === '책상은 밝은 창가 벽에, 옷장은 문 옆 긴 벽에' && (await owner.getByTestId('ai-suggest').getAttribute('data-busy')) === 'false',
    await owner.getByTestId('ai-request').inputValue(),
  );
  // 예전 리포트(조언 없음)는 채광·수납으로 요청을 만든다
  await admin.from('room_reports').update({ report: { ...REPORT, layoutTips: undefined } }).eq('room_id', roomId);
  await owner.reload();
  await panel.waitFor({ timeout: 120000 });
  await owner.getByTestId('analysis-toggle').click();
  await owner.getByTestId('analysis-to-suggest').click();
  await owner.getByTestId('ai-form').waitFor({ timeout: 5000 });
  check('예전 리포트: 채광·수납으로 만든 요청', (await owner.getByTestId('ai-request').inputValue()) === '책상은 밝은 창가 쪽에, 수납이 적으니 수납 가구를 벽에 붙여서, 문 앞과 통로는 넓게', await owner.getByTestId('ai-request').inputValue());
  // 비로그인은 버튼 없음
  await admin.from('room_reports').update({ report: REPORT }).eq('room_id', roomId);
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  const anon = await newPage();
  await anon.goto(`${appUrl}/rooms/${roomId}`);
  await anon.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  await anon.getByTestId('analysis-toggle').click();
  check('비로그인: 조언은 보이지만 추천 버튼은 없음', (await anon.getByTestId('analysis-tips').isVisible()) && (await anon.getByTestId('analysis-to-suggest').count()) === 0, null);
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
