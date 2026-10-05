// AI 배치 추천의 계산 부분. Gemini가 정한 배치 의도("어느 벽·구역에 무엇을 둘지")를 받아 실제 좌표를 정한다.
// 가구를 우선순위 순서로 하나씩: 후보 자리를 만들고 → 방 안·겹침·문 앞 검사로 거르고 → 점수가 가장 높은 자리에 놓는다.
// 먼저 놓은 가구 때문에 요청한 자리를 못 얻은 가구가 있으면, 그 가구를 앞 순서로 올려 다시 풀어 보고 더 나은 쪽을 고른다.
// 브라우저·서버 어디서나 쓸 수 있는 순수 함수이고, 화면의 배치 검사(check.ts)와 같은 함수를 쓴다.
import { parseWallId, wallId } from '@/lib/ai/roomSummary';
import type { LayoutIntent } from '@/lib/ai/schemas';
import { openingSegment, type Opening } from '@/lib/rooms/openings';
import { halfExtentAlong, signedArea, type Footprint, type Point2 } from '@/lib/three/floorDrag';
import { doorZone, findUnreachable, TALL_FURNITURE_HEIGHT, windowZone } from './access';
import { accessBlocked, accessRule, frontDirection } from './accessSide';
import { checkLayout } from './check';
import { distanceToPolygon, footprintInsideRoom, footprintsOverlap, interiorPoint, pointInPolygon } from './geometry';

export type SolverItem = { id: string; name: string; category: string; w: number; d: number; h: number; clearance: number };
export type SolverRoom = { polygon: Point2[]; openings: Opening[] };
export type Placement = LayoutIntent['placements'][number];
/** 자리가 정해진 가구. reason은 Gemini가 적은 이유 */
export type SolvedItem = SolverItem & Footprint & { reason: string };
export type SolverNote = { itemId: string; message: string };

export type SolveResult = {
  /** 놓은 가구 (입력한 가구 순서) */
  placed: SolvedItem[];
  /** 놓지 못한 가구와 이유 */
  failures: SolverNote[];
  /** 놓았지만 지키지 못한 조건: 요청한 벽이 아님, 문에서 갈 수 없음, 창문을 가림, 쓰는 쪽이 막힘 */
  unmet: SolverNote[];
};

export type SolveOptions = {
  /**
   * 요청한 벽·구역에 자리가 없을 때 다른 곳에라도 놓을지 (기본 true).
   * false면 놓지 않고 failures에 이유를 남긴다 → 이유를 Gemini에 보내 다시 계획하게 할 때 쓴다.
   */
  fallback?: boolean;
};

/** 벽을 따라 후보를 만드는 간격 (m) */
const WALL_STEP = 0.05;
/** 방 가운데 후보의 격자 간격 (m) */
const CENTER_STEP = 0.1;
/** 통로가 막히는지 확인해 볼 후보 수 (점수가 높은 순서) */
const WALKWAY_TRIES = 12;
/** 이 거리 안이면 벽에 붙은 것으로 본다 (m) */
const TOUCH = 0.03;
/** 요청한 자리를 못 얻은 가구를 앞 순서로 올려 다시 풀어 보는 횟수 */
const MAX_REORDERS = 3;

type Frame = { index: number; a: Point2; u: Point2; n: Point2; length: number };
type Candidate = { pose: Footprint; wallIndex: number | null; headOnWall: boolean; bias: number };
type Size = Pick<SolverItem, 'w' | 'd'>;

/** 벽마다: 시작점, 벽 방향, 방 안쪽 방향 */
function wallFrames(polygon: Point2[]): Frame[] {
  const sign = signedArea(polygon) > 0 ? 1 : -1;
  return polygon.flatMap((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) return [];
    const u: Point2 = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    return [{ index, a, u, n: [-u[1] * sign, u[0] * sign] as Point2, length }];
  });
}

