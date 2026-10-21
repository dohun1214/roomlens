// 가구 자유 회전: 각도는 0~359 정수(도). 90°의 배수 가까이에서는 그 각도로 붙는다.

/** 이 각도(도) 안으로 90°의 배수에 가까우면 그 배수로 맞춘다 */
export const RIGHT_ANGLE_SNAP = 4;
/** 버튼·키로 한 번 돌리는 각도 */
export const ROTATE_STEP = 15;

export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  return ((Math.round(deg) % 360) + 360) % 360;
}

/**
 * 끌어서 돌린 각도를 정리한다.
 * @param step 주면 그 단위로 맞춘다 (Shift를 누르고 돌릴 때 15°)
 */
export function snapRotation(deg: number, step?: number): number {
  if (step && step > 0) return normalizeRotation(Math.round(deg / step) * step);
  const right = Math.round(deg / 90) * 90;
  return normalizeRotation(Math.abs(deg - right) <= RIGHT_ANGLE_SNAP ? right : deg);
}

/**
 * 가구 중심에서 (vx, vz) 방향을 가구의 뒤쪽이 바라보게 하는 회전 (방 좌표: 회전 r의 뒤쪽은 [-sin r, -cos r]).
 * 평면도의 회전 손잡이가 가구 뒤쪽에 있으므로 손잡이를 잡아 끈 방향이 곧 뒤쪽이 된다.
 */
export function rotationTowards(vx: number, vz: number): number {
  return (Math.atan2(-vx, -vz) * 180) / Math.PI;
}

/** 각도 차이 a - b 를 -180~180으로 */
export function angleDelta(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/** 입력 칸의 글을 각도로 (숫자가 아니면 null) */
export function parseRotationInput(text: string): number | null {
  const value = Number(text.replace(/[°\s]/g, ''));
  return text.trim() !== '' && Number.isFinite(value) ? normalizeRotation(value) : null;
}
