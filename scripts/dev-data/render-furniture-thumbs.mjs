// 카탈로그 가구 목록에 넣을 작은 사진을 만든다: 압축한 모델(build-furniture-models.mjs의 결과)을 브라우저에서 그려
// public/furniture/{id}.webp (배경 투명, 96 × 96)로 저장한다. 모델을 바꾸면 다시 돌린다.
//
// 준비: ../roomlens-data/_e2e 에 playwright-core, ../roomlens-data/models/catalog/*.glb
// 실행: node scripts/dev-data/render-furniture-thumbs.mjs [id ...]
//   PLAYWRIGHT_MODULE=… 로 playwright 위치를, CHROMIUM_PATH=… 로 브라우저를 바꿀 수 있다 (없으면 설치된 Chrome)
import { createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(root, '../roomlens-data');
const modelDir = path.join(dataDir, 'models', 'catalog');
const outDir = path.join(root, 'public', 'furniture');
const require = createRequire(path.join(dataDir, '_e2e', 'package.json'));
const { chromium } = process.env.PLAYWRIGHT_MODULE ? await import(process.env.PLAYWRIGHT_MODULE) : require('playwright-core');

/** 저장할 크기 (px). 목록에서는 40px로 보이므로 2배보다 조금 크게 */
const SIZE = 96;

const PAGE = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c" width="${SIZE * 2}" height="${SIZE * 2}"></canvas>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('c'), antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
window.draw = async (url) => {
  const scene = new THREE.Scene();
  // 방 화면과 같은 조명 (FurnitureLayer)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(2, 5, 3);
  scene.add(sun);
  const object = (await loader.loadAsync(url)).scene;
  scene.add(object);
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  // 앞(+z)에서 오른쪽 위로 비스듬히 본다
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const direction = new THREE.Vector3(0.75, 0.6, 1).normalize();
  camera.position.copy(center).addScaledVector(direction, radius / Math.sin(THREE.MathUtils.degToRad(15)));
  camera.lookAt(center);
  renderer.render(scene, camera);
  object.traverse((node) => node.geometry?.dispose());
};
window.ready = true;
</script></body></html>`;

const types = { '.js': 'text/javascript', '.glb': 'model/gltf-binary' };
const server = http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    const file = url.startsWith('/three/') ? path.join(root, 'node_modules', url) : url.startsWith('/models/') ? path.join(modelDir, url.slice('/models/'.length)) : null;
    if (!file || !existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  })
  .listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: SIZE * 2, height: SIZE * 2 } });
  await page.goto(base);
  await page.waitForFunction(() => window.ready);
  mkdirSync(outDir, { recursive: true });
  const only = process.argv.slice(2);
  const ids = readdirSync(modelDir)
    .filter((f) => f.endsWith('.glb'))
    .map((f) => f.slice(0, -4))
    .filter((id) => !only.length || only.includes(id));
  for (const id of ids) {
    await page.evaluate((url) => window.draw(url), `/models/${id}.glb`);
    const png = await page.locator('#c').screenshot({ omitBackground: true });
    await sharp(png).resize(SIZE, SIZE).webp({ quality: 82, alphaQuality: 90 }).toFile(path.join(outDir, `${id}.webp`));
    console.log(`public/furniture/${id}.webp`);
  }
} finally {
  await browser.close();
  server.close();
}
