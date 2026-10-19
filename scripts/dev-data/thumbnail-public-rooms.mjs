// 공개 방의 대표 사진을 만든다 (샘플 방처럼 주인이 직접 열어 보기 전인 방).
// 로그인하지 않은 브라우저로 방 화면을 열어 처음 시점의 3D만 찍고(문·창문 표시와 화면 위 버튼은 숨김),
// 가운데를 16:10으로 잘라 960×600 JPEG로 R2에 올린 뒤 rooms.thumbnail_key 를 바꾼다. 예전 사진은 지운다.
// 실행: node --env-file=.env.local scripts/dev-data/thumbnail-public-rooms.mjs <방 id> [<방 id> ...]
//   APP_URL(기본 운영 주소)로 연다. 방이 공개여야 한다. --force 를 주면 이미 사진이 있는 방도 다시 찍는다
import { createRequire } from 'node:module';
import path from 'node:path';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createClient } from '@supabase/supabase-js';
import { dataDir } from './e2e-common.mjs';

const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = require('playwright-core');

const appUrl = process.env.APP_URL ?? 'https://roomlens-seven.vercel.app';
const force = process.argv.includes('--force');
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!ids.length) throw new Error('방 id를 하나 이상 주세요.');

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false } });
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
// 문·창문 판, 원래 가구 상자를 숨긴 채로 연다 (방 화면이 브라우저에 기억해 두는 표시 설정)
await context.addInitScript(() => window.localStorage.setItem('roomlens.markers', JSON.stringify({ openings: false, fixtures: false })));
// 다른 포트의 개발 서버로 열 때를 위해 R2 CORS 머리말을 붙인다
await context.route(/r2\.cloudflarestorage\.com/, async (route) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS', 'access-control-expose-headers': '*' };
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const response = await route.fetch();
  return route.fulfill({ response, headers: { ...response.headers(), ...cors } });
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));

let failed = 0;
for (const id of ids) {
  try {
    const { data: room } = await admin.from('rooms').select('id, title, is_public, status, thumbnail_key').eq('id', id).maybeSingle();
    if (!room?.is_public || room.status !== 'ready') throw new Error('공개된 준비 완료 방이 아님');
    if (room.thumbnail_key && !force) {
      console.log('SKIP', id, room.title, '(이미 있음)');
      continue;
    }
    const res = await page.goto(`${appUrl}/rooms/${id}`);
    if (res?.status() !== 200) throw new Error(`방 화면 ${res?.status()}`);
    await page.getByTestId('stage-calibrated').or(page.getByTestId('stage-uncalibrated')).waitFor({ timeout: 120000 });
    // 스플랫의 세밀도가 다 올라올 때까지
    await page.waitForTimeout(6000);
    // 3D 캔버스만 남긴다
    await page.addStyleTag({ content: '[data-testid=stage] > :not(:first-child) { display: none !important; }' });
    await page.waitForTimeout(500);
    const png = await page.locator('[data-testid=stage] canvas').first().screenshot();
    const jpegBase64 = await page.evaluate(async (pngBase64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${pngBase64}`;
      await image.decode();
      const aspect = 960 / 600;
      const w = image.width / image.height > aspect ? Math.round(image.height * aspect) : image.width;
      const h = Math.round(w / aspect);
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 600;
      canvas.getContext('2d').drawImage(image, (image.width - w) / 2, (image.height - h) / 2, w, h, 0, 0, 960, 600);
      return canvas.toDataURL('image/jpeg', 0.85).replace(/^data:image\/jpeg;base64,/, '');
    }, png.toString('base64'));
    const body = Buffer.from(jpegBase64, 'base64');
    if (body.length < 8 * 1024) throw new Error(`사진이 거의 비어 있음 (${body.length} bytes)`);
    const key = `rooms/${id}/thumbnail-${Date.now()}.jpg`;
    await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, Body: body, ContentType: 'image/jpeg' }));
    const { error } = await admin.from('rooms').update({ thumbnail_key: key }).eq('id', id);
    if (error) throw new Error(error.message);
    if (room.thumbnail_key) await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: room.thumbnail_key }));
    console.log('OK', id, room.title, `${Math.round(body.length / 1024)}KB`);
  } catch (err) {
    failed += 1;
    console.log('FAIL', id, String(err).slice(0, 200));
  }
}
await browser.close();
process.exitCode = failed ? 1 : 0;
