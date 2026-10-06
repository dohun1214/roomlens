// AI 배치 추천 실측: 실제 Gemini를 불러 추천을 받고, AI 배치가 따로 저장되는지와 권한·횟수 제한을 본다.
// 보정 값은 secret key로 직접 넣으므로 운영 주소에서도 돌릴 수 있다. 방은 비공개로만 만든다.
// Gemini를 실제로 부른다 (한 번 실행에 추천 1~2회, 몇 원 수준).
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-layout-suggest.mjs
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

// 시험용 방: 4 × 3 m 사각형. 문은 벽 1(z=-1.5)의 x -1.8 ~ -0.9, 창문은 벽 3(z=1.5)의 x -0.2 ~ 1
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];
const OPENINGS = [
  { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 },
  { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 },
];
const ITEMS = [
  { id: 'f1', furnitureRef: 'bed-single', kind: 'catalog' },
  { id: 'f2', furnitureRef: 'desk', kind: 'catalog' },
  { id: 'f3', furnitureRef: 'wardrobe', kind: 'catalog' },
  { id: 'f4', furnitureRef: 'chair', kind: 'catalog' },
];
const SIZES = { 'bed-single': [1.0, 2.0], desk: [1.2, 0.6], wardrobe: [0.9, 0.6], chair: [0.5, 0.5] };

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
      const started = performance.now();
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null), ms: Math.round(performance.now() - started) };
    },
    { method, url, body },
  );

/** 가구 밑면의 네 꼭짓점 범위 (90° 단위 회전만 나온다고 본다) */
const extent = (item) => {
  const [w, d] = SIZES[item.furnitureRef];
  const turned = Math.round(item.rotationDeg / 90) % 2 !== 0;
  const [hw, hd] = turned ? [d / 2, w / 2] : [w / 2, d / 2];
  return { minX: item.x - hw, maxX: item.x + hw, minZ: item.z - hd, maxZ: item.z + hd };
};
const overlaps = (a, b) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > 0.02 && Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ) > 0.02;

