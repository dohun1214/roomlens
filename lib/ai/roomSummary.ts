// AI 배치 추천에서 Gemini에 보내는 "방 요약" 글을 만든다.
// 좌표는 보내지 않는다: 벽 이름(W1..Wn)과 길이, 문·창문이 벽의 어디에 있는지, 가구의 치수만 알려 주고
// Gemini는 "어느 벽·구역에 무엇을 둘지"만 정한다. 실제 좌표는 lib/layout/solver.ts 가 계산한다.
import { OPENING_LABEL, wallsOf, type Opening } from '@/lib/rooms/openings';
import { signedArea, type Point2 } from '@/lib/three/floorDrag';

/** 사용자 요청 글의 최대 길이 */
export const MAX_REQUEST_LENGTH = 200;

export type SummaryItem = { id: string; name: string; w: number; d: number; h: number };

/** 벽 번호(0부터)를 Gemini와 주고받는 이름으로: 0 → "W1". 화면의 "벽 1"과 같은 번호다 */
export function wallId(index: number): string {
  return `W${index + 1}`;
}

/** "W3" → 2. 모양이 다르거나 없는 벽이면 null */
export function parseWallId(id: string, wallCount: number): number | null {
  const match = /^W(\d{1,3})$/i.exec(id.trim());
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return index >= 0 && index < wallCount ? index : null;
}

/** 사용자 요청을 한 줄로 정리한다: 줄바꿈·연속 공백을 없애고 길이를 자른다 */
export function cleanRequest(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_REQUEST_LENGTH);
}

const m = (v: number) => `${v.toFixed(2)}m`;

/** 벽이 방의 어느 쪽에 있는지. 실제 방위가 아니라 평면도에서의 이름이다 (마주 보는 벽을 알려 주기 위한 것) */
export function wallSide(a: Point2, b: Point2, polygon: Point2[]): '북쪽' | '남쪽' | '동쪽' | '서쪽' | '비스듬한' {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const u: Point2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
  const sign = signedArea(polygon) > 0 ? 1 : -1;
  // 벽에서 방 안쪽을 향하는 방향
  const n: Point2 = [-u[1] * sign, u[0] * sign];
  const AXIS = 0.966; // 축에서 15° 이내
  if (n[1] > AXIS) return '북쪽';
  if (n[1] < -AXIS) return '남쪽';
  if (n[0] > AXIS) return '서쪽';
  if (n[0] < -AXIS) return '동쪽';
  return '비스듬한';
}

function isRectangle(polygon: Point2[]): boolean {
  if (polygon.length !== 4) return false;
  return polygon.every((p, i) => {
    const prev = polygon[(i + 3) % 4];
    const next = polygon[(i + 1) % 4];
    const ax = p[0] - prev[0];
    const az = p[1] - prev[1];
    const bx = next[0] - p[0];
    const bz = next[1] - p[1];
    const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) || 1) * (Math.hypot(bx, bz) || 1));
    return Math.abs(cos) < 0.035; // 직각에서 2° 이내
  });
}

/**
 * 방·가구·요청을 Gemini에 보낼 글로 만든다.
 * @param polygon 보정된 방 평면도 (m). 벽 i = i번째 → 다음 꼭짓점
 * @param request 사용자가 적은 요청 (없으면 빈 문자열)
 */
export function summarizeRoom(polygon: Point2[], openings: Opening[], items: SummaryItem[], request = ''): string {
  const walls = wallsOf(polygon);
  const area = Math.abs(signedArea(polygon));
  const lines: string[] = [];

  if (isRectangle(polygon)) {
    lines.push(`방: ${m(walls[0].length)} x ${m(walls[1].length)} 직사각형 (넓이 ${area.toFixed(1)}㎡)`);
  } else {
    const xs = polygon.map((p) => p[0]);
    const zs = polygon.map((p) => p[1]);
    const width = Math.max(...xs) - Math.min(...xs);
    const depth = Math.max(...zs) - Math.min(...zs);
    lines.push(`방: 꼭짓점 ${polygon.length}개 다각형 (동서 ${m(width)} x 남북 ${m(depth)} 범위, 넓이 ${area.toFixed(1)}㎡)`);
  }
  lines.push('벽은 W1부터 방을 한 바퀴 도는 순서다. 문·창문의 위치는 앞 번호 벽과 만나는 모서리에서 잰 거리다.');
  lines.push('방위는 실제 방위가 아니라 평면도 기준이다. 북쪽 벽과 남쪽 벽, 동쪽 벽과 서쪽 벽이 서로 마주 본다.');

  for (const wall of walls) {
    const here = openings.filter((o) => o.wallIndex === wall.index).sort((a, b) => a.from - b.from);
    const detail = here.length === 0 ? '벽' : here.map((o) => `${OPENING_LABEL[o.type]} (${o.from.toFixed(2)}~${m(o.to)})`).join(', ');
    lines.push(`${wallId(wall.index)} (${m(wall.length)}, ${wallSide(wall.a, wall.b, polygon)} 벽): ${detail}`);
  }

  lines.push('가구:');
  for (const item of items) {
    lines.push(`- ${item.id}: ${item.name}, 가로 ${m(item.w)} x 깊이 ${m(item.d)} x 높이 ${m(item.h)}`);
  }
  const cleaned = cleanRequest(request);
  lines.push(`사용자 요청: ${cleaned === '' ? '없음' : cleaned}`);
  return lines.join('\n');
}
