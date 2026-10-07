// 키보드로 방 안을 걸어 다니기: W A S D(또는 방향키)로 앞뒤·좌우, Q E로 아래·위, Shift로 빠르게.
// 카메라와 바라보는 점을 같은 만큼 옮기므로, 마우스로 돌리는 조작은 그대로 쓸 수 있다.

export type Vec3 = [number, number, number];

/** 한글 입력 상태에서도 같은 자리의 키로 움직이도록 글자가 아니라 키 자리(event.code)로 본다 */
const KEY_AXES: Record<string, Vec3> = {
  // [오른쪽, 위, 앞]
  KeyW: [0, 0, 1],
  ArrowUp: [0, 0, 1],
  KeyS: [0, 0, -1],
  ArrowDown: [0, 0, -1],
  KeyD: [1, 0, 0],
  ArrowRight: [1, 0, 0],
  KeyA: [-1, 0, 0],
  ArrowLeft: [-1, 0, 0],
  KeyE: [0, 1, 0],
  KeyQ: [0, -1, 0],
};
const FAST_KEYS = ['ShiftLeft', 'ShiftRight'];

/** 걷는 속도 (보정된 방, m/초) */
export const WALK_SPEED = 1.6;
/** Shift를 누르면 이만큼 빠르게 */
export const FAST_FACTOR = 2.5;
/** 화면이 잠깐 멈췄다 돌아와도 한 번에 멀리 튀지 않게 한 프레임의 시간을 자른다 (초) */
export const MAX_STEP_SECONDS = 0.1;

export function isMoveKey(code: string): boolean {
  return code in KEY_AXES;
}

/** 지금 눌린 키들로 정한 방향 [오른쪽, 위, 앞]. 반대 키를 같이 누르면 0. 대각선도 같은 빠르기 */
export function moveAxes(pressed: Iterable<string>): Vec3 {
  const axes: Vec3 = [0, 0, 0];
  for (const code of new Set(pressed)) {
    const a = KEY_AXES[code];
    if (!a) continue;
    axes[0] += a[0];
    axes[1] += a[1];
    axes[2] += a[2];
  }
  const sign = axes.map((v) => Math.sign(v)) as Vec3;
  const length = Math.hypot(...sign);
  return length === 0 ? [0, 0, 0] : (sign.map((v) => v / length + 0) as Vec3);
}

export function isFast(pressed: Iterable<string>): boolean {
  for (const code of pressed) if (FAST_KEYS.includes(code)) return true;
  return false;
}

/**
 * 바닥과 나란한 "앞"과 "오른쪽" 방향 (y = 0).
 * 거의 똑바로 내려다보거나 올려다볼 때는 보는 방향이 바닥에 남기는 길이가 없으므로
 * 화면의 위쪽(카메라의 위 방향)을 앞으로 삼는다.
 */
export function groundBasis(viewDir: Vec3, cameraUp: Vec3): { forward: Vec3; right: Vec3 } {
  let [x, z] = [viewDir[0], viewDir[2]];
  if (Math.hypot(x, z) < 0.05) [x, z] = [cameraUp[0], cameraUp[2]];
  const length = Math.hypot(x, z);
  if (length < 1e-6) return { forward: [0, 0, -1], right: [1, 0, 0] };
  const forward: Vec3 = [x / length, 0, z / length];
  // 위(0, 1, 0)를 기준으로 앞에서 오른쪽으로 90°
  return { forward, right: [-forward[2] + 0, 0, forward[0]] };
}

/**
 * 이번 프레임에 옮길 거리.
 * @param pressed 눌린 키 (event.code)
 * @param viewDir 카메라가 보는 방향
 * @param cameraUp 카메라의 위 방향
 * @param seconds 지난 프레임부터 흐른 시간
 * @param speed 1초에 가는 거리
 */
export function moveStep(pressed: Iterable<string>, viewDir: Vec3, cameraUp: Vec3, seconds: number, speed: number): Vec3 | null {
  const keys = [...pressed];
  const [r, u, f] = moveAxes(keys);
  if (r === 0 && u === 0 && f === 0) return null;
  if (!(seconds > 0) || !(speed > 0)) return null;
  const { forward, right } = groundBasis(viewDir, cameraUp);
  const distance = speed * (isFast(keys) ? FAST_FACTOR : 1) * Math.min(seconds, MAX_STEP_SECONDS);
  return [(right[0] * r + forward[0] * f) * distance + 0, u * distance + 0, (right[2] * r + forward[2] * f) * distance + 0];
}

/** 글자를 넣는 곳에 초점이 있으면 키로 움직이지 않는다 */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes((target.tagName ?? '').toUpperCase());
}
