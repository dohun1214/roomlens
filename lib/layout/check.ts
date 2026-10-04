// 배치 검사: 가구끼리 겹침, 방 밖으로 나감, 문 앞을 막음, 문에서 갈 수 없음, 창문을 가림(경고).
import { placeOnFloor, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import type { Opening } from '@/lib/rooms/openings';
import { doorZone, findUnreachable, TALL_FURNITURE_HEIGHT, WALKWAY_WIDTH, windowZone } from './access';
import { footprintInsideRoom, footprintsOverlap } from './geometry';

/** h(높이, m)는 창문 가림 검사에만 쓴다. 없으면 낮은 가구로 본다 */
export type LayoutItem = Footprint & { id: string; name: string; h?: number };

export type ViolationType = 'overlap' | 'outside' | 'door' | 'unreachable' | 'window';

export type Violation = {
  itemId: string;
  type: ViolationType;
  /** error는 고쳐야 하는 문제, warning은 알려만 주는 것 */
  severity: 'error' | 'warning';
  /** 겹친 상대 가구 */
  otherId?: string;
  /** 화면에 그대로 보여줄 문구 */
  message: string;
};

export function checkLayout(items: LayoutItem[], floorPolygon: Point2[] | null, openings: Opening[] = []): Violation[] {
  const violations: Violation[] = [];
  const polygon = floorPolygon !== null && floorPolygon.length >= 3 ? floorPolygon : null;

  for (const item of items) {
    if (polygon && !footprintInsideRoom(item, polygon)) {
      violations.push({ itemId: item.id, type: 'outside', severity: 'error', message: `${item.name}: 방 밖으로 나갔습니다` });
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (!footprintsOverlap(items[i], items[j])) continue;
      violations.push(
        { itemId: items[i].id, type: 'overlap', severity: 'error', otherId: items[j].id, message: `${items[i].name}: ${items[j].name}와(과) 겹칩니다` },
        { itemId: items[j].id, type: 'overlap', severity: 'error', otherId: items[i].id, message: `${items[j].name}: ${items[i].name}와(과) 겹칩니다` },
      );
    }
  }
  if (!polygon || openings.length === 0) return violations;

  // 문 앞: 문 폭 × 문 폭 정사각형을 비워 둔다
  const doors = openings.filter((o) => o.type === 'door');
  const doorZones = doors.map((door) => doorZone(door, polygon)).filter((zone) => zone !== null);
  for (const item of items) {
    if (doorZones.some((zone) => footprintsOverlap(item, zone))) {
      violations.push({ itemId: item.id, type: 'door', severity: 'error', message: `${item.name}: 문 앞을 막습니다` });
    }
  }

  // 통로: 문에서 각 가구 옆까지 60cm 폭으로 갈 수 있어야 한다
  const unreachable = new Set(findUnreachable(items, polygon, doors) ?? []);
  for (const item of items) {
    if (unreachable.has(item.id)) {
      violations.push({
        itemId: item.id,
        type: 'unreachable',
        severity: 'error',
        message: `${item.name}: 문에서 갈 수 없습니다 (통로 ${WALKWAY_WIDTH * 100}cm 부족)`,
      });
    }
  }

  // 창문 가림: 키 큰 가구가 창문 바로 앞에 있으면 경고
  const windowZones = openings.filter((o) => o.type === 'window').map((w) => windowZone(w, polygon)).filter((zone) => zone !== null);
  for (const item of items) {
    if ((item.h ?? 0) > TALL_FURNITURE_HEIGHT && windowZones.some((zone) => footprintsOverlap(item, zone))) {
      violations.push({ itemId: item.id, type: 'window', severity: 'warning', message: `${item.name}: 창문을 가립니다` });
    }
  }
  return violations;
}

/** 고쳐야 하는 문제(error)가 있는 가구 id 모음 */
export function violatingIds(violations: Violation[]): Set<string> {
  return new Set(violations.filter((v) => v.severity === 'error').map((v) => v.itemId));
}

/** 경고만 있는 가구 id 모음 */
export function warningIds(violations: Violation[]): Set<string> {
  const errors = violatingIds(violations);
  return new Set(violations.filter((v) => v.severity === 'warning' && !errors.has(v.itemId)).map((v) => v.itemId));
}
const SEARCH_STEP = 0.25;
const SEARCH_RADIUS = 6;

/**
 * 새 가구를 놓을 빈자리를 찾는다: 방 가운데에서 시작해 바깥으로 넓혀 가며
 * 방 안이고 다른 가구와 겹치지 않는 첫 위치. 못 찾으면 가운데(겹친 채로 두고 검사에서 알린다).
 */
export function findFreeSpot(size: Pick<Footprint, 'w' | 'd'>, others: Footprint[], floorPolygon: Point2[] | null): Footprint {
  const polygon = floorPolygon && floorPolygon.length >= 3 ? floorPolygon : null;
  const center: Point2 = polygon
    ? // 꼭짓점의 평균. 보정된 방은 네 모서리의 중심이 원점이라 정확히 (0, 0)이 된다
      [polygon.reduce((s, p) => s + p[0], 0) / polygon.length, polygon.reduce((s, p) => s + p[1], 0) / polygon.length]
    : [0, 0];
  const at = (dx: number, dz: number) => placeOnFloor({ x: center[0] + dx, z: center[1] + dz, w: size.w, d: size.d, rotationDeg: 0 }, polygon);
  const fits = (f: Footprint) => (!polygon || footprintInsideRoom(f, polygon)) && others.every((o) => !footprintsOverlap(f, o));

  const first = at(0, 0);
  if (fits(first)) return first;
  // 가운데를 둘러싼 정사각형 고리를 안쪽부터 훑는다
  for (let ring = 1; ring * SEARCH_STEP <= SEARCH_RADIUS; ring += 1) {
    for (let i = -ring; i <= ring; i += 1) {
      for (const [dx, dz] of [[i, -ring], [i, ring], [-ring, i], [ring, i]] as const) {
        const candidate = at(dx * SEARCH_STEP, dz * SEARCH_STEP);
        if (fits(candidate)) return candidate;
      }
    }
  }
  return first;
}
