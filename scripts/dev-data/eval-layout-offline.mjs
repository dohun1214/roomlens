// 자동 보정 성능을 브라우저 없이 빠르게 잰다: eval-room-prep.mjs --mode points 로 저장한 표면 점 + 정답 파일
// 실행: npx tsx scripts/dev-data/eval-layout-offline.mjs [이름…]   (데이터 폴더: ROOMLENS_DATA 또는 ../roomlens-data)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { calibrateFromPoints } from '../../lib/three/autoCalibrate';
import { frameMap, scoreLayout } from '../../lib/eval/roomPrepScore';
import { fileURLToPath } from 'node:url';

const dataDir = process.env.ROOMLENS_DATA ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../roomlens-data');

const evalDir = path.join(dataDir, '_e2e', 'eval');
const only = process.argv.slice(2);
const names = readdirSync(path.join(evalDir, 'points'))
  .filter((f) => f.endsWith('.bin'))
  .map((f) => f.slice(0, -4))
  .filter((n) => only.length === 0 || only.includes(n));

/** 정답 보정에서 파일의 위쪽 방향 (방 +Y를 파일 좌표로) */
const truthUp = (frame) => {
  const [x, y, z, w] = frame.transform.q;
  // q의 역회전으로 (0,1,0)을 돌린다
  const v = [0, 1, 0];
  const [qx, qy, qz, qw] = [-x, -y, -z, w];
  const t = [2 * (qy * v[2] - qz * v[1]), 2 * (qz * v[0] - qx * v[2]), 2 * (qx * v[1] - qy * v[0])];
  const r = [v[0] + qw * t[0] + (qy * t[2] - qz * t[1]), v[1] + qw * t[1] + (qz * t[0] - qx * t[2]), v[2] + qw * t[2] + (qx * t[1] - qy * t[0])];
  return frame.flipX ? [r[0], -r[1], -r[2]] : r;
};

const rows = [];
for (const name of names) {
  const buf = readFileSync(path.join(evalDir, 'points', `${name}.bin`));
  const count = buf.readUInt32LE(0);
  const f32 = (offset, n) => new Float32Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + n * 4));
  const points = { count, positions: f32(4, count * 3), normals: f32(4 + count * 12, count * 3), weights: f32(4 + count * 24, count) };
  if (buf.length >= 4 + count * 32) points.brightness = f32(4 + count * 28, count);
  const truth = JSON.parse(readFileSync(path.join(evalDir, 'truth', `${name}.json`), 'utf8'));
  const t0 = Date.now();
  const cal = calibrateFromPoints(points);
  const ms = Date.now() - t0;
  if (!cal.ok) {
    rows.push({ name, fail: cal.message });
    continue;
  }
  const map = frameMap({ transform: cal.transform, flipX: false }, truth.frame);
  const score = scoreLayout(cal.floorPolygon.map(map), truth.polygon);
  const tu = truthUp(truth.frame);
  const upErr = (Math.acos(Math.max(-1, Math.min(1, tu[0] * cal.estimate.up[0] + tu[1] * cal.estimate.up[1] + tu[2] * cal.estimate.up[2]))) * 180) / Math.PI;
  const scaleErr = cal.transform.s / truth.frame.transform.s - 1;
  // 여러 방이 찍힌 장면: 사용자가 "다른 방"을 두 번까지 눌러 고르는 경우의 가장 좋은 값
  let bestIou = score.iou;
  for (let pick = 1; pick < Math.min(3, cal.estimate.rooms); pick += 1) {
    const other = calibrateFromPoints(points, undefined, { pick });
    if (!other.ok) continue;
    const m = frameMap({ transform: other.transform, flipX: false }, truth.frame);
    bestIou = Math.max(bestIou, scoreLayout(other.floorPolygon.map(m), truth.polygon).iou);
  }
  rows.push({ name, score, bestIou, rooms: cal.estimate.rooms, upErr, scaleErr, height: cal.height, guessed: cal.scaleGuessed, corners: cal.floorPolygon.length, ms, info: cal.estimate.info });
}
const f = (v, d = 2) => (v == null ? '-' : v.toFixed(d));
console.log('장면'.padEnd(18), 'IoU   모서리m 최대m  넓이비 위쪽°  크기오차 높이m 짐작 모서리(결과/정답) ms   방수 고르면IoU');
let sIou = 0;
let sBest = 0;
let sCorner = 0;
let ok = 0;
for (const r of rows) {
  if (r.fail) {
    console.log(r.name.padEnd(18), '실패', r.fail);
    continue;
  }
  ok += 1;
  sIou += r.score.iou;
  sBest += r.bestIou;
  sCorner += r.score.cornerMean;
  console.log(
    r.name.padEnd(18),
    f(r.score.iou).padEnd(5),
    f(r.score.cornerMean).padEnd(7),
    f(r.score.cornerMax).padEnd(5),
    f(r.score.areaRatio).padEnd(6),
    f(r.upErr, 1).padEnd(6),
    `${f(r.scaleErr * 100, 0)}%`.padEnd(8),
    f(r.height).padEnd(5),
    r.guessed ? '예' : '  ',
    `${r.score.corners[0]}/${r.score.corners[1]}`.padEnd(6),
    String(r.ms).padEnd(5),
    r.rooms,
    f(r.bestIou),
  );
}
console.log(`평균 IoU ${f(sIou / Math.max(1, ok))} (방을 고르면 ${f(sBest / Math.max(1, ok))}), 모서리 오차 ${f(sCorner / Math.max(1, ok))} m, 성공 ${ok}/${rows.length}`);
