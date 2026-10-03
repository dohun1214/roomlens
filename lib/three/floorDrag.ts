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

/**
 * 벽과의 틈이 threshold보다 작으면(벽을 넘어간 경우 포함) 가구를 벽에 딱 붙인다.
 * 볼록한 방을 가정한다. 가구가 방보다 크면 마주 보는 벽 사이에서 결과가 정해지지 않는다.
 * @param polygon 방 평면도 꼭짓점 (시계/반시계 무관)
 */
export function snapToWalls(f: Footprint, polygon: Point2[], threshold = WALL_SNAP_DISTANCE): Footprint {
  const out = { ...f };
  const inwardSign = signedArea(polygon) > 0 ? 1 : -1;
  // 모서리에서는 두 벽에 차례로 붙어야 하므로 두 번 돈다
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      // 벽에서 방 안쪽을 향하는 단위 법선
      const n: Point2 = [(-(b[1] - a[1]) / len) * inwardSign, ((b[0] - a[0]) / len) * inwardSign];
      const centerDistance = (out.x - a[0]) * n[0] + (out.z - a[1]) * n[1];
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
