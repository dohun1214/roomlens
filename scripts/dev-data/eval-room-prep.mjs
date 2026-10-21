// 방 준비(보정·문창문·원래 가구) 성능 재기. 정답 파일(eval-truth.mjs로 만듦)마다 실제 화면에서 돌려 보고 점수를 낸다.
//   --mode detect : 정답 보정을 넣어 둔 방에서 "문·창문 AI로 찾기"와 "원래 가구 AI로 찾기"만 잰다 (Gemini를 장면마다 2번 부름)
//   --mode layout : 보정 전 파일을 열어 자동 보정만 잰다 (Gemini 없음, 로그인 없음)
//   --mode full   : 자동 보정 → 문·창문 → 원래 가구를 이어서 하고 정답 좌표로 옮겨 잰다
//   --mode points : 장면의 표면 점을 eval/points/<이름>.bin 으로 저장한다 (eval-layout-offline.mjs로 빠르게 고쳐 보기용)
//   --mode analysis : 정답 보정·문창문을 넣은 방에서 "방 분석"을 돌려, 정답 원래 가구로 옵션(침대·책상·옷장·냉장고·세탁기)을 채점한다
//                     (원래 가구는 넣지 않는다: 그림만 보고 맞히는지 본다)
// 준비: 개발 서버(APP_URL, 기본 http://localhost:3100), 데이터 폴더를 내주는 파일 서버(DATA_URL, 기본 http://localhost:8094, --cors),
//       ../roomlens-data/_e2e 에 playwright-core
// 실행: npx tsx --env-file=.env.local scripts/dev-data/eval-room-prep.mjs --mode detect [--only 이름,이름] [--tag 이름]
// 결과: ../roomlens-data/_e2e/eval/results/<tag>-<mode>.json (장면마다 점수와 결과 원본) + 표 출력
// 평가 계정(e2e-eval-…@roomlens.test)과 장면마다 올린 방은 다음 실행에서 다시 쓴다 (eval/account.json, eval/rooms.json)
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { checkSplatFile, SPLAT_CONTENT_TYPE, SPLAT_HEAD_BYTES, splatKeyFor } from '../../lib/upload/splatFile';
import { frameMap, frameScale, mapFixture, mapSegment, openingSegments, scoreFixtures, scoreLayout, scoreOpenings } from '../../lib/eval/roomPrepScore';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'detect' },
    only: { type: 'string', default: '' },
    tag: { type: 'string', default: new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') },
    headed: { type: 'boolean', default: false },
  },
});
const appUrl = process.env.APP_URL ?? 'http://localhost:3100';
const dataUrl = process.env.DATA_URL ?? 'http://localhost:8094';
const evalDir = path.join(dataDir, '_e2e', 'eval');
const truthDir = path.join(evalDir, 'truth');
const resultDir = path.join(evalDir, 'results');
mkdirSync(resultDir, { recursive: true });
const only = values.only ? values.only.split(',') : [];
const truths = readdirSync(truthDir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(path.join(truthDir, f), 'utf8')))
  .filter((t) => only.length === 0 || only.includes(t.name));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const browser = await chromium.launch({ channel: 'chrome', headless: !values.headed, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
// R2의 CORS는 정해진 주소만 허락한다. 다른 포트의 개발 서버로 열 때를 위해 허락 머리말을 붙인다
await page.route(/r2\.cloudflarestorage\.com/, async (route) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS', 'access-control-expose-headers': '*' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const response = await route.fetch();
  return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
});

/** 평가 계정: 처음이면 가입하고, 아니면 로그인 */
async function signIn() {
  const accountPath = path.join(evalDir, 'account.json');
  const fresh = !existsSync(accountPath);
  const account = fresh
    ? { email: `e2e-eval-room-prep@${process.env.E2E_EMAIL_DOMAIN ?? 'roomlens.test'}`, password: `pw-${Math.random().toString(36).slice(2, 12)}A1` }
    : JSON.parse(readFileSync(accountPath, 'utf8'));
  const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
  let owner = users.users.find((u) => u.email === account.email);
  await page.goto(`${appUrl}/account`);
  if (!owner) {
    await page.getByRole('tab', { name: '가입' }).click();
    await page.getByLabel('이메일').fill(account.email);
    await page.getByLabel(/비밀번호/).fill(account.password);
    await page.getByLabel('만 18세 이상입니다.').check();
    await page.getByRole('button', { name: '가입하기' }).click();
    await page.waitForURL('**/account', { timeout: 15000 });
    writeFileSync(accountPath, JSON.stringify(account));
    writeFileSync(path.join(evalDir, 'rooms.json'), '{}');
    const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
    owner = data.users.find((u) => u.email === account.email);
  } else {
    await page.getByLabel('이메일').fill(account.email);
    await page.getByLabel(/비밀번호/).fill(account.password);
    await page.getByRole('button', { name: '로그인' }).click();
    await page.waitForFunction(() => !document.querySelector('input[name=password]'), null, { timeout: 15000 });
  }
  return owner;
}

/** 장면의 방: 이미 올린 것이 있으면 다시 쓰고, 없으면 올린다 */
async function ensureRoom(owner, truth) {
  const roomsPath = path.join(evalDir, 'rooms.json');
  const rooms = existsSync(roomsPath) ? JSON.parse(readFileSync(roomsPath, 'utf8')) : {};
  if (rooms[truth.name]) {
    const { data } = await admin.from('rooms').select('id, status').eq('id', rooms[truth.name]).eq('owner_id', owner.id).maybeSingle();
    if (data?.status === 'ready') return data.id;
  }
  const bytes = readFileSync(path.join(dataDir, truth.file));
  const check = checkSplatFile(bytes.length, bytes.subarray(0, SPLAT_HEAD_BYTES));
  if (!check.ok) throw new Error(check.message);
  const { data: room, error } = await admin
    .from('rooms')
    .insert({ owner_id: owner.id, title: `평가 ${truth.name}`, description: '', source: 'dataset', credit: '평가용', consent_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw error;
  const key = splatKeyFor(room.id, check.format);
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: bytes, ContentType: SPLAT_CONTENT_TYPE }));
  await admin.from('rooms').update({ status: 'ready', splat_key: key, splat_format: check.format, splat_bytes: bytes.length }).eq('id', room.id);
  rooms[truth.name] = room.id;
  writeFileSync(roomsPath, JSON.stringify(rooms, null, 1));
  return room.id;
}

