// 문·창문 찾기: 3D 화면 캡처에서 Gemini가 찾은 상자(box_2d)를 벽 위의 구간으로 바꾼다.
// 캡처할 때의 카메라 위치·방향을 알고 있으므로, 그림 위의 한 점은 방 안의 한 광선이 되고 그 광선이 닿는 벽을 계산할 수 있다.
// 결과는 "후보"다. 사용자가 3D에서 확인하고 틀린 것은 지운 뒤 저장한다. 네트워크·DB를 건드리지 않는다.
import { z } from 'zod';
import { distanceToPolygon, interiorPoint, pointInPolygon } from '@/lib/layout/geometry';
import { makeOpening, overlapsExisting, type Opening, type OpeningType } from '@/lib/rooms/openings';
import type { Point2 } from '@/lib/three/floorDrag';
import { MAX_IMAGE_BASE64, type CaptureView } from './analysis';

/** 한 번에 보내는 그림 수: 자리 3곳 × 6방향 */
export const MAX_DETECT_IMAGES = 18;
/** 캡처한 그림의 긴 변 (px). 18장을 합쳐도 요청 크기 한도(약 3.8MB) 안이다 */
export const DETECT_LONG_SIDE = 1280;
const MAX_SPOTS = 3;
const SPOT_SPACING = 2.5;
const WALL_MARGIN = 0.6;
const EYE_HEIGHT = 1.5;
const LOOK_DOWN = 0.1;
/** 이보다 먼 벽의 것은 위치가 부정확해서 쓰지 않는다 (m) */
const MAX_DISTANCE = 7;
/** 같은 벽에서 이만큼 이하로 떨어진 창문 조각은 하나의 창문으로 잇는다 (창틀·커튼 사이, m) */
const WINDOW_GAP = 0.5;
const MAX_DOOR_WIDTH = 2;

const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);

export const DetectInput = z.object({
  images: z
    .array(z.object({ data: z.string().min(100, '그림이 비어 있습니다.').max(MAX_IMAGE_BASE64, '그림이 너무 큽니다.') }))
    .min(1, '그림이 없습니다.')
    .max(MAX_DETECT_IMAGES, `그림은 ${MAX_DETECT_IMAGES}장까지 보낼 수 있습니다.`),
  /** 그림마다 찍은 자리와 본 곳 (방 좌표, m). images와 같은 순서 */
  views: z.array(z.object({ position: Vec3, target: Vec3 })).min(1).max(MAX_DETECT_IMAGES),
  /** 그림의 가로 ÷ 세로, 카메라의 세로 시야각(°) */
  aspect: z.number().min(0.3).max(4),
  fovDeg: z.number().min(20).max(120),
});
export type DetectInput = z.infer<typeof DetectInput>;

/** Gemini가 돌려주는 것: 그림마다 찾은 문·창문의 상자 */
export const DetectedOpenings = z.object({
  openings: z.array(
    z.object({
      type: z.enum(['door', 'window']),
      imageIndex: z.number().int().describe('그림 번호 (1부터)'),
      box_2d: z.array(z.number()).length(4).describe('[ymin, xmin, ymax, xmax], 0~1000'),
      confidence: z.enum(['low', 'medium', 'high']),
    }),
  ),
});
export type Detection = z.infer<typeof DetectedOpenings>['openings'][number];

type Vec = [number, number, number];
export type Camera = { aspect: number; fovDeg: number };

/**
 * 문·창문을 찾으려고 캡처할 자리와 방향 (보정된 방 좌표).
 * 방 안쪽에서 서로 2.5m 넘게 떨어진 자리를 3곳까지 잡고, 자리마다 60° 간격 여섯 방향을 본다.
 * (방 분석보다 촘촘하다: 문은 정면에 가깝게 보여야 위치가 맞는다)
 */
