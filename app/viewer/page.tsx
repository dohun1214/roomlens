import type { Metadata } from 'next';
import SplatViewer from '@/components/viewer/SplatViewerClient';

export const metadata: Metadata = {
  title: '3D 뷰어 테스트 | RoomLens',
};

export default function ViewerPage() {
  return (
    <main className="h-[calc(100dvh-3rem)] w-full bg-neutral-900">
      <SplatViewer />
    </main>
  );
}
