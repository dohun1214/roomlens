// 가구 3D 모델 실측: 카탈로그 가구(실사 모델, 18종 × 두 모양)를 놓은 방을 열어 모델이 불러와지는지, 치수에 맞는지 본다.
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
const PLACED = LAYOUT.map((p) => p.furnitureRef);
// 두 번째 배치: 새 종류 8개와 두 번째 모양들 (6 × 5 m 방에 겹치지 않게)
const LAYOUT_2 = [
  piece('g1', 'sofa', -2.0, -2.0),
  piece('g2', 'coffee-table', -2.0, -0.9),
  piece('g3', 'tv-stand', -2.0, 0.6, 180),
  piece('g4', 'nightstand', 0.0, -2.2),
  piece('g5', 'vanity', 1.2, -1.85),
  piece('g6', 'shoe-cabinet', 2.6, -2.35),
  piece('g7', 'bench', 2.4, -0.4),
  piece('g8', 'floor-lamp', -0.4, -0.4),
  piece('g9', 'sofa-b', -1.9, 1.9, 180),
  piece('g10', 'bookcase-b', 0.2, 2.35, 180),
  piece('g11', 'desk-b', 1.6, 2.2, 180),
  piece('g12', 'floor-lamp-b', 2.8, 0.8),
];
const PLACED_2 = LAYOUT_2.map((p) => p.furnitureRef);
const MODEL_PREFIX = 'furniture/catalog/v2/';

/** 그려진 모델마다 월드 좌표의 경계 상자(크기·바닥 높이·가운데)와 그림자 판의 높이를 잰다 (개발 서버에서만) */
const measureModels = (page) =>
  page.evaluate(() => {
    const e = window.__roomlens;
    const out = [];
    e.scene.traverse((node) => {
      if (!node.userData?.id || !node.isMesh) return;
      const model = node.children.find((c) => c.isGroup);
      const shadow = node.children.find((c) => c.isMesh && c.material?.map && c.material.transparent);
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
      shadow?.updateMatrixWorld(true);
      const shadowY = shadow ? +shadow.getWorldPosition(shadow.position.clone()).y.toFixed(4) : null;
      out.push({ id: node.userData.id, size: max.map((v, k) => +(v - min[k]).toFixed(3)), floor: +min[1].toFixed(3), center: [+((min[0] + max[0]) / 2).toFixed(3), +((min[2] + max[2]) / 2).toFixed(3)], shadowY });
    });
    return out;
  });
/** 잰 모델이 가구의 가로·높이·깊이와 같고 바닥(y=0) 위 제자리에 있는지 (2mm 안) */
const fits = (measured, shown) => {
  const byId = Object.fromEntries(measured.map((m) => [m.id, m]));
  return shown.every((i) => {
    const m = byId[i.id];
    return m && Math.abs(m.size[0] - i.w) < 0.002 && Math.abs(m.size[1] - i.h) < 0.002 && Math.abs(m.size[2] - i.d) < 0.002 && Math.abs(m.floor) < 0.002 && Math.abs(m.center[0] - i.x) < 0.002 && Math.abs(m.center[1] - i.z) < 0.002;
  });
};

