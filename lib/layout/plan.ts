// 2D 평면도(SVG)를 그릴 때 쓰는 계산. 방 좌표 [x, z](m)를 그대로 SVG 좌표 (x, y)로 쓴다:
// 위에서 내려다본 그림이고, 화면 오른쪽이 +x, 화면 아래쪽이 +z 다.
import { placeOnFloor, signedArea, type Footprint, type Point2 } from '@/lib/three/floorDrag';

export type PlanViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 방 둘레에 두는 여백 (m). 벽 번호를 쓸 자리 */
export const PLAN_MARGIN = 0.5;
/** 벽 번호를 벽에서 바깥으로 띄우는 거리 (m) */
const WALL_LABEL_OFFSET = 0.25;

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** 방 전체가 여백과 함께 들어오는 viewBox */
export function planViewBox(polygon: Point2[], margin = PLAN_MARGIN): PlanViewBox {
  if (polygon.length === 0) return { x: -margin, y: -margin, width: margin * 2, height: margin * 2 };
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  return {
    x: round3(minX - margin),
    y: round3(minZ - margin),
    width: round3(Math.max(...xs) - minX + margin * 2),
    height: round3(Math.max(...zs) - minZ + margin * 2),
  };
}

/** SVG의 points 속성 값 */
export function pointsAttr(points: Point2[]): string {
  return points.map(([x, z]) => `${round3(x)},${round3(z)}`).join(' ');
}

/** viewBox 안의 1m 격자선 위치 (정수 m) */
export function gridLines(viewBox: PlanViewBox): {
  xs: number[];
  zs: number[];
} {
  const range = (from: number, to: number) => {
    const out: number[] = [];
    for (let v = Math.ceil(from); v <= Math.floor(to); v += 1) out.push(v + 0);
    return out;
  };
  return {
    xs: range(viewBox.x, viewBox.x + viewBox.width),
    zs: range(viewBox.y, viewBox.y + viewBox.height),
  };
}

/** 벽 번호를 쓸 자리: 벽 가운데에서 방 바깥쪽으로 조금 띄운 점 */
export function wallLabels(polygon: Point2[]): { index: number; at: Point2 }[] {
  if (polygon.length < 3) return [];
  const sign = signedArea(polygon) > 0 ? 1 : -1;
  return polygon.map((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    // 방 안쪽 법선의 반대 방향
    const out: Point2 = [((b[1] - a[1]) / length) * sign, (-(b[0] - a[0]) / length) * sign];
    return {
      index,
      at: [round3((a[0] + b[0]) / 2 + out[0] * WALL_LABEL_OFFSET), round3((a[1] + b[1]) / 2 + out[1] * WALL_LABEL_OFFSET)],
    };
  });
}

/**
 * 평면도에서 가구를 끄는 동안의 위치. grab은 잡은 순간의 (가구 중심 − 포인터)라서
 * 가구의 어디를 잡았든 그 자리를 유지한 채 움직인다. 3D와 같은 5cm 격자·벽 붙이기를 쓴다.
 */
export function dragPlacement<T extends Footprint>(item: T, grab: Point2, pointer: Point2, polygon: Point2[] | null): T {
  return {
    ...item,
    ...placeOnFloor({ ...item, x: pointer[0] + grab[0], z: pointer[1] + grab[1] }, polygon),
  };
}
