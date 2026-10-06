// 방 분석 실측: "분석 시작"을 눌러 3D 화면을 캡처하고 실제 Gemini로 리포트를 받은 뒤,
// 리포트가 저장되고 다시 열어도 보이는지, 카메라·가구가 그대로인지, 권한이 지켜지는지 본다.
// 보정 값은 secret key로 직접 넣으므로 운영 주소에서도 돌릴 수 있다 (카메라 확인은 개발 서버에서만).
// Gemini를 실제로 두 번 부른다. 보낸 그림은 ../roomlens-data/_e2e/analysis-sent-*.jpg 로 남긴다.
// 방을 잠깐 공개로 바꾸므로 CC BY 샘플(Studio 11)만 쓴다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-analysis.mjs
import { createRequire } from 'node:module';
import { statSync, writeFileSync } from 'node:fs';
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

// Studio 11의 거실 (파일 좌표 그대로 방 좌표로 쓴다): x 2.78 ~ 6.33, z -3.05 ~ 2.75
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[2.78, -3.05], [6.33, -3.05], [6.33, 2.75], [2.78, 2.75]];
const OPTION_NAMES = ['에어컨', '세탁기', '냉장고', '인덕션/가스레인지', '전자레인지', '붙박이장', '신발장', '책상', '침대', '옷장', 'TV', '베란다'];

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
const pageErrors = [];
const newPage = async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
/** 개발 서버에서만: 지금 카메라 위치와 화면에 보이는 것의 수 */
const sceneState = (page) =>
  page.evaluate(() => {
    const engine = window.__roomlens;
    if (!engine) return null;
    const r = (v) => Math.round(v * 1000) / 1000;
    return { camera: engine.camera.position.toArray().map(r), target: engine.controls.target.toArray().map(r), visible: engine.scene.children.filter((c) => c.visible).length, enabled: engine.controls.enabled };
  });

