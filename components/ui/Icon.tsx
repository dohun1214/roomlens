import type { ReactNode } from 'react';

// 선으로 그린 작은 아이콘 모음. 색은 글자색(currentColor)을 따른다.
const PATHS = {
  lock: { box: 12, width: 1.4, d: <><rect x="2" y="5.5" width="8" height="5" rx="1.2" /><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" /></> },
  globe: { box: 12, width: 1.4, d: <><circle cx="6" cy="6" r="4.5" /><path d="M1.5 6h9M6 1.5c1.6 1.4 1.6 7.6 0 9M6 1.5c-1.6 1.4-1.6 7.6 0 9" /></> },
  check: { box: 12, width: 1.8, d: <path d="M2.5 6.5 5 9l4.5-5.5" /> },
  plus: { box: 12, width: 1.8, d: <path d="M6 1.5v9M1.5 6h9" /> },
  close: { box: 12, width: 1.8, d: <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /> },
  chevronDown: { box: 12, width: 1.6, d: <path d="M2.5 4.5 6 8l3.5-3.5" /> },
  chevronRight: { box: 14, width: 1.6, d: <path d="M5 3l4 4-4 4" /> },
  chevronLeft: { box: 14, width: 1.8, d: <path d="M9 3 5 7l4 4" /> },
  arrowRight: { box: 16, width: 2, d: <path d="M3 8h10M9 4l4 4-4 4" /> },
  upload: { box: 22, width: 1.9, d: <path d="M11 14V4M7 8l4-4 4 4M4 15v3h14v-3" /> },
  ruler: { box: 22, width: 1.8, d: <><path d="M2.5 15.5 15.5 2.5l4 4-13 13z" /><path d="M6 12l1.6 1.6M9 9l1.6 1.6M12 6l1.6 1.6" /></> },
  sofa: { box: 20, width: 1.7, d: <><path d="M3 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4" /><path d="M2 11h16v4H2zM4 15v2M16 15v2" /></> },
  door: { box: 20, width: 1.7, d: <><path d="M5 18V3h10v15M3 18h14" /><circle cx="12.5" cy="10.5" r="0.8" fill="currentColor" /></> },
  window: { box: 18, width: 1.6, d: <><rect x="3" y="3" width="12" height="12" rx="1.5" /><path d="M9 3v12M3 9h12" /></> },
  report: { box: 20, width: 1.7, d: <><rect x="3" y="2.5" width="14" height="15" rx="2" /><path d="M6.5 7h7M6.5 10h7M6.5 13h4" /></> },
  phone: { box: 22, width: 1.8, d: <><rect x="6" y="2" width="10" height="18" rx="2.5" /><path d="M10 17h2" /></> },
  cube: { box: 22, width: 1.8, d: <><path d="M11 2.5 19 7v8l-8 4.5L3 15V7z" /><path d="M3 7l8 4.5L19 7M11 11.5v8" /></> },
  dots: { box: 16, width: 0, d: <><circle cx="3" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="13" cy="8" r="1.4" fill="currentColor" /></> },
  rotate: { box: 14, width: 1.6, d: <><path d="M11.5 7A4.5 4.5 0 1 1 7 2.5h3" /><path d="M8.3 0.8 10.2 2.5 8.3 4.2" /></> },
  target: { box: 14, width: 1.5, d: <><circle cx="7" cy="7" r="2" /><path d="M7 0.8v2.4M7 10.8v2.4M0.8 7h2.4M10.8 7h2.4" /></> },
  sun: { box: 18, width: 1.6, d: <><circle cx="9" cy="9" r="3.2" /><path d="M9 1.5v2M9 14.5v2M1.5 9h2M14.5 9h2M3.7 3.7l1.4 1.4M12.9 12.9l1.4 1.4M3.7 14.3l1.4-1.4M12.9 5.1l1.4-1.4" /></> },
  drawer: { box: 18, width: 1.6, d: <><rect x="2.5" y="3.5" width="13" height="11" rx="1.6" /><path d="M2.5 9h13M8 6.3h2M8 11.8h2" /></> },
  alert: { box: 16, width: 1.6, d: <><circle cx="8" cy="8" r="6" /><path d="M8 4.8v3.8M8 11v.2" /></> },
  warn: { box: 16, width: 1.6, d: <><path d="M8 2 14.5 13.5h-13z" /><path d="M8 6.5v3.2M8 11.6v.2" /></> },
  image: { box: 18, width: 1.6, d: <><rect x="2.5" y="3.5" width="13" height="11" rx="1.6" /><circle cx="6.5" cy="7.5" r="1.2" /><path d="M3 13l4-3.5 3 2.5 2.5-2 3 3" /></> },
} satisfies Record<string, { box: number; width: number; d: ReactNode }>;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, size, className }: { name: IconName; size?: number; className?: string }) {
  const icon = PATHS[name];
  const px = size ?? icon.box;
  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${icon.box} ${icon.box}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={icon.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`shrink-0 ${className ?? ''}`}
    >
      {icon.d}
    </svg>
  );
}
