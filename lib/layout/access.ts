// 문·창문과 관련된 배치 검사에 쓰는 계산: 문 앞 구역, 창문 앞 구역, 문에서 가구까지의 통로.
// 모두 보정된 방 좌표(m)의 바닥 평면 [x, z]에서 계산한다.
import { signedArea, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { openingSegment, type Opening } from '@/lib/rooms/openings';
import { distanceToPolygon, pointInPolygon } from './geometry';

/** 사람이 지나가려면 필요한 폭 (m) */
export const WALKWAY_WIDTH = 0.6;
/** 통로 검사 격자 한 칸 (m) */
export const GRID_CELL = 0.05;
/** 창문 앞 이 거리 안에 키 큰 가구가 있으면 가린다고 본다 (m) */
export const WINDOW_FRONT_DEPTH = 0.3;
/** 이 높이를 넘는 가구만 창문을 가린다고 본다 (m) */
export const TALL_FURNITURE_HEIGHT = 1.0;

// 사람을 반지름 30cm 원으로 본다. 격자가 5cm 단위라 정확히 60cm인 틈을 놓치지 않도록 조금 줄여 잰다
const BODY_RADIUS = WALKWAY_WIDTH / 2 - GRID_CELL * 0.8;
/** 가구 "옆에 섰다"고 보는 거리: 몸이 가구에 닿을 만큼 가까운 칸 */
const REACH_DISTANCE = WALKWAY_WIDTH / 2 + GRID_CELL * 1.5;
/** 문 바로 안쪽에서 출발점으로 삼는 띠의 두께 */
const ENTRY_DEPTH = WALKWAY_WIDTH / 2 + GRID_CELL * 2;

/**
 * 문·창문 앞(방 안쪽)으로 depth만큼 뻗은 직사각형 구역.
 * 가구 밑면과 같은 모양(Footprint)이라 겹침 검사 함수를 그대로 쓸 수 있다.
 */
export function frontZone(opening: Opening, polygon: Point2[], depth: number): Footprint | null {
  const segment = openingSegment(opening, polygon);
  if (!segment) return null;
  const [p, q] = segment;
  const width = Math.hypot(q[0] - p[0], q[1] - p[1]);
  if (width < 1e-9) return null;
  const u: Point2 = [(q[0] - p[0]) / width, (q[1] - p[1]) / width];
  const n = inward(u, polygon);
  return {
    x: (p[0] + q[0]) / 2 + (n[0] * depth) / 2,
    z: (p[1] + q[1]) / 2 + (n[1] * depth) / 2,
    w: width,
    d: depth,
    // Footprint의 가로 방향이 벽 방향이 되게 돌린다
    rotationDeg: (Math.atan2(-u[1], u[0]) * 180) / Math.PI,
  };
}

/** 문 앞 금지 구역: 문 폭 × 문 폭 정사각형 */
export function doorZone(door: Opening, polygon: Point2[]): Footprint | null {
  return frontZone(door, polygon, door.to - door.from);
}

/** 창문 앞 구역: 창문 폭 × 0.3m */
export function windowZone(window: Opening, polygon: Point2[]): Footprint | null {
  return frontZone(window, polygon, WINDOW_FRONT_DEPTH);
}

/** 점에서 가구 밑면까지의 거리 (안에 있으면 0) */
export function distanceToFootprint(p: Point2, f: Footprint): number {
  const r = (f.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = p[0] - f.x;
  const dz = p[1] - f.z;
  // 가구의 가로·깊이 방향으로 잰 좌표
  const along = Math.abs(dx * c - dz * s) - f.w / 2;
  const across = Math.abs(dx * s + dz * c) - f.d / 2;
  return Math.hypot(Math.max(along, 0), Math.max(across, 0));
}

/**
 * 문에서 걸어서 옆까지 갈 수 없는 가구의 id.
 * 5cm 격자에서 벽과 가구를 사람 몸 반지름만큼 부풀려 막힌 칸을 정하고, 문 바로 안쪽에서 시작해 갈 수 있는 칸을 넓혀 간다(BFS).
 * 가구의 어느 쪽이든 옆에 설 수 있으면 갈 수 있는 것으로 본다.
 * 문이 없거나 모든 문 앞이 막혀 출발할 수 없으면 null (문 앞 검사가 따로 알려준다).
 */
export function findUnreachable(items: (Footprint & { id: string })[], polygon: Point2[], doors: Opening[]): string[] | null {
  if (polygon.length < 3 || doors.length === 0) return null;
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const minX = Math.min(...xs);
  const minZ = Math.min(...zs);
  const nx = Math.floor((Math.max(...xs) - minX) / GRID_CELL) + 1;
  const nz = Math.floor((Math.max(...zs) - minZ) / GRID_CELL) + 1;
  if (nx * nz > 1_000_000) return null; // 비정상적으로 큰 방은 검사하지 않는다

  // 문마다: 벽 위의 시작점, 벽 방향, 방 안쪽 방향, 폭
  const entries = doors.flatMap((door) => {
    const segment = openingSegment(door, polygon);
    if (!segment) return [];
    const [p, q] = segment;
    const width = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (width < 1e-9) return [];
    const u: Point2 = [(q[0] - p[0]) / width, (q[1] - p[1]) / width];
    return [{ p, u, n: inward(u, polygon), width }];
  });

  const free = new Uint8Array(nx * nz);
  const near: number[][] = items.map(() => []); // 가구마다: 그 옆에 설 수 있는 칸
  const queue: number[] = [];
  const reached = new Uint8Array(nx * nz);

  for (let iz = 0; iz < nz; iz += 1) {
    for (let ix = 0; ix < nx; ix += 1) {
      const point: Point2 = [minX + ix * GRID_CELL, minZ + iz * GRID_CELL];
      if (!pointInPolygon(point, polygon) || distanceToPolygon(point, polygon) < BODY_RADIUS) continue;
      const index = iz * nx + ix;
      let blocked = false;
      const touching: number[] = [];
      for (let k = 0; k < items.length; k += 1) {
        const distance = distanceToFootprint(point, items[k]);
        if (distance < BODY_RADIUS) {
          blocked = true;
          break;
        }
        if (distance <= REACH_DISTANCE) touching.push(k);
      }
      if (blocked) continue;
      free[index] = 1;
      for (const k of touching) near[k].push(index);
      // 문 바로 안쪽의 칸이면 출발점
      for (const entry of entries) {
        const dx = point[0] - entry.p[0];
        const dz = point[1] - entry.p[1];
        const along = dx * entry.u[0] + dz * entry.u[1];
        const depth = dx * entry.n[0] + dz * entry.n[1];
        if (along >= 0 && along <= entry.width && depth >= 0 && depth <= ENTRY_DEPTH) {
          reached[index] = 1;
          queue.push(index);
          break;
        }
      }
    }
  }
  if (queue.length === 0) return null;

  // 대각선을 포함한 여덟 방향으로 넓혀 간다
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const ix = index % nx;
    const iz = (index - ix) / nx;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const jx = ix + dx;
        const jz = iz + dz;
        if ((dx === 0 && dz === 0) || jx < 0 || jz < 0 || jx >= nx || jz >= nz) continue;
        const next = jz * nx + jx;
        if (free[next] && !reached[next]) {
          reached[next] = 1;
          queue.push(next);
        }
      }
    }
  }

  return items.filter((_, k) => !near[k].some((index) => reached[index])).map((item) => item.id);
}

/** 벽 방향 u에 수직이고 방 안쪽을 향하는 단위 벡터 */
function inward(u: Point2, polygon: Point2[]): Point2 {
  const sign = signedArea(polygon) > 0 ? 1 : -1;
  return [-u[1] * sign, u[0] * sign];
}
