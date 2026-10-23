// 보정된 평면도 손보기: 벽 하나를 그 벽과 직각 방향으로 옮기기, 방 전체 크기 바꾸기.
import { signedArea, type Point2 } from '@/lib/three/floorDrag';
import type { RoomTransform } from '@/lib/three/roomTransform';

/** 이보다 짧아지는 벽은 만들지 않는다 (m) */
export const MIN_EDIT_WALL = 0.2;

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** 옆 벽이 이만큼보다 짧아지게 끌면 아예 없애고 벽을 합친다 (m). 이보다 짧은 벽은 만들지 않으므로 MIN_EDIT_WALL과 같다 */
export const MERGE_SNAP = MIN_EDIT_WALL;

/**
 * 벽 i(꼭짓점 i → i+1)를 그 벽의 법선 방향으로 옮긴다. delta는 끌어 온 거리(방 좌표)이고, 법선 방향 성분만 쓴다 (1cm 단위).
 * 양옆 벽은 늘거나 줄어든다. 옆 벽이 거의 없어질 만큼(MERGE_SNAP 안) 끌면 그 벽을 없애고 이어지는 벽끼리 합친다
 * (얕은 단차 지우기). 방이 납작해지면 null. 그 밖에 옆 벽이 MIN_EDIT_WALL보다 짧아지거나 방향이 뒤집히면 null.
 */
export function moveWall(polygon: Point2[], wall: number, delta: Point2): Point2[] | null {
  const n = polygon.length;
  if (n < 3 || wall < 0 || wall >= n) return null;
  const a = polygon[wall];
  const b = polygon[(wall + 1) % n];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < 1e-9) return null;
  const normal: Point2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  let d = Math.round((delta[0] * normal[0] + delta[1] * normal[1]) * 100) / 100;
  if (d === 0) return polygon;
  // 옆 벽을 없애는 거리: 앞 벽(끝이 움직임)은 v + n·d = 0, 뒤 벽(시작이 움직임)은 v − n·d = 0. 옆 벽이 법선과 나란할 때만
  const prevV = sub(polygon[wall], polygon[(wall + n - 1) % n]);
  const nextV = sub(polygon[(wall + 2) % n], polygon[(wall + 1) % n]);
  const collapse = [
    { v: prevV, d: -dot(prevV, normal) },
    { v: nextV, d: dot(nextV, normal) },
  ].filter((c) => Math.abs(Math.hypot(...c.v) - Math.abs(dot(c.v, normal))) < 1e-6 && Math.abs(c.d - d) < MERGE_SNAP);
  if (collapse.length > 0) d = collapse[0].d;
  const out = polygon.map((p) => [p[0], p[1]] as Point2);
  for (const k of [wall, (wall + 1) % n]) out[k] = [round3(out[k][0] + normal[0] * d), round3(out[k][1] + normal[1] * d)];
  if (collapse.length > 0) {
    const merged = mergeDegenerate(out);
    return merged.length >= 3 && Math.abs(signedArea(merged)) > 0.01 ? merged : null;
  }
  // 옆 벽들이 너무 짧아지거나 뒤집히지 않았는지
  for (const k of [(wall + n - 1) % n, (wall + 1) % n]) {
    const p = polygon[k];
    const q = polygon[(k + 1) % n];
    const p2 = out[k];
    const q2 = out[(k + 1) % n];
    const before: Point2 = [q[0] - p[0], q[1] - p[1]];
    const after: Point2 = [q2[0] - p2[0], q2[1] - p2[1]];
    if (Math.hypot(...after) < MIN_EDIT_WALL || before[0] * after[0] + before[1] * after[1] <= 0) return null;
  }
  return out;
}

const sub = (p: Point2, q: Point2): Point2 => [p[0] - q[0], p[1] - q[1]];
const dot = (p: Point2, q: Point2) => p[0] * q[0] + p[1] * q[1];

/** 길이가 0인 벽(겹친 꼭짓점)과 한 직선 위의 꼭짓점을 지운다 */
export function mergeDegenerate(polygon: Point2[]): Point2[] {
  let pts = polygon.map((p) => [p[0], p[1]] as Point2);
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false;
    const n = pts.length;
    for (let i = 0; i < n; i += 1) {
      const prev = pts[(i + n - 1) % n];
      const p = pts[i];
      const next = pts[(i + 1) % n];
      const same = Math.hypot(p[0] - next[0], p[1] - next[1]) < 1e-6;
      const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
      if (same || Math.abs(cross) < 1e-9) {
        pts = pts.filter((_, k) => k !== i);
        changed = true;
        break;
      }
    }
  }
  return pts;
}

/** 방 전체를 k배로 (보정 변환과 평면도를 함께). 방 좌표의 원점을 기준으로 늘린다 */
export function scaleCalibration(transform: RoomTransform, polygon: Point2[], k: number): { transform: RoomTransform; floorPolygon: Point2[] } {
  return {
    transform: { s: transform.s * k, q: transform.q, t: [transform.t[0] * k, transform.t[1] * k, transform.t[2] * k] },
    floorPolygon: polygon.map(([x, z]) => [round3(x * k), round3(z * k)]),
  };
}
