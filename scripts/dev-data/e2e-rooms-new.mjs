// 방 만들기 화면 실측: 실제 브라우저로 가입 → /rooms/new 에서 파일을 골라 올리고 3D로 열어 본다.
// 시험용 계정·방·R2 파일은 끝나면 지운다 (secret key, R2 키 필요).
// 준비: npm run dev, ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/converted 에 .sog 파일
// 실행: node --env-file=.env.local scripts/dev-data/e2e-rooms-new.mjs [장면 이름]
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
const scene = process.argv[2] ?? '0194_840128';
const scenePath = path.join(dataDir, 'converted', `${scene}.sog`);
const sceneBytes = statSync(scenePath).size;
const email = `e2e-${Date.now()}@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`;
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const title = '화면 실측 방';
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

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 200)));
const text = async (testId, timeout = 8000) => (await page.getByTestId(testId).textContent({ timeout }).catch(() => null)) ?? '';
const shot = (name) => page.screenshot({ path: path.join(dataDir, '_e2e', name), fullPage: true }).catch(() => {});
const R2_HOST = /r2\.cloudflarestorage\.com/;

try {
  // 1) 로그인 없이는 들어올 수 없고, 가입하면 원래 가려던 화면으로 온다
  await page.goto(`${appUrl}/rooms/new`);
  check('비로그인으로 /rooms/new → 로그인 화면', page.url().includes('/login?next=%2Frooms%2Fnew'), page.url());
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/rooms/new', { timeout: 15000 });
  check('가입 후 /rooms/new 로 이동, 촬영 안내 표시', (await text('capture-guide')).includes('Scaniverse'), null);
  check('상단 메뉴에 "방 만들기" 링크', await page.getByRole('link', { name: '방 만들기' }).first().isVisible(), null);

  // 2) 파일을 고르는 즉시 확인
  const fileInput = page.getByTestId('room-file');
  await fileInput.setInputFiles({ name: 'room.ply', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not a splat file') });
  check('가짜 파일 → 바로 안내', (await text('room-file-error')).includes('지원하지 않는'), await text('room-file-error'));
  await fileInput.setInputFiles({ name: 'scan.spz', mimeType: 'application/octet-stream', buffer: Buffer.from([0x4e, 0x47, 0x53, 0x50, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) });
  check('SPZ v4 → PLY로 내보내라는 안내', (await text('room-file-error')).includes('PLY'), await text('room-file-error'));
  await page.getByTestId('room-submit').click();
  check('안 되는 파일을 고른 채 제출 → 진행되지 않고 안내만 나옴', (await text('upload-error')).length > 0 && !(await page.getByTestId('upload-progress').isVisible()), await text('upload-error'));

  await fileInput.setInputFiles(scenePath);
  const info = await text('room-file-info');
  check('정상 파일 → 형식·크기 표시', info.includes('SOG') && info.includes('MB') && !(await page.getByTestId('room-file-error').isVisible()), info);

  // 3) 입력 검증
  await page.getByTestId('room-submit').click();
  check('방 이름 없이 제출 → 안내', (await text('upload-error')).includes('방 이름'), await text('upload-error'));
  await page.getByTestId('room-title').fill(title);
  await page.getByTestId('room-description').fill('실측 스크립트가 만든 방');
  await page.getByTestId('room-submit').click();
  check('동의 없이 제출 → 안내', (await text('upload-error')).includes('동의'), await text('upload-error'));
  await page.getByTestId('room-consent').check();
  check('동의를 체크하면 앞선 오류 문구가 사라짐', !(await page.getByTestId('upload-error').isVisible()), null);
  await shot('rooms-new-form.png');

  // 4) 올리는 중 취소 → 다시 시도 (R2 요청을 붙잡아 두고 취소한다)
  await page.route(R2_HOST, () => {});
  await page.getByTestId('room-submit').click();
  await page.getByTestId('upload-cancel').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=upload-progress]')?.getAttribute('data-stage') === 'uploading', null, { timeout: 15000 });
  check('올리는 동안 입력이 잠김', await page.getByTestId('room-title').isDisabled(), null);
  await page.getByTestId('upload-cancel').click();
  check('취소 → 안내 문구', (await text('upload-error')).includes('취소'), await text('upload-error'));
  check('취소 후 버튼이 "다시 시도"', (await text('room-submit')).includes('다시 시도'), await text('room-submit'));
  await page.unroute(R2_HOST);

  // 5) 다시 시도 → 완료. 진행 단계를 기록한다
  await page.evaluate(() => {
    window.__stages = [];
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid=upload-progress]');
      if (el) window.__stages.push(`${el.getAttribute('data-stage')}:${el.getAttribute('data-percent')}`);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const started = Date.now();
  await page.getByTestId('room-submit').click();
  await page.getByTestId('upload-done').waitFor({ timeout: 90000 });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const stages = await page.evaluate(() => [...new Set(window.__stages)]);
  check(`다시 시도 → 업로드 완료 (${(sceneBytes / 1e6).toFixed(1)}MB, ${seconds}초)`, true, null);
  check('진행률이 화면에 표시됨 (올리는 중 %, 확인 중)', stages.some((s) => s.startsWith('uploading:')) && stages.some((s) => s.startsWith('verifying:')), stages.slice(0, 12));
  await shot('rooms-new-done.png');

  // 6) DB: 취소했다가 다시 올려도 방은 하나, ready 상태
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 200 });
  const userId = users?.users.find((u) => u.email === email)?.id;
  const { data: rooms } = await admin.from('rooms').select('id, title, description, status, splat_format, splat_bytes, is_public, consent_at').eq('owner_id', userId);
  const room = rooms?.[0];
  check('방이 하나만 생김 (다시 시도가 같은 방에 이어서 올림)', rooms?.length === 1, rooms?.length);
  check(
    'DB: ready, 크기·형식·제목·동의 시각 저장, 비공개',
    room?.status === 'ready' && room.splat_bytes === sceneBytes && room.splat_format === 'sog' && room.title === title && Boolean(room.consent_at) && room.is_public === false,
    room,
  );
  check('완료 화면의 방 id가 DB와 같음', (await page.getByTestId('upload-done').getAttribute('data-room-id')) === room?.id, null);

  // 7) 3D로 보기
  await page.getByTestId('upload-view').click();
  const loaded = await page
    .waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
  check('"3D로 보기" → 올린 파일이 뷰어에서 열림', loaded, page.url().slice(0, 60));

  check('브라우저 콘솔 오류 없음', errors.filter((e) => !e.includes('422') && !e.includes('ERR_FAILED') && !e.includes('net::')).length === 0, errors.slice(0, 3));
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
  await shot('rooms-new-failure.png');
} finally {
  await browser.close();
  // 정리: R2 파일 → 계정(방은 on delete cascade)
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => u.email === email) ?? [];
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
