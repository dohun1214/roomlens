// 브라우저에서 방 대표 사진을 올린다 (방 주인)
import { THUMBNAIL_CONTENT_TYPE } from './thumbnail';

export type ThumbnailUpload = { ok: true; src: string } | { ok: false; message: string };

export async function uploadThumbnail(roomId: string, image: Blob): Promise<ThumbnailUpload> {
  try {
    const res = await fetch(`/api/rooms/${roomId}/thumbnail`, { method: 'PUT', headers: { 'Content-Type': THUMBNAIL_CONTENT_TYPE }, body: image });
    const json = (await res.json().catch(() => null)) as { thumbnail?: string; error?: { message?: string } } | null;
    if (!res.ok || !json?.thumbnail) return { ok: false, message: json?.error?.message ?? '대표 사진을 저장하지 못했습니다.' };
    return { ok: true, src: json.thumbnail };
  } catch {
    return { ok: false, message: '대표 사진을 저장하지 못했습니다. 인터넷 연결을 확인해 주세요.' };
  }
}
