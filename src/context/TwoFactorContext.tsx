import { createContext, useContext, type ReactNode } from 'react';
import type { LedgerRuntimeMode } from '../lib/ledgerEngine';

export interface Simulated2FaAuditPayload {
  eventType: string;
  actor: string;
  details: string;
  severity: 'info' | 'warn' | 'critical';
}

export interface TwoFactorRuntimeContextValue {
  authMode: LedgerRuntimeMode;
  userEmail: string;
  onRecordSimulatedAudit?: (payload: Simulated2FaAuditPayload) => Promise<void> | void;
}

const TwoFactorRuntimeContext = createContext<TwoFactorRuntimeContextValue>({
  authMode: 'local_demo',
  userEmail: 'demo-operator@ntps.local',
});

export function TwoFactorRuntimeProvider({
  value,
  children,
}: {
  value: TwoFactorRuntimeContextValue;
  children: ReactNode;
}) {
  return (
    <TwoFactorRuntimeContext.Provider value={value}>
      {children}
    </TwoFactorRuntimeContext.Provider>
  );
}

export function useTwoFactorRuntime(): TwoFactorRuntimeContextValue {
  return useContext(TwoFactorRuntimeContext);
}