const waitReady = () => page.waitForFunction(() => document.querySelector('[data-testid=viewer-stats]')?.textContent?.includes('ready'), null, { timeout: 180000 });

/** 도구의 "AI로 찾기"를 누르고 끝날 때까지 기다린 뒤 저장한다 */
async function detect(tool) {
  const t0 = Date.now();
  if ((await page.getByTestId(`${tool}-toggle`).getAttribute('aria-pressed')) !== 'true') await page.getByTestId(`${tool}-toggle`).click();
  await page.getByTestId(`${tool}-detect-run`).click();
  await page.waitForFunction((t) => document.querySelector(`[data-testid=${t}-detect]`)?.getAttribute('data-busy') === 'true', tool, { timeout: 15000 });
  await page.waitForFunction((t) => document.querySelector(`[data-testid=${t}-detect]`)?.getAttribute('data-busy') === 'false', tool, { timeout: 300000 });
  const message = (await page.getByTestId(`${tool}-message`).innerText().catch(() => '')).replace(/\s+/g, ' ');
  if (await page.getByTestId(`${tool}-save`).count()) {
    await page.getByTestId(`${tool}-save`).click();
    await page.waitForFunction((t) => document.querySelector(`[data-testid=${t}-save-state]`)?.getAttribute('data-state') === 'saved', tool, { timeout: 15000 });
  }
  return { message, ms: Date.now() - t0 };
}

/** 결과(그 보정의 방 좌표)를 정답 방 좌표로 옮겨 점수를 낸다 */
function scoreAll(truth, pred) {
  const map = frameMap(pred.frame, truth.frame);
  const scale = frameScale(pred.frame, truth.frame);
  const polygon = pred.polygon.map(map);
  const openings = openingSegments(pred.openings ?? [], pred.polygon).map((s) => mapSegment(s, map));
  const fixtures = (pred.fixtures ?? []).map((f) => mapFixture(f, map, scale));
  return {
    layout: scoreLayout(polygon, truth.polygon),
    openings: scoreOpenings(openings, truth.openings),
    fixtures: scoreFixtures(fixtures, truth.fixtures),
  };
}

async function runDetect(owner, truth) {
  const roomId = await ensureRoom(owner, truth);
  // 정답 보정을 넣고 문·창문·원래 가구를 비운 뒤, 오늘의 AI 횟수도 비운다 (평가에서만)
  await admin
    .from('rooms')
    .update({ transform: { ...truth.frame.transform, flipX: truth.frame.flipX }, floor_polygon: truth.polygon, openings: [], fixtures: [] })
    .eq('id', roomId);
  await admin.from('ai_calls').delete().eq('owner_id', owner.id);
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await waitReady();
  await page.waitForTimeout(3000);
  const openingsRun = await detect('openings');
  const fixturesRun = await detect('fixtures');
  const { data } = await admin.from('rooms').select('openings, fixtures').eq('id', roomId).single();
  const pred = { frame: truth.frame, polygon: truth.polygon, openings: data.openings, fixtures: data.fixtures };
  return { pred, runs: { openings: openingsRun, fixtures: fixturesRun } };
}

