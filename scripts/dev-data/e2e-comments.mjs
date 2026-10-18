// 방 코멘트 실측: 방 주인·다른 사용자·비로그인이 같은 방을 열어 코멘트를 읽고, 쓰고, 지운다.
// 권한(누가 읽고 쓰고 지우는지)은 RLS가 정하므로 화면과 함께 Supabase에 직접 요청해서도 확인한다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-comments.mjs
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
const emails = { owner: `e2e-${stamp}-o@${domain}`, visitor: `e2e-${stamp}-v@${domain}` };
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
/** 시험용 계정으로 로그인한 Supabase 클라이언트 (RLS 확인용) */
const asUser = async (email) => {
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`로그인 실패: ${error.message}`);
  return client;
};
const anonClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
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
/** 방을 열고 코멘트 도구를 고른 뒤 목록이 읽힐 때까지 기다린다 */
const openComments = async (page, roomId) => {
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await page.getByTestId('comments-toggle').waitFor({ timeout: 120000 });
  await page.getByTestId('comments-toggle').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=comments-panel]')?.getAttribute('data-count') !== '', null, { timeout: 15000 });
};
const count = async (page) => Number(await page.getByTestId('comments-panel').getAttribute('data-count'));
const items = (page) => page.getByTestId('comment-item');
const send = async (page, text) => {
  const before = await count(page);
  await page.getByTestId('comments-input').fill(text);
  await page.getByTestId('comments-send').click();
  await page.waitForFunction((n) => Number(document.querySelector('[data-testid=comments-panel]')?.getAttribute('data-count')) === n, before + 1, { timeout: 10000 });
};
const lastItem = (page) => items(page).last();

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값 넣기 (아직 비공개)
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: '코멘트 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: calibrationError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  check('준비: 방 업로드 완료, 보정 값 넣음', putStatus === 200 && done.status === 200 && !calibrationError, [putStatus, done.status]);

  // 1) 비공개 방: 주인 혼자 메모로 쓴다
  await openComments(owner, roomId);
  check('비공개 방 주인: 빈 목록 + "나만 봅니다" 안내 + 입력칸', (await owner.getByTestId('comments-empty').isVisible()) && (await owner.getByTestId('comments-panel').innerText()).includes('나만 봅니다') && (await owner.getByTestId('comments-input').isVisible()), null);
  check('빈 내용이면 "남기기"를 누를 수 없음', await owner.getByTestId('comments-send').isDisabled(), null);
  await owner.getByTestId('comments-input').fill('   ');
  check('공백만 있어도 누를 수 없음', await owner.getByTestId('comments-send').isDisabled(), null);
  await send(owner, '침대는 창문 쪽이 좋을까?');
  const ownerFirst = lastItem(owner);
  check('주인 코멘트: 목록에 추가, 내 것, "방 주인" 표시, "방금"', (await ownerFirst.getAttribute('data-mine')) === 'true' && (await ownerFirst.innerText()).includes('방 주인') && (await ownerFirst.innerText()).includes('방금') && (await count(owner)) === 1, await ownerFirst.innerText());
  check('보낸 뒤 입력칸 비움', (await owner.getByTestId('comments-input').inputValue()) === '', null);

  // 연달아 보내면 잠깐 막는다
  await owner.getByTestId('comments-input').fill('두 번째');
  await owner.getByTestId('comments-send').click();
  await owner.getByTestId('comments-message').waitFor({ timeout: 3000 });
  check('3초 안에 또 보내면 "잠시 뒤에" 안내, 늘지 않음', (await owner.getByTestId('comments-message').innerText()).includes('잠시 뒤에') && (await count(owner)) === 1, null);
  await owner.waitForTimeout(3200);
  // 여러 줄 + Ctrl+Enter
  await owner.getByTestId('comments-input').fill('첫 줄\n\n\n\n둘째 줄  ');
  await owner.getByTestId('comments-input').press('Control+Enter');
  await owner.waitForFunction(() => Number(document.querySelector('[data-testid=comments-panel]')?.getAttribute('data-count')) === 2, null, { timeout: 10000 });
  const { data: multi } = await admin.from('comments').select('body').eq('room_id', roomId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  check('Ctrl+Enter로 보냄, 빈 줄은 두 줄까지·끝 공백 제거해 저장', multi?.body === '첫 줄\n\n둘째 줄', multi?.body);

  // 비공개 방은 남이 읽지도 쓰지도 못한다 (RLS)
  const visitorPage = await newPage();
  await signUp(visitorPage, emails.visitor);
  const visitorDb = await asUser(emails.visitor);
  const privRead = await visitorDb.from('comments').select('id').eq('room_id', roomId);
  const privWrite = await visitorDb.from('comments').insert({ room_id: roomId, body: '몰래' }).select('id');
  const anonPriv = await anonClient.from('comments').select('id').eq('room_id', roomId);
  check('비공개 방: 남·비로그인은 코멘트를 읽지 못함', privRead.data?.length === 0 && anonPriv.data?.length === 0, [privRead.data?.length, anonPriv.data?.length]);
  check('비공개 방: 남은 코멘트를 쓰지 못함', Boolean(privWrite.error), privWrite.error?.code);

  // 2) 방을 공개하면 (화면에서) 안내가 사라진다
  await owner.getByTestId('room-visibility-toggle').click();
  await owner.getByTestId('room-confirm-yes').click();
  await owner.waitForFunction(() => document.querySelector('[data-testid=room-visibility]')?.textContent === '공개', null, { timeout: 8000 });
  await owner.waitForFunction(() => !document.querySelector('[data-testid=comments-panel]')?.textContent?.includes('나만 봅니다'), null, { timeout: 8000 });
  check('공개로 바꾸면 "나만 봅니다" 안내가 사라짐', true, null);

  // 3) 비로그인: 읽기만
  const anon = await newPage();
  await openComments(anon, roomId);
  check('비로그인: 코멘트 2개를 읽음, 입력칸 없이 로그인 안내', (await count(anon)) === 2 && (await anon.getByTestId('comments-input').count()) === 0 && (await anon.getByTestId('comments-login-hint').isVisible()), await count(anon));
  check('비로그인: 지우기 버튼 없음', (await anon.getByTestId('comment-delete').count()) === 0, null);
  const loginHref = await anon.getByTestId('comments-login-hint').locator('a').getAttribute('href');
  check('로그인 안내는 이 방으로 돌아오는 주소', loginHref?.includes(encodeURIComponent(`/rooms/${roomId}`)) || loginHref?.includes(`/rooms/${roomId}`), loginHref);
  const anonWrite = await anonClient.from('comments').insert({ room_id: roomId, body: '익명' }).select('id');
  check('비로그인은 DB에 직접 써도 막힘', Boolean(anonWrite.error), anonWrite.error?.code);

  // 4) 다른 사용자: 읽고, 쓰고, 내 것만 지운다
  await openComments(visitorPage, roomId);
  check('다른 사용자: 주인 코멘트를 읽고, 주인 것에는 지우기 버튼 없음', (await count(visitorPage)) === 2 && (await visitorPage.getByTestId('comment-delete').count()) === 0, null);
  await send(visitorPage, '책상을 창가에 두면 어때요?');
  const mine = lastItem(visitorPage);
  check('다른 사용자 코멘트: 내 것, "방 주인" 표시 없음, 지우기 버튼 있음', (await mine.getAttribute('data-mine')) === 'true' && !(await mine.innerText()).includes('방 주인') && (await mine.getByTestId('comment-delete').count()) === 1, await mine.innerText());
  const ownerCommentId = await items(visitorPage).first().getAttribute('data-id');
  const stealDelete = await visitorDb.from('comments').delete().eq('id', ownerCommentId).select('id');
  check('다른 사용자는 DB에 직접 요청해도 주인 코멘트를 못 지움', (stealDelete.data?.length ?? 0) === 0, stealDelete.error?.code);
  const fakeAuthor = await visitorDb.from('comments').insert({ room_id: roomId, body: '사칭', author_id: (await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle()).data.owner_id }).select('id');
  check('다른 사람 이름(author_id)으로는 쓰지 못함', Boolean(fakeAuthor.error), fakeAuthor.error?.code);
  // 내 코멘트 지우기: 확인 → 취소 → 다시 → 지우기
  await mine.getByTestId('comment-delete').click();
  await visitorPage.getByRole('button', { name: '취소' }).click();
  check('지우기 확인에서 취소하면 그대로', (await count(visitorPage)) === 3, null);
  await mine.getByTestId('comment-delete').click();
  await visitorPage.getByTestId('comment-delete-yes').click();
  await visitorPage.waitForFunction(() => Number(document.querySelector('[data-testid=comments-panel]')?.getAttribute('data-count')) === 2, null, { timeout: 10000 });
  check('내 코멘트를 지우면 목록에서 빠짐', true, null);
  await visitorPage.waitForTimeout(3200);
  await send(visitorPage, '소파는 문 반대편이 좋겠어요.');

  // 5) 방 주인: 새로 고침으로 남의 코멘트를 보고, 지울 수 있다
  await owner.getByTestId('comments-refresh').click();
  await owner.waitForFunction(() => Number(document.querySelector('[data-testid=comments-panel]')?.getAttribute('data-count')) === 3, null, { timeout: 10000 });
  const others = lastItem(owner);
  check('주인: 새로 고침하면 남의 코멘트가 보이고 지우기 버튼 있음', (await others.getAttribute('data-mine')) === 'false' && (await others.innerText()).includes('소파는 문 반대편') && (await others.getByTestId('comment-delete').count()) === 1, await others.innerText());
  await owner.waitForTimeout(800);
  await owner.screenshot({ path: path.join(dataDir, '_e2e', 'comments-owner.png') });
  await others.getByTestId('comment-delete').click();
  check('주인이 남의 것을 지울 때는 "(방 주인)" 확인 문구', (await owner.getByTestId('comments-panel').innerText()).includes('(방 주인)'), null);
  await owner.getByTestId('comment-delete-yes').click();
  await owner.waitForFunction(() => Number(document.querySelector('[data-testid=comments-panel]')?.getAttribute('data-count')) === 2, null, { timeout: 10000 });
  const { count: dbCount } = await admin.from('comments').select('id', { count: 'exact', head: true }).eq('room_id', roomId);
  check('주인이 남의 코멘트를 지움 (DB에서도 2개)', dbCount === 2, dbCount);

  // 6) 다시 열어도 그대로, 오래된 것부터
  await openComments(anon, roomId);
  const texts = await items(anon).allInnerTexts();
  check('다시 열면 2개, 오래된 것부터', texts.length === 2 && texts[0].includes('침대는 창문') && texts[1].includes('둘째 줄'), texts.map((t) => t.replace(/\s+/g, ' ')));

  // 7) 폰 화면: 도구 탭에 코멘트가 있고 패널이 열린다
  const phone = await newPage({ width: 390, height: 844 });
  await openComments(phone, roomId);
  const box = await phone.getByTestId('tool-rail').boundingBox();
  check('폰: 도구 탭이 화면 안에 들어가고 코멘트 2개', box && box.x >= 0 && box.x + box.width <= 390 && (await count(phone)) === 2, box);
  await phone.waitForTimeout(800);
  await phone.screenshot({ path: path.join(dataDir, '_e2e', 'comments-phone.png') });
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
  check('시험용 계정·방·R2 파일 삭제', mine.length === 2, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