try {
  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기
  const owner = await newPage();
  await signUp(owner, emails.owner);
  await owner.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(owner, 'POST', '/api/rooms', { title: 'AI 추천 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(owner, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await owner.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(owner, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { data: ownerRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const ownerId = ownerRow.owner_id;
  check('준비: 방 업로드 완료', putStatus === 200 && done.status === 200, [putStatus, done.status]);
  const suggestUrl = `/api/rooms/${roomId}/layout-suggest`;
  const callsOf = async () => (await admin.from('ai_calls').select('kind, status, attempts, input_tokens, output_tokens, model, error').eq('owner_id', ownerId).order('created_at')).data ?? [];
  const layoutsOf = async () => (await admin.from('layouts').select('id, name, created_by, ai_summary, items, owner_id, is_public').eq('room_id', roomId).order('created_at')).data ?? [];

  // 1) 보정 전에는 추천할 수 없다
  const notCalibrated = await api(owner, 'POST', suggestUrl, { items: ITEMS, request: '' });
  check('보정하지 않은 방: 400 NOT_CALIBRATED, 횟수를 쓰지 않음', notCalibrated.status === 400 && notCalibrated.json?.error?.code === 'NOT_CALIBRATED' && (await callsOf()).length === 0, notCalibrated.json);
  const { error: calibrationError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, openings: OPENINGS }).eq('id', roomId);
  check('준비: 보정 값·문·창문 넣음', !calibrationError, calibrationError?.message);

  // 2) 요청 형식
  const empty = await api(owner, 'POST', suggestUrl, { items: [] });
  const unknown = await api(owner, 'POST', suggestUrl, { items: [{ id: 'f1', furnitureRef: 'no-such-furniture', kind: 'catalog' }] });
  const duplicated = await api(owner, 'POST', suggestUrl, { items: [ITEMS[0], ITEMS[0]] });
  check('가구 없음·모르는 가구·같은 id 두 번: 400, 횟수를 쓰지 않음', empty.status === 400 && unknown.status === 400 && duplicated.status === 400 && (await callsOf()).length === 0, [empty.json?.error?.message, unknown.json?.error?.message, duplicated.json?.error?.message]);

  // 3) 로그인하지 않은 사람, 방을 볼 수 없는 사람
  const anonymous = await newPage();
  await anonymous.goto(`${appUrl}/`);
  const anon = await api(anonymous, 'POST', suggestUrl, { items: ITEMS });
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  const stranger = await api(visitor, 'POST', suggestUrl, { items: ITEMS });
  check('로그인하지 않으면 401, 비공개 방의 다른 사람은 404', anon.status === 401 && stranger.status === 404, [anon.status, stranger.status]);

  // 4) 실제 추천. 먼저 오래된 AI 배치 5개와 내 배치 1개를 넣어 둔다 (가장 오래된 AI 배치가 지워져야 한다)
  const oldRows = Array.from({ length: 5 }, (_, i) => ({ room_id: roomId, owner_id: ownerId, name: `AI 배치 옛날 ${i + 1}`, created_by: 'ai', items: [], created_at: new Date(Date.now() - (10 - i) * 60000).toISOString() }));
  const { error: mineError } = await admin.from('layouts').insert({ room_id: roomId, owner_id: ownerId, items: [{ ...ITEMS[1], x: 0, z: 0, rotationDeg: 0 }] });
  const { error: oldError } = await admin.from('layouts').insert(oldRows);
  const before = await layoutsOf();
  check('준비: 내 배치 1개와 오래된 AI 배치 5개 넣음', !mineError && !oldError && before.length === 6, [mineError?.message, oldError?.message]);
  const suggested = await api(owner, 'POST', suggestUrl, { items: ITEMS, request: '책상은 창가에 두고 싶어요' });
  const body = suggested.json ?? {};
  console.log(`추천 응답 ${suggested.ms}ms, Gemini ${body.attempts}번`);
  console.log(JSON.stringify({ summary: body.summary, items: body.layout?.items, reasons: body.reasons, unmet: body.unmet, failures: body.failures }, null, 1));
  check('추천: 200, Gemini 1~3번, 남은 횟수 9', suggested.status === 200 && body.attempts >= 1 && body.attempts <= 3 && body.remaining === 9, [suggested.status, body.attempts, body.remaining, body.error]);
  const items = body.layout?.items ?? [];
  const KEYS = JSON.stringify(['furnitureRef', 'id', 'kind', 'rotationDeg', 'x', 'z']);
  check('결과: 가구 4개 모두, 저장 형식(id, furnitureRef, kind, x, z, rotationDeg)', items.length === 4 && items.every((i) => JSON.stringify(Object.keys(i).sort()) === KEYS) && items.map((i) => i.id).sort().join() === 'f1,f2,f3,f4', items);
  const boxes = items.map(extent);
  const inside = boxes.every((b) => b.minX >= -2.021 && b.maxX <= 2.021 && b.minZ >= -1.521 && b.maxZ <= 1.521);
  const collide = boxes.some((a, i) => boxes.some((b, j) => i < j && overlaps(a, b)));
  const doorZone = { minX: -1.8, maxX: -0.9, minZ: -1.5, maxZ: -0.6 };
  check('결과: 모두 방 안, 서로 겹치지 않음, 문 앞을 막지 않음', inside && !collide && !boxes.some((b) => overlaps(b, doorZone)), boxes);
  const desk = items.find((i) => i.id === 'f2');
  check('요청 반영: 책상이 창문이 있는 벽(z=1.5)에 붙음', desk && Math.abs(extent(desk).maxZ - 1.5) < 0.03, desk);
  check('이유: 전체 의도와 가구별 이유가 한국어로 옴', typeof body.summary === 'string' && body.summary.length > 0 && body.reasons?.length >= 3 && body.reasons.every((r) => /[가-힣]/.test(r.reason)), body.reasons?.length);

  const after = await layoutsOf();
  const created = after.find((l) => l.id === body.layout?.id);
  const mine = after.filter((l) => l.created_by === 'user');
  check('DB: AI 배치가 별도 행으로 저장 (created_by ai, 비공개, 이름 "AI 배치 …", 이유 글)', created && created.created_by === 'ai' && created.owner_id === ownerId && created.is_public === false && /^AI 배치 \d+\/\d+ \d\d:\d\d$/.test(created.name) && created.ai_summary?.includes('- ') && created.items.length === 4, created && { name: created.name, summary: created.ai_summary });
  check('DB: 내 배치는 그대로 (덮어쓰지 않음)', mine.length === 1 && mine[0].items.length === 1 && mine[0].id === before.find((l) => l.created_by === 'user').id, mine.map((l) => l.items.length));
  const aiNames = after.filter((l) => l.created_by === 'ai').map((l) => l.name);
  check('DB: AI 배치는 최근 5개만 (가장 오래된 것이 지워짐)', aiNames.length === 5 && !aiNames.includes('AI 배치 옛날 1') && body.removedLayoutIds?.length === 1, aiNames);
  const calls = await callsOf();
  check('DB: 호출 기록 1건 (layout, done, 토큰 수 기록)', calls.length === 1 && calls[0].kind === 'layout' && calls[0].status === 'done' && calls[0].attempts === body.attempts && calls[0].input_tokens > 0 && calls[0].output_tokens > 0, calls);

  // 5) 하루 10회 제한: 기록을 9건 더 넣으면 11번째는 거부된다
  await admin.from('ai_calls').insert(Array.from({ length: 9 }, () => ({ owner_id: ownerId, room_id: roomId, kind: 'layout', status: 'done' })));
  const limited = await api(owner, 'POST', suggestUrl, { items: ITEMS });
  check('오늘 10회를 썼으면: 429 AI_LIMIT, 배치를 만들지 않음', limited.status === 429 && limited.json?.error?.code === 'AI_LIMIT' && (await layoutsOf()).length === after.length, limited.json);
  // 실패한 호출과 어제의 호출은 세지 않는다 (Gemini를 부르지 않게 가구 목록을 틀리게 보내 횟수 확인만 통과시킨다)
  const { data: extra } = await admin.from('ai_calls').select('id').eq('owner_id', ownerId).order('created_at').limit(2);
  await admin.from('ai_calls').update({ status: 'failed' }).eq('id', extra[0].id);
  await admin.from('ai_calls').update({ created_at: new Date(Date.now() - 25 * 3600000).toISOString() }).eq('id', extra[1].id);
  const { count: counted } = await admin.from('ai_calls').select('id', { count: 'exact', head: true }).eq('owner_id', ownerId).in('status', ['running', 'done']).gte('created_at', new Date(Date.now() - 3600000).toISOString());
  check('실패한 호출·어제의 호출을 빼면 8회로 센다', counted === 8, counted);
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
