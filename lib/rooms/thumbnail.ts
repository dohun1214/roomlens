// 방 대표 사진(썸네일): 방 주인의 3D 화면을 16:10 JPEG로 찍어 R2에 둔다.
// 홈의 방 카드와 공유 링크 미리보기(Open Graph)에 쓴다. 읽기는 /rooms/{방}/thumbnail 이 방을 볼 수 있는지(RLS) 확인한 뒤 서명한 주소로 보낸다.
import { roomPrefix } from '@/lib/upload/splatFile';

/** 대표 사진 크기 (16:10) */
export const THUMBNAIL_WIDTH = 960;
export const THUMBNAIL_HEIGHT = 600;
export const THUMBNAIL_ASPECT = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT;
/** 받는 JPEG 크기 한도 (960×600 품질 0.85가 보통 80~200KB) */
export const MAX_THUMBNAIL_BYTES = 400 * 1024;
/** 이보다 작으면 거의 한 가지 색인 빈 그림으로 본다 */
export const MIN_THUMBNAIL_BYTES = 8 * 1024;
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

export type ThumbnailCheck = { ok: true } | { ok: false; message: string };

/** 올라온 대표 사진이 쓸 만한 JPEG인지 */
export function checkThumbnail(bytes: Uint8Array): ThumbnailCheck {
  if (bytes.length > MAX_THUMBNAIL_BYTES) return { ok: false, message: '사진이 너무 큽니다.' };
  if (bytes.length < MIN_THUMBNAIL_BYTES) return { ok: false, message: '사진이 거의 비어 있습니다. 3D가 다 보인 뒤에 다시 해 주세요.' };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return { ok: false, message: 'JPEG 사진이 아닙니다.' };
  return { ok: true };
}

/** 저장 위치. 바꿀 때마다 새 이름이라 브라우저·미리보기의 예전 사진이 남지 않는다 */
export function thumbnailKeyFor(roomId: string, now: number): string {
  return `${roomPrefix(roomId)}thumbnail-${now}.jpg`;
}

/** 화면에서 쓰는 대표 사진 주소 (없으면 null). 사진이 바뀌면 주소도 바뀐다 */
export function thumbnailSrc(roomId: string, key: string | null | undefined): string | null {
  if (!key) return null;
  const version = /thumbnail-(\d+)\.jpg$/.exec(key)?.[1] ?? '0';
  return `/rooms/${roomId}/thumbnail?v=${version}`;
}

/** w×h 그림의 가운데에서 aspect(가로/세로) 비율로 가장 크게 자르는 영역 */
export function centerCrop(w: number, h: number, aspect: number): { x: number; y: number; w: number; h: number } {
  if (w <= 0 || h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  if (w / h > aspect) {
    const cw = Math.round(h * aspect);
    return { x: Math.round((w - cw) / 2), y: 0, w: cw, h };
  }
  const ch = Math.round(w / aspect);
  return { x: 0, y: Math.round((h - ch) / 2), w, h: ch };
}
