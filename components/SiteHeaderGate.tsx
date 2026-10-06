'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

/** 자기 머리말을 따로 가진 화면에서는 공통 상단 메뉴를 그리지 않는다 */
const OWN_HEADER = [/^\/login$/];

export default function SiteHeaderGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (OWN_HEADER.some((pattern) => pattern.test(pathname))) return null;
  return children;
}