/** 사용자가 하는 그대로: 보정 전 방 → "AI로 방 준비하기"(자동 보정 → 저장하고 찾기) → 결과를 손대지 않고 저장 */
async function runFull(owner, truth) {
  const roomId = await ensureRoom(owner, truth);
  await admin.from('rooms').update({ transform: null, floor_polygon: null, openings: [], fixtures: [] }).eq('id', roomId);
  await admin.from('ai_calls').delete().eq('owner_id', owner.id);
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await waitReady();
  await page.waitForTimeout(3000);
  if ((await page.getByTestId('calibration-toggle').getAttribute('aria-pressed')) !== 'true') await page.getByTestId('calibration-toggle').click();
  const t0 = Date.now();
  await page.getByTestId('calibration-auto').click();
  await page.getByTestId('calibration-auto-info').waitFor({ timeout: 60000 });
  const layoutMs = Date.now() - t0;
  await page.getByTestId('calibration-save-prepare').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=prep-banner]')?.getAttribute('data-step') === 'review', null, { timeout: 300000 });
  const prepMs = Date.now() - t0;
  const runs = { layoutMs, prepMs };
  for (const tool of ['openings', 'fixtures']) {
    const el = page.getByTestId(`prep-${tool}`);
    runs[tool] = { state: await el.getAttribute('data-state'), found: Number(await el.getAttribute('data-found')) };
    if (runs[tool].state !== 'review') continue;
    await el.click();
    await page.getByTestId(`${tool}-save`).click();
    await page.waitForFunction((t) => document.querySelector(`[data-testid=prep-${t}]`)?.getAttribute('data-state') === 'saved', tool, { timeout: 15000 });
  }
  const { data: calls } = await admin.from('ai_calls').select('kind, bundle_of').eq('owner_id', owner.id);
  runs.counted = calls.filter((c) => !c.bundle_of).length;
  const { data } = await admin.from('rooms').select('transform, floor_polygon, openings, fixtures').eq('id', roomId).single();
  const { flipX, ...transform } = data.transform;
  const pred = { frame: { transform, flipX: Boolean(flipX) }, polygon: data.floor_polygon, openings: data.openings, fixtures: data.fixtures };
  return { pred, runs };
}

