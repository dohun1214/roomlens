import { z } from 'zod';
import type { RoomTransform } from '@/lib/three/roomTransform';

// 방에 저장하는 보정 값.
//   rooms.transform     = { s, q, t, flipX }  (크기·회전·이동 + 스플랫을 X축으로 뒤집었는지)
//   rooms.floor_polygon = [[x, z], ...]       (보정 후 방 좌표의 바닥 평면도, m)
// 브라우저에서 방 주인 권한으로 바로 저장하므로, 읽을 때 반드시 검증한다.

const finite = z.number().refine(Number.isFinite, '유한한 숫자여야 합니다.');

export const SavedTransformSchema = z.object({
  s: finite.refine((v) => v > 0, '크기는 0보다 커야 합니다.'),
  q: z.tuple([finite, finite, finite, finite]),
  t: z.tuple([finite, finite, finite]),
  /** 보정할 때 뷰어의 "X축 180°"가 켜져 있었는지. 보정 값은 그 상태 기준이라 함께 저장한다 */
  flipX: z.boolean().default(false),
});

export const FloorPolygonSchema = z.array(z.tuple([finite, finite])).min(3).max(64);

export type SavedCalibration = {
  transform: RoomTransform;
  flipX: boolean;
  floorPolygon: [number, number][];
};

/** DB에서 읽은 값을 검증한다. 보정하지 않았거나 형식이 맞지 않으면 null */
export function parseSavedCalibration(transform: unknown, floorPolygon: unknown): SavedCalibration | null {
  const t = SavedTransformSchema.safeParse(transform);
  const p = FloorPolygonSchema.safeParse(floorPolygon);
  if (!t.success || !p.success) return null;
  // 회전이 0벡터면 쓸 수 없다
  if (Math.hypot(...t.data.q) < 1e-6) return null;
  return { transform: { s: t.data.s, q: t.data.q, t: t.data.t }, flipX: t.data.flipX, floorPolygon: p.data };
}

/** DB에 넣을 모양으로 바꾼다 */
export function toCalibrationColumns(calibration: SavedCalibration) {
  return {
    transform: { ...calibration.transform, flipX: calibration.flipX },
    floor_polygon: calibration.floorPolygon,
  };
}

/**
 * 보정된 방을 열 때의 카메라: 방 안에서 방 가운데를 바라본다.
 * 긴 쪽으로 조금 물러난 눈높이에서 시작한다 (방 좌표: 바닥 y=0, 단위 m).
 */
export function startPoseForRoom(floorPolygon: [number, number][]): {
  position: [number, number, number];
  target: [number, number, number];
} {
  const xs = floorPolygon.map(([x]) => x);
  const zs = floorPolygon.map(([, z]) => z);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const alongX = maxX - minX >= maxZ - minZ;
  const back = (alongX ? maxX - minX : maxZ - minZ) * 0.3;
  return {
    position: [alongX ? cx + back : cx, 1.5, alongX ? cz : cz + back],
    target: [cx, 1.1, cz],
  };
}
