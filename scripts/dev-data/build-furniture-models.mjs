// 카탈로그 가구의 실사 3D 모델(GLB)을 받아 웹에 맞게 줄이고 R2의 furniture/catalog/v2/{id}.glb 로 올린다.
//
// 원본 (원본 파일은 저장소에 넣지 않는다. ../roomlens-data/models 아래에 받아 둔다)
// - Amazon Berkeley Objects (ABO): 실제 판매 상품을 스캔·모델링한 GLB. CC BY 4.0, 출처 "Amazon.com".
//   모든 모델이 위 = +y, 앞면 = +z, 바닥(y = 0)에 서 있도록 맞춰져 있다.
//   https://amazon-berkeley-objects.s3.amazonaws.com/index.html
// - Poly Haven: 스캔 기반 모델. CC0. https://polyhaven.com/models
//
// 실행: node --env-file=.env.local scripts/dev-data/build-furniture-models.mjs [--upload] [id ...]
//
// 하는 일: 원본을 받아(이미 있으면 건너뜀) 텍스처를 WebP(색 1024px, 나머지 512px)로, 메시를 meshopt로 압축한다(원본 5~45MB → 0.1~0.7MB).
// 필요하면 Y축으로 돌려 앞면을 +z에 맞춘다. 크기와 위치는 뷰어가 맞춘다(경계 상자의 바닥 가운데를 원점에 두고 가구 치수로 늘인다).
// 마지막에 모델의 실제 크기를 출력한다: 카탈로그 치수(DEFAULT_CATALOG, furniture_catalog)는 이 값을 cm로 반올림해 쓴다.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, getBounds, join, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
const modelsDir = path.join(dataDir, 'models');
const outDir = path.join(modelsDir, 'catalog');

export const LICENSES = {
  abo: 'Amazon Berkeley Objects (Amazon.com), CC BY 4.0',
  polyhaven: 'Poly Haven (CC0)',
};

/**
 * 카탈로그 id → 원본. key는 ABO의 3dmodel_id 또는 Poly Haven의 자산 id.
 * yaw(도)는 원본의 앞면이 +z를 보도록 돌리는 각도 (ABO는 이미 +z라 0. Shelf_01도 앞이 +z).
 * 종류마다 두 가지 모양이 있고, 두 번째는 id 끝에 -b를 붙인다.
 * 슈퍼싱글은 싱글과 같은 모델을 폭만 넓혀 쓴다 (뷰어가 치수에 맞춰 늘인다).
 */
export const MODELS = {
  'bed-single': { source: 'abo', key: 'B07H8V7MQS', yaw: 0 }, // 원목 (Movian Moselle)
  'bed-single-b': { source: 'abo', key: 'B086TFXK75', yaw: 0 }, // 철제
  'bed-super-single': { source: 'abo', key: 'B07H8V7MQS', yaw: 0 },
  'bed-super-single-b': { source: 'abo', key: 'B086TFXK75', yaw: 0 },
  'bed-queen': { source: 'abo', key: 'B07K7NXVXR', yaw: 0 }, // 원목
  'bed-queen-b': { source: 'abo', key: 'B086TG9Q4V', yaw: 0 }, // 철제
  desk: { source: 'abo', key: 'B07H4MM3TC', yaw: 0 }, // 서랍형 (Moselle)
  'desk-b': { source: 'abo', key: 'B07XL85YDN', yaw: 0 }, // 철제 다리
  chair: { source: 'abo', key: 'B07MDJYKXR', yaw: 0 }, // 패브릭 회전의자
  'chair-b': { source: 'abo', key: 'B075YMXWZM', yaw: 0 }, // 원목 의자
  wardrobe: { source: 'abo', key: 'B07H8V7P3H', yaw: 0 }, // 원목 (Moselle)
  'wardrobe-b': { source: 'abo', key: 'B07JGMW8DG', yaw: 0 }, // 화이트
  hanger: { source: 'abo', key: 'B07TY5QHX1', yaw: 0 }, // 선반형
  'hanger-b': { source: 'abo', key: 'B07TTYC9XD', yaw: 0 }, // 심플
  drawer: { source: 'abo', key: 'B084ZB8L8W', yaw: 0 }, // 원목 3단
  'drawer-b': { source: 'abo', key: 'B07HSL4TS1', yaw: 0 }, // 화이트
  'table-2': { source: 'abo', key: 'B07ML7P94G', yaw: 0 }, // 정사각
  'table-2-b': { source: 'abo', key: 'B07B86T48F', yaw: 0 }, // 원목
  bookcase: { source: 'abo', key: 'B075Z6YS1Z', yaw: 0 }, // 철제 4단
  'bookcase-b': { source: 'polyhaven', key: 'Shelf_01', yaw: 0 }, // 화이트
  sofa: { source: 'abo', key: 'B07B4M38B4', yaw: 0 }, // 화이트 2인
  'sofa-b': { source: 'abo', key: 'B071FMSY5M', yaw: 0 }, // 차콜 2인
  'tv-stand': { source: 'abo', key: 'B07HSJDMXQ', yaw: 0 }, // 원목
  'tv-stand-b': { source: 'abo', key: 'B07GFFR1SC', yaw: 0 }, // 블랙
  nightstand: { source: 'abo', key: 'B07K7K7GTZ', yaw: 0 }, // 원목
  'nightstand-b': { source: 'abo', key: 'B079VPLVH5', yaw: 0 }, // 화이트
  'coffee-table': { source: 'abo', key: 'B07H8SZP51', yaw: 0 }, // 화이트
  'coffee-table-b': { source: 'abo', key: 'B07QFB1TH8', yaw: 0 }, // 원목
  'shoe-cabinet': { source: 'abo', key: 'B07GG2X2MX', yaw: 0 }, // 화이트
  'shoe-cabinet-b': { source: 'abo', key: 'B07GFDZWMS', yaw: 0 }, // 블랙
  vanity: { source: 'abo', key: 'B076HF56ZC', yaw: 0 }, // 거울·의자 세트
  'vanity-b': { source: 'abo', key: 'B079ZB4V97', yaw: 0 }, // 서랍형
  bench: { source: 'abo', key: 'B07DBHFDSQ', yaw: 0 }, // 블랙 수납 벤치
  'bench-b': { source: 'abo', key: 'B07M6PKCQR', yaw: 0 }, // 화이트 수납 벤치
  'floor-lamp': { source: 'abo', key: 'B07HKF28GD', yaw: 0 }, // 갓 스탠드
  'floor-lamp-b': { source: 'abo', key: 'B082XLB716', yaw: 0 }, // 구형 스탠드
};

