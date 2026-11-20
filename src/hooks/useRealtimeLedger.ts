import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import type { LedgerRuntimeMode } from '../lib/ledgerEngine';

export type RealtimeConnectionState = 'connected' | 'disconnected' | 'demo';

interface UseRealtimeLedgerOptions {
  userId?: string;
  authMode: LedgerRuntimeMode;
  ledgerQueryKey: QueryKey;
}

const REALTIME_TABLES = [
  'wallets',
  'transactions',
  'withdrawal_requests',
  'invoices',
  'deposit_addresses',
  'terminals',
  'trading_accounts',
  'asset_rates',
  'audit_logs',
] as const;

const INVALIDATE_DEBOUNCE_MS = 120;

/**
 * Manages a single deduplicated Supabase Realtime channel for live ledger state
 * (`wallets`, `transactions`, `withdrawal_requests`, and supporting tables),
 * coalescing burst multi-table Postgres writes into a single React Query refetch.
 */
export function useRealtimeLedger({
  userId,
  authMode,
  ledgerQueryKey,
}: UseRealtimeLedgerOptions): {
  connectionState: RealtimeConnectionState;
  lastEventAt: string | null;
} {
  const queryClient = useQueryClient();
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>(
    authMode === 'supabase' ? 'disconnected' : 'demo'
  );
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);

  const debounceTimerRef = useRef<number | null>(null);
  const activeChannelRef = useRef<RealtimeChannel | null>(null);
  const queryKeyRef = useRef<QueryKey>(ledgerQueryKey);
  queryKeyRef.current = ledgerQueryKey;

  useEffect(() => {
    const clearDebounce = () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };

    if (authMode !== 'supabase') {
      clearDebounce();
      setConnectionState('demo');
      return;
    }

    if (!isSupabaseConfigured || !supabase || !userId) {
      clearDebounce();
      setConnectionState('disconnected');
      return;
    }

    const client = supabase;
    let isDisposed = false;
    setConnectionState('disconnected');

    // Guard against any lingering channel instance from an interrupted render cycle
    if (activeChannelRef.current) {
      void client.removeChannel(activeChannelRef.current);
      activeChannelRef.current = null;
    }

    const scheduleInvalidate = () => {
      if (isDisposed) return;
      setLastEventAt(new Date().toISOString());
      clearDebounce();
      debounceTimerRef.current = window.setTimeout(() => {
        if (!isDisposed) {
          void queryClient.invalidateQueries({ queryKey: queryKeyRef.current });
        }
      }, INVALIDATE_DEBOUNCE_MS);
    };

    const channelName = `ntps-ledger-sync-${userId}-${Date.now()}`;
    let channel = client.channel(channelName);

    for (const table of REALTIME_TABLES) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        scheduleInvalidate
      );
    }

    activeChannelRef.current = channel;

    channel.subscribe((status) => {
      if (isDisposed) return;
      if (status === 'SUBSCRIBED') {
        setConnectionState('connected');
      } else if (
        status === 'CHANNEL_ERROR' ||
        status === 'TIMED_OUT' ||
        status === 'CLOSED'
      ) {
        setConnectionState('disconnected');
      }
    });

    const handleOffline = () => {
      if (!isDisposed) setConnectionState('disconnected');
    };

    const handleOnline = () => {
      if (!isDisposed) {
        void queryClient.invalidateQueries({ queryKey: queryKeyRef.current });
      }
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      isDisposed = true;
      clearDebounce();
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      if (activeChannelRef.current === channel) {
        activeChannelRef.current = null;
      }
      void client.removeChannel(channel);
    };
  }, [authMode, userId, queryClient]);

  return { connectionState, lastEventAt };
}
