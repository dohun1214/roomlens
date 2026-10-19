import type { Metadata } from 'next';
import ErrorScreen from '@/components/ui/ErrorScreen';

export const metadata: Metadata = { title: '찾을 수 없음 | RoomLens' };

/** 없는 주소, 지워진 방, 남의 비공개 방 (비공개 방은 있는지조차 알리지 않는다) */
export default function NotFound() {
  return (
    <ErrorScreen code="404" title="찾을 수 없는 페이지입니다" testId="not-found">
      주소가 틀렸거나, 방이 지워졌거나, 주인이 비공개로 바꾼 방일 수 있습니다.
      <br />
      내 방이라면 로그인한 뒤 다시 열어 보세요.
    </ErrorScreen>
  );
}
