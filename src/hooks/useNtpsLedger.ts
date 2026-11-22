import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addWhitelistDestination,
  createInvoice,
  ensureDepositAddress,
  fetchAdminProfile,
  loadLedgerState,
  payInvoice,
  performInternalTransfer,
  performSimulatedDeposit,
  performWithdrawal,
  provisionSubTerminal,
  recordSimulatedTwoFactorAudit,
  resetLocalLedgerState,
  reviewKycSubmission,
  reviewWithdrawalQueue,
  submitKycSubmission,
  transferFromTrading,
  transferToTrading,
  updateSubTerminalPolicy,
  updateTerminalStatusAdmin,
  verifyLedgerInvariant,
  type LedgerRuntimeMode,
  type NtpsLedgerState,
} from '../lib/ledgerEngine';
import { useRealtimeLedger } from './useRealtimeLedger';
import type {
  AdminProfile,
  AssetSymbol,
  KycSubmissionInput,
  LedgerPosting,
  NetworkId,
  TerminalStatus,
} from '../types/ntps';

export const NTPS_LEDGER_QUERY_KEY = ['ntps', 'ledger'] as const;

export function useNtpsLedger(
  userId?: string,
  authMode: LedgerRuntimeMode = 'local_demo'
) {
  const queryClient = useQueryClient();
  const ledgerQueryKey = useMemo(
    () => ['ntps', 'ledger', userId ?? 'local', authMode] as const,
    [userId, authMode]
  );

  const ledgerQuery = useQuery<NtpsLedgerState>({
    queryKey: ledgerQueryKey,
    queryFn: () => loadLedgerState({ authMode, userId }),
    staleTime: authMode === 'supabase' ? 10_000 : 30_000,
  });

  const adminProfileQuery = useQuery<AdminProfile>({
    queryKey: ['ntps', 'admin_profile', userId ?? 'local', authMode],
    queryFn: () => fetchAdminProfile(authMode, userId),
    staleTime: 30_000,
  });

  const { connectionState: realtimeStatus, lastEventAt: lastRealtimeSyncAt } =
    useRealtimeLedger({
      userId,
      authMode,
      ledgerQueryKey,
    });

  const ensureDepositAddressMutation = useMutation({
    mutationFn: (params: {
      terminalUuid: string;
      asset: AssetSymbol;
      network: NetworkId;
      customAddress?: string;
    }) => ensureDepositAddress({ ...params, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const internalTransferMutation = useMutation({
    mutationFn: (params: Parameters<typeof performInternalTransfer>[0]) =>
      performInternalTransfer({ ...params, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const depositMutation = useMutation({
    mutationFn: (params: Parameters<typeof performSimulatedDeposit>[0]) =>
      performSimulatedDeposit({ ...params, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const withdrawalMutation = useMutation({
    mutationFn: (params: Parameters<typeof performWithdrawal>[0]) =>
      performWithdrawal({ ...params, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const provisionSubMutation = useMutation({
    mutationFn: (params: Parameters<typeof provisionSubTerminal>[0]) =>
      provisionSubTerminal({ ...params, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const updatePolicyMutation = useMutation({
    mutationFn: (params: {
      terminalUuid: string;
      status?: TerminalStatus;
      dailyLimitUsd?: number;
      perTxLimitUsd?: number;
      allowedAssets?: AssetSymbol[];
    }) => updateSubTerminalPolicy({ ...params, authMode }),
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  const addWhitelistMutation = useMutation({
    mutationFn: (params: {
      terminalUuid: string;
      label: string;
      asset: AssetSymbol;
      network: NetworkId;
      address: string;
    }) => addWhitelistDestination({ ...params, authMode }),
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  const createInvoiceMutation = useMutation({
    mutationFn: (params: Parameters<typeof createInvoice>[0]) =>
      createInvoice({ ...params, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const payInvoiceMutation = useMutation({
    mutationFn: (params: Parameters<typeof payInvoice>[0]) =>
      payInvoice({ ...params, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const tradingTransferMutation = useMutation({
    mutationFn: async (params: {
      terminalUuid: string;
      tradingAccountId: string;
      amount: number;
      direction: 'to_trading' | 'from_trading';
    }) => {
      if (params.direction === 'to_trading') {
        return transferToTrading({ ...params, authMode });
      }
      return transferFromTrading({ ...params, authMode });
    },
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  const adminUpdateStatusMutation = useMutation({
    mutationFn: (params: Parameters<typeof updateTerminalStatusAdmin>[0]) =>
      updateTerminalStatusAdmin({ ...params, authMode }),
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  const adminReviewWithdrawalMutation = useMutation({
    mutationFn: (params: Parameters<typeof reviewWithdrawalQueue>[0]) =>
      reviewWithdrawalQueue({ ...params, authMode }),
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  const verifyInvariantMutation = useMutation({
    mutationFn: (localPostings?: LedgerPosting[]) =>
      verifyLedgerInvariant(authMode, localPostings),
  });

  const resetLedgerMutation = useMutation({
    mutationFn: async () => resetLocalLedgerState(),
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  const recordSimulated2FaAuditMutation = useMutation({
    mutationFn: (params: {
      eventType: string;
      actor: string;
      details: string;
      severity: 'info' | 'warn' | 'critical';
    }) => recordSimulatedTwoFactorAudit({ ...params, authMode }),
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  const submitKycMutation = useMutation({
    mutationFn: (input: KycSubmissionInput) =>
      submitKycSubmission({ input, userId, authMode }),
    onSuccess: (result) => {
      queryClient.setQueryData(ledgerQueryKey, result.state);
    },
  });

  const adminReviewKycMutation = useMutation({
    mutationFn: (params: {
      submissionId: string;
      decision: 'approved' | 'rejected';
      reason?: string;
    }) => reviewKycSubmission({ ...params, authMode, userId }),
    onSuccess: (nextState) => {
      queryClient.setQueryData(ledgerQueryKey, nextState);
    },
  });

  return {
    ledgerQuery,
    adminProfileQuery,
    realtimeStatus,
    lastRealtimeSyncAt,
    ensureDepositAddressMutation,
    internalTransferMutation,
    depositMutation,
    withdrawalMutation,
    provisionSubMutation,
    updatePolicyMutation,
    addWhitelistMutation,
    createInvoiceMutation,
    payInvoiceMutation,
    tradingTransferMutation,
    adminUpdateStatusMutation,
    adminReviewWithdrawalMutation,
    verifyInvariantMutation,
    resetLedgerMutation,
    recordSimulated2FaAuditMutation,
    submitKycMutation,
    adminReviewKycMutation,
  };
}
