// 방 준비(보정·문창문·원래 가구) 결과를 정답과 견주는 점수. 성능을 숫자로 재며 고치기 위한 것으로, 앱 화면에서는 쓰지 않는다.
// 모든 값은 "정답 방 좌표"(정답 보정으로 옮긴 좌표, 바닥 y=0, m)에서 비교한다. 다른 보정으로 만든 결과는 frameMap으로 옮겨 온다.
import * as THREE from 'three';
import { footprintCorners, pointInPolygon, signedArea, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { applyRoomTransform, invertRoomTransform, type RoomTransform } from '@/lib/three/roomTransform';
import type { Opening, OpeningType } from '@/lib/rooms/openings';
import type { Fixture } from '@/lib/rooms/fixtures';

/** 문·창문을 벽 번호 대신 바닥 위의 선분으로 나타낸 것 */
export type OpeningSegment = { type: OpeningType; a: Point2; b: Point2 };
/** 정답·결과의 원래 가구 (id·remove 없이) */
export type FixtureBox = Footprint & { label: string; h: number };
export type CalibrationFrame = { transform: RoomTransform; flipX: boolean };

const FLIP_X = new THREE.Quaternion(1, 0, 0, 0);

/** 한 보정의 방 좌표(바닥 위 점)를 다른 보정의 방 좌표로 옮기는 함수. 같은 파일을 두 가지로 보정했을 때 쓴다 */
export function frameMap(from: CalibrationFrame, to: CalibrationFrame): (p: Point2) => Point2 {
  return ([x, z]) => {
    // 방 좌표 → 스플랫 좌표(뒤집기 전) → 파일 좌표
    const local = invertRoomTransform(new THREE.Vector3(x, 0, z), from.transform);
    if (from.flipX) local.applyQuaternion(FLIP_X);
    if (to.flipX) local.applyQuaternion(FLIP_X);
    const out = applyRoomTransform(local, to.transform);
    return [out.x, out.z];
  };
}

/** 한 보정의 방 좌표에서 길이 1m가 다른 보정에서 몇 m인지 */
export function frameScale(from: CalibrationFrame, to: CalibrationFrame): number {
  return to.transform.s / from.transform.s;
}

/** 저장 형식(벽 번호·거리)의 문·창문을 선분으로 */
export function openingSegments(openings: Opening[], polygon: Point2[]): OpeningSegment[] {
  const n = polygon.length;
  return openings.flatMap((o) => {
    const a = polygon[o.wallIndex];
    const b = polygon[(o.wallIndex + 1) % n];
    if (!a || !b) return [];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) return [];
    const u: Point2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    return [{ type: o.type, a: [a[0] + u[0] * o.from, a[1] + u[1] * o.from], b: [a[0] + u[0] * o.to, a[1] + u[1] * o.to] }];
  });
}

/** 꺾이는 꼭짓점만 남긴다 (한 직선 위의 점, 거의 같은 점은 뺀다) */
export function turningCorners(polygon: Point2[], tolerance = 0.03): Point2[] {
  const pts = polygon.slice();
  for (let changed = true; changed && pts.length > 3; ) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 3; i += 1) {
      const a = pts[(i + pts.length - 1) % pts.length];
      const p = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const off = ab < 1e-9 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / ab;
      if (off < tolerance) {
        pts.splice(i, 1);
        changed = true;
        i -= 1;
      }
    }
  }
  return pts;
}

/** 두 다각형의 겹침 비율(IoU). 격자(cell m)로 세어서 구한다 */
export function polygonIoU(a: Point2[], b: Point2[], cell = 0.02): number {
  if (a.length < 3 || b.length < 3) return 0;
  const all = [...a, ...b];
  const [x0, x1] = [Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0]))];
  const [z0, z1] = [Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[1]))];
  let inter = 0;
  let union = 0;
  for (let x = x0 + cell / 2; x < x1; x += cell) {
    for (let z = z0 + cell / 2; z < z1; z += cell) {
      const ia = pointInPolygon([x, z], a);
      const ib = pointInPolygon([x, z], b);
      if (ia && ib) inter += 1;
      if (ia || ib) union += 1;
    }
  }
  return union === 0 ? 0 : inter / union;
}

