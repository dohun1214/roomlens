'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { authErrorMessage, PASSWORD_MIN_LENGTH, validateSignUp } from '@/lib/auth/messages';
import { createClient } from '@/lib/supabase/client';

type Mode = 'login' | 'signup';

export default function AuthForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isAdult, setIsAdult] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (mode === 'signup') {
      const problem = validateSignUp({ email, password, isAdult });
      if (problem) {
        setError(problem);
        return;
      }
    }

    setBusy(true);
    const supabase = createClient();
    try {
      if (mode === 'login') {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (signInError) {
          setError(authErrorMessage(signInError));
          return;
        }
      } else {
        const { data, error: signUpError } = await supabase.auth.signUp({ email: email.trim(), password });
        if (signUpError) {
          setError(authErrorMessage(signUpError));
          return;
        }
        if (!data.session || !data.user) {
          // 확인 메일을 쓰지 않으므로 보통은 바로 세션이 생긴다
          setError('가입은 됐지만 바로 로그인되지 않았습니다. 로그인해 주세요.');
          setMode('login');
          return;
        }
        // 가입 화면에서 체크한 만 18세 이상 확인을 프로필에 남긴다
        const { error: profileError } = await supabase
          .from('profiles')
          .update({ is_adult_confirmed: true })
          .eq('id', data.user.id);
        if (profileError) console.error(profileError);
      }
      router.replace(next);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const tab = (value: Mode, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode === value}
      className={`h-11 rounded-[10px] text-[15px] ${mode === value ? 'bg-surface font-bold text-ink shadow-sm' : 'font-medium text-sub hover:text-ink'}`}
      onClick={() => {
        setMode(value);
        setError(null);
      }}
    >
      {label}
    </button>
  );

  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-6" noValidate>
      <div className="grid grid-cols-2 gap-1 rounded-[14px] bg-soft p-1" role="tablist" aria-label="로그인 또는 가입">
        {tab('login', '로그인')}
        {tab('signup', '가입')}
      </div>

      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-sm font-bold">
          <span>이메일</span>
          <input
            className="field h-[52px] text-base font-normal"
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label className="flex flex-col gap-2 text-sm font-bold">
          <span>
            비밀번호{mode === 'signup' ? <span className="font-normal text-sub">{` (${PASSWORD_MIN_LENGTH}자 이상)`}</span> : ''}
          </span>
          <input
            className="field h-[52px] text-base font-normal"
            type="password"
            name="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {mode === 'signup' && (
          <label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
            <input type="checkbox" name="isAdult" className="h-5 w-5 accent-accent" checked={isAdult} onChange={(e) => setIsAdult(e.target.checked)} />
            <span>만 18세 이상입니다.</span>
          </label>
        )}
      </div>

      {error && (
        <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger" role="alert" data-testid="auth-error">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy} className="btn btn-primary h-[54px] rounded-[14px] text-base shadow-accent">
        {busy ? '처리 중…' : mode === 'login' ? '로그인' : '가입하기'}
      </button>

      {mode === 'signup' && (
        <p className="rounded-[14px] bg-ground px-4 py-3.5 text-[13px] text-pretty text-sub">
          확인 메일 없이 바로 가입됩니다. 비밀번호를 잊으면 찾을 수 없으니 기억해 두세요.
        </p>
      )}
    </form>
  );
}
