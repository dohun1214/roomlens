import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoMark } from '@/components/ui/Logo';

/** 404·오류 화면의 공통 틀: 가운데 카드 하나와 홈으로 가는 길 */
export default function ErrorScreen({
  code,
  title,
  children,
  actions,
  testId,
}: {
  code: string;
  title: string;
  children: ReactNode;
  /** 홈 버튼 앞에 놓을 버튼 (다시 시도 등) */
  actions?: ReactNode;
  testId: string;
}) {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16" data-testid={testId}>
      <div className="flex w-full max-w-md flex-col items-center gap-5 rounded-[28px] bg-surface px-6 py-10 text-center shadow-card sm:px-10">
        <LogoMark size={44} />
        <span className="font-mono text-sm text-mute">{code}</span>
        <h1 className="text-2xl font-bold tracking-tight text-balance">{title}</h1>
        <div className="text-[15px] text-pretty text-sub">{children}</div>
        <div className="flex flex-wrap justify-center gap-2.5">
          {actions}
          <Link href="/" className="btn btn-primary h-12 rounded-[14px] px-6 text-[15px]">
            홈으로
          </Link>
        </div>
      </div>
    </main>
  );
}
