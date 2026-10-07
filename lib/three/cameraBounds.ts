// 카메라가 방 밖으로 나가지 않게 한다.
// 보정된 방은 바닥 평면도(방 좌표 [x, z], m)와 바닥 높이(y = 0)를 알고 있으므로 그 안에 머물게 할 수 있다.
import { distanceToPolygon, interiorPoint } from '@/lib/layout/geometry';
import { closestPointOnPolygon, pointInPolygon, type Point2 } from '@/lib/three/floorDrag';

/** 카메라가 벽에서 떨어져 있어야 하는 거리 (m). 이보다 붙으면 벽의 스플랫이 화면을 덮는다 */
export const WALL_MARGIN = 0.2;
/** 카메라의 가장 낮은 높이 (m) */
export const MIN_EYE_HEIGHT = 0.2;
/** 천장에서 떨어져 있어야 하는 거리 (m) */
export const CEILING_MARGIN = 0.15;
/** 천장을 아주 낮게 잘못 재어도 이 높이까지는 올라갈 수 있다 (m) */
const MIN_CEILING_LIMIT = 1.8;

const EPS = 1e-6;

/** 방 안이고 벽에서 margin 이상 떨어져 있는지 */
export function isInsideRoom(p: Point2, polygon: Point2[], margin = WALL_MARGIN): boolean {
  return pointInPolygon(p, polygon) && distanceToPolygon(p, polygon) >= margin - EPS;
}

/**
 * 점을 방 안(벽에서 margin 이상)으로 데려온다. 이미 안이면 그대로 돌려준다.
 * 벽에 비스듬히 부딪히면 벽을 따라 미끄러지고, 구석에서는 두 벽에서 모두 떨어진 자리에 멈춘다.
 * @param fallback 자리를 찾지 못했을 때 쓸 점 (직전의 올바른 자리). 없으면 방 안쪽의 한 점
 */
export function keepInsideRoom(point: Point2, polygon: Point2[], margin = WALL_MARGIN, fallback?: Point2 | null): Point2 {
  if (polygon.length < 3 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return point;
  if (isInsideRoom(point, polygon, margin)) return point;
  let p = point;
  for (let i = 0; i < 6; i += 1) {
    const wall = closestPointOnPolygon(p, polygon);
    const distance = Math.hypot(p[0] - wall[0], p[1] - wall[1]);
    let dir: Point2;
    if (distance > 1e-9) {
      // 방 안이면 벽에서 멀어지는 쪽, 방 밖이면 벽을 지나 들어오는 쪽
      const sign = pointInPolygon(p, polygon) ? 1 : -1;
      dir = [(sign * (p[0] - wall[0])) / distance, (sign * (p[1] - wall[1])) / distance];
    } else {
      // 정확히 벽 위: 방 안쪽의 한 점을 향해
      const inner = interiorPoint(polygon);
      const length = Math.hypot(inner[0] - wall[0], inner[1] - wall[1]) || 1;
      dir = [(inner[0] - wall[0]) / length, (inner[1] - wall[1]) / length];
    }
    p = [wall[0] + dir[0] * (margin + 1e-4), wall[1] + dir[1] * (margin + 1e-4)];
    if (isInsideRoom(p, polygon, margin)) return p;
  }
  // 통로가 margin의 두 배보다 좁은 곳 등: 직전 자리에 머문다
  if (fallback && isInsideRoom(fallback, polygon, margin)) return fallback;
  const inner = interiorPoint(polygon);
  return pointInPolygon(inner, polygon) ? inner : point;
}

/** 카메라가 있을 수 있는 높이 범위. ceilingY는 스캔에서 잰 천장 높이(모르면 null → 위는 막지 않음) */
export function heightRange(ceilingY: number | null): { min: number; max: number } {
  const max = ceilingY !== null && Number.isFinite(ceilingY) ? Math.max(MIN_CEILING_LIMIT, ceilingY - CEILING_MARGIN) : Infinity;
  return { min: MIN_EYE_HEIGHT, max };
}

export function clampHeight(y: number, ceilingY: number | null): number {
  const { min, max } = heightRange(ceilingY);
  return Math.min(max, Math.max(min, y));
}

/**
 * 카메라 자리 [x, y, z]를 방 안으로 데려온다.
 * @returns 바뀌지 않았으면 null
 */
export function keepCameraInRoom(
  position: [number, number, number],
  polygon: Point2[],
  ceilingY: number | null,
  lastGood?: Point2 | null,
): [number, number, number] | null {
  const [x, z] = keepInsideRoom([position[0], position[2]], polygon, WALL_MARGIN, lastGood);
  const y = clampHeight(position[1], ceilingY);
  if (x === position[0] && y === position[1] && z === position[2]) return null;
  return [x, y, z];
}
