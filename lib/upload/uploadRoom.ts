// 방 3D 파일을 올리는 전체 순서 (브라우저에서 실행).
//   파일 확인 → 방 생성 → 업로드 주소 발급 → R2로 직접 PUT → 서버에 완료 확인
// 네트워크 부분(deps)을 바꿔 끼울 수 있게 해서 순서와 오류 처리를 브라우저 없이 테스트한다.
import { checkSplatFile, SPLAT_HEAD_BYTES, type SplatFormat } from './splatFile';

export type UploadStage = 'checking' | 'creating' | 'signing' | 'uploading' | 'verifying';

export const STAGE_LABEL: Record<UploadStage, string> = {
  checking: '파일 확인 중…',
  creating: '방 만드는 중…',
  signing: '업로드 준비 중…',
  uploading: '올리는 중…',
  verifying: '올린 파일 확인 중…',
};

/** 어느 단계에서 왜 실패했는지. roomId가 있으면 방은 이미 만들어진 것이므로 다시 시도할 때 이어서 쓴다. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly stage: UploadStage,
    readonly roomId: string | null,
    readonly aborted = false,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

type ApiResult = { status: number; json: unknown };

export type UploadDeps = {
  readHead(file: Blob): Promise<Uint8Array>;
  fetchJson(method: 'POST' | 'PATCH', url: string, body: unknown): Promise<ApiResult>;
  /** R2로 PUT. HTTP 상태 코드를 돌려준다 (네트워크·CORS 실패는 0). 취소되면 AbortError를 던진다 */
  put(url: string, headers: Record<string, string>, body: Blob, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<number>;
};

export type UploadRoomInput = {
  file: Blob;
  title: string;
  description: string;
  consent: boolean;
  /** 'dataset'이면 credit(출처·라이선스)이 필요하다 */
  source?: 'scaniverse' | 'dataset';
  credit?: string;
  /** 앞선 시도에서 만들어진 방. 있으면 방을 새로 만들지 않는다 */
  roomId?: string | null;
  onStage?: (stage: UploadStage) => void;
  /** 0~1 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
};

const GENERIC = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
const PUT_FAILED = '업로드에 실패했습니다. 네트워크를 확인하고 다시 시도해 주세요.';
const ABORTED = '업로드를 취소했습니다.';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** API 오류 응답 { error: { message } } 에서 문구를 꺼낸다 */
function apiMessage(json: unknown): string {
  if (isRecord(json) && isRecord(json.error) && typeof json.error.message === 'string') return json.error.message;
  return GENERIC;
}

const isAbort = (err: unknown) => isRecord(err) && err.name === 'AbortError';

export async function uploadRoom(input: UploadRoomInput, deps: UploadDeps = browserDeps): Promise<{ roomId: string; format: SplatFormat }> {
  const { file, signal } = input;
  let roomId = input.roomId ?? null;
  let stage = 'checking' as UploadStage; // enter()에서 바뀌므로 타입을 좁히지 않는다
  const enter = (next: UploadStage) => {
    if (signal?.aborted) throw new UploadError(ABORTED, next, roomId, true);
    stage = next;
    input.onStage?.(next);
  };

  try {
    // 1) 올리기 전에 형식·크기를 먼저 본다 (서버도 올린 뒤 다시 확인한다)
    enter('checking');
    const check = checkSplatFile(file.size, await deps.readHead(file));
    if (!check.ok) throw new UploadError(check.message, stage, roomId);
    const format = check.format;

    // 2) 방 레코드
    if (!roomId) {
      enter('creating');
      const created = await deps.fetchJson('POST', '/api/rooms', {
        title: input.title,
        description: input.description,
        consent: input.consent,
        source: input.source ?? 'scaniverse',
        credit: input.credit ?? '',
      });
      const id = isRecord(created.json) && isRecord(created.json.room) ? created.json.room.id : null;
      if (created.status !== 201 || typeof id !== 'string') throw new UploadError(apiMessage(created.json), stage, roomId);
      roomId = id;
    }

    // 3) 올릴 주소
    enter('signing');
    const signed = await deps.fetchJson('POST', '/api/upload-url', { roomId, kind: 'splat', format, size: file.size });
    const url = isRecord(signed.json) ? signed.json.url : null;
    const headers = isRecord(signed.json) && isRecord(signed.json.headers) ? (signed.json.headers as Record<string, string>) : {};
    if (signed.status !== 200 || typeof url !== 'string') throw new UploadError(apiMessage(signed.json), stage, roomId);

    // 4) R2로 직접 올리기
    enter('uploading');
    input.onProgress?.(0);
    const putStatus = await deps.put(url, headers, file, (fraction) => input.onProgress?.(Math.min(1, Math.max(0, fraction))), signal);
    if (putStatus < 200 || putStatus >= 300) throw new UploadError(PUT_FAILED, stage, roomId);
    input.onProgress?.(1);

    // 5) 서버가 R2에서 실제 파일을 확인하고 방을 ready로 바꾼다
    enter('verifying');
    const done = await deps.fetchJson('PATCH', `/api/rooms/${roomId}`, { splatFormat: format });
    if (done.status !== 200) throw new UploadError(apiMessage(done.json), stage, roomId);

    return { roomId, format };
  } catch (err) {
    if (err instanceof UploadError) throw err;
    if (isAbort(err)) throw new UploadError(ABORTED, stage, roomId, true);
    throw new UploadError(stage === 'uploading' ? PUT_FAILED : GENERIC, stage, roomId);
  }
}

/** 파일 앞부분만 읽는다 (형식 확인용) */
export async function readFileHead(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, SPLAT_HEAD_BYTES).arrayBuffer());
}

/** fetch는 업로드 진행률을 알려주지 않으므로 XMLHttpRequest를 쓴다 */
function xhrPut(url: string, headers: Record<string, string>, body: Blob, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => resolve(xhr.status);
    xhr.onerror = () => resolve(0); // R2가 거부하면(403) CORS 헤더가 없어 여기로 온다
    xhr.onabort = () => reject(new DOMException(ABORTED, 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        reject(new DOMException(ABORTED, 'AbortError'));
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

const browserDeps: UploadDeps = {
  readHead: readFileHead,
  async fetchJson(method, url, body) {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => null) };
  },
  put: xhrPut,
};