export function detectionPlan(polygon: Point2[]): CaptureView[] {
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const candidates: { p: Point2; wall: number }[] = [];
  for (let x = minX; x <= maxX; x += 0.25) {
    for (let z = minZ; z <= maxZ; z += 0.25) {
      const p: Point2 = [x, z];
      if (!pointInPolygon(p, polygon)) continue;
      const wall = distanceToPolygon(p, polygon);
      if (wall >= WALL_MARGIN) candidates.push({ p, wall });
    }
  }
  let first = interiorPoint(polygon);
  if (!pointInPolygon(first, polygon) || distanceToPolygon(first, polygon) < WALL_MARGIN) {
    first = candidates.reduce((best, s) => (s.wall > best.wall ? s : best), { p: first, wall: -1 }).p;
  }
  const spots: Point2[] = [first];
  while (spots.length < MAX_SPOTS) {
    // 이미 고른 자리들에서 가장 먼 자리
    let best: Point2 | null = null;
    let bestDistance = SPOT_SPACING;
    for (const { p } of candidates) {
      const nearest = Math.min(...spots.map((s) => Math.hypot(p[0] - s[0], p[1] - s[1])));
      if (nearest > bestDistance) {
        bestDistance = nearest;
        best = p;
      }
    }
    if (!best) break;
    spots.push(best);
  }
  return spots.flatMap((spot) =>
    [0, 60, 120, 180, 240, 300].map((deg): CaptureView => {
      const r = (deg * Math.PI) / 180;
      return { position: [spot[0], EYE_HEIGHT, spot[1]], target: [spot[0] + Math.cos(r), EYE_HEIGHT - LOOK_DOWN, spot[1] + Math.sin(r)] };
    }),
  );
}

const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec): Vec => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

function basis(view: CaptureView): { forward: Vec; right: Vec; up: Vec } {
  const forward = unit(sub(view.target, view.position));
  const right = unit(cross(forward, [0, 1, 0]));
  return { forward, right, up: cross(right, forward) };
}

/** 그림 위의 점(px, py: 0~1, 왼쪽 위가 0,0)을 지나는 광선의 방향 */
export function rayThrough(view: CaptureView, camera: Camera, px: number, py: number): Vec {
  const { forward, right, up } = basis(view);
  const tan = Math.tan((camera.fovDeg * Math.PI) / 360);
  const x = (px * 2 - 1) * tan * camera.aspect;
  const y = (1 - py * 2) * tan;
  return unit([forward[0] + right[0] * x + up[0] * y, forward[1] + right[1] * x + up[1] * y, forward[2] + right[2] * x + up[2] * y]);
}

/** 방 안의 점이 그림의 어디에 보이는지 (0~1). 카메라 뒤면 null. rayThrough의 반대 */
export function projectPoint(view: CaptureView, camera: Camera, point: Vec): [number, number] | null {
  const { forward, right, up } = basis(view);
  const rel = sub(point, view.position);
  const depth = dot3(rel, forward);
  if (depth <= 1e-6) return null;
  const tan = Math.tan((camera.fovDeg * Math.PI) / 360);
  return [(dot3(rel, right) / depth / (tan * camera.aspect) + 1) / 2, (1 - dot3(rel, up) / depth / tan) / 2];
}

type WallHit = { wall: number; along: number; distance: number };

/** 광선이 벽 i의 직선과 만나는 곳. segmentOnly면 벽 구간 안에서 만날 때만 */
function intersectWall(origin: Vec, direction: Vec, polygon: Point2[], wall: number, segmentOnly: boolean): WallHit | null {
  const a = polygon[wall];
  const b = polygon[(wall + 1) % polygon.length];
  const ex = b[0] - a[0];
  const ez = b[1] - a[1];
  const den = direction[0] * ez - direction[2] * ex;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((a[0] - origin[0]) * ez - (a[1] - origin[2]) * ex) / den;
  if (t <= 0.05) return null;
  const u = ((a[0] - origin[0]) * direction[2] - (a[1] - origin[2]) * direction[0]) / den;
  if (segmentOnly && (u < -0.02 || u > 1.02)) return null;
  return { wall, along: Math.min(1, Math.max(0, u)) * Math.hypot(ex, ez), distance: t };
}