export type LayoutScore = {
  /** 바닥 모양의 겹침 비율 (1 = 같음) */
  iou: number;
  /** 정답 모서리마다 가장 가까운 결과 모서리까지 거리의 평균·최대 (m) */
  cornerMean: number;
  cornerMax: number;
  /** 결과 넓이 / 정답 넓이 */
  areaRatio: number;
  /** 꺾이는 모서리 수 (결과, 정답) */
  corners: [number, number];
};

export function scoreLayout(pred: Point2[], truth: Point2[]): LayoutScore {
  const p = turningCorners(pred);
  const t = turningCorners(truth);
  const dists = t.map((c) => Math.min(...p.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1]))));
  return {
    iou: polygonIoU(pred, truth),
    cornerMean: dists.reduce((s, d) => s + d, 0) / Math.max(1, dists.length),
    cornerMax: Math.max(0, ...dists),
    areaRatio: Math.abs(signedArea(pred)) / Math.max(1e-9, Math.abs(signedArea(truth))),
    corners: [p.length, t.length],
  };
}

export type MatchScore = {
  truth: number;
  pred: number;
  matched: number;
  /** 찾은 비율 = 맞은 수 / 정답 수 */
  recall: number;
  /** 맞은 비율 = 맞은 수 / 결과 수 */
  precision: number;
  /** 맞은 것 가운데 종류(이름)도 맞은 비율 */
  typeAccuracy: number;
};

const ratio = (a: number, b: number) => (b === 0 ? 1 : a / b);
const median = (v: number[]) => {
  if (v.length === 0) return 0;
  const s = [...v].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 두 선분이 같은 문·창문인지 보는 점수: 같은 벽선 위(수직 거리 maxOffset 이하)에서 구간이 겹치는 비율 */
export function segmentOverlap(p: OpeningSegment, t: OpeningSegment, maxOffset = 0.4): number {
  const len = Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1]);
  if (len < 1e-9) return 0;
  const u: Point2 = [(t.b[0] - t.a[0]) / len, (t.b[1] - t.a[1]) / len];
  const along = (q: Point2) => (q[0] - t.a[0]) * u[0] + (q[1] - t.a[1]) * u[1];
  const off = (q: Point2) => Math.abs((q[0] - t.a[0]) * u[1] - (q[1] - t.a[1]) * u[0]);
  if (off(p.a) > maxOffset || off(p.b) > maxOffset) return 0;
  // 방향이 크게 다르면(다른 벽) 같은 것이 아니다
  const pl = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
  if (pl > 1e-9 && Math.abs(((p.b[0] - p.a[0]) * u[0] + (p.b[1] - p.a[1]) * u[1]) / pl) < 0.7) return 0;
  const [p0, p1] = [along(p.a), along(p.b)].sort((x, y) => x - y);
  const inter = Math.min(p1, len) - Math.max(p0, 0);
  if (inter <= 0) return 0;
  return inter / (Math.max(p1, len) - Math.min(p0, 0));
}

export type OpeningsScore = MatchScore & {
  /** 맞은 것의 양 끝 오차의 가운뎃값 (m) */
  endError: number;
};

/** 문·창문: 구간이 minOverlap 이상 겹치면 같은 것으로 본다 (종류는 따로 센다) */
export function scoreOpenings(pred: OpeningSegment[], truth: OpeningSegment[], minOverlap = 0.3): OpeningsScore {
  const pairs: { i: number; j: number; s: number }[] = [];
  pred.forEach((p, i) =>
    truth.forEach((t, j) => {
      const s = segmentOverlap(p, t);
      if (s >= minOverlap) pairs.push({ i, j, s });
    }),
  );
  pairs.sort((x, y) => y.s - x.s);
  const usedP = new Set<number>();
  const usedT = new Set<number>();
  const ends: number[] = [];
  let sameType = 0;
  for (const { i, j } of pairs) {
    if (usedP.has(i) || usedT.has(j)) continue;
    usedP.add(i);
    usedT.add(j);
    const p = pred[i];
    const t = truth[j];
    if (p.type === t.type) sameType += 1;
    // 끝점은 가까운 쪽끼리
    const d1 = Math.hypot(p.a[0] - t.a[0], p.a[1] - t.a[1]) + Math.hypot(p.b[0] - t.b[0], p.b[1] - t.b[1]);
    const d2 = Math.hypot(p.a[0] - t.b[0], p.a[1] - t.b[1]) + Math.hypot(p.b[0] - t.a[0], p.b[1] - t.a[1]);
    ends.push(Math.min(d1, d2) / 2);
  }
  const matched = usedT.size;
  return {
    truth: truth.length,
    pred: pred.length,
    matched,
    recall: ratio(matched, truth.length),
    precision: ratio(matched, pred.length),
    typeAccuracy: ratio(sameType, matched),
    endError: median(ends),
  };
}

