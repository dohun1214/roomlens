// 방 안에서 둘러보는 조작의 계산.
//   끌기        = 제자리에서 고개 돌리기 (OrbitControls의 바라보는 점을 카메라 바로 앞에 둔다)
//   휠·벌리기    = 보는 쪽으로 다가가기/물러나기
//   오른쪽 끌기·Shift+끌기·두 손가락 끌기 = 옆·위아래로 옮기기 (잡아 끄는 방향으로 화면이 따라온다)
// 빠르기(speed)는 키보드로 걸을 때의 1초 거리(보정된 방 1.6 m)를 그대로 써서 모든 조작의 감이 같게 한다.
import type { Vec3 } from './keyboardMove';

/** 바라보는 점을 카메라 앞 이 거리에 둔다. 작을수록 제자리에서 도는 것에 가깝다 */
export const LOOK_DISTANCE = 0.1;
/** 끌어서 돌리는 빠르기 (OrbitControls.rotateSpeed). 음수 = 잡아 끄는 쪽으로 화면이 따라온다 */
export const LOOK_ROTATE_SPEED = -0.3;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const length = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/**
 * 바라보는 점을 카메라 바로 앞(같은 방향, LOOK_DISTANCE)으로 당긴 자리.
 * 이미 그 거리이거나 방향을 알 수 없으면 null.
 */
export function lookTarget(position: Vec3, target: Vec3, distance = LOOK_DISTANCE): Vec3 | null {
  const d = sub(target, position);
  const len = length(d);
  if (!(len > 1e-9) || Math.abs(len - distance) < 1e-6) return null;
  const k = distance / len;
  return [position[0] + d[0] * k, position[1] + d[1] * k, position[2] + d[2] * k];
}

/** 휠 한 번에 다가갈 거리 (+ = 앞으로). 휠을 아래로 굴리면(deltaY > 0) 물러난다 */
export function wheelDistance(deltaY: number, deltaMode: number, speed: number): number {
  if (!Number.isFinite(deltaY) || !(speed > 0)) return 0;
  // deltaMode 1 = 줄, 2 = 쪽 단위. 픽셀로 바꾼다
  const px = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  // 휠 한 칸(100px)에 0.3 m (보정된 방). 한 번에 너무 멀리 가지 않게 자른다
  const meters = (-px * speed * 0.3) / (100 * 1.6);
  const limit = speed * 0.6;
  return Math.max(-limit, Math.min(limit, meters)) + 0;
}

/**
 * 끈 만큼 옆·위아래로 옮길 거리. 잡아 끄는 방향으로 화면이 따라오므로 카메라는 반대로 간다.
 * @param right 카메라의 오른쪽 방향 (단위 벡터)
 */
export function panDelta(dx: number, dy: number, right: Vec3, speed: number): Vec3 {
  const k = speed * 0.003; // 보정된 방에서 1px에 약 4.8mm
  const sideways = -dx * k;
  const upward = dy * k;
  return [right[0] * sideways + 0, upward + 0, right[2] * sideways + 0];
}

/** 두 손가락 사이가 벌어진 만큼 앞으로 (오므리면 뒤로) */
export function pinchDistance(previous: number, next: number, speed: number): number {
  if (!(previous > 0) || !(next > 0)) return 0;
  return (next - previous) * speed * 0.006 + 0;
}