/** 정답 문·창문(양 끝 좌표)을 벽 번호 형식으로 */
function truthOpenings(truth) {
  const out = [];
  for (const o of truth.openings) {
    for (let i = 0; i < truth.polygon.length; i += 1) {
      const a = truth.polygon[i];
      const b = truth.polygon[(i + 1) % truth.polygon.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const off = (p) => Math.abs((p[0] - a[0]) * u[1] - (p[1] - a[1]) * u[0]);
      if (off(o.a) > 0.05 || off(o.b) > 0.05) continue;
      const along = (p) => (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
      const [from, to] = [along(o.a), along(o.b)].sort((m, n) => m - n).map((v) => Math.min(len, Math.max(0, Math.round(v * 100) / 100)));
      if (to - from >= 0.3) out.push({ type: o.type, wallIndex: i, from, to, widthM: Math.round((to - from) * 100) / 100 });
      break;
    }
  }
  return out;
}

/** 리포트의 옵션 가운데 정답 원래 가구로 채점할 수 있는 것: 옵션 이름 → 정답 가구 이름 */
const OPTION_TRUTH = { 침대: ['침대'], 책상: ['책상'], 옷장: ['옷장'], 냉장고: ['냉장고'], 세탁기: ['세탁기'] };

async function runAnalysis(owner, truth) {
  const roomId = await ensureRoom(owner, truth);
  await admin
    .from('rooms')
    .update({ transform: { ...truth.frame.transform, flipX: truth.frame.flipX }, floor_polygon: truth.polygon, openings: truthOpenings(truth), fixtures: [] })
    .eq('id', roomId);
  await admin.from('ai_calls').delete().eq('owner_id', owner.id);
  await admin.from('room_reports').delete().eq('room_id', roomId);
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await waitReady();
  await page.waitForTimeout(3000);
  await page.getByTestId('analysis-toggle').click();
  const t0 = Date.now();
  await page.getByTestId('analysis-run').click();
  await page.getByTestId('analysis-report').waitFor({ timeout: 240000 });
  const ms = Date.now() - t0;
  const { data } = await admin.from('room_reports').select('report').eq('room_id', roomId).maybeSingle();
  const report = data.report;
  const labels = new Set((truth.fixtures ?? []).map((f) => f.label));
  const options = Object.entries(OPTION_TRUTH).map(([name, names]) => {
    const present = names.some((n) => labels.has(n));
    const status = report.options.find((o) => o.name === name)?.status ?? 'missing';
    return { name, truth: present, status };
  });
  const windows = truth.openings.filter((o) => o.type === 'window').length;
  const tips = report.layoutTips ?? [];
  return {
    pred: null,
    analysis: {
      ms,
      options,
      tp: options.filter((o) => o.truth && o.status === 'present').length,
      truthPresent: options.filter((o) => o.truth).length,
      fp: options.filter((o) => !o.truth && o.status === 'present').length,
      truthAbsent: options.filter((o) => !o.truth).length,
      wrongAbsent: options.filter((o) => o.truth && o.status === 'absent').length,
      unknown: report.options.filter((o) => o.status === 'unknown').length,
      tips: tips.length,
      // 창문이 없는 방인데 창을 말하는 조언
      windowTipWithoutWindow: windows === 0 && tips.some((t) => t.includes('창')),
      // 벽 이름(W1..)을 써서 자리를 짚은 조언
      tipsWithWall: tips.filter((t) => /W\d/.test(t)).length,
      light: report.naturalLight.level,
      windows,
      report,
    },
  };
}

async function runPoints(truth) {
  await page.goto(`${appUrl}/viewer?url=${encodeURIComponent(`${dataUrl}/${truth.file}`)}`);
  await waitReady();
  await page.waitForTimeout(1500);
  const p = await page.evaluate(() => window.__roomlensScenePoints());
  if (!p) throw new Error('점을 읽지 못함');
  mkdirSync(path.join(evalDir, 'points'), { recursive: true });
  const head = Buffer.alloc(4);
  head.writeUInt32LE(p.count);
  writeFileSync(path.join(evalDir, 'points', `${truth.name}.bin`), Buffer.concat([head, Buffer.from(p.positions, 'base64'), Buffer.from(p.normals, 'base64'), Buffer.from(p.weights, 'base64'), ...(p.brightness ? [Buffer.from(p.brightness, 'base64')] : [])]));
  log('  점', p.count);
  return { pred: null, runs: { points: { count: p.count } } };
}

async function runLayout(truth) {
  await page.goto(`${appUrl}/viewer?url=${encodeURIComponent(`${dataUrl}/${truth.file}`)}`);
  await waitReady();
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  const result = await page.evaluate(async () => window.__roomlensAutoCalibrate());
  if (!result?.ok) return { pred: null, runs: { layout: { ms: Date.now() - t0, message: result?.message ?? '실패' } } };
  return {
    pred: { frame: { transform: result.transform, flipX: result.flipX }, polygon: result.floorPolygon },
    runs: { layout: { ms: Date.now() - t0, message: result.message ?? '', info: result.info ?? null } },
  };
}

const owner = values.mode === 'layout' || values.mode === 'points' ? null : await signIn();
if (!['detect', 'full', 'layout', 'points', 'analysis'].includes(values.mode)) throw new Error(`모르는 --mode: ${values.mode}`);
const rows = [];
for (const truth of truths) {
  log(truth.name, values.mode);
  try {
    const out =
      values.mode === 'analysis'
        ? await runAnalysis(owner, truth)
        : values.mode === 'detect'
        ? await runDetect(owner, truth)
        : values.mode === 'full'
          ? await runFull(owner, truth)
          : values.mode === 'points'
            ? await runPoints(truth)
            : await runLayout(truth);
    const score = out.pred ? scoreAll(truth, out.pred) : null;
    rows.push({ name: truth.name, kind: truth.kind, score, runs: out.runs, pred: out.pred, analysis: out.analysis });
    if (out.analysis) {
      const a = out.analysis;
      log('  ', `옵션 맞음 ${a.tp}/${a.truthPresent} 없는데 있다 ${a.fp}/${a.truthAbsent} 있는데 없다 ${a.wrongAbsent} 모름 ${a.unknown} 조언 ${a.tips}${a.windowTipWithoutWindow ? ' (창 없는데 창 조언)' : ''} 채광 ${a.light}(창 ${a.windows}) ${Math.round(a.ms / 1000)}초`);
    }
    if (score) log('  ', JSON.stringify({ layout: round(score.layout), openings: round(score.openings), fixtures: round(score.fixtures) }));
  } catch (err) {
    log('  실패', String(err).slice(0, 300));
    rows.push({ name: truth.name, kind: truth.kind, score: null, error: String(err).slice(0, 300) });
  }
}
await browser.close();

function round(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]));
}
const outPath = path.join(resultDir, `${values.tag}-${values.mode}.json`);
writeFileSync(outPath, JSON.stringify({ mode: values.mode, tag: values.tag, at: new Date().toISOString(), rows, pageErrors }, null, 1));

