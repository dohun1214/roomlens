// 업로드 API 실측: 실제 브라우저로 가입한 뒤 방 생성 → 업로드 주소 발급 → R2에 직접 PUT(CORS) →
// 업로드 확인 → presigned GET 주소로 뷰어 로드까지 해 본다.
// 시험용 계정·방·R2 파일은 끝나면 지운다 (secret key, R2 키 필요).
// 준비: npm run dev, ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/converted 에 .sog 파일
// 실행: node --env-file=.env.local scripts/dev-data/e2e-upload.mjs [장면 이름]
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
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
// 장면 파일은 디스크에서 바로 내준다 (브라우저가 같은 출처에서 받아 R2로 올리게 하려는 것)
await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));

/** 페이지 안에서 API 호출 (로그인 쿠키가 함께 간다) */
const api = (method, url, body) =>
  page.evaluate(
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

/** 페이지 안에서 R2로 직접 PUT. source: 'scene'(실제 파일) | 숫자 배열(바이트). cut: 뒤에서 잘라낼 바이트 수 */
const putToR2 = (url, source, { contentType = 'application/octet-stream', cut = 0 } = {}) =>
  page.evaluate(
    async ({ url, source, contentType, cut }) => {
      let blob = source === 'scene' ? await (await fetch('/__e2e_scene')).blob() : new Blob([new Uint8Array(source)]);
      if (cut) blob = blob.slice(0, blob.size - cut);
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        let progressEvents = 0;
        xhr.upload.onprogress = () => progressEvents++;
        xhr.onloadend = () => resolve({ status: xhr.status, progressEvents, sent: blob.size });
        xhr.open('PUT', url);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.send(blob);
      });
    },
    { url, source, contentType, cut },
  );

const roomIds = [];
const newRoom = async (title) => {
  const res = await api('POST', '/api/rooms', { title, consent: true });
  if (res.status === 201) roomIds.push(res.json.room.id);
  return res;
};
const ascii = (text) => [...Buffer.from(text, 'latin1')];