/** 광선이 처음 닿는 벽 */
function firstWall(origin: Vec, direction: Vec, polygon: Point2[]): WallHit | null {
  let best: WallHit | null = null;
  for (let i = 0; i < polygon.length; i += 1) {
    const hit = intersectWall(origin, direction, polygon, i, true);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}

type Located = { type: OpeningType; wall: number; from: number; to: number; cutFrom: boolean; cutTo: boolean };
type Group = Located & { members: Located[] };

/** 상자 하나를 벽 위의 구간으로. 상자 가운데가 닿는 벽을 그 문·창문의 벽으로 보고, 좌우 끝은 그 벽의 직선 위로 내린다 */
function locate(detection: Detection, view: CaptureView, camera: Camera, polygon: Point2[]): Located | null {
  const [ymin, xmin, ymax, xmax] = detection.box_2d.map((v) => Math.min(1, Math.max(0, v / 1000)));
  if (!(xmax > xmin) || !(ymax > ymin)) return null;
  // 문은 아래쪽(바닥 가까이), 창문은 가운데 높이에서 벽을 찾는다
  const py = detection.type === 'door' ? ymin + (ymax - ymin) * 0.8 : (ymin + ymax) / 2;
  const middle = firstWall(view.position, rayThrough(view, camera, (xmin + xmax) / 2, py), polygon);
  if (!middle || middle.distance > MAX_DISTANCE) return null;
  const left = intersectWall(view.position, rayThrough(view, camera, xmin, py), polygon, middle.wall, false);
  const right = intersectWall(view.position, rayThrough(view, camera, xmax, py), polygon, middle.wall, false);
  if (!left || !right) return null;
  // 그림 가장자리에 닿은 쪽은 잘려서 끝이 보이지 않는 것이다
  const cutLeft = xmin < 0.01;
  const cutRight = xmax > 0.99;
  const flipped = left.along > right.along;
  return {
    type: detection.type,
    wall: middle.wall,
    from: Math.min(left.along, right.along),
    to: Math.max(left.along, right.along),
    cutFrom: flipped ? cutRight : cutLeft,
    cutTo: flipped ? cutLeft : cutRight,
  };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const overlap = (a: { from: number; to: number }, b: { from: number; to: number }) => Math.min(a.to, b.to) - Math.max(a.from, b.from);

/**
 * Gemini가 찾은 상자들을 문·창문 후보로 바꾼다.
 * - 같은 것이 여러 그림에 보이면 하나로 묶는다: 끝이 보인 그림들의 가운데값, 모두 잘렸으면 가장 바깥 값
 * - 같은 벽에서 가까이 이어진 창문 조각은 하나의 창문으로 잇는다
 * - 같은 자리를 문으로도 창문으로도 봤으면 더 많이 본 쪽을 쓴다 (유리문)
 * - 벽을 벗어나거나 너무 좁은 것, 서로 겹치는 것은 버린다
 */
export function locateDetections(detections: Detection[], views: CaptureView[], camera: Camera, polygon: Point2[]): Opening[] {
  const groups: Group[] = [];
  for (const detection of detections) {
    const view = views[detection.imageIndex - 1];
    if (!view || detection.confidence === 'low') continue;
    const located = locate(detection, view, camera, polygon);
    if (!located) continue;
    const group = groups.find((g) => g.type === located.type && g.wall === located.wall && overlap(g, located) > 0.3 * Math.min(g.to - g.from, located.to - located.from));
    if (group) {
      group.members.push(located);
      group.from = Math.min(group.from, located.from);
      group.to = Math.max(group.to, located.to);
    } else {
      groups.push({ ...located, members: [located] });
    }
  }
  for (const group of groups) {
    const fromSeen = group.members.filter((m) => !m.cutFrom).map((m) => m.from);
    const toSeen = group.members.filter((m) => !m.cutTo).map((m) => m.to);
    group.from = fromSeen.length > 0 ? median(fromSeen) : Math.min(...group.members.map((m) => m.from));
    group.to = toSeen.length > 0 ? median(toSeen) : Math.max(...group.members.map((m) => m.to));
  }

  // 창문 조각 잇기
  const merged: Group[] = [];
  for (const group of [...groups].sort((a, b) => a.wall - b.wall || a.from - b.from)) {
    const previous = merged[merged.length - 1];
    if (previous && group.type === 'window' && previous.type === 'window' && previous.wall === group.wall && group.from - previous.to <= WINDOW_GAP) {
      previous.to = Math.max(previous.to, group.to);
      previous.members.push(...group.members);
    } else {
      merged.push({ ...group, members: [...group.members] });
    }
  }

  // 많이 본 것부터 넣는다. 먼저 들어간 것과 겹치면 버린다
  const openings: Opening[] = [];
  for (const group of merged.sort((a, b) => b.members.length - a.members.length || (a.type === 'door' ? -1 : 1))) {
    const width = group.to - group.from;
    if (group.type === 'door' && width > MAX_DOOR_WIDTH) continue;
    const made = makeOpening(group.type, group.wall, group.from, width, polygon);
    if (!made.ok) continue;
    // 종류가 달라도 같은 자리면 겹친 것으로 본다
    if (overlapsExisting(made.opening, openings)) continue;
    openings.push(made.opening);
  }
  return openings.sort((a, b) => a.wallIndex - b.wallIndex || a.from - b.from);
}
