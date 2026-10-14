'use client';

import Image from 'next/image';
import { useState } from 'react';
import { furnitureTone } from '@/lib/layout/furnitureLook';
import FurnitureGlyph from './FurnitureGlyph';

/**
 * 카탈로그 가구의 모델 사진 (public/furniture/{id}.webp). 사진이 없거나(내 가구) 못 불러오면 위에서 본 작은 그림을 쓴다.
 */
export default function FurnitureThumb({
  furnitureRef,
  category,
  src,
  size = 40,
}: {
  furnitureRef: string;
  category: string;
  src: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <FurnitureGlyph furnitureRef={furnitureRef} category={category} size={size} />;
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden"
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: furnitureTone(category).tile }}
      aria-hidden="true"
    >
      {/* 이미 작게 만든 사진이라 Next 이미지 최적화를 거치지 않는다 */}
      <Image src={src} alt="" width={size} height={size} unoptimized onError={() => setFailed(true)} data-testid="furniture-thumb" />
    </span>
  );
}
