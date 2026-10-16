// "AI로 방 준비하기" 실측: 보정 전 방에서 자동 보정 → "저장하고 문·창문·원래 가구 찾기" → 두 찾기가 이어서 돈다 →
// 확인 단계에서 각각 저장. AI 횟수는 1회만 줄고, ai_calls에는 원래 가구 찾기가 문·창문 찾기를 bundle_of로 가리킨다.
// 실제 Gemini를 부른다 (시험 계정의 횟수만 씀).
// 준비: 개발 서버(APP_URL), ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/converted/<장면>.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-room-prep.mjs [장면]
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { checkSplatFile, SPLAT_CONTENT_TYPE, SPLAT_HEAD_BYTES, splatKeyFor } from '../../lib/upload/splatFile.ts';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
const scene = process.argv[2] ?? '0056_839909';
const email = `e2e-${Date.now()}-prep@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`;
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const shotDir = path.join(dataDir, '_e2e');


const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
// R2의 CORS는 정해진 주소만 허락한다. 다른 포트의 개발 서버로 열 때를 위해 허락 머리말을 붙인다
await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS', 'access-control-expose-headers': '*' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const response = await route.fetch();
  return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
});

try {
  await page.goto(`${appUrl}/account`);
  await page.getByRole('tab', { name: '가입' }).click();
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel(/비밀번호/).fill(password);
  await page.getByLabel('만 18세 이상입니다.').check();
  await page.getByRole('button', { name: '가입하기' }).click();
  await page.waitForURL('**/account', { timeout: 15000 });
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const owner = users.users.find((u) => u.email === email);

  const bytes = readFileSync(path.join(dataDir, 'converted', `${scene}.sog`));
  const fileCheck = checkSplatFile(bytes.length, bytes.subarray(0, SPLAT_HEAD_BYTES));
  const { data: room } = await admin
    .from('rooms')
    .insert({ owner_id: owner.id, title: `방 준비 ${scene}`, description: '', source: 'dataset', credit: '시험', consent_at: new Date().toISOString() })
    .select('id')
    .single();
  const key = splatKeyFor(room.id, fileCheck.format);
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, ContentType: SPLAT_CONTENT_TYPE }));
  await admin.from('rooms').update({ status: 'ready', splat_key: key, splat_format: fileCheck.format, splat_bytes: bytes.length }).eq('id', room.id);

  await page.goto(`${appUrl}/rooms/${room.id}`);
  await page.waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 180000 });
  await page.waitForTimeout(2000);
  if ((await page.getByTestId('calibration-toggle').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('calibration-toggle').click();
  check('보정 전 방: "AI로 방 준비하기" 안내가 보인다', await page.getByText('AI로 방 준비하기 (추천)').isVisible());

  // 1) 자동 보정 → 저장하고 이어서 찾기
  await page.getByTestId('calibration-auto').click();
  await page.getByTestId('calibration-auto-info').waitFor({ timeout: 30000 });
  check('자동 보정 뒤 "저장하고 문·창문·원래 가구 찾기" 버튼', await page.getByTestId('calibration-save-prepare').isVisible());
  const t0 = Date.now();
  await page.getByTestId('calibration-save-prepare').click();
  await page.getByTestId('prep-banner').waitFor({ timeout: 15000 });
  const firstStep = await page.getByTestId('prep-banner').getAttribute('data-step');
  check('보정을 저장하고 문·창문 찾기부터 시작한다', firstStep === 'openings' || firstStep === 'fixtures', firstStep);
  const { data: savedRoom } = await admin.from('rooms').select('transform, floor_polygon').eq('id', room.id).single();
  check('보정이 저장됐다', Boolean(savedRoom.transform) && Array.isArray(savedRoom.floor_polygon));

  // 2) 두 찾기가 끝나 확인 단계로
  await page.waitForFunction(() => document.querySelector('[data-testid=prep-banner]')?.getAttribute('data-step') === 'review', null, { timeout: 300000 });
  const prepMs = Date.now() - t0;
  const state = async (tool) => page.getByTestId(`prep-${tool}`).evaluate((el) => ({ state: el.dataset.state, found: Number(el.dataset.found) }));
  const o = await state('openings');
  const f = await state('fixtures');
  check('찾기 두 개가 5분 안에 끝난다', prepMs < 300000, `${Math.round(prepMs / 1000)} s`);
  check('문·창문을 하나 이상 찾았다', o.state === 'review' && o.found >= 1, o);
  check('원래 가구를 하나 이상 찾았다', f.state === 'review' && f.found >= 1, f);
  check('확인 단계는 문·창문 도구에서 시작한다', (await page.getByTestId('workspace').getAttribute('data-tool')) === 'openings');
  await page.screenshot({ path: path.join(shotDir, `room-prep-${scene}.jpg`), type: 'jpeg', quality: 75 });

  // 3) AI 횟수: 한 번만 셌다
  const { data: calls } = await admin.from('ai_calls').select('id, kind, status, bundle_of').eq('owner_id', owner.id).order('created_at');
  const opening = calls.find((c) => c.kind === 'openings');
  const fixture = calls.find((c) => c.kind === 'fixtures');
  check('ai_calls: 문·창문 1행, 원래 가구 1행', calls.length === 2 && opening && fixture, calls.map((c) => `${c.kind}:${c.status}`));
  check('원래 가구 찾기가 문·창문 찾기를 bundle_of로 가리킨다', fixture?.bundle_of === opening?.id && !opening?.bundle_of);
  const remaining = await page.getByTestId('openings-detect').getAttribute('data-remaining');
  check('화면의 남은 횟수가 9 (1회만 씀)', remaining === '9', remaining);

  // 4) 확인하고 저장: 문·창문 → 원래 가구
  await page.getByTestId('openings-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=prep-openings]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  await page.getByTestId('prep-fixtures').click();
  check('단계 버튼으로 원래 가구 도구로 간다', (await page.getByTestId('workspace').getAttribute('data-tool')) === 'fixtures');
  await page.getByTestId('fixtures-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=prep-fixtures]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  const { data: done } = await admin.from('rooms').select('openings, fixtures').eq('id', room.id).single();
  check('저장: 문·창문과 원래 가구가 DB에 들어갔다', done.openings.length === o.found && done.fixtures.length === f.found, { openings: done.openings.length, fixtures: done.fixtures.length });
  check('모두 저장하면 끝 안내', (await page.getByTestId('prep-banner').innerText()).includes('방 준비 끝'));
  await page.getByTestId('prep-close').click();
  check('닫으면 안내가 사라진다', (await page.getByTestId('prep-banner').count()) === 0);
  check('화면 오류 없음', pageErrors.length === 0, pageErrors);
} catch (err) {
  check('실행 중 오류', false, String(err).slice(0, 300));
} finally {
  await browser.close();
}
const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(c.ok ? '통과' : '실패', c.name, c.detail === undefined ? '' : JSON.stringify(c.detail));
console.log(`${checks.length - failed.length}/${checks.length} 통과`);
process.exit(failed.length ? 1 : 0);
