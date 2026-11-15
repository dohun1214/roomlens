// 사용 기록 (사용자 테스트 기간의 방문·방 조회·가구 놓기 횟수). 사람을 알아볼 수 있는 값은 남기지 않는다.
import { z } from 'zod';

export const USAGE_KINDS = ['home_view', 'room_view', 'furniture_place'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const UsageEventInput = z.object({
  kind: z.enum(USAGE_KINDS),
  roomId: z.uuid().optional(),
  /** 브라우저마다 만든 무작위 값 (같은 사람이 몇 번 왔는지 세려고) */
  visitor: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
});
export type UsageEventInput = z.infer<typeof UsageEventInput>;

/** 자동화 브라우저·검색 로봇은 세지 않는다 (실측 스크립트가 기록을 부풀리지 않게) */
export function isAutomated(userAgent: string | null): boolean {
  if (!userAgent) return true;
  return /HeadlessChrome|Playwright|bot\b|crawler|spider|Lighthouse/i.test(userAgent);
}
