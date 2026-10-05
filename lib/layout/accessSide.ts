// 가구의 "쓰는 쪽"이 비어 있는지 검사한다. 통로 검사(access.ts)는 가구의 어느 쪽이든 옆에 설 수 있으면 통과하지만,
// 옷장은 문을 여는 앞쪽, 책상은 의자를 놓는 앞쪽, 침대는 들어갈 긴 변 한쪽이 비어 있어야 실제로 쓸 수 있다.
// 가구의 앞은 회전 0°일 때 +z 방향이다 (3D 모델·평면도의 앞면 표시와 같다).
import type { Footprint, Point2 } from '@/lib/three/floorDrag';
import { footprintInsideRoom, footprintsOverlap } from './geometry';

export type Side = 'front' | 'back' | 'left' | 'right';

/** sides 가운데 하나만 비면 되는지(any), 모두 비어야 하는지(all) */
export type AccessRule = { sides: Side[]; mode: 'any' | 'all'; message: string };

/** category·clearance가 없으면 쓰는 쪽을 따지지 않는 가구로 본다 */
export type AccessItem = Footprint & { id: string; category?: string; clearance?: number };

/**
 * 가구 종류별로 비어 있어야 하는 쪽. 비워 둘 깊이는 카탈로그의 clearance(m)이고 0이면 검사하지 않는다.
 * - 침대: 긴 변 한쪽 (들어갈 자리)
 * - 식탁: 긴 변 양쪽 (마주 앉는 자리)
 * - 책상·수납(옷장·행거·서랍장·책장): 앞
 * - 의자·내 가구: 검사하지 않음 (내 가구는 어느 쪽이 앞인지 모른다)
 */
export function accessRule(item: Pick<AccessItem, 'category' | 'clearance' | 'w' | 'd'>): AccessRule | null {
  const clearance = item.clearance ?? 0;
  if (clearance <= 0) return null;
  const cm = Math.round(clearance * 100);
  const longSides: Side[] = item.d >= item.w ? ['left', 'right'] : ['front', 'back'];
  switch (item.category) {
    case 'bed':
      return { sides: longSides, mode: 'any', message: `옆으로 들어갈 자리가 없습니다 (긴 변 한쪽에 ${cm}cm 필요)` };
    case 'table':
      return { sides: longSides, mode: 'all', message: `양쪽에 앉을 자리가 없습니다 (긴 변 양쪽에 ${cm}cm 필요)` };
    case 'desk':
    case 'storage':
      return { sides: ['front'], mode: 'all', message: `앞이 막혀 있습니다 (앞에 ${cm}cm 필요)` };
    default:
      return null;
  }
}

/** 가구의 한쪽 면 바로 바깥으로 depth만큼 뻗은 직사각형 구역 */
export function sideZone(f: Footprint, side: Side, depth: number): Footprint {
  const r = (f.rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  // 가구의 가로(x)·깊이(z) 방향. floorDrag의 footprintCorners와 같은 규칙
  const ux: Point2 = [c, -s];
  const uz: Point2 = [s, c];
  if (side === 'front' || side === 'back') {
    const k = (side === 'front' ? 1 : -1) * (f.d / 2 + depth / 2);
    return { x: f.x + uz[0] * k, z: f.z + uz[1] * k, w: f.w, d: depth, rotationDeg: f.rotationDeg };
  }
  const k = (side === 'right' ? 1 : -1) * (f.w / 2 + depth / 2);
  return { x: f.x + ux[0] * k, z: f.z + ux[1] * k, w: depth, d: f.d, rotationDeg: f.rotationDeg };
}

/** 가구가 앞(+z)으로 보는 방향의 단위 벡터 [x, z] */
export function frontDirection(rotationDeg: number): Point2 {
  const r = (rotationDeg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

/**
 * 가구의 쓰는 쪽이 막혔는지. 구역이 방 밖으로 나가거나(벽에 막힘) 다른 가구와 겹치면 그쪽은 막힌 것이다.
 * 의자는 옮기기 쉬우므로 막는 것으로 보지 않는다 (책상 앞의 의자).
 */
export function accessBlocked(item: AccessItem, others: AccessItem[], polygon: Point2[] | null): boolean {
  const rule = accessRule(item);
  if (!rule) return false;
  const clearance = item.clearance ?? 0;
  const free = (side: Side) => {
    const zone = sideZone(item, side, clearance);
    if (polygon && !footprintInsideRoom(zone, polygon)) return false;
    return others.every((o) => o.id === item.id || o.category === 'chair' || !footprintsOverlap(zone, o));
  };
  return rule.mode === 'any' ? !rule.sides.some(free) : !rule.sides.every(free);
}

/** 쓰는 쪽이 막힌 가구와 화면에 보여줄 이유 */
export function findBlockedAccess(items: AccessItem[], polygon: Point2[] | null): { id: string; message: string }[] {
  const blocked: { id: string; message: string }[] = [];
  for (const item of items) {
    if (accessBlocked(item, items, polygon)) blocked.push({ id: item.id, message: accessRule(item)?.message ?? '' });
  }
  return blocked;
}
