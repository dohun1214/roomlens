// 배치 검사: 가구끼리 겹침, 방 밖으로 나감. (문 앞·통로·창문 가림은 문·창문 정보가 생기면 추가)
import { placeOnFloor, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { footprintInsideRoom, footprintsOverlap } from './geometry';

export type LayoutItem = Footprint & { id: string; name: string };

export type Violation = {
  itemId: string;
  type: 'overlap' | 'outside';
  /** 겹친 상대 가구 */
  otherId?: string;
  /** 화면에 그대로 보여줄 문구 */
  message: string;
};

export function checkLayout(items: LayoutItem[], floorPolygon: Point2[] | null): Violation[] {
  const violations: Violation[] = [];
  const hasRoom = floorPolygon !== null && floorPolygon.length >= 3;

  for (const item of items) {
    if (hasRoom && !footprintInsideRoom(item, floorPolygon)) {
      violations.push({ itemId: item.id, type: 'outside', message: `${item.name}: 방 밖으로 나갔습니다` });
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (!footprintsOverlap(items[i], items[j])) continue;
      violations.push(
        { itemId: items[i].id, type: 'overlap', otherId: items[j].id, message: `${items[i].name}: ${items[j].name}와(과) 겹칩니다` },
        { itemId: items[j].id, type: 'overlap', otherId: items[i].id, message: `${items[j].name}: ${items[i].name}와(과) 겹칩니다` },
      );
    }
  }
  return violations;
}

/** 문제가 있는 가구 id 모음 */
export function violatingIds(violations: Violation[]): Set<string> {
  return new Set(violations.map((v) => v.itemId));
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
