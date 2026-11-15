import { describe, expect, it } from 'vitest';
import { roomIdFromPath } from '@/lib/usage/client';
import { isAutomated, UsageEventInput } from '@/lib/usage/events';

describe('UsageEventInput', () => {
  it('정해진 종류와 무작위 방문자 값만 받는다', () => {
    expect(UsageEventInput.safeParse({ kind: 'home_view', visitor: 'abcd1234efgh' }).success).toBe(true);
    expect(UsageEventInput.safeParse({ kind: 'room_view', roomId: '48fdf433-b393-430c-a606-83811eab1624', visitor: 'abcd1234efgh' }).success).toBe(true);
    expect(UsageEventInput.safeParse({ kind: 'login', visitor: 'abcd1234efgh' }).success).toBe(false);
    expect(UsageEventInput.safeParse({ kind: 'home_view', visitor: 'me@x.com' }).success).toBe(false);
    expect(UsageEventInput.safeParse({ kind: 'home_view', visitor: 'short' }).success).toBe(false);
  });
});

describe('isAutomated', () => {
  it('자동화 브라우저와 로봇은 세지 않는다', () => {
    expect(isAutomated('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0 Safari/537.36')).toBe(true);
    expect(isAutomated('Googlebot/2.1')).toBe(true);
    expect(isAutomated(null)).toBe(true);
    expect(isAutomated('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1')).toBe(false);
  });
});

describe('roomIdFromPath', () => {
  it('방 화면 주소에서 방 id', () => {
    expect(roomIdFromPath('/rooms/48fdf433-b393-430c-a606-83811eab1624')).toBe('48fdf433-b393-430c-a606-83811eab1624');
    expect(roomIdFromPath('/rooms/48fdf433-b393-430c-a606-83811eab1624/thumbnail')).toBe('48fdf433-b393-430c-a606-83811eab1624');
    expect(roomIdFromPath('/rooms/new')).toBeUndefined();
    expect(roomIdFromPath('/')).toBeUndefined();
  });
});
