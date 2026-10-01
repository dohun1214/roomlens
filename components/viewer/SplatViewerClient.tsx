'use client';

import dynamic from 'next/dynamic';

// three.js·Spark는 브라우저 전용이므로 SSR 없이 불러온다.
const SplatViewer = dynamic(() => import('./SplatViewer'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-neutral-400">
      3D 뷰어 불러오는 중…
    </div>
  ),
});

export default SplatViewer;
