// 방 분석(그림 → 리포트)에서 화면과 서버가 함께 쓰는 규칙과 계산. 네트워크·DB를 건드리지 않는다.
import { z } from 'zod';
import { distanceToPolygon, interiorPoint, pointInPolygon } from '@/lib/layout/geometry';
import type { Point2 } from '@/lib/three/floorDrag';
import { RoomReport } from './schemas';

/** 한 번에 보낼 수 있는 그림 수 (3D 화면 캡처 + 사진) */
export const MAX_ANALYSIS_IMAGES = 10;
/** 그림 한 장의 base64 길이 한도 (약 520KB) */
export const MAX_IMAGE_BASE64 = 700_000;
/** 요청 전체의 base64 길이 한도. Vercel 함수는 요청 본문이 4.5MB까지다 */
export const MAX_TOTAL_BASE64 = 3_800_000;
/** 캡처·사진을 줄일 때 긴 변의 크기 (px) */
export const CAPTURE_LONG_SIDE = 1024;
export const PHOTO_LONG_SIDE = 1280;

export const AnalyzeInput = z.object({
  images: z
    .array(
      z.object({
        /** JPEG의 base64 (data: 머리말 없이) */
        data: z.string().min(100, '그림이 비어 있습니다.').max(MAX_IMAGE_BASE64, '그림이 너무 큽니다.'),
        /** capture = 3D 화면을 캡처한 그림, photo = 사용자가 넣은 사진 */
        source: z.enum(['capture', 'photo']),
      }),
    )
    .min(1, '분석할 그림이 없습니다.')
    .max(MAX_ANALYSIS_IMAGES, `그림은 ${MAX_ANALYSIS_IMAGES}장까지 보낼 수 있습니다.`),
});
export type AnalyzeInput = z.infer<typeof AnalyzeInput>;

/** base64가 JPEG로 시작하는지 (FF D8 FF → "/9j/") 그리고 base64 글자로만 되어 있는지 */
export function isJpegBase64(data: string): boolean {
  return data.startsWith('/9j/') && /^[A-Za-z0-9+/]+={0,2}$/.test(data);
}

export function totalBase64(images: { data: string }[]): number {
  return images.reduce((sum, image) => sum + image.data.length, 0);
}

const clip = (text: string, max: number) => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/**
 * Gemini가 준 리포트를 저장하기 전에 다듬는다: 글 길이를 자르고, 같은 옵션이 두 번 나오면 처음 것만,
 * 문제(issues)는 10개까지, 그림 번호는 보낸 그림 수 안으로.
 */
export function tidyReport(report: RoomReport, imageCount: number): RoomReport {
  const seen = new Set<string>();
  return {
    options: report.options
      .filter((o) => (seen.has(o.name) ? false : (seen.add(o.name), true)))
      .map((o) => ({ ...o, evidence: clip(o.evidence, 200) })),
    storage: { level: report.storage.level, notes: clip(report.storage.notes, 300) },
    naturalLight: { level: report.naturalLight.level, notes: clip(report.naturalLight.notes, 300) },
    issues: report.issues.slice(0, 10).map((issue) => ({
      ...issue,
      photoIndex: Math.min(Math.max(1, Math.round(issue.photoIndex)), Math.max(1, imageCount)),
      description: clip(issue.description, 300),
    })),
    summary: clip(report.summary, 500),
  };
}

/** DB에서 읽은 리포트를 검증한다. 모양이 다르면 null */
export function parseReport(raw: unknown): RoomReport | null {
  const parsed = RoomReport.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export const OPTION_STATUS_LABEL: Record<RoomReport['options'][number]['status'], string> = { present: '있음', absent: '없음', unknown: '확인 안 됨' };
export const STORAGE_LABEL: Record<RoomReport['storage']['level'], string> = { low: '적음', medium: '보통', high: '많음', unknown: '알 수 없음' };
export const LIGHT_LABEL: Record<RoomReport['naturalLight']['level'], string> = { low: '어두움', medium: '보통', high: '밝음', unknown: '알 수 없음' };
export const CONFIDENCE_LABEL: Record<RoomReport['issues'][number]['confidence'], string> = { low: '낮음', medium: '보통', high: '높음' };

export type CaptureView = { position: [number, number, number]; target: [number, number, number] };

/** 캡처할 때의 눈높이와, 바닥이 조금 보이게 내려다보는 정도 (m) */
const EYE_HEIGHT = 1.5;
const LOOK_DOWN = 0.15;
/** 두 번째 자리를 쓰는 기준: 첫 자리에서 이만큼 떨어진 방 안의 점이 있을 때 */
const SECOND_SPOT_DISTANCE = 3;
/** 서는 자리는 벽에서 이만큼 떨어진다 */
const WALL_MARGIN = 0.6;

function viewsFrom(spot: Point2, anglesDeg: number[]): CaptureView[] {
  return anglesDeg.map((deg) => {
    const r = (deg * Math.PI) / 180;
    return {
      position: [spot[0], EYE_HEIGHT, spot[1]],
      target: [spot[0] + Math.cos(r), EYE_HEIGHT - LOOK_DOWN, spot[1] + Math.sin(r)],
    };
  });
}

/**
 * 방을 빠짐없이 보도록 캡처할 자리와 방향을 정한다 (보정된 방 좌표, m).
 * 방 안쪽 한 자리에서 60° 간격으로 여섯 방향. 방이 길거나 여러 구역이면(집 전체 등)
 * 첫 자리에서 가장 먼 자리를 하나 더 잡아 두 자리에서 대각선 네 방향씩 본다.
 */
export function capturePlan(polygon: Point2[]): CaptureView[] {
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  const [minX, maxX, minZ, maxZ] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  // 설 수 있는 자리: 방 안이고 벽에서 떨어진 격자점
  const spots: { p: Point2; wall: number }[] = [];
  for (let x = minX; x <= maxX; x += 0.25) {
    for (let z = minZ; z <= maxZ; z += 0.25) {
      const p: Point2 = [x, z];
      if (!pointInPolygon(p, polygon)) continue;
      const wall = distanceToPolygon(p, polygon);
      if (wall >= WALL_MARGIN) spots.push({ p, wall });
    }
  }
  // 첫 자리는 방 가운데. 그곳이 벽에 너무 가까우면(오목한 방) 벽에서 가장 먼 자리
  let first = interiorPoint(polygon);
  if (!pointInPolygon(first, polygon) || distanceToPolygon(first, polygon) < WALL_MARGIN) {
    first = spots.reduce((best, s) => (s.wall > best.wall ? s : best), { p: first, wall: -1 }).p;
  }
  let second: Point2 | null = null;
  let far = SECOND_SPOT_DISTANCE;
  for (const { p } of spots) {
    const d = Math.hypot(p[0] - first[0], p[1] - first[1]);
    if (d > far) {
      far = d;
      second = p;
    }
  }
  if (!second) return viewsFrom(first, [0, 60, 120, 180, 240, 300]);
  return [...viewsFrom(first, [45, 135, 225, 315]), ...viewsFrom(second, [45, 135, 225, 315])];
}

/** 보정하지 않은 방: 지금 서 있는 자리에서 수평으로 여섯 방향 */
export function capturePlanAround(position: [number, number, number]): CaptureView[] {
  return [0, 60, 120, 180, 240, 300].map((deg) => {
    const r = (deg * Math.PI) / 180;
    return { position, target: [position[0] + Math.cos(r), position[1], position[2] + Math.sin(r)] };
  });
}