try {
  // 0) 로그인 없이
  const anon = await fetch(`${appUrl}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'x', consent: true }),
  });
  check('비로그인 방 생성 → 401', anon.status === 401, anon.status);

  // 1) 가입 (만 18세 체크)
  await page.goto(`${appUrl}/account`);
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });

  // 2) 방 생성
  const noConsent = await api('POST', '/api/rooms', { title: '동의 없음', consent: false });
  check('동의 없이 방 생성 → 400', noConsent.status === 400 && noConsent.json?.error?.message.includes('동의'), noConsent.json?.error);
  const created = await newRoom('업로드 실측 방');
  const roomId = created.json?.room?.id;
  check('방 생성 → 201, status uploading', created.status === 201 && created.json.room.status === 'uploading', created.json);
  const before = await api('GET', `/api/rooms/${roomId}`);
  check('올리기 전: 내 방으로 보이고 읽기 주소는 없음', before.json?.isOwner === true && before.json?.splatUrl === null, before.status);

  // 3) 업로드 주소 발급
  const tooBig = await api('POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: 100 * 1024 * 1024 + 1 });
  check('100MB 초과 → 주소 발급 거부(400)', tooBig.status === 400, tooBig.json?.error);
  const noFile = await api('PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  check('올리지 않고 완료 요청 → UPLOAD_NOT_FOUND', noFile.json?.error?.code === 'UPLOAD_NOT_FOUND', noFile.json?.error);

  // 4) 서명과 다른 크기·형식으로는 올릴 수 없다
  const signed = await api('POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  check('업로드 주소 발급 → 200', signed.status === 200 && signed.json.url.includes('X-Amz-Signature'), signed.status);
  const shortPut = await putToR2(signed.json.url, 'scene', { cut: 1000 });
  check('약속한 크기와 다르게 올리기 → 실패', shortPut.status !== 200, shortPut);
  const wrongType = await putToR2(signed.json.url, 'scene', { contentType: 'text/plain' });
  check('다른 Content-Type으로 올리기 → 실패', wrongType.status !== 200, wrongType);
  check('실패한 업로드는 R2에 남지 않음', (await listKeys(`rooms/${roomId}/`)).length === 0, null);

  // 5) 가짜 파일은 완료 확인에서 걸러지고 지워진다
  const fakeRoom = (await newRoom('가짜 파일 방')).json.room.id;
  const fake = ascii('this is not a splat file at all');
  const fakeUrl = await api('POST', '/api/upload-url', { roomId: fakeRoom, kind: 'splat', format: 'ply', size: fake.length });
  const fakePut = await putToR2(fakeUrl.json.url, fake);
  const fakeDone = await api('PATCH', `/api/rooms/${fakeRoom}`, { splatFormat: 'ply' });
  check('가짜 파일(텍스트를 .ply로) → UNKNOWN_FORMAT', fakePut.status === 200 && fakeDone.json?.error?.code === 'UNKNOWN_FORMAT', fakeDone.json?.error);
  check('거부된 파일은 R2에서 삭제됨', (await listKeys(`rooms/${fakeRoom}/`)).length === 0, null);

  const v4 = [...ascii('NGSP'), 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const v4Url = await api('POST', '/api/upload-url', { roomId: fakeRoom, kind: 'splat', format: 'spz', size: v4.length });
  await putToR2(v4Url.json.url, v4);
  const v4Done = await api('PATCH', `/api/rooms/${fakeRoom}`, { splatFormat: 'spz' });
  check('SPZ v4 → SPZ_V4_UNSUPPORTED (PLY 안내)', v4Done.json?.error?.code === 'SPZ_V4_UNSUPPORTED' && v4Done.json.error.message.includes('PLY'), v4Done.json?.error);

  const plyAsSog = ascii('ply\nformat binary_little_endian 1.0\n');
  const mismatchUrl = await api('POST', '/api/upload-url', { roomId: fakeRoom, kind: 'splat', format: 'sog', size: plyAsSog.length });
  await putToR2(mismatchUrl.json.url, plyAsSog);
  const mismatch = await api('PATCH', `/api/rooms/${fakeRoom}`, { splatFormat: 'sog' });
  check('형식을 속여 올리기 → FORMAT_MISMATCH', mismatch.json?.error?.code === 'FORMAT_MISMATCH', mismatch.json?.error);

  // 6) 실제 파일 올리기 (브라우저 → R2, CORS)
  const started = Date.now();
  const realPut = await putToR2(signed.json.url, 'scene');
  check(
    `브라우저에서 R2로 직접 업로드 (${(sceneBytes / 1e6).toFixed(1)}MB, ${((Date.now() - started) / 1000).toFixed(1)}초)`,
    realPut.status === 200 && realPut.sent === sceneBytes,
    realPut,
  );
  check('업로드 진행률 이벤트가 온다', realPut.progressEvents > 0, realPut.progressEvents);

  const done = await api('PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  check(
    '업로드 확인 → ready, 크기·형식 저장',
    done.status === 200 && done.json.room.status === 'ready' && done.json.room.splat_bytes === sceneBytes && done.json.room.splat_format === 'sog',
    done.json?.room ?? done.json,
  );
  const again = await api('PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const reissue = await api('POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  check('이미 올린 방에 다시 요청 → 409', again.status === 409 && reissue.status === 409, [again.status, reissue.status]);

  // 7) 읽기
  const after = await api('GET', `/api/rooms/${roomId}`);
  const splatUrl = after.json?.splatUrl;
  check('방 조회에 읽기 주소(presigned GET) 포함, 내부 키는 숨김', Boolean(splatUrl) && !('splat_key' in after.json.room), after.status);
  const anonGet = await fetch(`${appUrl}/api/rooms/${roomId}`);
  check('비공개 방은 남에게 404', anonGet.status === 404, anonGet.status);
  const otherPatch = await fetch(`${appUrl}/api/rooms/${roomId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ splatFormat: 'sog' }),
  });
  check('비로그인 완료 요청 → 401', otherPatch.status === 401, otherPatch.status);

  // 8) presigned GET 주소로 뷰어가 여는지 (R2 CORS GET + Spark의 형식 판별)
  await page.goto(`${appUrl}/viewer?url=${encodeURIComponent(splatUrl)}`, { waitUntil: 'domcontentloaded' });
  const loaded = await page
    .waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 120000 })
    .then(() => true)
    .catch(() => false);
  const stats = (await page.getByTestId('viewer-stats').textContent().catch(() => '')) ?? '';
  check('presigned GET 주소로 3D 뷰어 로드', loaded, stats.replace(/\s+/g, ' ').slice(0, 160));
  await page.waitForTimeout(3000); // 첫 화면이 그려질 때까지
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'upload-viewer.png') }).catch(() => {});

  // 9) 방 개수 제한
  await page.goto(`${appUrl}/account`);
  let last = null;
  for (let i = roomIds.length; i < 11; i++) last = await newRoom(`제한 확인 ${i + 1}`);
  check('11번째 방 → 409 ROOM_LIMIT', roomIds.length === 10 && last?.json?.error?.code === 'ROOM_LIMIT', [roomIds.length, last?.status]);
} catch (err) {
  check('예외 없이 끝까지 실행', false, String(err).slice(0, 300));
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'upload-failure.png') }).catch(() => {});
} finally {
  await browser.close();
  // 정리: R2 파일 → 계정(방은 on delete cascade)
  let removed = 0;
  for (const id of roomIds) {
    const keys = await listKeys(`rooms/${id}/`);
    if (keys.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
      removed += keys.length;
    }
  }
  const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
  const mine = data?.users.filter((u) => u.email === email) ?? [];
  for (const u of mine) await admin.auth.admin.deleteUser(u.id);
  const { count } = roomIds.length
    ? await admin.from('rooms').select('id', { count: 'exact', head: true }).in('id', roomIds)
    : { count: 0 };
  check('시험용 계정·방·R2 파일 삭제', mine.length === 1 && count === 0, `계정 ${mine.length}, 남은 방 ${count}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
