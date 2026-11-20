import { useCallback, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

export type AuthMode = 'supabase' | 'local_demo';

export const LOCAL_DEMO_USER_ID = '99999999-9999-4999-8999-999999999901';
export const LOCAL_DEMO_EMAIL = 'treasury@nova-terminal.local';
const DEMO_OVERRIDE_STORAGE_KEY = 'ntps_demo_mode_override';

function readDemoOverride(): boolean {
  if (!isSupabaseConfigured) return true;
  if (typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(DEMO_OVERRIDE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export interface SupabaseAuthState {
  session: Session | null;
  user: User | null;
  isLoading: boolean;
  isSupabaseConfigured: boolean;
  authMode: AuthMode;
  demoModeEnabled: boolean;
  shouldShowAuthGate: boolean;
  effectiveUserId: string;
  effectiveUserEmail: string;
  setDemoModeEnabled: (enabled: boolean) => void;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string
  ) => Promise<{ error: string | null; requiresEmailConfirmation: boolean }>;
  signOut: () => Promise<{ error: string | null }>;
}

export function useSupabaseAuth(): SupabaseAuthState {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(isSupabaseConfigured);
  const [demoModeEnabled, setDemoModeState] = useState<boolean>(readDemoOverride);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setSession(null);
      setIsLoading(false);
      return;
    }

    let mounted = true;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session ?? null);
        setIsLoading(false);
      })
      .catch(() => {
        if (!mounted) return;
        setSession(null);
        setIsLoading(false);
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession ?? null);
      setIsLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const setDemoModeEnabled = useCallback((enabled: boolean) => {
    setDemoModeState(enabled);
    if (typeof window !== 'undefined') {
      try {
        if (enabled) {
          window.sessionStorage.setItem(DEMO_OVERRIDE_STORAGE_KEY, 'true');
        } else {
          window.sessionStorage.removeItem(DEMO_OVERRIDE_STORAGE_KEY);
        }
      } catch {
        // Ignore storage errors in restricted iframes
      }
    }
  }, []);

  const signIn = useCallback(
    async (email: string, password: string): Promise<{ error: string | null }> => {
      if (!supabase) {
        return { error: 'Supabase environment variables are not configured.' };
      }
      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) {
        return { error: error.message };
      }
      setDemoModeEnabled(false);
      return { error: null };
    },
    [setDemoModeEnabled]
  );

  const signUp = useCallback(
    async (
      email: string,
      password: string
    ): Promise<{ error: string | null; requiresEmailConfirmation: boolean }> => {
      if (!supabase) {
        return {
          error: 'Supabase environment variables are not configured.',
          requiresEmailConfirmation: false,
        };
      }
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (error) {
        return { error: error.message, requiresEmailConfirmation: false };
      }
      if (data.session) {
        setDemoModeEnabled(false);
        return { error: null, requiresEmailConfirmation: false };
      }
      return { error: null, requiresEmailConfirmation: true };
    },
    [setDemoModeEnabled]
  );

  const signOut = useCallback(async (): Promise<{ error: string | null }> => {
    if (!supabase) {
      return { error: null };
    }
    const { error } = await supabase.auth.signOut();
    if (error) {
      return { error: error.message };
    }
    return { error: null };
  }, []);

  const authMode: AuthMode =
    isSupabaseConfigured && session && !demoModeEnabled ? 'supabase' : 'local_demo';

  const effectiveUserId =
    authMode === 'supabase' && session?.user?.id ? session.user.id : LOCAL_DEMO_USER_ID;

  const effectiveUserEmail =
    authMode === 'supabase' && session?.user?.email ? session.user.email : LOCAL_DEMO_EMAIL;

  const shouldShowAuthGate =
    isSupabaseConfigured && !isLoading && !session && !demoModeEnabled;

  return {
    session,
    user: session?.user ?? null,
    isLoading,
    isSupabaseConfigured,
    authMode,
    demoModeEnabled,
    shouldShowAuthGate,
    effectiveUserId,
    effectiveUserEmail,
    setDemoModeEnabled,
    signIn,
    signUp,
    signOut,
  };
}
