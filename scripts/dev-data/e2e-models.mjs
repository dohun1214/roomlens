// 가구 3D 모델 실측: 카탈로그 가구 10종을 놓은 방을 열어 모델이 불러와지는지, 치수에 맞는지 본다.
// 보정 값은 secret key로 직접 넣으므로(탭 자동화 없음) 운영 주소에서도 돌릴 수 있다.
// 방은 비공개로만 만든다. 개발 서버에서는 스플랫을 숨기고 가구만 찍은 그림도 남긴다 (../roomlens-data/_e2e/models-*.png).
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/samples/studio11_1m_up.sog
// 실행: node --env-file=.env.local scripts/dev-data/e2e-models.mjs
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

// 시험용 방: 6 × 5 m 사각형 (파일 좌표를 그대로 방 좌표로 쓴다)
const TRANSFORM = { s: 1, q: [0, 0, 0, 1], t: [0, 0, 0], flipX: false };
const FLOOR = [[-3, -2.5], [3, -2.5], [3, 2.5], [-3, 2.5]];

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
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { method, url, body },
  );
/** 방을 열고 가구 패널이 뜰 때까지 기다린다 */
const openRoom = async (page, roomId) => {
  await page.goto(`${appUrl}/rooms/${roomId}`);
  await page.getByTestId('furniture-panel').waitFor({ timeout: 120000 });
};
// 6 × 5 m 방에 10종을 겹치지 않게 놓는다 (회전 0°: 앞면이 +z, 화면에서는 카메라 쪽)
const piece = (id, furnitureRef, x, z, rotationDeg = 0) => ({ id, furnitureRef, kind: 'catalog', x, z, rotationDeg });
const LAYOUT = [
  piece('f1', 'bed-single', -2.4, -1.4),
  piece('f2', 'bed-super-single', -1.1, -1.4),
  piece('f3', 'bed-queen', 0.5, -1.4),
  piece('f4', 'wardrobe', 2.0, -2.1),
  piece('f5', 'bookcase', 2.55, -0.2),
  piece('f6', 'desk', -2.2, 1.0),
  piece('f7', 'chair', -0.9, 1.0),
  piece('f8', 'drawer', 0.2, 1.0),
  piece('f9', 'table-2', 1.4, 1.0),
  piece('f10', 'hanger', 2.4, 1.0),
];
const WITH_MODEL = ['bed-single', 'bed-super-single', 'bed-queen', 'desk', 'chair', 'wardrobe', 'drawer', 'table-2', 'bookcase'];

