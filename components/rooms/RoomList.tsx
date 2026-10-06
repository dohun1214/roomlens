import Link from 'next/link';
import MiniPlan from '@/components/rooms/MiniPlan';
import Icon from '@/components/ui/Icon';
import { LogoMark } from '@/components/ui/Logo';
import type { RoomCardData } from '@/lib/rooms/list';

/** 방 카드 목록. 위에는 방의 평면도(보정한 방), 아래에는 이름·설명·상태 */
export default function RoomList({ rooms, testId }: { rooms: RoomCardData[]; testId: string }) {
  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3" data-testid={testId}>
      {rooms.map((room) => (
        <li key={room.id}>
          <Link
            href={`/rooms/${room.id}`}
            className="flex h-full flex-col overflow-hidden rounded-[20px] bg-surface text-ink shadow-card transition-shadow hover:shadow-float"
            data-testid="room-card"
            data-room-id={room.id}
          >
            <div className="relative flex aspect-[16/10] items-center justify-center bg-soft">
              {room.outline ? (
                <MiniPlan outline={room.outline} className="absolute inset-5 h-[calc(100%-2.5rem)] w-[calc(100%-2.5rem)]" />
              ) : (
                <span className="opacity-30">
                  <LogoMark size={44} />
                </span>
              )}
              {room.badges.length > 0 && (
                <div className="absolute top-3 left-3 flex flex-wrap gap-1.5">
                  {room.badges.map((badge) => (
                    <span key={badge} className="pill bg-surface/95 text-ink-2 shadow-sm" data-testid="room-badge">
                      {badge === '비공개' && <Icon name="lock" size={11} />}
                      {badge}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-2.5 p-[18px]">
              <div className="space-y-0.5">
                <h3 className="text-[17px] font-bold">{room.title}</h3>
                {room.description && <p className="line-clamp-2 text-sm text-sub">{room.description}</p>}
              </div>
              {room.stats && (
                <div className="flex flex-wrap gap-1.5" data-testid="room-stats">
                  {room.stats.calibrated ? (
                    <>
                      <span className="pill bg-ok-soft font-medium text-ok">
                        <Icon name="check" size={11} />
                        보정됨
                      </span>
                      <span className="pill bg-soft text-body">문·창문 {room.stats.openings}</span>
                      <span className="pill bg-soft text-body">배치 {room.stats.layouts}</span>
                      {room.stats.hasReport && <span className="pill bg-accent-soft text-accent-strong">분석 리포트</span>}
                    </>
                  ) : (
                    <span className="pill bg-warn-soft font-medium text-warn">크기 보정이 필요합니다</span>
                  )}
                </div>
              )}
              <p className="mt-auto text-xs text-mute">
                {room.ownerNickname}
                {room.createdLabel ? ` · ${room.createdLabel}` : ''}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
