// 찍은 모서리로 만든 평면도를 "벽이 서로 직각인" 모양으로 바로잡는다.
// 모서리가 가구에 가려 몇 cm 틀리게 찍혀도 벽이 반듯하게 잡히게 하기 위함이다.
// 평면 위의 점은 [x, z]. 각도는 atan2(z, x) 로 잰다.
import type { Point2 } from './floorDrag';

/**
 * 벽들의 주된 방향(라디안, −45° 초과 45° 이하). 벽은 서로 직각이라고 보고 90° 주기로 평균을 낸다.
 * 긴 벽일수록 더 믿는다. 한 벽이 조금 틀리게 찍혀도 다른 벽들이 방향을 잡아 준다.
 */
export function dominantAxisAngle(points: Point2[]): number {
  let sumCos = 0;
  let sumSin = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    const angle = Math.atan2(dz, dx);
    // 각도에 4를 곱하면 0°, 90°, 180°, 270° 방향의 벽이 모두 같은 값이 된다
    sumCos += length * Math.cos(4 * angle);
    sumSin += length * Math.sin(4 * angle);
  }
  return Math.atan2(sumSin, sumCos) / 4 + 0;
}

type Run = { horizontal: boolean; value: number };

/**
 * 좌표축과 거의 나란한 벽들로 이루어진 다각형을, 모든 벽이 정확히 가로(x 방향)나 세로(z 방향)가 되게 바로잡는다.
 * 이어진 같은 방향의 벽들은 한 줄로 보고, 그 줄의 위치는 벽 길이로 가중 평균한다. 꼭짓점 수와 순서는 그대로다.
 * 비스듬한 벽이 있거나(허용 각도를 넘음) 직각으로 볼 수 없는 모양이면 null.
 */
export function rectifyPolygon(points: Point2[], toleranceDeg = 30): Point2[] | null {
  const n = points.length;
  if (n < 4) return null;
  const horizontal: boolean[] = [];
  const lengths: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const dx = Math.abs(b[0] - a[0]);
    const dz = Math.abs(b[1] - a[1]);
    const length = Math.hypot(dx, dz);
    if (length < 1e-9) return null;
    const angle = (Math.atan2(dz, dx) * 180) / Math.PI; // 0° = 가로, 90° = 세로
    if (angle <= toleranceDeg) horizontal.push(true);
    else if (angle >= 90 - toleranceDeg) horizontal.push(false);
    else return null;
    lengths.push(length);
  }

  // 방향이 바뀌는 벽에서 시작해, 이어진 같은 방향의 벽을 한 줄(run)로 묶는다
  const start = horizontal.findIndex((h, i) => h !== horizontal[(i + n - 1) % n]);
  if (start < 0) return null;
  const runOfEdge = new Array<number>(n);
  const runs: Run[] = [];
  let weight = 0;
  let sum = 0;
  for (let k = 0; k < n; k += 1) {
    const i = (start + k) % n;
    if (k > 0 && horizontal[i] !== horizontal[(i + n - 1) % n]) {
      runs[runs.length - 1].value = sum / weight;
      weight = 0;
      sum = 0;
    }
    if (weight === 0) runs.push({ horizontal: horizontal[i], value: 0 });
    runOfEdge[i] = runs.length - 1;
    const axis = horizontal[i] ? 1 : 0; // 가로 벽은 z 값이, 세로 벽은 x 값이 그 줄의 위치다
    sum += lengths[i] * ((points[i][axis] + points[(i + 1) % n][axis]) / 2);
    weight += lengths[i];
  }
  runs[runs.length - 1].value = sum / weight;
  if (runs.length < 4) return null;

  return points.map((p, i) => {
    const before = runs[runOfEdge[(i + n - 1) % n]];
    const after = runs[runOfEdge[i]];
    if (before === after) return after.horizontal ? [p[0], after.value] : [after.value, p[1]];
    const h = before.horizontal ? before : after;
    const v = before.horizontal ? after : before;
    return [v.value, h.value];
  });
}