// 표: 장면마다, 그리고 평균
const pct = (v) => (v == null ? '  - ' : `${Math.round(v * 100)}%`.padStart(4));
const m = (v) => (v == null ? '   - ' : v.toFixed(2).padStart(5));
console.log(`\n${'장면'.padEnd(18)} 바닥IoU 모서리m | 문창 찾음 맞음 종류 끝m | 가구 찾음 맞음 이름 가운데m 높이m`);
const sum = { n: 0 };
const add = (k, v) => {
  if (v == null || Number.isNaN(v)) return;
  sum[k] = (sum[k] ?? 0) + v;
  sum[`${k}#`] = (sum[`${k}#`] ?? 0) + 1;
};
for (const r of rows) {
  const s = r.score;
  if (!s) {
    console.log(`${r.name.padEnd(18)} 실패 ${r.error ?? r.runs?.layout?.message ?? ''}`);
    continue;
  }
  const L = values.mode === 'detect' ? null : s.layout;
  const O = values.mode === 'layout' ? null : s.openings;
  const F = values.mode === 'layout' ? null : s.fixtures;
  console.log(
    `${r.name.padEnd(18)} ${pct(L?.iou)}  ${m(L?.cornerMean)} | ${String(O ? `${O.matched}/${O.truth}` : '-').padStart(5)} ${pct(O?.recall)} ${pct(O?.precision)} ${pct(O?.typeAccuracy)} ${m(O?.endError)} | ${String(F ? `${F.matched}/${F.truth}` : '-').padStart(5)} ${pct(F?.recall)} ${pct(F?.precision)} ${pct(F?.typeAccuracy)} ${m(F?.centerError)} ${m(F?.heightError)}`,
  );
  add('iou', L?.iou);
  add('corner', L?.cornerMean);
  add('oRecall', O?.recall);
  add('oPrecision', O?.precision);
  add('oType', O?.typeAccuracy);
  add('oEnd', O?.endError);
  add('fRecall', F?.recall);
  add('fPrecision', F?.precision);
  add('fType', F?.typeAccuracy);
  add('fCenter', F?.centerError);
  add('fHeight', F?.heightError);
}
const avg = (k) => (sum[`${k}#`] ? sum[k] / sum[`${k}#`] : null);
console.log(
  `${'평균'.padEnd(18)} ${pct(avg('iou'))}  ${m(avg('corner'))} |       ${pct(avg('oRecall'))} ${pct(avg('oPrecision'))} ${pct(avg('oType'))} ${m(avg('oEnd'))} |       ${pct(avg('fRecall'))} ${pct(avg('fPrecision'))} ${pct(avg('fType'))} ${m(avg('fCenter'))} ${m(avg('fHeight'))}`,
);
if (values.mode === 'analysis') {
  const list = rows.filter((r) => r.analysis).map((r) => r.analysis);
  const total = (k) => list.reduce((a, b) => a + (typeof b[k] === 'number' ? b[k] : b[k] ? 1 : 0), 0);
  console.log(
    `분석 ${list.length}장면: 있는 옵션 맞힘 ${total('tp')}/${total('truthPresent')} (${pct(total('tp') / Math.max(1, total('truthPresent')))}), 없는데 있다 ${total('fp')}/${total('truthAbsent')}, 있는데 없다 ${total('wrongAbsent')}, 모름 평균 ${(total('unknown') / Math.max(1, list.length)).toFixed(1)}, 조언 평균 ${(total('tips') / Math.max(1, list.length)).toFixed(1)}, 창 없는데 창 조언 ${total('windowTipWithoutWindow')}, 벽을 짚은 조언 ${total('tipsWithWall')}/${total('tips')}, 평균 ${Math.round(total('ms') / Math.max(1, list.length) / 1000)}초`,
  );
}
console.log(`결과: ${outPath}`);
if (pageErrors.length) console.log('화면 오류', pageErrors.slice(0, 5));
