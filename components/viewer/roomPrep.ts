// "AI로 방 준비하기": 보정을 저장한 뒤 문·창문 찾기 → 원래 가구 찾기를 이어서 돌리고, 사용자는 결과만 확인·저장한다.
// 두 찾기는 같은 1회의 AI 사용으로 센다 (원래 가구 찾기가 문·창문 찾기 호출을 bundleOf로 가리킨다).

/** 도구가 스스로 한 번 AI로 찾게 하는 신호. token이 바뀔 때마다 한 번 */
export type AutoDetect = { token: string; bundleOf?: string; onDone: (result: AutoDetectResult) => void };
export type AutoDetectResult = { ok: boolean; found: number; callId?: string | null; message?: string };

export type PrepStep = 'openings' | 'fixtures' | 'review';
export type RoomPrep = {
  step: PrepStep;
  token: string;
  /** 문·창문 찾기 호출 (원래 가구 찾기를 같은 1회로 세려고) */
  bundleOf?: string;
  openings?: AutoDetectResult;
  fixtures?: AutoDetectResult;
};
