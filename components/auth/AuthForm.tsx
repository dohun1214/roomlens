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
      className={`flex-1 border-b-2 py-2 text-sm ${
        mode === value ? 'border-neutral-900 font-semibold dark:border-white' : 'border-transparent text-neutral-500'
      }`}
      onClick={() => {
        setMode(value);
        setError(null);
      }}
    >
      {label}
    </button>
  );

  const inputClass =
    'w-full rounded border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700';

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4" noValidate>
      <div className="flex" role="tablist">
        {tab('login', '로그인')}
        {tab('signup', '가입')}
      </div>

      <label className="block space-y-1 text-sm">
        <span>이메일</span>
        <input
          className={inputClass}
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>

      <label className="block space-y-1 text-sm">
        <span>비밀번호{mode === 'signup' ? ` (${PASSWORD_MIN_LENGTH}자 이상)` : ''}</span>
        <input
          className={inputClass}
          type="password"
          name="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </label>

      {mode === 'signup' && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="isAdult"
            className="mt-1"
            checked={isAdult}
            onChange={(e) => setIsAdult(e.target.checked)}
          />
          <span>만 18세 이상입니다.</span>
        </label>
      )}

      {error && (
        <p className="text-sm text-red-600" role="alert" data-testid="auth-error">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {busy ? '처리 중…' : mode === 'login' ? '로그인' : '가입하기'}
      </button>

      {mode === 'signup' && (
        <p className="text-xs text-neutral-500">확인 메일 없이 바로 가입됩니다. 비밀번호를 잊으면 찾을 수 없으니 기억해 두세요.</p>
      )}
    </form>
  );
}
