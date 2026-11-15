import Link from 'next/link';
import MiniPlan from '@/components/rooms/MiniPlan';
import { LogoMark } from '@/components/ui/Logo';
import { shortTitle, sizeLabel } from '@/lib/rooms/featured';
import type { RoomCardData } from '@/lib/rooms/list';

/** 홈의 샘플 방: 큰 정사각형 사진과 짧은 제목·크기 */
export default function SampleRooms({ rooms }: { rooms: RoomCardData[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4" data-testid="sample-rooms">
      {rooms.map((room) => {
        const size = room.outline ? sizeLabel(room.outline.polygon) : null;
        return (
          <li key={room.id}>
            <Link href={`/rooms/${room.id}`} className="group flex flex-col gap-3" data-testid="sample-room" data-room-id={room.id}>
              <span className="relative block aspect-square overflow-hidden rounded-[24px] bg-soft">
                {room.thumbnail ? (
                  // 대표 사진은 서명한 R2 주소로 넘겨주는 경로라 next/image의 최적화를 쓰지 않는다
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={room.thumbnail}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                  />
                ) : room.outline ? (
                  <MiniPlan outline={room.outline} className="absolute inset-6 h-[calc(100%-3rem)] w-[calc(100%-3rem)]" />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center opacity-30">
                    <LogoMark size={44} />
                  </span>
                )}
              </span>
              <span className="flex flex-col gap-1 px-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                  <span className="text-base font-bold sm:text-[17px]">{shortTitle(room.title)}</span>
                  {size && <span className="shrink-0 font-mono text-[13px] text-mute">{size}</span>}
                </span>
                {room.description && <span className="line-clamp-1 text-sm text-sub">{room.description}</span>}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
