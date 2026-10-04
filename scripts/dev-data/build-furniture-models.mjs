// 카탈로그 가구의 3D 모델(GLB)을 준비해 R2의 furniture/catalog/{id}.glb 로 올린다.
//
// 원본: Kenney "Furniture Kit" 2.0 (CC0, https://kenney.nl/assets/furniture-kit). 원본 파일은 저장소에 넣지 않는다.
// 준비: ../roomlens-data/models/kenney 에 압축을 푼다 ("Models/GLTF format/*.glb").
// 실행: node --env-file=.env.local scripts/dev-data/build-furniture-models.mjs [--upload]
//
// 하는 일: 모델을 Y축으로 돌려 "가로 = x, 깊이 = z, 앞면 = +z" 로 맞춘 GLB를 새로 쓴다(지오메트리는 그대로, 맨 위에 노드 하나만 추가).
// 크기와 위치는 뷰어가 맞춘다: 경계 상자를 재서 가구의 가로·깊이·높이로 늘이고 바닥 가운데를 원점에 둔다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(here, '../../../roomlens-data');
const sourceDir = path.join(dataDir, 'models', 'kenney', 'Models', 'GLTF format');
const outDir = path.join(dataDir, 'models', 'catalog');

/** 카탈로그 id → 원본 모델과 Y축 회전(도). yaw는 원본의 앞면이 +z를 보도록 눈으로 확인해 정했다 */
export const MODELS = {
  'bed-single': { source: 'bedSingle', yaw: 0 },
  'bed-super-single': { source: 'bedSingle', yaw: 0 },
  'bed-queen': { source: 'bedDouble', yaw: 0 },
  desk: { source: 'desk', yaw: 0 },
  chair: { source: 'chairDesk', yaw: 0 },
  wardrobe: { source: 'bookcaseClosedDoors', yaw: 0 },
  drawer: { source: 'sideTableDrawers', yaw: 0 },
  'table-2': { source: 'table', yaw: 0 },
  bookcase: { source: 'bookcaseOpen', yaw: 0 },
};
export const MODEL_LICENSE = 'Kenney Furniture Kit 2.0 (CC0)';

// ── GLB 읽기·쓰기 (헤더 12바이트 + JSON 청크 + BIN 청크) ─────────────────────────
function readGlb(file) {
  const buffer = readFileSync(file);
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error(`GLB가 아님: ${file}`);
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8'));
  const rest = buffer.subarray(20 + jsonLength);
  const bin = rest.length >= 8 ? rest.subarray(8, 8 + rest.readUInt32LE(0)) : Buffer.alloc(0);
  return { json, bin };
}

function writeGlb(file, json, bin) {
  const pad = (buffer, fill) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + (binChunk.length ? 8 + binChunk.length : 0), 8);
  const chunkHeader = (length, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.writeUInt32LE(type, 4);
    return b;
  };
  const parts = [header, chunkHeader(jsonChunk.length, 0x4e4f534a), jsonChunk];
  if (binChunk.length) parts.push(chunkHeader(binChunk.length, 0x004e4942), binChunk);
  writeFileSync(file, Buffer.concat(parts));
}

// ── 경계 상자: 노드 변환을 따라 내려가며 각 메시의 POSITION min/max 여덟 꼭짓점을 변환한다 ──────
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
export function boundingBox(json) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const visit = (index, parent) => {
    const node = json.nodes[index];
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) {
        const accessor = json.accessors[primitive.attributes.POSITION];
        for (let corner = 0; corner < 8; corner += 1) {
          const p = [0, 1, 2].map((k) => ((corner >> k) & 1 ? accessor.max[k] : accessor.min[k]));
          for (let k = 0; k < 3; k += 1) {
            const v = matrix[k] * p[0] + matrix[4 + k] * p[1] + matrix[8 + k] * p[2] + matrix[12 + k];
            min[k] = Math.min(min[k], v);
            max[k] = Math.max(max[k], v);
          }
        }
      }
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  for (const root of json.scenes[json.scene ?? 0].nodes) visit(root, identity());
  return { min, max, size: max.map((v, k) => v - min[k]) };
}

/** 장면의 맨 위에 Y축 회전 노드를 하나 끼운다 */
function withYaw(json, yawDeg) {
  const out = structuredClone(json);
  const scene = out.scenes[out.scene ?? 0];
  const half = (yawDeg * Math.PI) / 360;
  out.nodes.push({ name: 'roomlens-root', rotation: [0, Math.sin(half), 0, Math.cos(half)], children: scene.nodes });
  scene.nodes = [out.nodes.length - 1];
  return out;
}

const round = (v) => +v.toFixed(3);

async function main() {
  const upload = process.argv.includes('--upload');
  const inspect = process.argv.includes('--inspect');
  if (inspect) {
    // 후보 모델의 크기를 본다: node ... --inspect bedSingle desk ...
    for (const name of process.argv.slice(process.argv.indexOf('--inspect') + 1)) {
      const { json } = readGlb(path.join(sourceDir, `${name}.glb`));
      const box = boundingBox(json);
      console.log(name, 'size', box.size.map(round), 'min', box.min.map(round), 'ext', json.extensionsUsed ?? [], 'tex', (json.images ?? []).length, 'mat', (json.materials ?? []).length);
    }
    return;
  }
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
  for (const [id, { source, yaw }] of Object.entries(MODELS)) {
    const { json, bin } = readGlb(path.join(sourceDir, `${source}.glb`));
    const turned = withYaw(json, yaw);
    const outFile = path.join(outDir, `${id}.glb`);
    writeGlb(outFile, turned, bin);
    const box = boundingBox(readGlb(outFile).json);
    const bytes = readFileSync(outFile).length;
    console.log(`${id} ← ${source} (yaw ${yaw}°): 가로 ${round(box.size[0])} × 깊이 ${round(box.size[2])} × 높이 ${round(box.size[1])}, ${bytes} bytes`);
    if (s3) {
      await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: `furniture/catalog/${id}.glb`, Body: readFileSync(outFile), ContentType: 'model/gltf-binary' }));
      console.log(`  → R2 furniture/catalog/${id}.glb`);
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