/** 가구의 앞이 front 방향을 보게 하는 회전 각도 (0~360°) */
function rotationFacing(front: Point2): number {
  const deg = Math.round(((Math.atan2(front[0], front[1]) * 180) / Math.PI) * 100) / 100;
  return ((deg % 360) + 360) % 360;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0;
const neg = (v: Point2): Point2 => [-v[0], -v[1]];
const dot = (a: Point2, b: Point2) => a[0] * b[0] + a[1] * b[1];

/**
 * 벽에 붙여 놓을 때 가구의 앞이 볼 방향들.
 * 기본은 벽을 등지고 방 안쪽을 본다. 침대는 머리를 벽에 대는 방향과 긴 변을 벽에 붙이는 방향을 모두 시도한다.
 * 앞뒤가 없는 가구(내 가구)는 90° 돌린 것도 시도한다.
 */
function frontsOnWall(item: SolverItem, frame: Frame): Point2[] {
  if (item.category === 'bed') return [frame.n, frame.u, neg(frame.u)];
  if (item.category !== 'chair' && accessRule(item) === null) return [frame.n, frame.u];
  return [frame.n];
}

/**
 * 한 벽에 붙인 자리들. 가구 중심의 벽 방향 위치 t를 [range] 안에서 5cm씩 옮긴다.
 * @param only 'ends'면 벽의 양 끝(모서리) 자리만
 */
function posesOnWall(size: Size, frame: Frame, front: Point2, options: { range?: [number, number]; only?: 'ends'; center?: number } = {}): Candidate[] {
  const rotationDeg = rotationFacing(front);
  const shape: Footprint = { x: 0, z: 0, w: size.w, d: size.d, rotationDeg };
  const halfAlong = halfExtentAlong(shape, frame.u);
  const halfDeep = halfExtentAlong(shape, frame.n);
  let lo = halfAlong;
  let hi = frame.length - halfAlong;
  if (hi < lo - 1e-6) return []; // 벽이 가구보다 짧다
  if (options.range) {
    const mid = (options.range[0] + options.range[1]) / 2;
    const from = Math.max(lo, options.range[0]);
    const to = Math.min(hi, options.range[1]);
    // 구간 안에 중심을 둘 수 없으면 구간 가운데에 가장 가까운 한 자리
    if (to < from) lo = hi = Math.min(hi, Math.max(lo, mid));
    else [lo, hi] = [from, to];
  }
  const ts: number[] = [];
  if (options.only === 'ends') {
    ts.push(lo, hi);
  } else {
    const steps = Math.floor((hi - lo) / WALL_STEP + 1e-9);
    for (let i = 0; i <= steps; i += 1) ts.push(lo + i * WALL_STEP);
    if (hi - ts[ts.length - 1] > 1e-6) ts.push(hi);
  }
  const headOnWall = dot(front, frame.n) > 0.99;
  return ts.map((t) => ({
    pose: {
      x: frame.a[0] + frame.u[0] * t + frame.n[0] * halfDeep,
      z: frame.a[1] + frame.u[1] * t + frame.n[1] * halfDeep,
      w: size.w,
      d: size.d,
      rotationDeg,
    },
    wallIndex: frame.index,
    headOnWall,
    bias: options.center === undefined ? 0 : -Math.abs(t - options.center),
  }));
}

/** 가구가 붙어 있는 벽의 수 (2 이상이면 모서리) */
function touchingWalls(pose: Footprint, frames: Frame[]): number {
  let count = 0;
  for (const frame of frames) {
    const rel: Point2 = [pose.x - frame.a[0], pose.z - frame.a[1]];
    const centerDistance = dot(rel, frame.n);
    if (centerDistance < 0) continue;
    if (Math.abs(centerDistance - halfExtentAlong(pose, frame.n)) > TOUCH) continue;
    const along = dot(rel, frame.u);
    const halfAlong = halfExtentAlong(pose, frame.u);
    if (along + halfAlong > 0.01 && along - halfAlong < frame.length - 0.01) count += 1;
  }
  return count;
}

function againstWalls(item: SolverItem, frames: Frame[]): Candidate[] {
  return frames.flatMap((frame) => frontsOnWall(item, frame).flatMap((front) => posesOnWall(item, frame, front)));
}

function corners(item: SolverItem, frames: Frame[], all: Frame[]): Candidate[] {
  return frames
    .flatMap((frame) => frontsOnWall(item, frame).flatMap((front) => posesOnWall(item, frame, front, { only: 'ends' })))
    .filter((c) => touchingWalls(c.pose, all) >= 2);
}

function underWindows(item: SolverItem, frames: Frame[], windows: Opening[]): Candidate[] {
  return windows.flatMap((w) => {
    const frame = frames.find((f) => f.index === w.wallIndex);
    return frame ? posesOnWall(item, frame, frame.n, { range: [w.from, w.to], center: (w.from + w.to) / 2 }) : [];
  });
}

/** 기준 가구의 양옆(같은 방향, 뒷면을 맞춤)과 앞(마주 보게: 책상 앞의 의자) */
function besideItem(item: SolverItem, ref: Footprint): Candidate[] {
  const front = frontDirection(ref.rotationDeg);
  const right: Point2 = [front[1], -front[0]];
  const back = (item.d - ref.d) / 2;
  const out: Candidate[] = [];
  for (const side of [-1, 1]) {
    const k = side * (ref.w / 2 + item.w / 2);
    out.push({
      pose: { x: ref.x + right[0] * k + front[0] * back, z: ref.z + right[1] * k + front[1] * back, w: item.w, d: item.d, rotationDeg: ref.rotationDeg },
      wallIndex: null,
      headOnWall: false,
      bias: 0,
    });
  }
  const k = ref.d / 2 + item.d / 2 + 0.05;
  out.push({
    pose: { x: ref.x + front[0] * k, z: ref.z + front[1] * k, w: item.w, d: item.d, rotationDeg: (ref.rotationDeg + 180) % 360 },
    wallIndex: null,
    headOnWall: false,
    // 의자는 책상·식탁 앞이 제자리, 다른 가구는 옆이 먼저
    bias: item.category === 'chair' ? 1 : -1,
  });
  return out;
}

/** 방 가운데 쪽: 10cm 격자의 방 안 점들. 방 한가운데에 가까울수록 점수가 높다 */
function centerPoses(item: SolverItem, polygon: Point2[]): Candidate[] {
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const middle = interiorPoint(polygon);
  const margin = Math.min(item.w, item.d) / 2 - 0.02;
  // 앞이 정해진 가구(책상·수납)는 네 방향, 앞뒤가 같은 가구는 두 방향만 다르다
  const rule = accessRule(item);
  const rotations = rule !== null && rule.sides.length === 1 ? [0, 90, 180, 270] : [0, 90];
  const out: Candidate[] = [];
  for (let x = minX; x <= maxX + 1e-9; x += CENTER_STEP) {
    for (let z = minZ; z <= maxZ + 1e-9; z += CENTER_STEP) {
      const p: Point2 = [x, z];
      if (!pointInPolygon(p, polygon) || distanceToPolygon(p, polygon) < margin) continue;
      const bias = -0.5 * Math.hypot(x - middle[0], z - middle[1]);
      for (const rotationDeg of rotations) out.push({ pose: { x, z, w: item.w, d: item.d, rotationDeg }, wallIndex: null, headOnWall: false, bias });
    }
  }
  return out;
}

const ZONE_LABEL: Record<Placement['zone'], string> = {
  against_wall: '벽',
  corner: '모서리',
  under_window: '창문 아래',
  beside_item: '옆자리',
  center: '방 가운데',
};

const DEFAULT_PLACEMENT = { zone: 'against_wall', wallId: '', nearItemId: '', facing: 'into_room', priority: 10, reason: '' } as const;

/**
 * 배치 의도를 좌표로 바꾼다.
 * 돌려준 placed는 서로 겹치지 않고, 방 안에 있고, 문 앞을 막지 않는다.
 * 통로·창문·쓰는 쪽은 되도록 지키고, 못 지킨 것은 unmet에 적는다.
 * 의도에 없는 가구 id는 무시하고, 의도에서 빠진 가구는 아무 벽에나 붙인다.
 */
export function solveLayout(room: SolverRoom, items: SolverItem[], placements: Placement[], options: SolveOptions = {}): SolveResult {
  const fallback = options.fallback ?? true;
  const { polygon, openings } = room;
  const frames = wallFrames(polygon);
  const doors = openings.filter((o) => o.type === 'door');
  const windows = openings.filter((o) => o.type === 'window');
  const doorZones = doors.map((door) => doorZone(door, polygon)).filter((zone) => zone !== null);
  const windowZones = windows.map((w) => windowZone(w, polygon)).filter((zone) => zone !== null);
  const windowCenters = windows.flatMap((w) => {
    const segment = openingSegment(w, polygon);
    return segment ? [[(segment[0][0] + segment[1][0]) / 2, (segment[0][1] + segment[1][1]) / 2] as Point2] : [];
  });
  const doorCenters = doors.flatMap((door) => {
    const segment = openingSegment(door, polygon);
    return segment ? [[(segment[0][0] + segment[1][0]) / 2, (segment[0][1] + segment[1][1]) / 2] as Point2] : [];
  });

  const byId = new Map(items.map((item) => [item.id, item]));
  const intentById = new Map<string, Placement>();
  for (const p of placements) {
    if (byId.has(p.itemId) && !intentById.has(p.itemId)) intentById.set(p.itemId, p);
  }
  const plan = items.map((item) => intentById.get(item.id) ?? { ...DEFAULT_PLACEMENT, itemId: item.id });
  const area = (id: string) => (byId.get(id)?.w ?? 0) * (byId.get(id)?.d ?? 0);
  const sorted = [...plan].sort((a, b) => a.priority - b.priority || area(b.itemId) - area(a.itemId));

  /** 놓는 순서: promoted의 가구를 맨 앞으로, 나머지는 우선순위 순서. "다른 가구 옆"은 기준 가구가 먼저 놓여야 한다 */
  const orderFor = (promoted: string[]): Placement[] => {
    const rank = new Map(promoted.map((id, index) => [id, index]));
    const list = [...sorted].sort((a, b) => (rank.get(a.itemId) ?? 1e9) - (rank.get(b.itemId) ?? 1e9));
    const order: Placement[] = [];
    const visit = (p: Placement, stack: Set<string>) => {
      if (order.includes(p) || stack.has(p.itemId)) return;
      stack.add(p.itemId);
      const ref = p.zone === 'beside_item' ? list.find((q) => q.itemId === p.nearItemId) : undefined;
      if (ref) visit(ref, stack);
      order.push(p);
    };
    for (const p of list) visit(p, new Set());
    return order;
  };

  let best = attempt(orderFor([]));
  let last = best;
  let promoted: string[] = [];
  for (let round = 0; round < MAX_REORDERS && last.missed.length > 0; round += 1) {
    const next = [...promoted, ...last.missed.filter((id) => !promoted.includes(id))];
    if (next.length === promoted.length) break;
    promoted = next;
    last = attempt(orderFor(promoted));
    if (last.cost < best.cost) best = last;
  }
  const position = new Map(items.map((item, index) => [item.id, index]));
  best.placed.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
  return { placed: best.placed, failures: best.failures, unmet: best.unmet };

  /** 주어진 순서로 한 번 풀어 본다. missed는 요청한 자리를 못 얻었거나 놓지 못한 가구, cost는 작을수록 좋다 */
  function attempt(order: Placement[]): SolveResult & { missed: string[]; cost: number } {
    const placed: SolvedItem[] = [];
    const failures: SolverNote[] = [];
    const notes: SolverNote[] = [];

    const whyInvalid = (pose: Footprint): { type: 'outside' | 'door' | 'overlap'; otherId?: string } | null => {
      if (!footprintInsideRoom(pose, polygon)) return { type: 'outside' };
      const other = placed.find((q) => footprintsOverlap(pose, q));
      if (other) return { type: 'overlap', otherId: other.id };
      if (doorZones.some((zone) => footprintsOverlap(pose, zone))) return { type: 'door' };
      return null;
    };

    for (const p of order) {
      const item = byId.get(p.itemId);
      if (!item) continue;
      const target = parseWallId(p.wallId, polygon.length);
      const targetFrames = target === null ? frames : frames.filter((f) => f.index === target);
      const ref = p.zone === 'beside_item' ? placed.find((q) => q.id === p.nearItemId) : undefined;

      // 후보를 단계별로: ① 요청한 벽·구역 ② 같은 구역, 다른 벽 ③ 아무 벽이나 방 가운데
      const zoneOn = (on: Frame[]): Candidate[] => {
        switch (p.zone) {
          case 'against_wall':
            return againstWalls(item, on);
          case 'corner':
            return corners(item, on, frames);
          case 'under_window':
            return underWindows(item, on, windows);
          case 'beside_item':
            return ref ? besideItem(item, ref) : [];
          case 'center':
            return centerPoses(item, polygon);
        }
      };
      const tiers: { kind: 'asked' | 'otherWall' | 'anywhere'; make: () => Candidate[] }[] = [{ kind: 'asked', make: () => zoneOn(targetFrames) }];
      if (fallback) {
        if (target !== null && p.zone !== 'beside_item' && p.zone !== 'center') tiers.push({ kind: 'otherWall', make: () => zoneOn(frames) });
        tiers.push({
          kind: 'anywhere',
          make: () => (p.zone === 'against_wall' ? centerPoses(item, polygon) : [...againstWalls(item, frames), ...centerPoses(item, polygon)]),
        });
      }

      let valid: Candidate[] = [];
      let tierUsed: (typeof tiers)[number]['kind'] = 'asked';
      let firstCandidates: Candidate[] = [];
      for (const tier of tiers) {
        const candidates = tier.make();
        if (tier.kind === 'asked') firstCandidates = candidates;
        valid = candidates.filter((c) => whyInvalid(c.pose) === null);
        tierUsed = tier.kind;
        if (valid.length > 0) break;
      }

      if (valid.length === 0) {
        /** 요청한 자리에 왜 못 놓았는지 (Gemini에 다시 물어볼 때 보낸다) */
        const whyNone = (): string => {
          const where = `${target !== null ? `${wallId(target)}의 ` : ''}${ZONE_LABEL[p.zone]}`;
          if (p.zone === 'beside_item' && !ref) return `기준 가구(${p.nearItemId || '없음'})가 놓이지 않아 옆에 둘 수 없음`;
          if (p.zone === 'under_window' && windows.every((w) => target !== null && w.wallIndex !== target)) return `${where}: 창문이 없음`;
          if (firstCandidates.length === 0) return `${where}에 놓을 수 없음 (가구가 들어갈 길이가 안 됨)`;
          const counts = new Map<string, number>();
          for (const c of firstCandidates) {
            const why = whyInvalid(c.pose);
            const key = why === null ? '' : why.type === 'overlap' ? `overlap:${why.otherId}` : why.type;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
          if (top.startsWith('overlap:')) return `${where}에 자리가 없음 (${byId.get(top.slice(8))?.name ?? '다른 가구'}와(과) 겹침)`;
          if (top === 'door') return `${where}에 자리가 없음 (문 앞을 막음)`;
          return `${where}에 자리가 없음 (방 밖으로 나감)`;
        };
        failures.push({ itemId: item.id, message: `${item.name}: ${whyNone()}` });
        continue;
      }

      // 점수: 쓰는 쪽이 비었는지, 다른 가구의 쓰는 쪽을 막는지, 창문을 가리는지, 침대 머리, 모서리, 보는 방향, 기준 가구와의 거리
      const blockedBefore = new Set(placed.filter((q) => accessBlocked(q, placed, polygon)).map((q) => q.id));
      const hasRule = accessRule(item) !== null;
      const score = (c: Candidate): number => {
        const self = { ...item, ...c.pose };
        const all = [...placed, self];
        let s = c.bias;
        if (hasRule) s += accessBlocked(self, all, polygon) ? -2 : 2;
        for (const q of placed) {
          if (!blockedBefore.has(q.id) && accessBlocked(q, all, polygon)) s -= 2;
        }
        if (item.h > TALL_FURNITURE_HEIGHT && windowZones.some((zone) => footprintsOverlap(c.pose, zone))) s -= 3;
        if (item.category === 'bed' && c.headOnWall) s += 1;
        if (item.category !== 'chair' && item.category !== 'table' && touchingWalls(c.pose, frames) >= 2) s += 0.5;
        const front = frontDirection(c.pose.rotationDeg);
        const here: Point2 = [c.pose.x, c.pose.z];
        if (p.facing === 'toward_window' && windowCenters.length > 0) {
          const nearest = windowCenters.reduce((best, w) => (Math.hypot(w[0] - here[0], w[1] - here[1]) < Math.hypot(best[0] - here[0], best[1] - here[1]) ? w : best));
          const length = Math.hypot(nearest[0] - here[0], nearest[1] - here[1]) || 1;
          s += dot(front, [(nearest[0] - here[0]) / length, (nearest[1] - here[1]) / length]);
        }
        if (ref) s -= Math.hypot(ref.x - here[0], ref.z - here[1]);
        // 문에서 조금 떨어진 자리를 살짝 선호한다 (드나드는 곳을 넓게)
        if (doorCenters.length > 0) s += 0.1 * Math.min(2, Math.min(...doorCenters.map((dc) => Math.hypot(dc[0] - here[0], dc[1] - here[1]))));
        return s;
      };
      const ranked = valid.map((c, index) => ({ c, index, s: score(c) })).sort((a, b) => b.s - a.s || a.index - b.index);

      // 통로: 점수가 높은 후보부터, 이미 놓은 가구나 이 가구로 가는 길을 새로 막지 않는 첫 자리
      let chosen = ranked[0].c;
      if (doors.length > 0) {
        const before = new Set(findUnreachable(placed, polygon, doors) ?? []);
        for (const { c } of ranked.slice(0, WALKWAY_TRIES)) {
          const after = findUnreachable([...placed, { ...c.pose, id: item.id }], polygon, doors);
          if (after === null || after.every((id) => before.has(id))) {
            chosen = c;
            break;
          }
        }
      }

      if (tierUsed !== 'asked') {
        const where = chosen.wallIndex !== null ? `${wallId(chosen.wallIndex)} 벽` : '다른 곳';
        const wanted = tierUsed === 'otherWall' && target !== null ? `${wallId(target)}의 ${ZONE_LABEL[p.zone]}` : `요청한 자리(${ZONE_LABEL[p.zone]})`;
        notes.push({ itemId: item.id, message: `${item.name}: ${wanted}에 자리가 없어 ${where}에 놓았습니다` });
      }
      placed.push({
        ...item,
        x: round3(chosen.pose.x),
        z: round3(chosen.pose.z),
        w: item.w,
        d: item.d,
        rotationDeg: chosen.pose.rotationDeg,
        reason: p.reason,
      });
    }

    // 놓은 결과를 화면과 같은 검사로 확인해, 지키지 못한 조건을 모은다
    const violations = checkLayout(placed, polygon, openings);
    const unmet = [...notes, ...violations.map((v) => ({ itemId: v.itemId, message: v.message }))];
    const missed = [...failures.map((f) => f.itemId), ...notes.map((n) => n.itemId)];
    return { placed, failures, unmet, missed, cost: failures.length * 100 + notes.length * 10 + violations.length };
  }
}
