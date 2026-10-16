// 브라우저에서: 벽마다 정면 그림을 찍어 문·창문 후보를 받아 온다 (lib/ai/wallViews.ts).
import type { SplatMesh } from '@sparkjsdev/spark';
import { MAX_TOTAL_BASE64, totalBase64 } from '@/lib/ai/analysis';
import { parseOpenings, type Opening } from '@/lib/rooms/openings';
import type { CaptureEngine } from '@/lib/three/capture';
import { measureCeiling } from '@/lib/three/ceilingHeight';
import type { Point2 } from '@/lib/three/floorDrag';
import { captureFixedViews } from '@/lib/three/topView';
import { WALL_VIEW_BEHIND, WALL_VIEW_DISTANCE, WALL_VIEW_FRONT, WALL_VIEW_PX, wallViewPlan } from './wallViews';

export type DetectOutcome = { ok: true; candidates: Opening[]; remaining: number | null; callId: string | null } | { ok: false; code: string; message: string };

const FALLBACK = '문·창문을 찾지 못했습니다. 잠시 뒤에 다시 해 주세요.';
/** 천장을 재지 못했을 때 */
const DEFAULT_CEILING = 2.5;

/**
 * @param polygon 저장된 보정의 평면도 (지금 화면에 적용된 것과 같아야 한다)
 * @param onProgress 캡처가 한 장 끝날 때마다, 그리고 보낼 때(done === total)
 */
export async function requestOpeningsDetection(
  engine: CaptureEngine & { splat: SplatMesh | null },
  roomId: string,
  polygon: Point2[],
  onProgress?: (done: number, total: number) => void,
): Promise<DetectOutcome> {
  // 천장 높이는 서버가 같은 자리를 다시 계산할 수 있게 함께 보낸다 (cm 단위로 맞춘다)
  const ceiling = Math.round((engine.splat ? (measureCeiling(engine.splat, polygon) ?? DEFAULT_CEILING) : DEFAULT_CEILING) * 100) / 100;
  const plan = wallViewPlan(polygon, ceiling);
  if (plan.length === 0) return { ok: false, code: 'NO_WALLS', message: '찍을 벽이 없습니다. 보정을 확인해 주세요.' };
  let images: string[];
  try {
    images = await captureFixedViews(
      engine,
      plan.map((view) => ({
        position: view.position,
        target: view.target,
        up: [0, 1, 0],
        fovDeg: (2 * Math.atan(view.size / 2 / WALL_VIEW_DISTANCE) * 180) / Math.PI,
        near: WALL_VIEW_DISTANCE - WALL_VIEW_FRONT,
        far: WALL_VIEW_DISTANCE + WALL_VIEW_BEHIND,
      })),
      { px: WALL_VIEW_PX, settleMs: 1200, onProgress },
    );
  } catch {
    return { ok: false, code: 'CAPTURE', message: '화면을 캡처하지 못했습니다. 다시 해 주세요.' };
  }
  if (totalBase64(images.map((data) => ({ data }))) > MAX_TOTAL_BASE64) return { ok: false, code: 'TOO_LARGE', message: '캡처한 그림이 너무 큽니다. 다시 해 주세요.' };

  let res: Response;
  try {
    res = await fetch(`/api/rooms/${roomId}/openings-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'walls', images: images.map((data) => ({ data })), ceiling }),
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  }
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string }; candidates?: unknown; remaining?: unknown; callId?: unknown } | null;
  if (!res.ok) return { ok: false, code: json?.error?.code ?? 'UNKNOWN', message: json?.error?.message ?? FALLBACK };
  // 서버가 준 값도 벽 범위·겹침을 다시 확인한다
  return {
    ok: true,
    candidates: parseOpenings(json?.candidates, polygon),
    remaining: typeof json?.remaining === 'number' ? json.remaining : null,
    callId: typeof json?.callId === 'string' ? json.callId : null,
  };
}