try {
  // 준비: 가입 → 방 만들고 파일 올리기 → 보정 값 넣기 → 가구 하나 놓아 두기
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '방 분석 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const { data: ownerRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const ownerId = ownerRow.owner_id;
  await admin.from('layouts').insert({ room_id: roomId, owner_id: ownerId, items: [{ id: 'f1', furnitureRef: 'wardrobe', kind: 'catalog', x: 4.5, z: 0, rotationDeg: 0 }] });
  check('준비: 방 업로드 완료, 보정 값·가구 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);
  const analyzeUrl = `/api/rooms/${roomId}/analyze`;
  const reportsOf = async () => (await admin.from('room_reports').select('id, model, report, created_at').eq('room_id', roomId).order('created_at')).data ?? [];
  const callsOf = async () => (await admin.from('ai_calls').select('kind, status, input_tokens, output_tokens').eq('owner_id', ownerId).order('created_at')).data ?? [];

  const panel = page.getByTestId('analysis-panel');
  const report = page.getByTestId('analysis-report');
  const openRoom = async (p = page) => {
    await p.goto(`${appUrl}/rooms/${roomId}`);
    await p.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
  };

  // 1) 잘못된 요청은 Gemini를 부르지 않는다
  const notJpeg = await api(page, 'POST', analyzeUrl, { images: [{ data: `iVBORw0KGgo${'A'.repeat(200)}`, source: 'photo' }] });
  const none = await api(page, 'POST', analyzeUrl, { images: [] });
  check('JPEG가 아닌 그림·그림 없음: 400, 횟수를 쓰지 않음', notJpeg.status === 400 && none.status === 400 && (await callsOf()).length === 0, [notJpeg.json?.error?.message, none.json?.error?.message]);

  // 2) 처음: 리포트가 없다
  await openRoom();
  await page.waitForTimeout(2000);
  await page.getByTestId('analysis-toggle').click();
  const emptyText = await panel.innerText();
  check('"방 분석"을 누르면: "아직 분석한 적이 없습니다", 무엇을 보내는지와 남은 횟수 10', emptyText.includes('아직 분석한 적이 없습니다') && emptyText.includes('Google Gemini') && emptyText.includes('저장하지 않습니다') && (await page.getByTestId('analysis-controls').getAttribute('data-remaining')) === '10', emptyText);

  // 3) 분석: 방 안에서 여섯 방향을 캡처해 보낸다
  const before = await sceneState(page);
  const started = Date.now();
  await page.getByTestId('analysis-run').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=analysis-panel]')?.getAttribute('data-phase') === 'capturing', null, { timeout: 5000 });
  const capturingText = await page.getByTestId('analysis-run').innerText();
  await report.waitFor({ timeout: 150000 });
  console.log(`분석까지 ${Date.now() - started}ms`);
  const first = JSON.parse(await report.getAttribute('data-json'));
  console.log(JSON.stringify(first, null, 1));
  const sent = await page.getByTestId('analysis-sent').locator('img').evaluateAll((imgs) => imgs.map((img) => img.src));
  sent.forEach((src, i) => writeFileSync(path.join(dataDir, '_e2e', `analysis-sent-${i + 1}.jpg`), Buffer.from(src.replace(/^data:image\/jpeg;base64,/, ''), 'base64')));
  check('누르면 "화면 캡처 중 (n/6)", 그림 6장을 보냄 (한 장 20KB 이상 = 빈 그림이 아님)', /화면 캡처 중 \(\d\/6\)/.test(capturingText) && sent.length === 6 && sent.every((src) => src.startsWith('data:image/jpeg;base64,/9j/') && src.length > 27000), [capturingText, sent.map((s) => Math.round((s.length * 0.75) / 1024))]);
  check('리포트: 옵션 12가지가 모두 한 번씩, 수납·채광·요약이 한국어로 옴', first.options.length === 12 && OPTION_NAMES.every((name) => first.options.filter((o) => o.name === name).length === 1) && ['low', 'medium', 'high', 'unknown'].includes(first.storage.level) && /[가-힣]/.test(first.summary) && first.options.every((o) => /[가-힣]/.test(o.evidence)), first.options.map((o) => `${o.name}:${o.status}`));
  const text = await report.innerText();
  check('화면: 요약, 옵션(있음/없음/확인 안 됨), 수납, 채광, "AI 참고용, 직접 확인 필요", 치수는 추정하지 않는다는 말', ['옵션', '수납', '채광', 'AI 참고용, 직접 확인 필요', '치수는 AI가 추정하지 않습니다'].every((word) => text.includes(word)) && text.includes(first.summary), text);
  const after = await sceneState(page);
  if (before && after) {
    check('분석한 뒤: 카메라가 제자리로, 숨겼던 것(가구·격자)이 다시 보이고, 화면을 다시 돌릴 수 있음', JSON.stringify(before) === JSON.stringify(after) && after.enabled, [before, after]);
  }
  const furniture = JSON.parse(await page.getByTestId('furniture-panel').getAttribute('data-json'));
  check('분석한 뒤: 놓아 둔 가구는 그대로, 남은 횟수 9', furniture.length === 1 && furniture[0].name === '옷장' && (await page.getByTestId('analysis-controls').getAttribute('data-remaining')) === '9' && (await page.getByTestId('ai-suggest').getAttribute('data-remaining')) === '9', furniture.map((i) => i.name));
  const rows = await reportsOf();
  const calls = await callsOf();
  check('DB: 리포트 1건(모델 이름과 함께), 호출 기록 1건(analysis, done)', rows.length === 1 && rows[0].model.startsWith('gemini') && rows[0].report.options.length === 12 && calls.length === 1 && calls[0].kind === 'analysis' && calls[0].status === 'done' && calls[0].input_tokens > 1000, [rows.length, calls]);
  check('그림은 저장하지 않음 (R2에는 3D 파일 하나뿐)', (await listKeys(`rooms/${roomId}/`)).length === 1 && ((await admin.from('room_photos').select('id').eq('room_id', roomId)).data ?? []).length === 0, await listKeys(`rooms/${roomId}/`));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(dataDir, '_e2e', 'analysis-report.png') });

  // 4) 사진을 넣어 다시 분석: 그림 7장, 리포트는 새것 하나만 남는다
  await page.getByTestId('analysis-photos').setInputFiles(path.join(dataDir, '_e2e', 'analysis-sent-1.jpg'));
  await page.getByTestId('analysis-photo-list').waitFor({ timeout: 10000 });
  const photoText = await page.getByTestId('analysis-photo-list').innerText();
  await page.getByTestId('analysis-run').click();
  await page.waitForFunction((id) => document.querySelector('[data-testid=analysis-report]')?.getAttribute('data-report-id') !== id, rows[0].id, { timeout: 150000 });
  const second = await reportsOf();
  check('사진 1장을 넣어 "다시 분석": 그림 7장을 보내고, 리포트는 새것 하나만 남음', photoText.includes('사진 1장') && (await page.getByTestId('analysis-sent').getAttribute('data-count')) === '7' && second.length === 1 && second[0].id !== rows[0].id && (await callsOf()).length === 2, [photoText, second.length]);

  // 5) 다시 열어도 리포트가 보인다
  await openRoom();
  check('새로고침하면: "방 분석 ✓"', (await page.getByTestId('analysis-toggle').innerText()).includes('✓'), await page.getByTestId('analysis-toggle').innerText());
  await page.getByTestId('analysis-toggle').click();
  check('다시 열어도 저장된 리포트가 보임 ("다시 분석" 버튼)', (await report.getAttribute('data-report-id')) === second[0].id && (await page.getByTestId('analysis-run').innerText()) === '다시 분석', await report.getAttribute('data-report-id'));

  // 6) 다른 사람: 공개 방이면 리포트는 보이지만 분석은 못 한다
  const anonymous = await newPage();
  await anonymous.goto(`${appUrl}/`);
  const anon = await api(anonymous, 'POST', analyzeUrl, { images: [{ data: sent[0].replace(/^data:image\/jpeg;base64,/, ''), source: 'capture' }] });
  const visitor = await newPage();
  await signUp(visitor, emails.visitor);
  const privateTry = await api(visitor, 'POST', analyzeUrl, { images: [{ data: sent[0].replace(/^data:image\/jpeg;base64,/, ''), source: 'capture' }] });
  await admin.from('rooms').update({ is_public: true }).eq('id', roomId);
  const publicTry = await api(visitor, 'POST', analyzeUrl, { images: [{ data: sent[0].replace(/^data:image\/jpeg;base64,/, ''), source: 'capture' }] });
  await openRoom(visitor);
  await visitor.getByTestId('analysis-toggle').click();
  const visitorSees = (await visitor.getByTestId('analysis-report').getAttribute('data-report-id')) === second[0].id && (await visitor.getByTestId('analysis-controls').count()) === 0;
  await admin.from('rooms').update({ is_public: false }).eq('id', roomId);
  check('로그인하지 않으면 401, 다른 사람은 비공개든 공개든 404, 호출 기록은 그대로 2건', anon.status === 401 && privateTry.status === 404 && publicTry.status === 404 && (await callsOf()).length === 2, [anon.status, privateTry.status, publicTry.status]);
  check('공개 방의 다른 사람: 리포트는 보이고 분석 버튼은 없음', visitorSees, null);
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
  check('시험용 계정·방·R2 파일 삭제', mine.length === 2, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail).slice(0, 600) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
