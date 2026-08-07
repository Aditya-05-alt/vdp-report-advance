'use client';

import Link from 'next/link';
import { useFormStatus } from 'react-dom';
import { useActionState, useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { signInAction } from '@/lib/auth/actions';
import { INACTIVITY_TIMEOUT_MINUTES } from '@/lib/auth/inactivityTimeout';
import { resetDealerToAll } from '@/lib/dashboard/dashboardPrefs';

const initialState = { ok: false, error: null };

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button className="login-btn" type="submit" disabled={pending}>
      {pending ? 'Signing in…' : 'Log In'}
    </button>
  );
}

export default function LoginForm({ demoMode = false, demoEmail = '', demoPassword = '' }) {
  const searchParams = useSearchParams();
  const sessionTimedOut = searchParams.get('timeout') === '1';
  const [state, formAction] = useActionState(signInAction, initialState);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    resetDealerToAll();
  }, []);

  const fillDemo = useCallback(() => {
    setEmail(demoEmail);
    setPassword(demoPassword);
  }, [demoEmail, demoPassword]);

  return (
    <div className="vdp-login-card">
      <h1>VDP &amp; Page View Performance</h1>
      <div className="vdp-login-sub">Dealer Reporting Portal — sign in to continue</div>

      {sessionTimedOut && (
        <div className="login-error" style={{ marginBottom: 12, minHeight: 0 }}>
          Your session ended after {INACTIVITY_TIMEOUT_MINUTES} minutes of inactivity.
          Please sign in again.
        </div>
      )}

      <form action={formAction} noValidate>
        <div className="login-field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@dealership.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="login-field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <input type="hidden" name="remember" value="on" />

        <div className="login-error" id="loginError" role="alert">
          {state?.error || ''}
        </div>

        <SubmitButton />
      </form>

      {demoMode && (
        <div className="login-demo">
          <strong>Demo account</strong> (Supabase not configured — click to autofill):
          <div
            className="demo-row"
            onClick={fillDemo}
            onKeyDown={(e) => e.key === 'Enter' && fillDemo()}
            role="button"
            tabIndex={0}
          >
            <span>{demoEmail}</span>
            <span>{demoPassword}</span>
          </div>
        </div>
      )}

      <p style={{ marginTop: 18, fontSize: 12, color: '#64748b', textAlign: 'center' }}>
        <Link href="/forgot-password" style={{ color: '#2563eb', fontWeight: 600 }}>
          Forgot password?
        </Link>
      </p>
    </div>
  );
}
