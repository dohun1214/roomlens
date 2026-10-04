// 방 3D 파일(가우시안 스플랫)의 형식·크기 검증.
// 브라우저(올리기 전)와 서버(올린 뒤 R2에서 앞부분만 읽어서) 양쪽에서 같은 함수를 쓴다.

export const SPLAT_FORMATS = ['spz', 'ply', 'rad', 'sog'] as const;
export type SplatFormat = (typeof SPLAT_FORMATS)[number];

/** 한 파일의 최대 크기 (100MB) */
export const MAX_SPLAT_BYTES = 100 * 1024 * 1024;
/** 형식을 알아내는 데 필요한 앞부분 바이트 수 */
export const SPLAT_HEAD_BYTES = 16;
/** R2에 올릴 때 쓰는 Content-Type. presigned URL 서명에 들어가므로 브라우저도 같은 값을 보내야 한다. */
export const SPLAT_CONTENT_TYPE = 'application/octet-stream';

export type SplatFileErrorCode = 'EMPTY' | 'TOO_LARGE' | 'UNKNOWN_FORMAT' | 'SPZ_V4_UNSUPPORTED';

export type SplatFileCheck =
  | { ok: true; format: SplatFormat }
  | { ok: false; code: SplatFileErrorCode; message: string };

const MESSAGES: Record<SplatFileErrorCode, string> = {
  EMPTY: '빈 파일입니다. 파일을 다시 내보내 주세요.',
  TOO_LARGE: '파일이 100MB를 넘습니다. 더 작은 파일로 내보내 주세요.',
  UNKNOWN_FORMAT: '지원하지 않는 파일입니다. Scaniverse에서 SPZ 또는 PLY로 내보낸 파일을 올려 주세요.',
  SPZ_V4_UNSUPPORTED:
    '이 SPZ 파일은 새 버전(v4)이라 아직 열 수 없습니다. Scaniverse에서 PLY로 내보내 다시 올려 주세요.',
};

const fail = (code: SplatFileErrorCode): SplatFileCheck => ({ ok: false, code, message: MESSAGES[code] });

const startsWith = (head: Uint8Array, bytes: number[]) =>
  head.length >= bytes.length && bytes.every((b, i) => head[i] === b);

/**
 * 파일 앞부분(매직 바이트)으로 형식을 알아낸다. 확장자는 믿지 않는다.
 *  - PLY: "ply" + 줄바꿈
 *  - SPZ v1~3: gzip (1f 8b 08). Spark가 읽을 수 있다
 *  - SPZ v4: 압축하지 않은 헤더 "NGSP" + 버전. Spark 2.3이 읽지 못한다
 *  - RAD: "RAD0" (Spark의 미리 만든 LOD)
 *  - SOG: zip ("PK\x03\x04")
 */
export function detectSplatFormat(head: Uint8Array): SplatFormat | 'spz-raw' | null {
  if (startsWith(head, [0x70, 0x6c, 0x79]) && (head[3] === 0x0a || head[3] === 0x0d)) return 'ply';
  if (startsWith(head, [0x1f, 0x8b, 0x08])) return 'spz';
  if (startsWith(head, [0x4e, 0x47, 0x53, 0x50])) return 'spz-raw';
  if (startsWith(head, [0x52, 0x41, 0x44, 0x30])) return 'rad';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'sog';
  return null;
}

/** 크기와 앞부분으로 올릴 수 있는 파일인지 확인한다. */
export function checkSplatFile(size: number, head: Uint8Array): SplatFileCheck {
  if (!Number.isFinite(size) || size <= 0) return fail('EMPTY');
  if (size > MAX_SPLAT_BYTES) return fail('TOO_LARGE');
  const format = detectSplatFormat(head);
  if (format === null) return fail('UNKNOWN_FORMAT');
  if (format === 'spz-raw') return fail('SPZ_V4_UNSUPPORTED');
  return { ok: true, format };
}

/** 방 하나의 파일이 모두 들어가는 R2 경로. 방을 지울 때 이 아래를 전부 지운다 */
export function roomPrefix(roomId: string): string {
  return `rooms/${roomId}/`;
}

/** R2 키: rooms/{roomId}/scene.{형식} */
export function splatKeyFor(roomId: string, format: SplatFormat): string {
  return `${roomPrefix(roomId)}scene.${format}`;
}

export function isSplatFormat(value: unknown): value is SplatFormat {
  return typeof value === 'string' && (SPLAT_FORMATS as readonly string[]).includes(value);
}
