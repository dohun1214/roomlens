// 브라우저에서: 방 안을 여러 방향으로 캡처해 문·창문 후보를 받아 온다.
import { MAX_TOTAL_BASE64, totalBase64 } from '@/lib/ai/analysis';
import { parseOpenings, type Opening } from '@/lib/rooms/openings';
import { captureViews, type CaptureEngine } from '@/lib/three/capture';
import type { Point2 } from '@/lib/three/floorDrag';
import { DETECT_LONG_SIDE, detectionPlan } from './openingsDetect';

export type DetectOutcome = { ok: true; candidates: Opening[]; remaining: number | null } | { ok: false; code: string; message: string };

const FALLBACK = '문·창문을 찾지 못했습니다. 잠시 뒤에 다시 해 주세요.';

/**
 * @param polygon 저장된 보정의 평면도 (지금 화면에 적용된 것과 같아야 한다)
 * @param onProgress 캡처가 한 장 끝날 때마다, 그리고 보낼 때(done === total)
 */
export async function requestOpeningsDetection(
  engine: CaptureEngine,
  roomId: string,
  polygon: Point2[],
  onProgress?: (done: number, total: number) => void,
): Promise<DetectOutcome> {
  const views = detectionPlan(polygon);
  let images: string[];
  try {
    // 문틀·창틀의 가장자리가 또렷해야 위치가 맞으므로, 방 분석보다 크게 찍고 스플랫이 다 그려질 때까지 넉넉히 기다린다
    images = await captureViews(engine, views, { longSide: DETECT_LONG_SIDE, settleMs: 1200, onProgress });
  } catch {
    return { ok: false, code: 'CAPTURE', message: '화면을 캡처하지 못했습니다. 다시 해 주세요.' };
  }
  if (totalBase64(images.map((data) => ({ data }))) > MAX_TOTAL_BASE64) return { ok: false, code: 'TOO_LARGE', message: '캡처한 그림이 너무 큽니다. 창을 줄이고 다시 해 주세요.' };

  // 캡처한 그림의 비율은 화면(canvas)의 비율과 같다
  const canvas = engine.renderer.domElement;
  let res: Response;
  try {
    res = await fetch(`/api/rooms/${roomId}/openings-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: images.map((data) => ({ data })), views, aspect: canvas.width / canvas.height, fovDeg: engine.camera.fov }),
    });
  } catch {
    return { ok: false, code: 'NETWORK', message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  }
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string }; candidates?: unknown; remaining?: unknown } | null;
  if (!res.ok) return { ok: false, code: json?.error?.code ?? 'UNKNOWN', message: json?.error?.message ?? FALLBACK };
  // 서버가 준 값도 벽 범위·겹침을 다시 확인한다
  return { ok: true, candidates: parseOpenings(json?.candidates, polygon), remaining: typeof json?.remaining === 'number' ? json.remaining : null };
}
