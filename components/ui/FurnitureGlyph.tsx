import type { ReactNode } from 'react';
import { furnitureTone, glyphKind, type GlyphKind } from '@/lib/layout/furnitureLook';

// 위에서 내려다본 가구의 작은 그림 (24×24)
const SHAPES: Record<GlyphKind, ReactNode> = {
  bed: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2" />
      <rect x="8.5" y="4.5" width="7" height="3.5" rx="1" />
      <path d="M6 11h12" />
    </>
  ),
  'bed-wide': (
    <>
      <rect x="3.5" y="2.5" width="17" height="19" rx="2" />
      <rect x="5.5" y="4.5" width="5.5" height="3.5" rx="1" />
      <rect x="13" y="4.5" width="5.5" height="3.5" rx="1" />
      <path d="M3.5 11h17" />
    </>
  ),
  desk: (
    <>
      <rect x="2.5" y="7" width="19" height="10" rx="1.8" />
      <rect x="8" y="9" width="8" height="2.5" rx="0.8" />
    </>
  ),
  chair: (
    <>
      <rect x="6.5" y="8" width="11" height="10.5" rx="3" />
      <path d="M6.5 5.5h11" />
    </>
  ),
  wardrobe: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="1.8" />
      <path d="M12 6.5v11M10 12h.01M14 12h.01" />
    </>
  ),
  hanger: <path d="M3 12h18M7 9v6M10.5 9v6M14 9v6M17.5 9v6" />,
  drawer: (
    <>
      <rect x="4" y="7.5" width="16" height="9" rx="1.8" />
      <path d="M4 12h16M11 9.8h2M11 14.3h2" />
    </>
  ),
  table: (
    <>
      <rect x="5" y="8" width="14" height="8" rx="1.8" />
      <rect x="9" y="3" width="6" height="2.8" rx="1" />
      <rect x="9" y="18.2" width="6" height="2.8" rx="1" />
    </>
  ),
  bookcase: (
    <>
      <rect x="3" y="9" width="18" height="6" rx="1.4" />
      <path d="M9 9v6M15 9v6" />
    </>
  ),
  box: <rect x="4.5" y="6" width="15" height="12" rx="2" />,
};

/** 분류 색의 옅은 타일 위에 가구 그림을 올린다 */
export default function FurnitureGlyph({
  furnitureRef,
  category,
  size = 36,
  className = '',
}: {
  furnitureRef: string;
  category: string;
  size?: number;
  className?: string;
}) {
  const tone = furnitureTone(category);
  const icon = Math.round(size * 0.61);
  return (
    <span
      className={`flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: tone.tile }}
      aria-hidden="true"
    >
      <svg width={icon} height={icon} viewBox="0 0 24 24" fill="none" stroke={tone.ink} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {SHAPES[glyphKind(furnitureRef, category)]}
      </svg>
    </span>
  );
}
