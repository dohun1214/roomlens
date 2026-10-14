// 브라우저에서: 방을 위에서 내려다본 그림을 찍어 원래 가구 후보를 받아 오고, 높이를 스플랫에서 잰다.
import { MAX_TOTAL_BASE64, totalBase64 } from '@/lib/ai/analysis';
import { parseFixtures, updateFixture, type Fixture } from '@/lib/rooms/fixtures';
import type { CaptureEngine } from '@/lib/three/capture';
import { measureFixtureHeights } from '@/lib/three/fixtureHeights';
import type { Point2 } from '@/lib/three/floorDrag';
import { captureTopViews } from '@/lib/three/topView';
import type { SplatMesh } from '@sparkjsdev/spark';
import { TOP_VIEW_CUT, TOP_VIEW_HEIGHT, TOP_VIEW_PX, topViewPlan } from './fixturesDetect';

export type FixturesDetectOutcome =
  | {
      ok: true;
      candidates: Fixture[];
      measured: number;
      remaining: number | null;
    }
  | { ok: false; code: string; message: string };

const FALLBACK = '원래 가구를 찾지 못했습니다. 잠시 뒤에 다시 해 주세요.';

/**
 * @param polygon 저장된 보정의 평면도 (지금 화면에 적용된 것과 같아야 한다)
 * @param onProgress 캡처가 한 장 끝날 때마다, 그리고 보낼 때(done === total)
 */
export async function requestFixturesDetection(
  engine: CaptureEngine & { splat: SplatMesh | null },
  roomId: string,
  polygon: Point2[],
  onProgress?: (done: number, total: number) => void,
): Promise<FixturesDetectOutcome> {
  const tiles = topViewPlan(polygon);
  if (tiles.length === 0)
    return {
      ok: false,
      code: 'NOT_CALIBRATED',
      message: '방의 크기·바닥 보정을 먼저 저장해 주세요.',
    };
  onProgress?.(0, tiles.length);
  let images: string[];
  try {
    images = await captureTopViews(engine, tiles, {
      px: TOP_VIEW_PX,
      height: TOP_VIEW_HEIGHT,
      cut: TOP_VIEW_CUT,
      onProgress,
    });
  } catch {
    return {
      ok: false,
      code: 'CAPTURE',
      message: '화면을 캡처하지 못했습니다. 다시 해 주세요.',
    };
  }
  if (totalBase64(images.map((data) => ({ data }))) > MAX_TOTAL_BASE64)
    return {
      ok: false,
      code: 'TOO_LARGE',
      message: '캡처한 그림이 너무 큽니다. 다시 해 주세요.',
    };

  let res: Response;
  try {
    res = await fetch(`/api/rooms/${roomId}/fixtures-suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: images.map((data) => ({ data })) }),
    });
  } catch {
    return {
      ok: false,
      code: 'NETWORK',
      message: '서버에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.',
    };
  }
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
    candidates?: unknown;
    remaining?: unknown;
  } | null;
  if (!res.ok)
    return {
      ok: false,
      code: json?.error?.code ?? 'UNKNOWN',
      message: json?.error?.message ?? FALLBACK,
    };
  // 서버가 준 값도 모양·방 범위를 다시 확인한다
  let candidates = parseFixtures(json?.candidates, polygon);
  // 높이는 이름별 흔한 값으로 와 있다. 스플랫에서 잴 수 있는 것은 잰 값으로 바꾼다
  let measured = 0;
  if (engine.splat && candidates.length > 0) {
    const heights = measureFixtureHeights(engine.splat, candidates);
    for (const [i, h] of heights.entries()) {
      if (h === null) continue;
      candidates = updateFixture(candidates, candidates[i].id, { h });
      measured += 1;
    }
  }
  return {
    ok: true,
    candidates,
    measured,
    remaining: typeof json?.remaining === 'number' ? json.remaining : null,
  };
}
