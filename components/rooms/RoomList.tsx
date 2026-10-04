import Link from 'next/link';
import type { RoomCardData } from '@/lib/rooms/list';

/** 방 카드 목록. 꾸밈은 최소로 두고(디자인은 따로 진행) 정보만 보여준다. */
export default function RoomList({ rooms, testId }: { rooms: RoomCardData[]; testId: string }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2" data-testid={testId}>
      {rooms.map((room) => (
        <li key={room.id}>
          <Link
            href={`/rooms/${room.id}`}
            className="block h-full space-y-1 rounded border border-neutral-300 p-3 text-sm hover:border-neutral-500 dark:border-neutral-700"
            data-testid="room-card"
            data-room-id={room.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{room.title}</span>
              {room.badges.map((badge) => (
                <span key={badge} className="rounded bg-neutral-200 px-1.5 py-0.5 text-xs dark:bg-neutral-700" data-testid="room-badge">
                  {badge}
                </span>
              ))}
            </div>
            {room.description && <p className="line-clamp-2 text-neutral-600 dark:text-neutral-300">{room.description}</p>}
            <p className="text-xs text-neutral-500">
              {room.ownerNickname}
              {room.createdLabel ? ` · ${room.createdLabel}` : ''}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
