// AI 배치 추천 화면 실측: 가구를 놓고 "AI 추천"을 눌러 실제 Gemini의 추천을 받은 뒤,
// AI 배치가 따로 저장되는지, 배치를 바꿔 볼 수 있는지, 새로고침해도 남는지, 지울 수 있는지 본다.
// 보정 값은 secret key로 직접 넣으므로 운영 주소에서도 돌릴 수 있다. 방은 비공개로만 만든다.
// Gemini를 실제로 한 번 부른다.
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-ai-layout.mjs
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

// 시험용 방: 4 × 3 m 사각형. 문은 벽 1(z=-1.5)의 x -1.8 ~ -0.9, 창문은 벽 3(z=1.5)의 x -0.2 ~ 1
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-2, -1.5], [2, -1.5], [2, 1.5], [-2, 1.5]];
const OPENINGS = [
  { type: 'door', wallIndex: 0, from: 0.2, to: 1.1, widthM: 0.9 },
  { type: 'window', wallIndex: 2, from: 1, to: 2.2, widthM: 1.2 },
];

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
const mm = (v) => Math.round(v * 1000) / 1000 + 0;
const positions = (items) => items.map((i) => [i.name, mm(i.x), mm(i.z), i.rotationDeg]);
const spots = (items) => items.map((i) => [mm(i.x), mm(i.z)]);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  // 준비: 가입 → 방 만들고 파일 올리기 → 보정 값·문·창문 넣기
  const page = await newPage();
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: 'AI 배치 화면 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR, openings: OPENINGS }).eq('id', roomId);
  const { data: ownerRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const ownerId = ownerRow.owner_id;
  check('준비: 방 업로드 완료, 보정 값·문·창문 넣음', putStatus === 200 && done.status === 200 && !setupError, [putStatus, done.status]);

  const panel = page.getByTestId('furniture-panel');
  const items = async () => JSON.parse(await panel.getAttribute('data-json'));
  const ai = page.getByTestId('ai-suggest');
  const chooser = page.getByTestId('layout-chooser');
  const saveState = () => page.getByTestId('layout-save-state').getAttribute('data-state');
  const layoutsOf = async () => (await admin.from('layouts').select('id, name, created_by, ai_summary, items').eq('room_id', roomId).order('created_at')).data ?? [];
  const openRoom = async () => {
    await page.goto(`${appUrl}/rooms/${roomId}`);
    await panel.waitFor({ timeout: 120000 });
  };
  const add = (name) => panel.getByRole('button', { name: `+ ${name}`, exact: true }).click();
  const shot = async (name) => {
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(dataDir, '_e2e', name) });
  };

  // 1) 처음: 가구가 없으면 추천받을 수 없다
  await openRoom();
  check('처음 연 방: "AI 배치 추천 · 오늘 10회 남음", 가구가 없어 버튼은 꺼져 있고 안내가 보임', (await ai.getAttribute('data-remaining')) === '10' && (await page.getByTestId('ai-open').isDisabled()) && (await page.getByTestId('ai-hint').innerText()).includes('가구를 먼저') && (await chooser.count()) === 0, await ai.innerText());

  // 2) 가구 4개를 놓고 추천받기 (저장하지 않은 지금 배치는 먼저 "내 배치"로 저장된다)
  for (const name of ['싱글 침대', '책상', '옷장', '의자']) await add(name);
  const mine = await items();
  await page.getByTestId('ai-open').click();
  await page.getByTestId('ai-request').fill('책상은 창가에 두고 싶어요');
  const formText = await page.getByTestId('ai-form').innerText();
  check('"AI 추천"을 누르면 요청 입력칸: 가구 4개를 다시 배치하고 지금 배치는 남는다는 안내', formText.includes('가구 4개') && formText.includes('그대로 남습니다'), formText);
  const started = Date.now();
  await page.getByTestId('ai-run').click();
  const busyText = await page.getByTestId('ai-run').innerText();
  const result = page.getByTestId('ai-result');
  await result.waitFor({ timeout: 120000 });
  const elapsed = Date.now() - started;
  console.log(`추천까지 ${elapsed}ms`);
  check('누르면 "AI가 배치하는 중…", 끝나면 "AI 추천 결과"가 나옴', busyText.includes('배치하는 중') && (await result.innerText()).includes('AI 추천 결과'), busyText);

  const suggested = await items();
  const violations = page.getByTestId('layout-violations');
  console.log(JSON.stringify({ before: positions(mine), after: positions(suggested), result: await result.innerText() }, null, 1));
  check('가구 4개가 새 자리로 옮겨지고 고쳐야 할 문제(빨강)가 없음', suggested.length === 4 && !same(positions(suggested), positions(mine)) && (await violations.getAttribute('data-errors')) === '0', await violations.innerText());
  const desk = suggested.find((i) => i.name === '책상');
  check('요청 반영: 책상이 창문이 있는 벽(z=1.5) 쪽에 붙음', desk && Math.abs(desk.z - 1.2) < 0.03, desk && [desk.x, desk.z, desk.rotationDeg]);
  const reasons = await page.getByTestId('ai-result-reasons').locator('li').allInnerTexts();
  check('결과: 전체 의도와 가구별 이유(한국어)', (await page.getByTestId('ai-result-summary').innerText()).length > 5 && reasons.length >= 3 && reasons.every((r) => /[가-힣]/.test(r)), reasons);
  const aiId = await result.getAttribute('data-layout-id');
  const options = await page.getByTestId('layout-select').locator('option').allInnerTexts();
  check('배치 고르기: "AI 배치 …"와 "내 배치" 둘, 지금은 AI 배치, 저장됨, 남은 횟수 9', options.length === 2 && /^AI 배치 \d+\/\d+ \d\d:\d\d$/.test(options[0]) && options[1] === '내 배치' && (await chooser.getAttribute('data-current')) === aiId && (await saveState()) === 'saved' && (await ai.getAttribute('data-remaining')) === '9', options);
  const rows = await layoutsOf();
  const mineRow = rows.find((r) => r.created_by === 'user');
  const aiRow = rows.find((r) => r.id === aiId);
  check('DB: 내 배치(추천 전의 자리)와 AI 배치가 따로 저장됨', rows.length === 2 && mineRow && same(spots(mineRow.items), spots(mine)) && aiRow?.created_by === 'ai' && same(spots(aiRow.items), spots(suggested)), rows.map((r) => [r.name, r.items.length]));
  await shot('ai-layout-3d.png');
  await page.getByTestId('plan-toggle').click();
  await shot('ai-layout-plan.png');
  await page.getByTestId('plan-toggle').click();

  // 3) 배치 바꾸기: 내 배치 ↔ AI 배치
  await page.getByTestId('layout-select').selectOption({ label: '내 배치' });
  await page.waitForFunction((id) => document.querySelector('[data-testid=layout-chooser]')?.getAttribute('data-current') !== id, aiId);
  check('"내 배치"를 고르면 추천 전의 자리로, 추천 결과는 보이지 않음', same(positions(await items()), positions(mine)) && (await result.count()) === 0 && (await page.getByTestId('ai-saved-summary').count()) === 0, positions(await items()));
  await page.getByTestId('layout-select').selectOption(aiId);
  await result.waitFor({ timeout: 10000 });
  check('AI 배치를 다시 고르면 추천 자리와 결과가 다시 보임', same(positions(await items()), positions(suggested)), positions(await items()));

  // 4) AI 배치를 고친 뒤 다른 배치로 바꾸면 먼저 저장된다
  await add('서랍장');
  check('AI 배치에 가구를 더하면 "저장 안 됨"', (await saveState()) === 'dirty' && (await items()).length === 5, await saveState());
  await page.getByTestId('layout-select').selectOption({ label: '내 배치' });
  await page.waitForFunction((id) => document.querySelector('[data-testid=layout-chooser]')?.getAttribute('data-current') !== id, aiId);
  const afterSwitch = await layoutsOf();
  check('저장하지 않고 다른 배치로 바꾸면: 고친 AI 배치가 먼저 저장됨 (5개), 내 배치는 4개 그대로', afterSwitch.find((r) => r.id === aiId)?.items.length === 5 && afterSwitch.find((r) => r.created_by === 'user')?.items.length === 4 && (await items()).length === 4, afterSwitch.map((r) => [r.name, r.items.length]));

  // 5) 새로고침: 마지막으로 고친 배치(AI 배치)로 시작하고, 저장된 추천 이유가 보인다
  await openRoom();
  const saved = page.getByTestId('ai-saved-summary');
  check('새로고침하면: AI 배치(5개)로 시작, "AI가 추천한 배치"와 이유가 보임', (await chooser.getAttribute('data-current')) === aiId && (await items()).length === 5 && (await saved.innerText()).includes('AI가 추천한 배치') && (await saved.innerText()).includes('- 책상:'), (await saved.count()) ? await saved.innerText() : null);

  // 6) 실패했을 때: 이유를 보여주고 배치는 그대로
  await page.route('**/layout-suggest', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'AI_ERROR', message: 'AI가 답하지 못했습니다. 잠시 뒤에 다시 해 주세요.' } }) }));
  await page.getByTestId('ai-open').click();
  await page.getByTestId('ai-run').click();
  const message = page.getByTestId('ai-message');
  await message.waitFor({ timeout: 15000 });
  check('추천이 실패하면: 이유를 보여주고, 배치와 고르는 칸은 그대로', (await message.innerText()).includes('AI가 답하지 못했습니다') && (await items()).length === 5 && (await chooser.getAttribute('data-count')) === '2', await message.innerText());
  await page.unroute('**/layout-suggest');

  // 7) AI 배치 지우기
  await page.getByTestId('layout-delete').click();
  const confirmText = await page.getByTestId('layout-delete-confirm').innerText();
  await page.getByTestId('layout-delete-yes').click();
  await page.waitForFunction((id) => document.querySelector('[data-testid=layout-chooser]')?.getAttribute('data-current') !== id, aiId);
  const afterDelete = await layoutsOf();
  check('AI 배치를 지우면: 확인을 묻고, 내 배치만 남아 그 배치가 열림', confirmText.includes('지울까요') && afterDelete.length === 1 && afterDelete[0].created_by === 'user' && (await chooser.getAttribute('data-count')) === '1' && (await items()).length === 4, afterDelete.map((r) => r.name));

  // 8) 오늘 횟수를 다 쓰면 버튼이 꺼진다
  await admin.from('ai_calls').insert(Array.from({ length: 9 }, () => ({ owner_id: ownerId, room_id: roomId, kind: 'layout', status: 'done' })));
  await openRoom();
  check('오늘 10회를 다 쓰면: "오늘 0회 남음", 버튼이 꺼지고 안내가 보임', (await ai.getAttribute('data-remaining')) === '0' && (await page.getByTestId('ai-open').isDisabled()) && (await page.getByTestId('ai-hint').innerText()).includes('모두 썼습니다'), await ai.innerText());
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