/** 볼록 다각형 두 개의 겹친 넓이 (Sutherland–Hodgman) */
function convexIntersectionArea(subject: Point2[], clip: Point2[]): number {
  const ccw = (poly: Point2[]) => (signedArea(poly) < 0 ? [...poly].reverse() : poly);
  let out = ccw(subject);
  const c = ccw(clip);
  for (let i = 0; i < c.length && out.length > 0; i += 1) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const inside = (p: Point2) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cross = (p: Point2, q: Point2): Point2 => {
      const [x1, y1, x2, y2] = [p[0], p[1], q[0], q[1]];
      const [x3, y3, x4, y4] = [a[0], a[1], b[0], b[1]];
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      const t = den === 0 ? 0 : ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k += 1) {
      const p = input[k];
      const q = input[(k + 1) % input.length];
      if (inside(q)) {
        if (!inside(p)) out.push(cross(p, q));
        out.push(q);
      } else if (inside(p)) {
        out.push(cross(p, q));
      }
    }
  }
  return out.length < 3 ? 0 : Math.abs(signedArea(out));
}

/** 두 가구 바닥 사각형의 겹침 비율 */
export function boxIoU(a: Footprint, b: Footprint): number {
  const pa = footprintCorners(a);
  const pb = footprintCorners(b);
  const inter = convexIntersectionArea(pa, pb);
  if (inter <= 0) return 0;
  return inter / (a.w * a.d + b.w * b.d - inter);
}

export type FixturesScore = MatchScore & {
  /** 맞은 것의 가운데 오차·높이 오차의 가운뎃값 (m) */
  centerError: number;
  heightError: number;
};

/** 원래 가구: 바닥 사각형이 minIou 이상 겹치면 같은 것으로 본다 (한 정답에 한 결과) */
export function scoreFixtures(pred: FixtureBox[], truth: FixtureBox[], minIou = 0.3): FixturesScore {
  const pairs: { i: number; j: number; s: number }[] = [];
  pred.forEach((p, i) =>
    truth.forEach((t, j) => {
      const s = boxIoU(p, t);
      if (s >= minIou) pairs.push({ i, j, s });
    }),
  );
  pairs.sort((x, y) => y.s - x.s);
  const usedP = new Set<number>();
  const usedT = new Set<number>();
  const centers: number[] = [];
  const heights: number[] = [];
  let sameLabel = 0;
  for (const { i, j } of pairs) {
    if (usedP.has(i) || usedT.has(j)) continue;
    usedP.add(i);
    usedT.add(j);
    const p = pred[i];
    const t = truth[j];
    if (p.label === t.label) sameLabel += 1;
    centers.push(Math.hypot(p.x - t.x, p.z - t.z));
    heights.push(Math.abs(p.h - t.h));
  }
  const matched = usedT.size;
  return {
    truth: truth.length,
    pred: pred.length,
    matched,
    recall: ratio(matched, truth.length),
    precision: ratio(matched, pred.length),
    typeAccuracy: ratio(sameLabel, matched),
    centerError: median(centers),
    heightError: median(heights),
  };
}

/** 원래 가구를 다른 보정의 방 좌표로 옮긴다 (가운데·방향·크기) */
export function mapFixture(f: Fixture | FixtureBox, map: (p: Point2) => Point2, scale: number): FixtureBox {
  const center = map([f.x, f.z]);
  const r = (f.rotationDeg * Math.PI) / 180;
  const ahead = map([f.x + Math.cos(r), f.z - Math.sin(r)]);
  const deg = (Math.atan2(-(ahead[1] - center[1]), ahead[0] - center[0]) * 180) / Math.PI;
  return { label: f.label, x: center[0], z: center[1], w: f.w * scale, d: f.d * scale, rotationDeg: ((deg % 360) + 360) % 360, h: f.h * scale };
}

/** 문·창문 선분을 다른 보정의 방 좌표로 */
export function mapSegment(s: OpeningSegment, map: (p: Point2) => Point2): OpeningSegment {
  return { type: s.type, a: map(s.a), b: map(s.b) };
}
