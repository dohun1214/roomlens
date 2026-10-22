// 3D 스캔 가구 파일(GLB) 검사. 브라우저(고르기 전)와 서버(올린 뒤) 양쪽에서 쓴다.

/** 고를 수 있는 스캔 원본 GLB의 최대 크기 (브라우저 안에서만 다룬다) */
export const MAX_SCAN_INPUT_BYTES = 80 * 1024 * 1024;
/** 바닥을 지우고 줄여서 서버로 보내는 GLB의 최대 크기 (Vercel 요청 4.5MB 한도 안) */
export const MAX_SCAN_MODEL_BYTES = 4 * 1024 * 1024;
/** 서버에 올리는 모델의 Content-Type */
export const SCAN_MODEL_CONTENT_TYPE = 'model/gltf-binary';

export type GlbCheck = { ok: true } | { ok: false; message: string };

/** GLB 머리말: "glTF" + 버전 2 + 전체 길이(파일 크기와 같아야 함) */
export function checkGlb(bytes: Uint8Array, maxBytes = MAX_SCAN_MODEL_BYTES): GlbCheck {
  if (bytes.length < 20) return { ok: false, message: '빈 파일이거나 GLB가 아닙니다.' };
  if (bytes.length > maxBytes) return { ok: false, message: `파일이 너무 큽니다 (${Math.round(maxBytes / 1024 / 1024)}MB까지).` };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) return { ok: false, message: 'GLB 파일이 아닙니다. Scaniverse에서 GLB로 내보내 주세요.' };
  if (view.getUint32(4, true) !== 2) return { ok: false, message: '지원하지 않는 GLB 버전입니다.' };
  if (view.getUint32(8, true) !== bytes.length) return { ok: false, message: 'GLB 파일이 잘렸습니다. 다시 내보내 주세요.' };
  return { ok: true };
}

/** 내 가구 3D 모델의 R2 경로 */
export function scanModelKey(userId: string, furnitureId: string): string {
  return `furniture/user/${userId}/${furnitureId}.glb`;
}
