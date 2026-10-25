// 원래 가구 옮기기 실측: 방 주인이 "옮기기"를 누르면 방 3D 파일에서 원래 가구를 떼어 내 R2에 올리고(조각), 배치의 가구로 놓는다.
// 원래 자리는 방 스플랫에서 숨기고, 조각을 끌고 돌릴 수 있고, 저장·다시 열기·제자리로가 되는지,
// 원래 가구 도구로 저장해도 조각 정보가 남는지, 다른 사람은 떼어 낸 원래 가구만 옮길 수 있는지, AI 추천이 옮긴 자리를 지키는지 본다.
// 옮긴 뒤 빈자리를 AI로 채우는 것도 본다 (방 주인).
// 방은 CC BY 샘플(침실, ethan3111)과 그 방의 보정·원래 가구 값으로 만든다. Gemini를 두 번 부른다 (빈자리 채우기, AI 추천).
// 준비: 개발 서버(APP_URL), ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/superspl/bedroom_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-fixture-move.mjs
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scenePath = path.join(dataDir, 'samples', 'superspl', 'bedroom_up.sog');
const sceneBytes = statSync(scenePath).size;
const stamp = Date.now();
const domain = process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test';
const emails = { owner: `e2e-${stamp}-o@${domain}`, visitor: `e2e-${stamp}-v@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const near = (a, b, tol = 0.03) => Math.abs(a - b) <= tol;

// 침실 샘플 방의 보정·평면도와 원래 가구 둘 (의자는 창가 벽에 붙어 있다)
const TRANSFORM = { s: 0.6652209365777558, q: [0.0009007231773199491, 0.9611268789407866, 0.0003507603197659124, 0.27610539336003215], t: [0.14650000000000005, 0.004122947664177054, -0.48700000000000054], flipX: false };
const FLOOR = [[-2.915, -2.003], [2.915, -2.003], [2.915, 2.003], [-2.915, 2.003]];
const FIXTURES = [
  { id: 'x2', label: '의자', x: -2.452, z: -0.956, w: 0.83, d: 0.96, h: 1.19, rotationDeg: 0, remove: false },
  { id: 'x3', label: '수납장', x: -2.538, z: 0.098, w: 0.65, d: 0.53, h: 0.63, rotationDeg: 0, remove: false },
];

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
const readHead = async (key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-1' }))).Body.transformToByteArray());

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const pageErrors = [];
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
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
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
const openRoom = async (page, roomId) => {
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await page.getByTestId('stage-calibrated').waitFor({ timeout: 120000 });
  await page.getByTestId('furniture-panel').waitFor({ timeout: 60000 });
  await page.waitForTimeout(2500);
};
const itemsOf = async (page) => JSON.parse(await page.getByTestId('furniture-panel').getAttribute('data-json'));
const row = (page, id) => page.locator(`[data-testid=fixture-move-list] li[data-id=${id}]`);
// 방 스플랫에 걸린 숨기기 편집 수와, 그려지는 조각(방 스플랫이 아닌 스플랫 메시) 수 (개발 서버에서만 보이는 window.__roomlens)
const sceneState = (page) =>
  page.evaluate(() => {
    const engine = window.__roomlens;
    let pieces = 0;
    engine.scene.traverse((o) => {
      if (o !== engine.splat && o.packedSplats && o.packedSplats.numSplats > 0) pieces += 1;
    });
    return { edits: engine.splat?.edits?.length ?? 0, sdfs: engine.splat?.edits?.[0]?.sdfs?.length ?? 0, pieces };
  });
const shot = async (page, name) => {
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(dataDir, '_e2e', name) });
};

let roomId = null;
try {
  // 준비: 가입 → 방 만들고 파일 올리기 → 보정 값·원래 가구 넣기, 공개
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  roomId = (await api(owner, 'POST', '/api/rooms', { title: '원래 가구 옮기기 실측 방', consent: true, source: 'dataset', credit: 'Bedroom by ethan3111 (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, fixtures: FIXTURES, is_public: true }).eq('id', roomId);
  check('준비: 방 업로드, 보정 값·원래 가구 2개 넣음, 공개', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status, setupError?.message]);
  const fixturesInDb = async () => (await admin.from('rooms').select('fixtures').eq('id', roomId).maybeSingle()).data?.fixtures ?? [];

  // 1) 방 주인: 가구 도구에 "방에 원래 있던 가구" 두 개, 아직 떼어 내지 않음
  await openRoom(owner, roomId);
  const states = await owner.locator('[data-testid=fixture-move-list] li').evaluateAll((els) => els.map((el) => [el.getAttribute('data-id'), el.getAttribute('data-state')]));
  check('가구 도구: 원래 가구 2개, 방 주인이라 둘 다 "옮기기"(떼어 내기 전)', JSON.stringify(states) === JSON.stringify([['x2', 'prepare'], ['x3', 'prepare']]), states);
  await shot(owner, 'fixture-move-0-before.png');

  // 2) 의자 "옮기기" → 떼어 내 올리고 배치에 놓는다
  const t0 = Date.now();
  await row(owner, 'x2').getByTestId('fixture-move-button').click();
  await owner.locator('[data-testid=fixture-move-list] li[data-id=x2][data-state=moved]').waitFor({ timeout: 240000 });
  const prepMs = Date.now() - t0;
  const db1 = await fixturesInDb();
  const chair = db1.find((f) => f.id === 'x2');
  const key = chair?.piece ? `rooms/${roomId}/fixtures/x2-piece-${chair.piece.v}.spz` : '';
  const size = key ? await headSize(key) : null;
  const head = key ? await readHead(key) : Buffer.alloc(0);
  check('떼어 내기: DB의 의자에 조각 정보(버전·높이), 수납장은 그대로', chair?.piece?.v > 0 && chair.piece.top >= 1.19 && chair.piece.top <= 1.9 && !db1.find((f) => f.id === 'x3').piece, { piece: chair?.piece, ms: prepMs });
  check('떼어 내기: R2에 조각 파일 (gzip SPZ, 10KB~30MB)', size !== null && size > 10000 && size < 30 * 1024 * 1024 && head[0] === 0x1f && head[1] === 0x8b, size);
  let items = await itemsOf(owner);
  const moved = items.find((i) => i.kind === 'fixture');
  check('배치에 원래 자리 그대로 놓이고 고른 상태', moved?.furnitureRef === 'x2' && near(moved.x, -2.452) && near(moved.z, -0.956) && moved.h === chair.piece.top && (await owner.getByTestId('selection-bar').getAttribute('data-id')) === moved?.id, moved);
  await owner.waitForTimeout(3000);
  let scene = await sceneState(owner);
  check('3D: 원래 자리는 숨기고(편집 1·상자 1), 조각 하나를 그린다', scene.edits === 1 && scene.sdfs === 1 && scene.pieces === 1, scene);
  check('선택 줄의 버튼은 "제자리로"', (await owner.getByTestId('selection-remove').innerText()).trim() === '제자리로', null);

  // 3) 평면도에서 끌어 옮기고 3D에서 180° 돌린다
  await owner.getByTestId('plan-toggle').click();
  const roomBox = await owner.getByTestId('plan-room').boundingBox();
  const scale = (roomBox.width - 5) / 5.83;
  const itemBox = await owner.locator(`[data-testid=plan-item][data-id=${moved.id}]`).boundingBox();
  const fixtureShapes = await owner.getByTestId('plan-fixture').count();
  await owner.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2);
  await owner.mouse.down();
  await owner.mouse.move(itemBox.x + itemBox.width / 2 + 4.2 * scale, itemBox.y + itemBox.height / 2 - 0.45 * scale, { steps: 10 });
  await owner.mouse.up();
  await owner.waitForTimeout(500);
  items = await itemsOf(owner);
  let after = items.find((i) => i.id === moved.id);
  check('평면도: 원래 자리의 빗금 상자는 옮긴 의자만큼 빠지고(1개), 끌면 옮겨짐', fixtureShapes === 1 && near(after.x, -2.452 + 4.2, 0.12) && near(after.z, -0.956 - 0.45, 0.12), { fixtureShapes, x: after.x, z: after.z });
  await owner.getByTestId('plan-toggle').click();
  await owner.getByTestId('rotate-input').fill('180');
  await owner.getByTestId('rotate-input').press('Enter');
  await owner.waitForTimeout(300);
  items = await itemsOf(owner);
  after = items.find((i) => i.id === moved.id);
  const violationTexts = await owner.getByTestId('layout-violations').innerText();
  check('돌리기 180°, 옮긴 의자에 문제 없음 (원래 자리의 의자와 겹친다고 하지 않음)', after.rotationDeg === 180 && !violationTexts.includes('원래 있던 의자'), [after.rotationDeg, violationTexts.slice(0, 120)]);
  await owner.getByTestId('selection-focus').click();
  await shot(owner, 'fixture-move-1-moved.png');
  await owner.getByTestId('layout-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=layout-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  const { data: layoutRows } = await admin.from('layouts').select('items').eq('room_id', roomId);
  const savedItem = layoutRows?.[0]?.items?.find((i) => i.kind === 'fixture');
  check('저장: 배치에 kind fixture로 (원래 가구 id·자리·회전)', savedItem?.furnitureRef === 'x2' && near(savedItem.x, after.x, 0.001) && savedItem.rotationDeg === 180, savedItem);

  // 4) 다시 열기: 옮긴 자리, 숨기기, 조각
  await openRoom(owner, roomId);
  await owner.waitForTimeout(3000);
  items = await itemsOf(owner);
  scene = await sceneState(owner);
  const reopened = items.find((i) => i.kind === 'fixture');
  check('다시 열면 옮긴 자리·회전 그대로, 원래 자리는 숨김, 조각을 그림', reopened && near(reopened.x, after.x, 0.001) && reopened.rotationDeg === 180 && scene.edits === 1 && scene.pieces === 1 && (await row(owner, 'x2').getAttribute('data-state')) === 'moved', { reopened, scene });
  await shot(owner, 'fixture-move-2-reopened.png');
  await owner.locator(`[data-testid=placed-focus][data-id=${reopened.id}]`).click();
  await shot(owner, 'fixture-move-3-reopened-moved.png');

  // 5) 원래 가구 도구에서 이름을 고쳐 저장해도 조각 정보가 남는다
  await owner.getByTestId('fixtures-toggle').click();
  await owner.getByTestId('fixture-label').nth(1).selectOption('TV장');
  await owner.getByTestId('fixtures-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=fixtures-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  const db2 = await fixturesInDb();
  check('원래 가구 도구로 저장: 의자의 조각 정보는 그대로, 수납장 이름은 TV장', db2.find((f) => f.id === 'x2')?.piece?.v === chair.piece.v && db2.find((f) => f.id === 'x3')?.label === 'TV장', db2.map((f) => [f.id, f.label, f.piece?.v ?? null]));
  await owner.getByTestId('tool-furniture').click();

  // 6) 제자리로: 배치에서 빠지고 숨기기도 풀린다 (저장하지 않음)
  await row(owner, 'x2').getByTestId('fixture-return').click();
  await owner.waitForTimeout(1500);
  items = await itemsOf(owner);
  scene = await sceneState(owner);
  check('"제자리로": 배치에서 빠지고 원래 자리가 다시 보임', !items.some((i) => i.kind === 'fixture') && scene.edits === 0 && scene.pieces === 0 && (await row(owner, 'x2').getAttribute('data-state')) === 'ready', { scene });
  await owner.getByTestId('layout-undo').click();
  await owner.waitForTimeout(800);
  check('되돌리기로 다시 옮긴 자리', (await itemsOf(owner)).some((i) => i.kind === 'fixture' && near(i.x, after.x, 0.001)), null);

  // 7) 빈자리 AI로 채우기 (방 주인, AI 1회): 바닥·창가 벽을 찍어 AI가 채운 그림으로 납작한 스플랫 조각을 올린다
  // 원래 가구 도구의 "3D에서 보기"로 의자의 원래 자리를 본 뒤 가구 도구로 돌아온다
  const lookAtHole = async (page) => {
    await page.getByTestId('fixtures-toggle').click();
    await page.getByRole('button', { name: /^의자 · .* 3D에서 보기$/ }).click();
    await page.waitForTimeout(1200);
    await page.getByTestId('tool-furniture').click();
  };
  await lookAtHole(owner);
  await shot(owner, 'fixture-move-4-hole.png');
  const remainingBefore = Number(await owner.getByTestId('ai-suggest').getAttribute('data-remaining'));
  const fillStart = Date.now();
  await row(owner, 'x2').getByTestId('fixture-fill').click();
  await owner.locator('[data-testid=fixture-fill][data-filled=true]').waitFor({ timeout: 240000 });
  const fillMs = Date.now() - fillStart;
  await owner.waitForTimeout(3000);
  const db3 = await fixturesInDb();
  const fillV = db3.find((f) => f.id === 'x2')?.fill?.v;
  const fillKey = fillV ? `rooms/${roomId}/fixtures/x2-fill-${fillV}.spz` : '';
  const fillSize = fillKey ? await headSize(fillKey) : null;
  scene = await sceneState(owner);
  const remainingAfter = Number(await owner.getByTestId('ai-suggest').getAttribute('data-remaining'));
  const { data: fillCalls } = await admin.from('ai_calls').select('kind, status').eq('room_id', roomId).eq('kind', 'fill');
  check('빈자리 채우기: DB에 채운 조각 버전, R2에 조각 파일(10KB 넘음), AI 1회', fillV > 0 && fillSize > 10000 && remainingAfter === remainingBefore - 1 && fillCalls?.length === 1 && fillCalls[0].status === 'done', { fillV, fillSize, remainingBefore, remainingAfter, fillMs, fillCalls });
  check('빈자리 채우기: 바닥 구멍·창가 벽도 숨기고(상자 3개), 채운 조각을 원래 자리에 그림(조각 2개)', scene.sdfs === 3 && scene.pieces === 2, scene);
  await lookAtHole(owner);
  await shot(owner, 'fixture-move-5-filled.png');
  await openRoom(owner, roomId);
  await owner.waitForTimeout(3000);
  scene = await sceneState(owner);
  check('다시 열어도 채운 빈자리가 보임', scene.sdfs === 3 && scene.pieces === 2 && (await row(owner, 'x2').getByTestId('fixture-fill').getAttribute('data-filled')) === 'true', scene);

  // 8) 로그인하지 않은 사람: 떼어 낸 의자는 옮겨 볼 수 있고, 떼어 내지 않은 수납장은 잠김(로그인 안내)
  const guest = await newPage();
  await openRoom(guest, roomId);
  const gStates = await guest.locator('[data-testid=fixture-move-list] li').evaluateAll((els) => els.map((el) => [el.getAttribute('data-id'), el.getAttribute('data-state')]));
  const gHint = await row(guest, 'x3').innerText();
  check('로그인 안 함: 의자는 옮기기, 수납장은 잠김 + "로그인하면" 안내', JSON.stringify(gStates) === JSON.stringify([['x2', 'ready'], ['x3', 'locked']]) && gHint.includes('로그인하면') && (await row(guest, 'x3').getByTestId('fixture-move-button').isDisabled()), { gStates, gHint });
  await guest.close();

  // 9) 다른 사람(로그인): 떼어 낸 의자는 바로 옮기고, 수납장은 원할 때 직접 떼어 낸다
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  await openRoom(visitor, roomId);
  const vStates = await visitor.locator('[data-testid=fixture-move-list] li').evaluateAll((els) => els.map((el) => [el.getAttribute('data-id'), el.getAttribute('data-state')]));
  check('다른 사람: 의자는 바로 옮기기, 수납장은 "옮기기"(직접 떼어 냄)', JSON.stringify(vStates) === JSON.stringify([['x2', 'ready'], ['x3', 'prepare']]) && !(await row(visitor, 'x3').getByTestId('fixture-move-button').isDisabled()), vStates);
  await row(visitor, 'x2').getByTestId('fixture-move-button').click();
  await visitor.waitForTimeout(2000);
  const vItems = await itemsOf(visitor);
  check('다른 사람: 바로 원래 자리에 놓이고, 조각과 방 주인이 채운 빈자리가 보임 (떼어 내기 없이)', vItems.some((i) => i.kind === 'fixture' && near(i.x, -2.452)) && (await sceneState(visitor)).pieces === 2, vItems);
  check('다른 사람: 이미 채운 빈자리는 "다시 채우기"가 없음 (방 주인만)', (await row(visitor, 'x2').getByTestId('fixture-fill').count()) === 0);
  // 의자를 옮긴 채로 침대를 하나 놓고 AI 추천: 결과에 옮긴 의자가 그 자리 그대로 들어 있고, 침대는 의자와 겹치지 않는다
  await visitor.getByTestId('furniture-panel').getByRole('button', { name: /^\+ 싱글 침대/ }).first().click();
  await visitor.getByTestId('ai-open').click();
  await visitor.getByTestId('ai-request').fill('침대는 창가에');
  await visitor.getByTestId('ai-run').click();
  await visitor.getByTestId('ai-result').waitFor({ timeout: 120000 });
  await visitor.waitForTimeout(1500);
  const aiItems = await itemsOf(visitor);
  const aiChair = aiItems.find((i) => i.kind === 'fixture');
  const aiErrors = await visitor.getByTestId('layout-violations').getAttribute('data-errors');
  check('AI 추천: 옮긴 의자는 원래 자리 그대로 결과에 남고, 문제 없음', aiChair && near(aiChair.x, -2.452) && aiItems.length === 2 && aiErrors === '0', { aiItems: aiItems.map((i) => [i.kind, i.name, i.x, i.z]), aiErrors });

  // 다른 사람이 수납장 "옮기기" → 그 자리에서 떼어 내 방에 저장된다
  await row(visitor, 'x3').getByTestId('fixture-move-button').click();
  await visitor.locator('[data-testid=fixture-move-list] li[data-id=x3][data-state=moved]').waitFor({ timeout: 240000 });
  const cabinet = (await fixturesInDb()).find((f) => f.id === 'x3');
  const cabinetSize = cabinet?.piece ? await headSize(`rooms/${roomId}/fixtures/x3-piece-${cabinet.piece.v}.spz`) : null;
  check('다른 사람: 수납장을 원할 때 떼어 냄 (방에 조각 저장, R2에 파일)', Boolean(cabinet?.piece) && cabinetSize > 1000, { piece: cabinet?.piece, cabinetSize });
  check('다른 사람: 떼어 낸 수납장은 빈자리 채우기 버튼이 보임 (아직 안 채움)', (await row(visitor, 'x3').getByTestId('fixture-fill').getAttribute('data-filled')) === 'false');
  await visitor.waitForTimeout(1500);
  await shot(visitor, 'fixture-move-6-visitor.png');
  // 방 주인이 다시 열면 다른 사람이 떼어 낸 수납장도 바로 옮길 수 있다
  await openRoom(owner, roomId);
  const oStates = await owner.locator('[data-testid=fixture-move-list] li').evaluateAll((els) => els.map((el) => el.getAttribute('data-state')));
  check('방 주인: 다른 사람이 떼어 낸 수납장이 "ready"로 보임', oStates[1] === 'ready', oStates);

  // 10) API 막기: 다른 사람은 이미 있는 조각·채운 빈자리를 바꿀 수 없고, 비공개 방은 없는 방
  const again = await api(visitor, 'POST', `/api/rooms/${roomId}/fixture-pieces`, { fixtureId: 'x3', kind: 'piece', size: 1000 });
  const refill = await api(visitor, 'POST', `/api/rooms/${roomId}/fixture-fill`, { fixtureId: 'x2', images: [{ kind: 'floor', data: 'A'.repeat(200) }] });
  const bad = await api(owner, 'PATCH', `/api/rooms/${roomId}/fixture-pieces`, { fixtureId: 'x3', kind: 'fill', v: Date.now() });
  check('API: 다른 사람은 다시 떼어 내기·다시 채우기 409, 올리지 않고 끝냈다고 하면 409', again.status === 409 && refill.status === 409 && bad.status === 409, [again.status, again.json?.error?.code, refill.status, refill.json?.error?.code, bad.status, bad.json?.error?.code]);
  await admin.from('rooms').update({ is_public: false }).eq('id', roomId);
  const hidden = await api(visitor, 'POST', `/api/rooms/${roomId}/fixture-pieces`, { fixtureId: 'x3', kind: 'fill', size: 1000 });
  check('API: 비공개 방은 다른 사람에게 404', hidden.status === 404, hidden.status);
  check('화면 오류 없음', pageErrors.length === 0, pageErrors);
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
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
        removed += keys.length;
      }
    }
    await admin.auth.admin.deleteUser(u.id);
  }
  check('시험용 계정·방·R2 파일 삭제', mine.length === 2, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
