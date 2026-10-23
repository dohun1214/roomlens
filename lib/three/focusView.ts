// 가구로 시점 옮기기: 놓인 가구를 비스듬히 내려다보는 카메라 자리를 고르고, 그 자리로 부드럽게 날아간다.
// 자리 계산(furnitureViewpoint)은 순수 함수, 날아가기(flyTo)는 브라우저 전용.
import { distanceToPolygon } from '@/lib/layout/geometry';
import { pointInPolygon, type Point2 } from '@/lib/three/floorDrag';

/** 카메라가 벽에서 떨어져 있어야 하는 거리 (m) */
const VIEW_WALL_MARGIN = 0.3;
/** 가구에서 물러날 거리의 범위 (m) */
const MIN_BACK = 1.4;
const MAX_BACK = 3.2;

export type FocusBox = { x: number; z: number; w: number; d: number; h: number };
export type Viewpoint = { position: [number, number, number]; target: [number, number, number] };

/** 가구 크기에 맞는 물러날 거리: 작은 의자는 1.4 m, 큰 침대·옷장은 멀리 */
export function focusDistance(box: FocusBox): number {
  return Math.min(MAX_BACK, Math.max(MIN_BACK, 0.9 + Math.max(box.w, box.d) * 0.85 + box.h * 0.3));
}

/**
 * 가구를 보는 카메라 자리. 지금 카메라가 있는 쪽을 먼저 보고(시점이 덜 바뀌게), 안 되면 방 가운데 쪽, 그다음 여러 방향을 본다.
 * 카메라 자리와 가구 사이가 방 안(벽을 넘지 않음)이고 벽에서 30cm 넘게 떨어져야 한다. 가까워도 되면 거리를 줄여 본다.
 * @param eye 지금 카메라의 [x, z] (없으면 방 가운데 쪽부터)
 */
export function furnitureViewpoint(box: FocusBox, polygon: Point2[], eye?: Point2 | null): Viewpoint {
  const target: [number, number, number] = [box.x, Math.max(0.3, box.h * 0.5), box.z];
  const center: Point2 = [box.x, box.z];
  const reach = Math.max(box.w, box.d) / 2;
  const back = focusDistance(box);
  const unit = (v: Point2): Point2 | null => {
    const len = Math.hypot(v[0], v[1]);
    return len > 1e-6 ? [v[0] / len, v[1] / len] : null;
  };
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const middle: Point2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  const directions: Point2[] = [];
  const push = (d: Point2 | null) => d && directions.push(d);
  if (eye) push(unit([eye[0] - center[0], eye[1] - center[1]]));
  push(unit([middle[0] - center[0], middle[1] - center[1]]));
  for (let k = 0; k < 16; k += 1) push([Math.cos((k * Math.PI) / 8), Math.sin((k * Math.PI) / 8)]);

  const clear = (p: Point2) => pointInPolygon(p, polygon) && distanceToPolygon(p, polygon) >= VIEW_WALL_MARGIN;
  /** 가구 가장자리에서 카메라까지 벽을 넘지 않는지 (점을 찍어 본다) */
  const visible = (dir: Point2, distance: number) => {
    for (let t = reach; t <= distance; t += 0.1) {
      if (!pointInPolygon([center[0] + dir[0] * t, center[1] + dir[1] * t], polygon)) return false;
    }
    return true;
  };
  for (const scale of [1, 0.8, 0.6]) {
    const distance = Math.max(reach + 0.5, back * scale);
    for (const dir of directions) {
      const p: Point2 = [center[0] + dir[0] * distance, center[1] + dir[1] * distance];
      if (clear(p) && visible(dir, distance)) return { position: [p[0], eyeHeight(box, distance), p[1]], target };
    }
  }
  // 좁은 방: 가구 바로 위에서 내려다본다
  const fallback = unit([middle[0] - center[0], middle[1] - center[1]]) ?? [0, 1];
  return { position: [center[0] + fallback[0] * (reach + 0.3), Math.max(2, box.h + 1.2), center[1] + fallback[1] * (reach + 0.3)], target };
}

/** 내려다보는 높이: 가구 위로 0.8 m 이상, 멀수록 조금 더 높게 (2.4 m까지) */
function eyeHeight(box: FocusBox, distance: number): number {
  return Math.min(2.4, Math.max(1.5, box.h + 0.8, 0.9 + distance * 0.35));
}

/** 두 점 사이를 부드럽게 (처음과 끝이 느리게) */
export function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
}

type FlyEngine = {
  camera: { position: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => unknown } };
  controls: { target: { x: number; y: number; z: number; set: (x: number, y: number, z: number) => unknown }; update: () => unknown };
};
const flights = new WeakMap<object, number>();

/**
 * 카메라를 view로 옮긴다. 보는 점도 함께 옮겨, 가는 동안 가구 쪽으로 고개가 돌아간다.
 * 움직임을 줄이도록 설정한 사용자(prefers-reduced-motion)에게는 바로 옮긴다. 다시 부르면 앞의 비행은 멈춘다.
 * 끝나면 resolve.
 */
export function flyTo(engine: FlyEngine, view: Viewpoint, ms = 450): Promise<void> {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const from = [engine.camera.position.x, engine.camera.position.y, engine.camera.position.z];
  const fromTarget = [engine.controls.target.x, engine.controls.target.y, engine.controls.target.z];
  const token = (flights.get(engine) ?? 0) + 1;
  flights.set(engine, token);
  const apply = (t: number) => {
    const k = easeInOut(t);
    const mix = (a: number[], b: number[]) => a.map((v, i) => v + (b[i] - v) * k) as [number, number, number];
    engine.camera.position.set(...mix(from, view.position));
    engine.controls.target.set(...mix(fromTarget, view.target));
    engine.controls.update();
  };
  if (reduce || ms <= 0) {
    apply(1);
    return Promise.resolve();
  }
  const start = performance.now();
  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (flights.get(engine) !== token) return resolve();
      const t = (now - start) / ms;
      apply(t);
      if (t < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
