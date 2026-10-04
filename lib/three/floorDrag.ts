/**
 * 가구를 바닥 위에서 끌 때 쓰는 순수 계산. 좌표는 모두 보정된 방 좌표(m, 바닥 y=0)이고
 * 평면 위의 점은 [x, z]로 쓴다.
 */

export type Point2 = [number, number];

/** 바닥에 놓인 가구의 밑면. w = 가로(회전 0°일 때 x 방향), d = 깊이(z 방향) */
export type Footprint = { x: number; z: number; w: number; d: number; rotationDeg: number };

export const GRID_STEP = 0.05;
export const WALL_SNAP_DISTANCE = 0.1;

/**
 * 광선과 바닥 평면(y = floorY)의 교점 [x, z].
 * 광선이 바닥과 나란하거나 바닥에서 멀어지는 방향이면 null.
 */
export function rayFloorPoint(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  floorY = 0,
): Point2 | null {
  if (Math.abs(direction.y) < 1e-9) return null;
  const t = (floorY - origin.y) / direction.y;
  if (t <= 0) return null;
  return [origin.x + direction.x * t, origin.z + direction.z * t];
}

export function snapToGrid(value: number, step = GRID_STEP): number {
  return Math.round(value / step) * step;
}

/** 가구 밑면의 네 꼭짓점 (three.js의 Y축 회전과 같은 방향) */
export function footprintCorners(f: Footprint): Point2[] {
  const [ux, uz] = axes(f.rotationDeg);
  const hw = f.w / 2;
  const hd = f.d / 2;
  return [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ].map(([a, b]) => [f.x + ux[0] * a + uz[0] * b, f.z + ux[1] * a + uz[1] * b] as Point2);
}

/** 방향 n(단위 벡터)으로 잰 가구 밑면의 반폭 */
export function halfExtentAlong(f: Footprint, n: Point2): number {
  const [ux, uz] = axes(f.rotationDeg);
  return (Math.abs(n[0] * ux[0] + n[1] * ux[1]) * f.w) / 2 + (Math.abs(n[0] * uz[0] + n[1] * uz[1]) * f.d) / 2;
}

/** 점이 다각형 안에 있는지 (경계 위는 구현에 따라 달라지므로 거리와 함께 쓴다) */
export function pointInPolygon(p: Point2, polygon: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** 다각형 테두리(벽) 위에서 점에 가장 가까운 곳 */
export function closestPointOnPolygon(p: Point2, polygon: Point2[]): Point2 {
  let best: Point2 = polygon[0];
  let bestDistance = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const abx = b[0] - a[0];
    const abz = b[1] - a[1];
    const len2 = abx * abx + abz * abz;
    const t = len2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / len2));
    const q: Point2 = [a[0] + abx * t, a[1] + abz * t];
    const distance = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = q;
    }
  }
  return best;
}

/** 가구가 벽 구간과 이만큼(m)도 나란히 겹치지 않으면 그 벽은 무시한다 */
const WALL_OVERLAP_MIN = 0.01;

/**
 * 벽과의 틈이 threshold보다 작으면(벽을 넘어간 경우 포함) 가구를 벽에 딱 붙인다.
 * 오목한 방(ㄱ자 등)에서도 쓸 수 있게 벽을 "무한한 직선"이 아니라 "구간"으로 본다:
 * 가구의 중심이 그 벽의 안쪽에 있고, 가구가 벽 구간과 나란히 겹칠 때만 그 벽에 붙인다.
 * 중심이 방 밖이면 먼저 가장 가까운 벽 위로 데려온다. 가구가 방보다 크면 결과가 정해지지 않는다.
 * @param polygon 방 평면도 꼭짓점 (시계/반시계 무관)
 */
export function snapToWalls(f: Footprint, polygon: Point2[], threshold = WALL_SNAP_DISTANCE): Footprint {
  const out = { ...f };
  const inwardSign = signedArea(polygon) > 0 ? 1 : -1;
  if (!pointInPolygon([out.x, out.z], polygon)) {
    [out.x, out.z] = closestPointOnPolygon([out.x, out.z], polygon);
  }
  // 모서리에서는 두 벽에 차례로 붙어야 하므로 두 번 돈다
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      const u: Point2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      // 벽에서 방 안쪽을 향하는 단위 법선
      const n: Point2 = [-u[1] * inwardSign, u[0] * inwardSign];
      const centerDistance = (out.x - a[0]) * n[0] + (out.z - a[1]) * n[1];
      // 중심이 이 벽의 뒤쪽이면 오목한 방의 다른 구역에 있는 것이다
      if (centerDistance < -1e-6) continue;
      const along = (out.x - a[0]) * u[0] + (out.z - a[1]) * u[1];
      const halfAlong = halfExtentAlong(out, u);
      if (along + halfAlong < WALL_OVERLAP_MIN || along - halfAlong > len - WALL_OVERLAP_MIN) continue;
      const gap = centerDistance - halfExtentAlong(out, n);
      if (gap < threshold) {
        out.x -= gap * n[0];
        out.z -= gap * n[1];
      }
    }
  }
  return out;
}
/** 드래그 중 한 번의 위치 갱신: 격자 스냅 → 벽 스냅 */
export function placeOnFloor(f: Footprint, polygon: Point2[] | null): Footprint {
  const snapped = { ...f, x: snapToGrid(f.x), z: snapToGrid(f.z) };
  return polygon && polygon.length >= 3 ? snapToWalls(snapped, polygon) : snapped;
}

/** 부호 있는 넓이. [x, z] 평면에서 양수/음수로 꼭짓점이 도는 방향을 구분한다. */
export function signedArea(polygon: Point2[]): number {
  let s = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/** 회전된 가구의 로컬 x축·z축 방향을 [x, z] 평면에서 본 단위 벡터 */
function axes(rotationDeg: number): [Point2, Point2] {
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [c, -s],
    [s, c],
  ];
}
