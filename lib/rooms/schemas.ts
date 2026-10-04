import { z } from 'zod';
import { MAX_SPLAT_BYTES, SPLAT_FORMATS } from '@/lib/upload/splatFile';

// 방 API의 요청 본문 형식. 화면과 서버가 같은 규칙을 쓴다.

export const ROOM_TITLE_MAX = 60;
export const ROOM_DESCRIPTION_MAX = 500;
/** 한 사람이 만들 수 있는 방 개수 (R2 무료 10GB 안에서 쓰기 위한 제한) */
export const MAX_ROOMS_PER_USER = 10;

export const RoomId = z.uuid();

export const ROOM_CREDIT_MAX = 300;
/** 방 3D 파일을 어떻게 얻었는지. scaniverse = 직접 찍음, dataset = 공개 데이터셋 등 다른 사람이 만든 것 */
export const ROOM_SOURCES = ['scaniverse', 'dataset'] as const;
export type RoomSource = (typeof ROOM_SOURCES)[number];

export const CreateRoomInput = z
  .object({
  title: z.string().trim().min(1, '방 이름을 입력해 주세요.').max(ROOM_TITLE_MAX, `방 이름은 ${ROOM_TITLE_MAX}자까지입니다.`),
  description: z.string().trim().max(ROOM_DESCRIPTION_MAX, `설명은 ${ROOM_DESCRIPTION_MAX}자까지입니다.`).default(''),
  // 방 영상·3D 파일은 개인정보로 다루므로 동의 없이는 만들지 않는다
  consent: z.literal(true, '개인정보 수집·이용에 동의해야 방을 만들 수 있습니다.'),
  source: z.enum(ROOM_SOURCES).default('scaniverse'),
  // 다른 사람이 만든 파일이면 출처·라이선스를 적는다 (방 화면에 표시)
  credit: z.string().trim().max(ROOM_CREDIT_MAX, `출처는 ${ROOM_CREDIT_MAX}자까지입니다.`).default(''),
})
  .refine((v) => v.source !== 'dataset' || v.credit.length > 0, {
    path: ['credit'],
    message: '데이터셋 파일은 출처와 라이선스를 적어 주세요.',
  });
export type CreateRoomInput = z.infer<typeof CreateRoomInput>;

export const UploadUrlInput = z.object({
  roomId: RoomId,
  kind: z.literal('splat'),
  format: z.enum(SPLAT_FORMATS),
  size: z.int().min(1).max(MAX_SPLAT_BYTES, '파일이 100MB를 넘습니다.'),
});
export type UploadUrlInput = z.infer<typeof UploadUrlInput>;

/** 업로드를 끝냈다고 알릴 때: 어떤 형식으로 올렸는지 */
export const CompleteUploadInput = z.object({
  splatFormat: z.enum(SPLAT_FORMATS),
});
export type CompleteUploadInput = z.infer<typeof CompleteUploadInput>;

/** zod 오류에서 사용자에게 보여줄 첫 문구 */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? '요청 형식이 올바르지 않습니다.';
}