try {
  // 0) 카탈로그와 R2
  const { data: catalog } = await admin.from('furniture_catalog').select('id, model_key, license').order('sort_order');
  const keyed = catalog.filter((c) => c.model_key);
  const licensed = (c) => (c.id === 'bookcase-b' ? c.license === 'Poly Haven (CC0)' : c.license === 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0');
  check('DB: 36개(18종 × 두 모양) 모두 실사 모델 경로와 라이선스 (책장 · 화이트만 Poly Haven)', catalog.length === 36 && keyed.length === 36 && keyed.every((c) => c.model_key === `${MODEL_PREFIX}${c.id}.glb` && licensed(c)), keyed.length);
  const stored = await listKeys(MODEL_PREFIX);
  check(`R2: ${MODEL_PREFIX} 에 모델 파일 36개`, catalog.every((c) => stored.includes(`${MODEL_PREFIX}${c.id}.glb`)) && stored.length === 36, stored.length);

  // 준비: 방 주인이 가입 → 방 만들고 파일 올리기 → 보정 값·배치 넣기
  const page = await newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
  const glbResponses = [];
  page.on('response', (res) => {
    if (res.url().includes(`/${MODEL_PREFIX}`)) glbResponses.push({ status: res.status(), id: res.url().split(`/${MODEL_PREFIX}`)[1].split('.glb')[0], bytes: Number(res.headers()['content-length'] ?? 0) });
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
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid=furniture-panel]').getAttribute('data-json')).filter((i) => i.model).length >= 10, null, { timeout: 30000 }).catch(() => {});
  const shown = await items();
  check('놓은 10개 모두 3D 모델로 그려짐', shown.length === 10 && shown.filter((i) => i.model).map((i) => i.furnitureRef).sort().join() === [...PLACED].sort().join(), shown.map((i) => [i.name, i.model]));
  const okIds = [...new Set(glbResponses.filter((r) => r.status === 200).map((r) => r.id))];
  check('모델 파일 10개를 한 번씩만 받음 (모두 200)', okIds.length === 10 && glbResponses.length === 10, glbResponses.map((r) => r.status));
  const totalBytes = glbResponses.reduce((sum, r) => sum + r.bytes, 0);
  check('모델 파일은 작다 (하나 1MB 미만, 10개 합 3MB 미만)', glbResponses.every((r) => r.bytes > 0 && r.bytes < 1e6) && totalBytes < 3e6, `${(totalBytes / 1e6).toFixed(2)}MB`);
  check('치수·위치는 카탈로그(실사 모델의 실제 크기)·저장값 그대로', shown[0].w === 0.99 && shown[0].d === 2.14 && shown[2].w === 1.47 && shown[5].name === '책상' && shown[5].w === 1.25 && shown[5].h === 0.77 && shown[5].x === -2.2, shown.slice(0, 3).map((i) => [i.name, i.w, i.d, i.h]));
  const credit = await page.getByTestId('furniture-credit').innerText();
  check('가구 추가 칸 아래에 모델 출처(ABO, CC BY 4.0 · Poly Haven)가 보임', credit.includes('Amazon Berkeley Objects (Amazon.com), CC BY 4.0') && credit.includes('Poly Haven (CC0)'), credit);
  const labels = await page.getByTestId('furniture-catalog').getByRole('button', { name: /^\+ / }).evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')));
  check('목록: 36칸, "종류 · 모양" 이름, 같은 종류 둘이 나란히', labels.length === 36 && labels[0] === '+ 싱글 침대 · 원목' && labels[1] === '+ 싱글 침대 · 철제' && labels.includes('+ 소파 · 화이트') && labels.includes('+ 스탠드 조명 · 구형'), labels.slice(0, 4));
  await page.getByTestId('furniture-catalog').scrollIntoViewIfNeeded();
  const thumbs = await page.getByTestId('furniture-catalog').getByTestId('furniture-thumb').evaluateAll(async (images) => {
    await Promise.all(images.map((img) => (img.complete ? null : new Promise((r) => img.addEventListener('load', r, { once: true })))));
    return images.map((img) => img.naturalWidth);
  });
  check('목록의 36칸 모두 모델 사진(96px)이 뜸', thumbs.length === 36 && thumbs.every((w) => w === 96), thumbs.filter((w) => w !== 96).length);
  // 침대 셋을 나란히 붙여 놓아 "옆으로 들어갈 자리" 경고는 나온다. 고쳐야 하는 문제(겹침·방 밖)는 없어야 한다
  check('배치에 고쳐야 할 문제 없음, 화면 오류 없음', (await page.getByTestId('layout-violations').getAttribute('data-errors')) === '0' && pageErrors.length === 0, pageErrors);

  // 2) 개발 서버: 그려진 모델의 실제 크기를 재고(월드 좌표의 경계 상자), 그림을 남긴다
  const dev = await page.evaluate(() => Boolean(window.__roomlens));
  if (dev) {
    const measured = await measureModels(page);
    check('그려진 모델 10개의 크기가 가구의 가로·높이·깊이와 같고, 바닥(y=0) 위 제자리에 있음', measured.length === 10 && fits(measured, shown), measured.map((m) => [m.id, ...m.size]));
    check('모델마다 바닥 바로 위(0~1cm)에 그림자 판이 있음', measured.every((m) => m.shadowY !== null && m.shadowY > 0 && m.shadowY < 0.01), measured.map((m) => m.shadowY));

    const shot = async (name, position, target) => {
      await page.evaluate(
        async ({ position, target }) => {
          const e = window.__roomlens;
          e.freeCamera = true; // 방 밖에서 내려다보도록 "방 안에서만"을 끈다
          e.splat.visible = false;
          e.scene.background = e.scene.background ?? null;
          e.camera.position.set(...position);
          e.controls.target.set(...target);
          e.controls.update();
          await new Promise((r) => setTimeout(r, 600));
        },
        { position, target },
      );
      await page.screenshot({ path: path.join(dataDir, '_e2e', name) });
    };
    await shot('models-front.png', [0, 2.6, 5.2], [0, 0.4, -0.6]);
    await shot('models-top.png', [0, 8.5, 0.01], [0, 0, 0]);
    await shot('models-back.png', [0, 2.6, -5.6], [0, 0.4, 0.6]);
    await shot('models-tall-front.png', [1.2, 1.4, 1.6], [2.2, 0.9, -1.4]);
    await shot('models-tall-back.png', [1.2, 1.4, -4.6], [2.2, 0.9, -1.4]);

    // 3) 모델로 그려진 가구도 3D에서 끌 수 있다 (보이지 않는 상자를 잡는다)
    await page.evaluate(async () => {
      const e = window.__roomlens;
      e.freeCamera = true;
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
  await page.getByTestId('plan-toggle').click();
  check('평면도에는 10개가 모두 나옴', (await page.getByTestId('plan-item').count()) === 10, null);

  // 5) 두 번째 배치: 새 종류 8개와 두 번째 모양들
  const glbBefore = glbResponses.length;
  const { error: layout2Error } = await admin.from('layouts').update({ items: LAYOUT_2 }).eq('room_id', roomId);
  await openRoom(page, roomId);
  await page.waitForFunction((n) => JSON.parse(document.querySelector('[data-testid=furniture-panel]').getAttribute('data-json')).filter((i) => i.model).length >= n, LAYOUT_2.length, { timeout: 30000 }).catch(() => {});
  const shown2 = await items();
  check('두 번째 배치(새 종류 8개 + 두 번째 모양 4개): 12개 모두 모델로 그려지고 고쳐야 할 문제 없음', !layout2Error && shown2.length === 12 && shown2.every((i) => i.model) && shown2.map((i) => i.furnitureRef).join() === PLACED_2.join() && (await page.getByTestId('layout-violations').getAttribute('data-errors')) === '0', [shown2.filter((i) => !i.model).map((i) => i.furnitureRef), await page.getByTestId('layout-violations').innerText()]);
  check('소파 앞의 커피테이블은 "앞이 막힘" 경고가 아님', !(await page.getByTestId('layout-violations').innerText()).includes('소파: 앞이 막혀'), await page.getByTestId('layout-violations').innerText());
  check('새로 받은 모델 파일 12개 모두 200', glbResponses.slice(glbBefore).filter((r) => r.status === 200).length === 12, glbResponses.slice(glbBefore).map((r) => r.id));
  if (dev) {
    const measured2 = await measureModels(page);
    check('두 번째 배치의 모델 12개도 치수·바닥·제자리가 맞음', measured2.length === 12 && fits(measured2, shown2), measured2.map((m) => [m.id, ...m.size]));
    await page.evaluate(async () => {
      const e = window.__roomlens;
      e.freeCamera = true;
      e.splat.visible = false;
      e.camera.position.set(0.3, 3.0, 5.4);
      e.controls.target.set(0, 0.4, -0.2);
      e.controls.update();
      await new Promise((r) => setTimeout(r, 800));
    });
    await page.screenshot({ path: path.join(dataDir, '_e2e', 'models-new-kinds.png') });
  }
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
    check('시험용 계정·방·R2 파일 삭제 (모델 파일은 그대로)', mine.length === 1 && (await listKeys(MODEL_PREFIX)).length === 36, `계정 ${mine.length}, 지운 파일 ${removed}`);
}

for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.detail ? JSON.stringify(c.detail) : '');
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
