// 홈의 "샘플 방": 처음 온 사람이 바로 들어가 볼 공개 방 몇 곳. 한국식으로 만든 방 2곳과 화질이 좋은 스캔 2곳.
// 운영 DB의 방 id다. 지워졌거나 비공개가 되면 건너뛰고, 모자라면 다른 공개 방(최근 순)으로 채운다.
import type { Point2 } from '@/lib/three/floorDrag';

export const FEATURED_ROOM_IDS = [
  'cb05693e-5745-4316-bf5f-8fc8a5a78160', // 한국식 거실 (생성한 방)
  '48fdf433-b393-430c-a606-83811eab1624', // 한국식 안방 (생성한 방)
  '31cfd81c-8e95-48fa-94ee-b37895a75e1a', // 침실 (Bedroom)
  'c866250f-7f4a-46ef-8b2a-f0e22582d6b5', // 거실·식당·부엌 (Studio 11)
];
export const FEATURED_COUNT = 4;

/** 고른 방을 정한 순서대로, 모자라면 나머지(받은 순서)로 채운다 */
export function pickFeatured<T extends { id: string }>(rows: T[], ids: readonly string[] = FEATURED_ROOM_IDS, count = FEATURED_COUNT): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const picked = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  for (const row of rows) {
    if (picked.length >= count) break;
    if (!picked.includes(row)) picked.push(row);
  }
  return picked.slice(0, count);
}

/** 카드에 쓰는 짧은 제목: 끝의 괄호(원래 이름·"생성한 방")를 뗀다 */
export function shortTitle(title: string): string {
  const short = title.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return short || title;
}

/** 바닥 모양의 가로 × 세로 표시 (긴 쪽 먼저, 0.1 m 단위). 예: "5.4 × 4.2 m" */
export function sizeLabel(polygon: Point2[]): string | null {
  if (polygon.length < 3) return null;
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const [a, b] = [Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)].sort((p, q) => q - p);
  if (!(a > 0) || !(b > 0)) return null;
  return `${a.toFixed(1)} × ${b.toFixed(1)} m`;
}
