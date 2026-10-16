// 자동 보정 실측: 시험 계정에 보정 전 방을 올리고, 방 화면에서 "자동으로 찾기" → 평면도에서 벽 끌기 → 크기 맞추기 → 저장까지.
// 정답이 있는 InteriorGS 장면(장면 좌표 = m, 바닥 y=0)으로 찾은 방의 넓이·높이를 정답과 견준다.
// 준비: 개발 서버(APP_URL), ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/converted/<장면>.sog, interiorgs/<장면>/structure.json
// 실행: node --env-file=.env.local scripts/dev-data/e2e-auto-calibrate.mjs [장면]
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
const email = `e2e-${Date.now()}-auto@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`;
const password = `pw-${Math.random().toString(36).slice(2, 12)}A1`;
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const shotDir = path.join(dataDir, '_e2e');

const structure = JSON.parse(readFileSync(path.join(dataDir, 'interiorgs', scene, 'structure.json'), 'utf8'));
const truthPolygon = structure.rooms[0].profile;
const area = (poly) => Math.abs(poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length][1] - poly[(i + 1) % poly.length][0] * p[1], 0)) / 2;
const truthArea = area(truthPolygon);

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
    .insert({ owner_id: owner.id, title: `자동 보정 ${scene}`, description: '', source: 'dataset', credit: '시험', consent_at: new Date().toISOString() })
    .select('id')
    .single();
  const key = splatKeyFor(room.id, fileCheck.format);
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, ContentType: SPLAT_CONTENT_TYPE }));
  await admin.from('rooms').update({ status: 'ready', splat_key: key, splat_format: fileCheck.format, splat_bytes: bytes.length }).eq('id', room.id);

  await page.goto(`${appUrl}/rooms/${room.id}`);
  await page.waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 180000 });
  await page.waitForTimeout(2000);
  if ((await page.getByTestId('calibration-toggle').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('calibration-toggle').click();
  check('보정 전 방: 자동 보정 버튼이 보인다', await page.getByTestId('calibration-auto').isVisible());

  // 1) 자동으로 찾기
  const t0 = Date.now();
  await page.getByTestId('calibration-auto').click();
  await page.getByTestId('calibration-auto-info').waitFor({ timeout: 30000 });
  const autoMs = Date.now() - t0;
  const info = await page.getByTestId('calibration-auto-info').evaluate((el) => ({ height: Number(el.dataset.height), guessed: el.dataset.guessed === 'true' }));
  check('자동 보정이 30초 안에 끝난다', autoMs < 30000, `${autoMs} ms`);
  check('천장 높이가 정답(2.8 m 벽) 근처', info.height > 2.3 && info.height < 3.1, info);
  check('m 단위 장면이라 크기를 짐작하지 않는다', !info.guessed, info);
  await page.screenshot({ path: path.join(shotDir, `auto-calibrate-${scene}.jpg`), type: 'jpeg', quality: 75 });

  const readPolygon = () =>
    page.getByTestId('calibration-wall-editor').evaluate((svg) => {
      const poly = svg.querySelector('polygon');
      return poly.getAttribute('points').split(' ').map((p) => p.split(',').map(Number));
    });
  const polygon = await readPolygon();
  const found = area(polygon);
  check('찾은 바닥 넓이가 정답의 85~115%', found > truthArea * 0.85 && found < truthArea * 1.15, { found: found.toFixed(2), truth: truthArea.toFixed(2) });
  check('벽이 4개 이상', polygon.length >= 4, polygon.length);

  // 2) 평면도에서 벽 1을 끌어 옮긴다
  const wall = page.getByTestId('calibration-wall-0');
  const box = await wall.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const horizontal = box.width > box.height;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(horizontal ? cx : cx + 15, horizontal ? cy + 15 : cy, { steps: 5 });
  await page.mouse.up();
  const moved = await readPolygon();
  check('벽을 끌면 평면도가 바뀌고 넓이가 달라진다', Math.abs(area(moved) - found) > 0.05, { before: found.toFixed(2), after: area(moved).toFixed(2) });
  check('벽을 끈 뒤에도 모서리 수는 그대로', moved.length === polygon.length);

  // 3) 크기 맞추기: 벽 1의 길이를 1.1배로
  const len0 = Math.hypot(moved[1][0] - moved[0][0], moved[1][1] - moved[0][1]);
  await page.getByTestId('calibration-scale-wall').selectOption('0');
  await page.getByTestId('calibration-scale-length').fill((len0 * 1.1).toFixed(3));
  await page.getByTestId('calibration-scale-apply').click();
  const scaled = await readPolygon();
  check('크기 맞추기: 넓이가 1.21배', Math.abs(area(scaled) / area(moved) - 1.21) < 0.02, (area(scaled) / area(moved)).toFixed(3));

  // 4) 저장
  await page.getByTestId('calibration-save').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=calibration-save-state]')?.getAttribute('data-state') === 'saved', null, { timeout: 15000 });
  const { data: saved } = await admin.from('rooms').select('transform, floor_polygon').eq('id', room.id).single();
  check('저장: 평면도가 화면과 같다', JSON.stringify(saved.floor_polygon.map((p) => p.map((v) => Math.round(v * 100)))) === JSON.stringify(scaled.map((p) => p.map((v) => Math.round(v * 100)))));
  check('저장: 크기 배율이 1.1 근처 (m 장면을 1.1배로 늘림)', Math.abs(saved.transform.s - 1.1) < 0.03, saved.transform.s);
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
