'use client';

import { useEffect } from 'react';
import ErrorScreen from '@/components/ui/ErrorScreen';

/** 화면을 그리다 생긴 오류. 다시 시도하거나 홈으로 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <ErrorScreen
      code={error.digest ? `오류 ${error.digest}` : '오류'}
      title="화면을 보여 주지 못했습니다"
      testId="error-screen"
      actions={
        <button type="button" className="btn btn-outline h-12 rounded-[14px] px-6 text-[15px]" onClick={reset} data-testid="error-retry">
          다시 시도
        </button>
      }
    >
      잠깐 연결이 끊겼거나 서버가 바빴을 수 있습니다. 다시 시도해도 안 되면 잠시 뒤에 열어 주세요.
    </ErrorScreen>
  );
}
