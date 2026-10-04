// 문·창문 실측: 숫자로 넣고 저장 → 다시 열면 그대로인지, 잘못된 값은 거부하는지, 방 주인이 아닌 사람에게는 어떻게 보이는지 본다.
// 보정 값은 secret key로 직접 넣으므로(탭 자동화 없음) 운영 주소에서도 돌릴 수 있다.
// 방을 공개로 바꾸므로 CC BY 샘플만 쓴다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-openings.mjs
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
const openingsOf = async (page) => JSON.parse(await page.getByTestId('openings').getAttribute('data-json'));
const dbOpenings = async (roomId) => (await admin.from('rooms').select('openings').eq('id', roomId).maybeSingle()).data?.openings;
const saveState = (page) => page.getByTestId('openings-save-state').getAttribute('data-state');
/** 종류·벽·시작·폭을 넣고 "추가"를 누른다 */
const addOpening = async (page, type, wall, from, width) => {
  await page.getByTestId('openings-type').selectOption(type);
  await page.getByTestId('openings-wall').selectOption(String(wall - 1));
  await page.getByTestId('openings-from').fill(String(from));
  await page.getByTestId('openings-width').fill(String(width));
  await page.getByTestId('openings-add').click();
};
const messageOf = async (page) => ((await page.getByTestId('openings-message').count()) ? page.getByTestId('openings-message').innerText() : null);
const DOOR = { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 };
const WINDOW = { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 };
// DB(jsonb)는 키 순서를 바꿔 돌려주므로 키를 정렬해서 비교한다
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
const same = (a, b) => canon(a) === canon(b);

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값 넣기 (4 × 3 m, 벽 1·3은 4m, 벽 2·4는 3m)
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '문·창문 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: calibrationError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  check('준비: 방 업로드 완료, 보정 값 넣음', putStatus === 200 && done.status === 200 && !calibrationError, [putStatus, done.status]);

  // 1) 처음: 접힌 버튼, 0개
  await openRoom(owner, roomId);
  check('처음 연 방: "문·창문 (0)" 버튼', (await owner.getByTestId('openings-toggle').innerText()) === '문·창문 (0)', null);
  await owner.getByTestId('openings-toggle').click();
  const wallOptions = await owner.getByTestId('openings-wall').locator('option').allInnerTexts();
  check('벽 목록에 길이가 나옴', same(wallOptions, ['벽 1 (4.00 m)', '벽 2 (3.00 m)', '벽 3 (4.00 m)', '벽 4 (3.00 m)']), wallOptions);
  check('저장할 것이 없으면 "저장됨", 저장 버튼 없음', (await saveState(owner)) === 'saved' && (await owner.getByTestId('openings-save').count()) === 0, null);

  // 2) 넣기
  await addOpening(owner, 'door', 1, 0.2, 0.9);
  await addOpening(owner, 'window', 3, 1, 1.2);
  check('문과 창문을 넣으면 목록에 나오고 "저장 안 됨"', same(await openingsOf(owner), [DOOR, WINDOW]) && (await saveState(owner)) === 'dirty', await owner.getByTestId('openings-list').locator('li').allInnerTexts());

  // 3) 잘못된 값
  await addOpening(owner, 'window', 1, 0.5, 1);
  const overlapMessage = await messageOf(owner);
  await addOpening(owner, 'door', 2, 2.5, 1);
  const tooLongMessage = await messageOf(owner);
  await addOpening(owner, 'door', 2, 0, 0.1);
  const tooNarrowMessage = await messageOf(owner);
  await addOpening(owner, 'door', 2, '', 0.9);
  const emptyMessage = await messageOf(owner);
  check(
    '겹침·벽보다 긺·너무 좁음·빈 값은 이유와 함께 거부, 목록은 그대로',
    overlapMessage?.includes('겹칩니다') && tooLongMessage?.includes('벽 2의 길이(3.00 m)') && tooNarrowMessage?.includes('0.3 m 이상') && emptyMessage?.includes('숫자로') && (await openingsOf(owner)).length === 2,
    [overlapMessage, tooLongMessage, tooNarrowMessage, emptyMessage],
  );

  // 4) 저장
  check('저장 전: DB는 비어 있음', same(await dbOpenings(roomId), []), null);
  await owner.getByTestId('openings-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=openings-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  check('저장 → DB에 설계서 형식({ type, wallIndex, from, to, widthM })으로 들어감', same(await dbOpenings(roomId), [DOOR, WINDOW]), await dbOpenings(roomId));
  await owner.waitForTimeout(1000);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'openings-panel.png') });

  // 5) 다시 열기
  await owner.reload();
  await owner.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  check('다시 열면: "문·창문 (2)", 값이 그대로', (await owner.getByTestId('openings-toggle').innerText()) === '문·창문 (2)' && same(await openingsOf(owner), [DOOR, WINDOW]), null);

  // 6) 지우기
  await owner.getByTestId('openings-toggle').click();
  await owner.getByRole('button', { name: /^문 · 벽 1 .* 삭제$/ }).click();
  check('문을 지우면 "저장 안 됨", DB는 아직 그대로', (await saveState(owner)) === 'dirty' && same(await dbOpenings(roomId), [DOOR, WINDOW]), null);
  await owner.getByRole('button', { name: '닫기', exact: true }).click();
  check('접어도 저장 안 된 것이 버튼에 보임', (await owner.getByTestId('openings-toggle').innerText()) === '문·창문 (1) · 저장 안 됨', await owner.getByTestId('openings-toggle').innerText());
  await owner.getByTestId('openings-toggle').click();
  await owner.getByTestId('openings-save').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=openings-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 10000 });
  check('다시 저장 → DB에 창문만 남음', same(await dbOpenings(roomId), [WINDOW]), null);

  // 7) DB에 틀린 값이 섞여 있어도 화면은 올바른 것만 읽는다
  await admin.from('rooms').update({ openings: [WINDOW, { ...DOOR, wallIndex: 9 }, { type: 'gate' }, { ...DOOR, wallIndex: 1, from: 2.5, to: 3.4 }, DOOR] }).eq('id', roomId);
  await owner.reload();
  await owner.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  check('틀린 항목(없는 벽, 모르는 종류, 벽을 넘음)은 버리고 읽음', same(await openingsOf(owner), [WINDOW, DOOR]), await openingsOf(owner));

  // 8) 공개 방에서 방 주인이 아닌 사람: 개수만 보이고 고칠 수 없다
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  const guest = await newPage();
  await openRoom(guest, roomId);
  const guestText = await guest.getByTestId('openings').innerText();
  check('다른 사람: "문 1 · 창문 1"만 보이고 넣는 버튼은 없음', guestText === '문 1 · 창문 1' && (await guest.getByTestId('openings-toggle').count()) === 0 && same(await openingsOf(guest), [WINDOW, DOOR]), guestText);
  await guest.waitForTimeout(1500);
  await guest.screenshot({ path: path.join(dataDir, '_e2e', 'openings-guest.png') });

  // 9) 브라우저(로그인 없음)에서 남의 방 openings를 바꿀 수 없다 (RLS)
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  await anon.from('rooms').update({ openings: [] }).eq('id', roomId);
  check('로그인 없이 API로 남의 방 문·창문을 지울 수 없음', same(await dbOpenings(roomId), [WINDOW, { ...DOOR, wallIndex: 9 }, { type: 'gate' }, { ...DOOR, wallIndex: 1, from: 2.5, to: 3.4 }, DOOR]), null);

  // 10) DB 제약: 배열이 아니거나 21개 이상이면 거부
  const notArray = await admin.from('rooms').update({ openings: { a: 1 } }).eq('id', roomId);
  const tooMany = await admin.from('rooms').update({ openings: Array.from({ length: 21 }, () => WINDOW) }).eq('id', roomId);
  check('DB 제약: 배열 아님·21개는 거부', Boolean(notArray.error) && Boolean(tooMany.error), [notArray.error?.code, tooMany.error?.code]);
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
