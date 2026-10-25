// 원래 가구의 3D 조각을 올린다 (브라우저): 올릴 주소 받기 → R2에 바로 올리기 → 끝났다고 알리기.
import type { PieceKind } from './fixturePiece';
import type { Fixture } from './fixtures';

export type PieceUpload = { ok: true; fixture: Fixture; url: string } | { ok: false; message: string };

const FALLBACK = '조각을 올리지 못했습니다. 잠시 후 다시 해 주세요.';

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? FALLBACK;
}

export async function uploadFixturePiece(roomId: string, fixtureId: string, kind: PieceKind, bytes: Uint8Array, top?: number): Promise<PieceUpload> {
  const api = `/api/rooms/${roomId}/fixture-pieces`;
  try {
    const start = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureId, kind, size: bytes.byteLength }) });
    if (!start.ok) return { ok: false, message: await errorMessage(start) };
    const { url, headers, v } = (await start.json()) as { url: string; headers: Record<string, string>; v: number };
    const put = await fetch(url, { method: 'PUT', headers, body: new Blob([bytes as BlobPart]) });
    if (!put.ok) return { ok: false, message: FALLBACK };
    const finish = await fetch(api, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureId, kind, v, ...(top !== undefined ? { top } : {}) }) });
    if (!finish.ok) return { ok: false, message: await errorMessage(finish) };
    const body = (await finish.json()) as { fixture: Fixture; url: string };
    return { ok: true, fixture: body.fixture, url: body.url };
  } catch {
    return { ok: false, message: FALLBACK };
  }
}
