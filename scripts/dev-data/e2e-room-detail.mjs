// 방 상세 페이지 실측: 3D 투어, 공개/비공개, 삭제(R2 파일 포함), 남의 방 접근 차단.
// 시험용 계정·방·R2 파일은 끝나면 지운다 (secret key, R2 키 필요).
// 준비: npm run dev, ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog (CC BY 샘플)
// 실행: node --env-file=.env.local scripts/dev-data/e2e-room-detail.mjs [장면 이름]
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
// 이 실측은 방을 잠깐 공개로 바꾼다. 로컬 개발 서버도 운영과 같은 DB·R2를 쓰므로
// 다시 배포해도 되는 파일(CC BY 샘플)을 기본으로 쓴다. 장면 이름을 주면 converted 폴더의 파일을 쓴다.
const scenePath = process.argv[2]
  ? path.join(dataDir, 'converted', `${process.argv[2]}.sog`)
  : path.join(dataDir, 'samples', 'studio11_1m_up.sog');
const sceneBytes = statSync(scenePath).size;
const stamp = Date.now();
const domain = process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test';
const emails = { owner: `e2e-${stamp}-a@${domain}`, other: `e2e-${stamp}-b@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const title = '상세 페이지 실측 방';
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

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
const roomExists = async (id) => ((await admin.from('rooms').select('id').eq('id', id)).data ?? []).length === 1;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const newPage = async () => (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
const page = await newPage(); // 방 주인
const anon = await newPage(); // 로그인하지 않은 사람
const other = await newPage(); // 다른 사용자

const signUp = async (p, email) => {
  await p.goto(`${appUrl}/account`);
  await p.getByRole('tab', { name: '가입' }).click();
  await p.getByLabel('이메일').fill(email);
  await p.getByLabel(/비밀번호/).fill(password);
  await p.getByLabel('만 18세 이상입니다.').check();
  await p.getByRole('button', { name: '가입하기' }).click();
  await p.waitForURL('**/account', { timeout: 15000 });
};
const api = (p, method, url, body) =>
  p.evaluate(
    async ({ method, url, body }) => {
      const res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, url, body },
  );
/** 그 주소가 열리는지(HTTP 상태)와 방 제목 */
const visit = async (p, url) => {
  const res = await p.goto(url, { waitUntil: 'domcontentloaded' });
  const shown = await p.getByTestId('room-title').textContent({ timeout: 1500 }).catch(() => null);
  return { status: res?.status() ?? 0, title: shown };
};
const viewerReady = (p) =>
  p
    .waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
const text = async (p, testId) => (await p.getByTestId(testId).textContent({ timeout: 8000 }).catch(() => null)) ?? '';

try {
  await signUp(page, emails.owner);
  await signUp(other, emails.other);
  const nickname = await text(page, 'header-nickname');

  // 준비: 파일을 올린 방 하나, 올리지 않은 방 하나 (API로)
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title, description: '상세 설명', consent: true })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const emptyId = (await api(page, 'POST', '/api/rooms', { title: '올리다 만 방', consent: true })).json.room.id;
  check('준비: 방 업로드 완료', putStatus === 200 && done.status === 200, [putStatus, done.status]);
  const roomUrl = `${appUrl}/rooms/${roomId}`;

  // 1) 주인이 보는 방
  const mine = await visit(page, roomUrl);
  check('주인: 방 화면이 열리고 제목·닉네임 표시', mine.status === 200 && mine.title === title && (await text(page, 'room-owner')) === nickname, mine);
  check('주인: 3D 뷰어가 방 파일을 엶', await viewerReady(page), (await text(page, 'viewer-stats')).replace(/\s+/g, ' ').slice(0, 90));
  const statsText = await text(page, 'viewer-stats');
  check('뷰어에 서명된 주소 대신 방 이름이 보임', statsText.includes(title) && !statsText.includes('X-Amz'), null);
  check('방 화면에는 개발용 URL 입력칸이 없음', (await page.getByPlaceholder('SPZ / PLY URL').count()) === 0, null);
  check('처음에는 비공개', (await text(page, 'room-visibility')) === '비공개', null);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'room-detail.png') }).catch(() => {});

  // 2) 비공개 방은 남에게 404
  check('비공개 방: 비로그인 404', (await visit(anon, roomUrl)).status === 404, null);
  check('비공개 방: 다른 사용자 404', (await visit(other, roomUrl)).status === 404, null);

  // 3) 공개 (한 번 더 확인)
  await page.getByTestId('room-visibility-toggle').click();
  check('공개 전 확인 문구', (await text(page, 'room-confirm-text')).includes('누구나'), null);
  await page.getByTestId('room-confirm-no').click();
  check('취소하면 그대로 비공개', (await text(page, 'room-visibility')) === '비공개', null);
  await page.getByTestId('room-visibility-toggle').click();
  await page.getByTestId('room-confirm-yes').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=room-visibility]')?.textContent === '공개', null, { timeout: 8000 });
  check('공개로 바뀜', true, null);
  const publicView = await visit(anon, roomUrl);
  check('공개 방: 비로그인도 열림', publicView.status === 200 && publicView.title === title, publicView);
  check('공개 방: 남에게는 관리 버튼이 없음', (await anon.getByTestId('room-owner-controls').count()) === 0, null);
  check('공개 방: 비로그인도 3D 로드', await viewerReady(anon), null);

  // 4) 남은 지울 수 없음
  check('삭제 API: 비로그인 401', (await api(anon, 'DELETE', `/api/rooms/${roomId}`)).status === 401, null);
  check('삭제 API: 다른 사용자 404 (공개 방이어도)', (await api(other, 'DELETE', `/api/rooms/${roomId}`)).status === 404, null);
  check('남의 삭제 시도 후에도 방과 파일이 그대로', (await roomExists(roomId)) && (await listKeys(`rooms/${roomId}/`)).length === 1, null);

  // 5) 다시 비공개
  await page.getByTestId('room-visibility-toggle').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=room-visibility]')?.textContent === '비공개', null, { timeout: 8000 });
  check('비공개로 되돌리면 남에게 다시 404', (await visit(anon, roomUrl)).status === 404, null);

  // 6) 파일을 올리지 않은 방
  const emptyView = await visit(page, `${appUrl}/rooms/${emptyId}`);
  check('올리다 만 방: 주인에게 안내 표시', emptyView.status === 200 && (await page.getByTestId('room-not-ready').isVisible()), emptyView);
  check('올리다 만 방: 공개 버튼 없음, 삭제 버튼 있음', (await page.getByTestId('room-visibility-toggle').count()) === 0 && (await page.getByTestId('room-delete').count()) === 1, null);
  await page.getByTestId('room-delete').click();
  await page.getByTestId('room-confirm-yes').click();
  await page.waitForURL(`${appUrl}/`, { timeout: 15000 });
  check('올리다 만 방 삭제 → 홈으로 이동, DB에서 사라짐', !(await roomExists(emptyId)), null);

  // 7) 방 삭제: 확인 → R2 파일까지 삭제
  await visit(page, roomUrl);
  await page.getByTestId('room-delete').click();
  check('삭제 전 확인 문구', (await text(page, 'room-confirm-text')).includes('되돌릴 수 없습니다'), null);
  await page.getByTestId('room-confirm-no').click();
  check('취소하면 방이 그대로', await roomExists(roomId), null);
  await page.getByTestId('room-delete').click();
  await page.getByTestId('room-confirm-yes').click();
  await page.waitForURL(`${appUrl}/`, { timeout: 20000 });
  check('삭제 → 홈으로 이동', true, null);
  check('삭제: DB에서 사라짐', !(await roomExists(roomId)), null);
  check('삭제: R2 파일도 사라짐', (await listKeys(`rooms/${roomId}/`)).length === 0, null);
  check('지운 방 주소는 주인에게도 404', (await visit(page, roomUrl)).status === 404, null);
  check('잘못된 방 주소 404', (await visit(page, `${appUrl}/rooms/not-a-room`)).status === 404, null);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'room-detail-failure.png') }).catch(() => {});
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
  check('시험용 계정 삭제 (남은 파일 없음)', mine.length === 2 && removed === 0, `계정 ${mine.length}, 정리 때 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
