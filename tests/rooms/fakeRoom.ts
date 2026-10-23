// 자동 보정 시험용 가짜 방 점들
import type { Vec3 } from '@/lib/rooms/autoLayout';
import type { ScenePoints } from '@/lib/three/scenePoints';
import { polygonIoU } from '@/lib/eval/roomPrepScore';
import type { Point2 } from '@/lib/three/floorDrag';

export type { Vec3 };

/** 결정적인 난수 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export type Box = { x0: number; x1: number; z0: number; z1: number; h: number };

/**
 * 가짜 방: 바닥 다각형(직각), 높이, 가구 상자들. 벽·바닥·천장·가구 표면에 점을 뿌린다.
 * rotate: 파일 좌표로 돌리는 함수 (방 좌표 → 파일 좌표), unit: 파일 단위 1 = unit m
 */
export function fakeRoom(polygon: Point2[], height: number, boxes: Box[], rotate: (p: Vec3) => Vec3, unit = 1, seed = 1): ScenePoints {
  const r = rng(seed);
  const pos: number[] = [];
  const nor: number[] = [];
  const add = (p: Vec3, n: Vec3) => {
    const fp = rotate(p).map((v) => v / unit) as Vec3;
    const o = rotate([0, 0, 0]);
    const fn = rotate(n).map((v, k) => v - o[k]) as Vec3;
    pos.push(...fp);
    nor.push(...fn);
  };
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const inside = (x: number, z: number) => {
    let c = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, zi] = polygon[i];
      const [xj, zj] = polygon[j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  for (let k = 0; k < 40000; k += 1) {
    const x = x0 + r() * (x1 - x0);
    const z = z0 + r() * (z1 - z0);
    if (!inside(x, z)) continue;
    add([x, 0, z], [0, 1, 0]);
    add([x, height, z], [0, -1, 0]);
  }
  polygon.forEach((a, i) => {
    const b = polygon[(i + 1) % polygon.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nrm: Vec3 = [-(b[1] - a[1]) / len, 0, (b[0] - a[0]) / len];
    for (let k = 0; k < len * 3000; k += 1) {
      const t = r();
      add([a[0] + (b[0] - a[0]) * t, r() * height, a[1] + (b[1] - a[1]) * t], nrm);
    }
  });
  for (const b of boxes) {
    for (let k = 0; k < 3000; k += 1) add([b.x0 + r() * (b.x1 - b.x0), b.h, b.z0 + r() * (b.z1 - b.z0)], [0, 1, 0]);
    for (let k = 0; k < 3000; k += 1) {
      const side = Math.floor(r() * 4);
      const t = r();
      const y = r() * b.h;
      const p: Vec3 = side === 0 ? [b.x0, y, b.z0 + t * (b.z1 - b.z0)] : side === 1 ? [b.x1, y, b.z0 + t * (b.z1 - b.z0)] : side === 2 ? [b.x0 + t * (b.x1 - b.x0), y, b.z0] : [b.x0 + t * (b.x1 - b.x0), y, b.z1];
      add(p, side < 2 ? [1, 0, 0] : [0, 0, 1]);
    }
  }
  const count = pos.length / 3;
  return { count, positions: Float32Array.from(pos), normals: Float32Array.from(nor), weights: new Float32Array(count).fill(1) };
}

export const L_ROOM: Point2[] = [
  [0, 0],
  [5, 0],
  [5, 3],
  [2.5, 3],
  [2.5, 4.5],
  [0, 4.5],
];
export const FURNITURE: Box[] = [
  { x0: 0.1, x1: 1.7, z0: 0.1, z1: 2.1, h: 0.55 }, // 침대 (벽에 붙음)
  { x0: 4.4, x1: 4.95, z0: 0.5, z1: 2.3, h: 2.0 }, // 옷장 (벽에 붙음)
  { x0: 2.8, x1: 3.6, z0: 1.0, z1: 1.8, h: 0.75 }, // 탁자
];

/** 축 둘레로 돌리는 함수 */
export const rotation = (axis: Vec3, deg: number) => {
  const [ux, uy, uz] = axis.map((v) => v / Math.hypot(...axis));
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return (p: Vec3): Vec3 => {
    const d = ux * p[0] + uy * p[1] + uz * p[2];
    const cr: Vec3 = [uy * p[2] - uz * p[1], uz * p[0] - ux * p[2], ux * p[1] - uy * p[0]];
    return [0, 1, 2].map((k) => p[k] * c + cr[k] * s + [ux, uy, uz][k] * d * (1 - c)) as Vec3;
  };
};

/** 결과 모서리(파일 좌표)를 방 좌표로 되돌려 정답 다각형과 견준다 */
export function iouBack(corners: Vec3[], inverse: (p: Vec3) => Vec3, unit: number, truth: Point2[]): number {
  const back = corners.map((c) => inverse(c.map((v) => v * unit) as Vec3));
  return polygonIoU(
    back.map((p) => [p[0], p[2]]),
    truth,
  );
}

