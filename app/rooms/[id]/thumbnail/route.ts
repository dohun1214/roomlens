import { presignGet } from '@/lib/r2';
import { RoomId } from '@/lib/rooms/schemas';
import { createClient } from '@/lib/supabase/server';

type Context = { params: Promise<{ id: string }> };

/**
 * 방 대표 사진. 방을 볼 수 있으면(공개 방이거나 내 방, RLS) 서명한 R2 주소로 보낸다.
 * 홈의 카드와 공유 링크 미리보기가 이 주소를 쓴다. 볼 수 없거나 사진이 없으면 404.
 */
export async function GET(_request: Request, { params }: Context) {
  const id = RoomId.safeParse((await params).id);
  if (!id.success) return new Response(null, { status: 404 });
  const supabase = await createClient();
  const { data: room } = await supabase.from('rooms').select('thumbnail_key').eq('id', id.data).maybeSingle();
  if (!room?.thumbnail_key) return new Response(null, { status: 404 });
  return new Response(null, {
    status: 302,
    // 서명한 주소는 1시간 동안 쓸 수 있으므로 그보다 짧게만 기억하게 한다. 비공개 방도 있어 공용 캐시에는 두지 않는다
    headers: { Location: await presignGet(room.thumbnail_key), 'Cache-Control': 'private, max-age=600' },
  });
}