try {
  // 0) 카탈로그와 R2
  const { data: catalog } = await admin.from('furniture_catalog').select('id, model_key, license').order('sort_order');
  const keyed = catalog.filter((c) => c.model_key);
  check('DB: 9종에 모델 경로와 라이선스(CC0), 행거는 없음', keyed.length === 9 && keyed.every((c) => c.model_key === `furniture/catalog/${c.id}.glb` && c.license.includes('CC0')) && catalog.find((c) => c.id === 'hanger').model_key === null, keyed.map((c) => c.id));
  const stored = await listKeys('furniture/catalog/');
  check('R2: furniture/catalog/ 에 모델 파일 9개', WITH_MODEL.every((id) => stored.includes(`furniture/catalog/${id}.glb`)) && stored.length === 9, stored.length);

  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값·배치 넣기
  const page = await newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  const glbResponses = [];
  page.on('response', (res) => {
    if (res.url().includes('/furniture/catalog/')) glbResponses.push({ status: res.status(), id: res.url().split('/furniture/catalog/')[1].split('.glb')[0] });
  });
  await signUp(page, emails.owner);
  await page.route('**/__e2e_scene', (route) => route.fulfill({ path: scenePath, contentType: 'application/octet-stream' }));
  const roomId = (await api(page, 'POST', '/api/rooms', { title: '가구 모델 실측 방', consent: true, source: 'dataset', credit: 'Studio 11 by milanoski (SuperSplat), CC BY 4.0' })).json.room.id;
  const signed = await api(page, 'POST', '/api/upload-url', { roomId, kind: 'splat', format: 'sog', size: sceneBytes });
  const putStatus = await page.evaluate(
    async ({ url, headers }) => (await fetch(url, { method: 'PUT', headers, body: await (await fetch('/__e2e_scene')).blob() })).status,
    { url: signed.json.url, headers: signed.json.headers },
  );
  const done = await api(page, 'PATCH', `/api/rooms/${roomId}`, { splatFormat: 'sog' });
  const { error: setupError } = await admin.from('rooms').update({ transform: TRANSFORM, floor_polygon: FLOOR }).eq('id', roomId);
  const { data: roomRow } = await admin.from('rooms').select('owner_id').eq('id', roomId).maybeSingle();
  const { error: layoutError } = await admin.from('layouts').insert({ room_id: roomId, owner_id: roomRow.owner_id, items: LAYOUT });
  check('준비: 방 업로드 완료, 보정 값·배치(10종) 넣음', putStatus === 200 && done.status === 200 && !setupError && !layoutError, [putStatus, done.status]);

  const panel = page.getByTestId('furniture-panel');
  const items = async () => JSON.parse(await panel.getAttribute('data-json'));

  // 1) 방을 열면 모델을 받아 그린다
  await openRoom(page, roomId);
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=furniture-panel]').getAttribute('data-json')).filter((i) => i.model).length >= 9, null, { timeout: 30000 }).catch(() => {});
  const shown = await items();
  check('9종은 3D 모델로, 행거는 상자로 그려짐', shown.length === 10 && shown.filter((i) => i.model).map((i) => i.furnitureRef).sort().join() === [...WITH_MODEL].sort().join() && shown.find((i) => i.furnitureRef === 'hanger').model === false, shown.map((i) => [i.name, i.model]));
  const okIds = [...new Set(glbResponses.filter((r) => r.status === 200).map((r) => r.id))];
  check('모델 파일 9개를 한 번씩만 받음 (모두 200)', okIds.length === 9 && glbResponses.length === 9, glbResponses.map((r) => r.status));
  check('치수·위치는 카탈로그·저장값 그대로 (모델이 가구 크기를 바꾸지 않음)', shown[0].w === 1 && shown[0].d === 2 && shown[2].w === 1.5 && shown[5].name === '책상' && shown[5].w === 1.2 && shown[5].h === 0.73 && shown[5].x === -2.2, shown.slice(0, 3).map((i) => [i.name, i.w, i.d, i.h]));
  // 침대 셋을 나란히 붙여 놓아 "옆으로 들어갈 자리" 경고는 나온다. 고쳐야 하는 문제(겹침·방 밖)는 없어야 한다
  check('배치에 고쳐야 할 문제 없음, 화면 오류 없음', (await page.getByTestId('layout-violations').getAttribute('data-errors')) === '0' && pageErrors.length === 0, pageErrors);

  // 2) 개발 서버: 그려진 모델의 실제 크기를 재고(월드 좌표의 경계 상자), 그림을 남긴다
  const dev = await page.evaluate(() => Boolean(window.__roomlens));
  if (dev) {
    const measured = await page.evaluate(() => {
      const e = window.__roomlens;
      const out = [];
      e.scene.traverse((node) => {
        if (!node.userData?.id || !node.isMesh) return;
        const model = node.children.find((c) => c.isGroup);
        if (!model) return;
        model.updateMatrixWorld(true);
        // 모델의 메시만으로 경계 상자를 잰다
        let min = [Infinity, Infinity, Infinity];
        let max = [-Infinity, -Infinity, -Infinity];
        model.traverse((m) => {
          if (!m.isMesh) return;
          m.geometry.computeBoundingBox();
          const b = m.geometry.boundingBox;
          for (let c = 0; c < 8; c += 1) {
            const p = m.position.clone().set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z).applyMatrix4(m.matrixWorld);
            min = min.map((v, k) => Math.min(v, p.getComponent(k)));
            max = max.map((v, k) => Math.max(v, p.getComponent(k)));
          }
        });
        out.push({ id: node.userData.id, size: max.map((v, k) => +(v - min[k]).toFixed(3)), floor: +min[1].toFixed(3), center: [+((min[0] + max[0]) / 2).toFixed(3), +((min[2] + max[2]) / 2).toFixed(3)] });
      });
      return out;
    });
    const byId = Object.fromEntries(measured.map((m) => [m.id, m]));
    const fits = shown.filter((i) => i.model).every((i) => {
      const m = byId[i.id];
      return m && Math.abs(m.size[0] - i.w) < 0.002 && Math.abs(m.size[1] - i.h) < 0.002 && Math.abs(m.size[2] - i.d) < 0.002 && Math.abs(m.floor) < 0.002 && Math.abs(m.center[0] - i.x) < 0.002 && Math.abs(m.center[1] - i.z) < 0.002;
    });
    check('그려진 모델 9개의 크기가 가구의 가로·높이·깊이와 같고, 바닥(y=0) 위 제자리에 있음', measured.length === 9 && fits, measured.map((m) => [m.id, ...m.size]));

    const shot = async (name, position, target) => {
      await page.evaluate(
        async ({ position, target }) => {
          const e = window.__roomlens;
          e.splat.visible = false;
          e.scene.background = e.scene.background ?? null;
          e.camera.position.set(...position);
          e.controls.target.set(...target);
          e.controls.update();
          await new Promise((r) => setTimeout(r, 600));
        },
        { position, target },
      );
      await page.getByTestId('panel-compact').isVisible();
      await page.screenshot({ path: path.join(dataDir, '_e2e', name) });
    };
    await page.getByTestId('panel-compact').click();
    await shot('models-front.png', [0, 2.6, 5.2], [0, 0.4, -0.6]);
    await shot('models-top.png', [0, 8.5, 0.01], [0, 0, 0]);
    await shot('models-back.png', [0, 2.6, -5.6], [0, 0.4, 0.6]);
    await shot('models-tall-front.png', [1.2, 1.4, 1.6], [2.2, 0.9, -1.4]);
    await shot('models-tall-back.png', [1.2, 1.4, -4.6], [2.2, 0.9, -1.4]);

    // 3) 모델로 그려진 가구도 3D에서 끌 수 있다 (보이지 않는 상자를 잡는다)
    await page.evaluate(async () => {
      const e = window.__roomlens;
      e.camera.position.set(0, 6, 3);
      e.controls.target.set(0, 0, 0.5);
      e.controls.update();
      await new Promise((r) => setTimeout(r, 400));
    });
    const project = (point) =>
      page.evaluate((point) => {
        const e = window.__roomlens;
        const v = e.camera.position.clone().set(...point).project(e.camera);
        const rect = e.renderer.domElement.getBoundingClientRect();
        return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
      }, point);
    const table = shown.find((i) => i.furnitureRef === 'table-2');
    const from = await project([table.x, table.h, table.z]);
    const to = await project([table.x, 0, table.z + 0.8]);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    const draggedTable = (await items()).find((i) => i.furnitureRef === 'table-2');
    check('모델로 그려진 식탁을 3D에서 끌면 움직임 (z +0.5m 이상)', draggedTable.z - table.z > 0.5 && Math.abs(draggedTable.x - table.x) < 0.3, [table.z, draggedTable.z]);
  }

  // 4) 평면도·저장은 그대로
  if (!dev) await page.getByTestId('panel-compact').click();
  await page.getByTestId('plan-toggle').click();
  check('평면도에는 10개가 모두 나옴', (await page.getByTestId('plan-item').count()) === 10, null);
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
    check('시험용 계정·방·R2 파일 삭제 (모델 파일은 그대로)', mine.length === 1 && (await listKeys('furniture/catalog/')).length === 9, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