/** 텍스처의 긴 변 (px). 색은 1024, 요철·거칠기는 화면에서 덜 보이므로 512로 줄여 폰의 GPU 메모리를 아낀다 */
const COLOR_TEXTURE_SIZE = 1024;
const DETAIL_TEXTURE_SIZE = 512;
/** 메시 단순화 허용 오차 (모델 크기에 대한 비율) */
const SIMPLIFY_ERROR = 0.0001;
const USER_AGENT = 'RoomLens-dev/1.0 (school project)';

async function download(url, file) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`받기 실패 ${res.status}: ${url}`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** 원본을 받아 두고 읽을 파일 경로를 돌려준다 */
async function fetchSource({ source, key }) {
  if (source === 'abo') {
    // 저장소 안의 경로는 "<id의 마지막 글자>/<id>.glb"
    const file = path.join(modelsDir, 'abo', `${key}.glb`);
    if (!existsSync(file)) await download(`https://amazon-berkeley-objects.s3.amazonaws.com/3dmodels/original/${key.at(-1)}/${key}.glb`, file);
    return file;
  }
  if (source === 'polyhaven') {
    const dir = path.join(modelsDir, 'polyhaven', key);
    const file = path.join(dir, `${key}.gltf`);
    if (!existsSync(file)) {
      const res = await fetch(`https://api.polyhaven.com/files/${key}`, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`Poly Haven 목록 실패 ${res.status}: ${key}`);
      const gltf = (await res.json()).gltf['1k'].gltf;
      for (const [rel, { url }] of Object.entries(gltf.include ?? {})) await download(url, path.join(dir, rel));
      await download(gltf.url, file);
    }
    return file;
  }
  throw new Error(`모르는 원본: ${source}`);
}

/** 장면의 맨 위에 Y축 회전 노드를 하나 끼운다 */
function addYaw(document, yawDeg) {
  if (!yawDeg) return;
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  const half = (yawDeg * Math.PI) / 360;
  const root = document.createNode('roomlens-root').setRotation([0, Math.sin(half), 0, Math.cos(half)]);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    root.addChild(child);
  }
  scene.addChild(root);
}

const round = (v) => +v.toFixed(3);

/** 원본 크기 (Poly Haven은 .gltf 옆의 파일까지 더한다) */
function sourceBytes(file) {
  if (!file.endsWith('.gltf')) return statSync(file).size;
  const dir = path.dirname(file);
  return readdirSync(dir, { recursive: true }).reduce((sum, rel) => {
    const stat = statSync(path.join(dir, rel));
    return stat.isFile() ? sum + stat.size : sum;
  }, 0);
}

async function main() {
  const upload = process.argv.includes('--upload');
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  mkdirSync(outDir, { recursive: true });
  const s3 = upload
    ? new S3Client({
        region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED',
      })
    : null;

  const sizes = {};
  for (const [id, model] of Object.entries(MODELS)) {
    if (only.length && !only.includes(id)) continue;
    const sourceFile = await fetchSource(model);
    const document = await io.read(sourceFile);
    document.setLogger(new Logger(Logger.Verbosity.WARN));
    addYaw(document, model.yaw);
    await document.transform(
      dedup(),
      flatten(),
      join(),
      weld(),
      simplify({ simplifier: MeshoptSimplifier, error: SIMPLIFY_ERROR }),
      textureCompress({ encoder: sharp, targetFormat: 'webp', slots: /^(normal|occlusion|metallicRoughness)/, resize: [DETAIL_TEXTURE_SIZE, DETAIL_TEXTURE_SIZE] }),
      textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [COLOR_TEXTURE_SIZE, COLOR_TEXTURE_SIZE] }),
      prune(),
      meshopt({ encoder: MeshoptEncoder, level: 'high' }),
    );
    const outFile = path.join(outDir, `${id}.glb`);
    await io.write(outFile, document);
    const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
    const { min, max } = getBounds(scene);
    const size = max.map((v, k) => v - min[k]);
    sizes[id] = { source: model.source, key: model.key, license: LICENSES[model.source], width: round(size[0]), depth: round(size[2]), height: round(size[1]) };
    const mb = (bytes) => (bytes / 1e6).toFixed(2);
    console.log(`${id} ← ${model.source}:${model.key}: 가로 ${round(size[0])} × 깊이 ${round(size[2])} × 높이 ${round(size[1])} m, ${mb(sourceBytes(sourceFile))}MB → ${mb(statSync(outFile).size)}MB`);
    if (s3) {
      await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `furniture/catalog/v2/${id}.glb`, Body: readFileSync(outFile), ContentType: 'model/gltf-binary' }));
      console.log(`  → R2 furniture/catalog/v2/${id}.glb`);
    }
  }
  writeFileSync(path.join(outDir, 'sizes.json'), JSON.stringify(sizes, null, 2));
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exitCode = 1;
});
