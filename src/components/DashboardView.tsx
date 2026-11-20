import { useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Copy,
  QrCode,
  Share2,
  ShieldCheck,
  ChevronRight,
} from 'lucide-react';
import type {
  ActiveView,
  AssetRateMap,
  AssetSymbol,
  TerminalRecord,
  TransactionRecord,
  WalletBalance,
} from '../types/ntps';
import {
  ASSET_USD_RATES,
  NETWORK_LABELS,
  computePortfolioUsd,
  getTerminalAssetTotal,
} from '../lib/ledgerEngine';
import { formatAssetAmount, formatTimestamp, formatUsd, truncateHash } from '../lib/format';

interface DashboardViewProps {
  masterTerminal: TerminalRecord;
  subTerminals: TerminalRecord[];
  wallets: WalletBalance[];
  transactions: TransactionRecord[];
  dailyWithdrawnUsd: number;
  assetRates?: AssetRateMap;
  assetRatesSource?: string;
  onCopy: (text: string, label: string) => void;
  onOpenQr: () => void;
  onNavigate: (view: ActiveView, preselectAsset?: AssetSymbol, mode?: 'deposit' | 'withdraw') => void;
}

const ASSET_META: Record<
  AssetSymbol,
  { name: string; subtitle: string; accentClass: string; badgeText: string }
> = {
  USDT: {
    name: 'Tether USD',
    subtitle: 'TRC-20 Live · ERC-20 (Simulated)',
    accentClass: 'text-emerald-400',
    badgeText: 'USDT',
  },
  BTC: {
    name: 'Bitcoin',
    subtitle: 'Native SegWit · Simulated Rail',
    accentClass: 'text-[#F5C542]',
    badgeText: 'BTC',
  },
  ETH: {
    name: 'Ethereum',
    subtitle: 'Mainnet · Arbitrum · Simulated',
    accentClass: 'text-[#00E5FF]',
    badgeText: 'ETH',
  },
};

export function DashboardView({
  masterTerminal,
  subTerminals,
  wallets,
  transactions,
  dailyWithdrawnUsd,
  assetRates = ASSET_USD_RATES,
  assetRatesSource = 'local_demo',
  onCopy,
  onOpenQr,
  onNavigate,
}: DashboardViewProps) {
  const [usdtNetworkFilter, setUsdtNetworkFilter] = useState<'ALL' | 'TRC20' | 'ERC20'>('ALL');

  const masterUuid = masterTerminal.id;
  const masterId = masterTerminal.terminalId;
  const masterUsd = computePortfolioUsd(wallets, [masterUuid], assetRates);
  const subUsd = computePortfolioUsd(
    wallets,
    subTerminals.map((s) => s.id),
    assetRates
  );
  const totalPortfolioUsd = masterUsd + subUsd;

  const recentTxs = transactions.slice(0, 5);

  const handleShare = async () => {
    const shareText = `NOVA Terminal ID: ${masterId}`;
    if (typeof navigator !== 'undefined' && navigator.share) {
      try {
        await navigator.share({
          title: 'NOVA Terminal Payment ID',
          text: shareText,
        });
        return;
      } catch {
        // Fallback to clipboard
      }
    }
    onCopy(`ntps://terminal/${masterId}`, 'Copied shareable Terminal URI');
  };

  const getAssetDisplayBalances = (asset: AssetSymbol) => {
    if (asset === 'USDT' && usdtNetworkFilter !== 'ALL') {
      const filtered = wallets.filter(
        (w) =>
          w.terminalUuid === masterUuid &&
          w.asset === 'USDT' &&
          w.network === usdtNetworkFilter
      );
      return filtered.reduce(
        (acc, w) => ({
          available: acc.available + w.available,
          pending: acc.pending + w.pending,
          locked: acc.locked + w.locked,
        }),
        { available: 0, pending: 0, locked: 0 }
      );
    }
    return getTerminalAssetTotal(wallets, masterUuid, asset);
  };

  const dailyPct = Math.min(100, Math.round((dailyWithdrawnUsd / masterTerminal.daily_limit_usd) * 100));

  return (
    <div className="space-y-6">
      {/* Hero Master Terminal & Portfolio Valuation */}
      <section className="bg-[#0B0F16] border border-white/[0.08] rounded-xl p-6 lg:p-7 cyan-underglow">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
          {/* Left: Master Terminal Identity */}
          <div className="xl:col-span-7 flex flex-col justify-between space-y-5">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold text-[#F5C542] tracking-wide">
                Master Terminal · Gold Tier
              </span>
              <span className="text-slate-600" aria-hidden="true">
                /
              </span>
              <span className="inline-flex items-center gap-1.5 text-emerald-400 font-medium">
                <ShieldCheck className="w-3.5 h-3.5" />
                Active
              </span>
              <span className="text-slate-600" aria-hidden="true">
                /
              </span>
              <span className="text-slate-400">
                {subTerminals.filter((s) => s.status === 'active').length} Active Sub-Terminals
              </span>
            </div>

            <div>
              <p className="text-xs text-slate-400 mb-1.5">Primary Settlement Identifier</p>
              <div className="font-mono text-2xl sm:text-3xl lg:text-[2.15rem] font-bold tracking-wider text-[#00E5FF] cyan-text-glow break-all">
                {masterId}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => onCopy(masterId, 'Copied Master Terminal ID')}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-100 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Copy className="w-3.5 h-3.5 text-[#00E5FF]" />
                Copy ID
              </button>
              <button
                type="button"
                onClick={onOpenQr}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-100 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <QrCode className="w-3.5 h-3.5 text-[#00E5FF]" />
                QR Code
              </button>
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-100 bg-white/[0.05] hover:bg-white/[0.1] border border-white/[0.1] rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Share2 className="w-3.5 h-3.5 text-slate-400" />
                Share
              </button>
              <button
                type="button"
                onClick={() => onNavigate('transfer')}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#05070A] bg-[#00E5FF] hover:bg-[#33ECFF] rounded-lg transition-colors whitespace-nowrap shrink-0 ml-auto sm:ml-2"
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
                Instant Transfer
              </button>
            </div>
          </div>

          {/* Right: Total Portfolio Valuation */}
          <div className="xl:col-span-5 xl:border-l border-white/[0.08] xl:pl-7 flex flex-col justify-between space-y-5">
            <div>
              <p className="text-xs text-slate-400">Total Consolidated Balance (USD Equivalent)</p>
              <div className="font-mono tabular-nums text-3xl sm:text-4xl font-bold text-[#F5C542] mt-1.5 tracking-tight">
                {formatUsd(totalPortfolioUsd)}
              </div>
              <div className="flex items-center gap-4 mt-3 text-xs text-slate-400">
                <span>
                  Master:{' '}
                  <strong className="font-mono tabular-nums text-slate-200 font-medium">
                    {formatUsd(masterUsd)}
                  </strong>
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span>
                  Sub-Desks:{' '}
                  <strong className="font-mono tabular-nums text-slate-200 font-medium">
                    {formatUsd(subUsd)}
                  </strong>
                </span>
              </div>
            </div>

            <div className="space-y-2 pt-2 border-t border-white/[0.06]">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Daily Outbound Quota</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {formatUsd(dailyWithdrawnUsd)} / {formatUsd(masterTerminal.daily_limit_usd)}
                </span>
              </div>
              <div className="h-1.5 w-full bg-[#05070A] rounded-full overflow-hidden border border-white/[0.06]">
                <div
                  className="h-full bg-[#00E5FF] transition-all duration-300"
                  style={{ width: `${dailyPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Interactive Asset Wallet Strip */}
      <section aria-labelledby="wallet-strip-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="wallet-strip-heading" className="text-sm font-semibold text-slate-200">
            Master Terminal Wallets
          </h2>
          <span className="text-xs text-slate-400 font-mono tabular-nums">
            BTC {formatUsd(assetRates.BTC)} · ETH {formatUsd(assetRates.ETH)} · USDT {formatUsd(assetRates.USDT)}
            <span className="text-slate-500 ml-2">
              [{assetRatesSource === 'local_demo' ? 'Demo Rates' : `Feed: ${assetRatesSource}`}]
            </span>
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {(['USDT', 'BTC', 'ETH'] as AssetSymbol[]).map((asset) => {
            const meta = ASSET_META[asset];
            const bal = getAssetDisplayBalances(asset);
            const totalUnits = bal.available + bal.pending + bal.locked;
            const usdEq = totalUnits * assetRates[asset];

            return (
              <div
                key={asset}
                className="bg-[#0B0F16] border border-white/[0.08] hover:border-white/[0.15] rounded-xl p-5 flex flex-col justify-between transition-colors"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className={`font-mono text-base font-bold ${meta.accentClass}`}>
                          {meta.badgeText}
                        </span>
                        <span className="text-xs text-slate-400">{meta.name}</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">{meta.subtitle}</p>
                    </div>

                    {asset === 'USDT' ? (
                      <div className="flex items-center bg-[#05070A] border border-white/[0.08] rounded-md p-0.5 text-[11px]">
                        {(['ALL', 'TRC20', 'ERC20'] as const).map((net) => (
                          <button
                            key={net}
                            type="button"
                            onClick={() => setUsdtNetworkFilter(net)}
                            className={`px-2 py-0.5 rounded transition-colors whitespace-nowrap ${
                              usdtNetworkFilter === net
                                ? 'bg-white/[0.1] text-slate-100 font-medium'
                                : 'text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {net === 'ALL' ? 'All' : NETWORK_LABELS[net]}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="font-mono text-xs text-slate-400 tabular-nums">
                        {formatUsd(assetRates[asset])}
                      </span>
                    )}
                  </div>

                  <div className="mt-4 pb-4 border-b border-white/[0.06]">
                    <div className="font-mono tabular-nums text-2xl font-bold text-slate-100">
                      {formatAssetAmount(totalUnits, asset)}{' '}
                      <span className="text-xs font-normal text-slate-400">{asset}</span>
                    </div>
                    <div className="font-mono tabular-nums text-xs text-[#F5C542] mt-0.5">
                      ≈ {formatUsd(usdEq)}
                    </div>
                  </div>

                  <div className="py-3.5 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Available</span>
                      <span className="font-mono tabular-nums text-slate-100 font-medium">
                        {formatAssetAmount(bal.available, asset)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Pending</span>
                      <span className="font-mono tabular-nums text-amber-400">
                        {formatAssetAmount(bal.pending, asset)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Locked</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {formatAssetAmount(bal.locked, asset)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-white/[0.06]">
                  <button
                    type="button"
                    onClick={() => onNavigate('transfer', asset)}
                    className="flex items-center justify-center gap-1 py-2 px-2 text-xs font-medium text-slate-200 bg-white/[0.04] hover:bg-[#00E5FF]/15 hover:text-[#00E5FF] border border-white/[0.07] rounded-lg transition-colors whitespace-nowrap"
                  >
                    <ArrowLeftRight className="w-3 h-3" />
                    Send
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('deposit_withdraw', asset, 'deposit')}
                    className="flex items-center justify-center gap-1 py-2 px-2 text-xs font-medium text-slate-200 bg-white/[0.04] hover:bg-emerald-500/15 hover:text-emerald-300 border border-white/[0.07] rounded-lg transition-colors whitespace-nowrap"
                  >
                    <ArrowDownLeft className="w-3 h-3" />
                    Deposit
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('deposit_withdraw', asset, 'withdraw')}
                    className="flex items-center justify-center gap-1 py-2 px-2 text-xs font-medium text-slate-200 bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.07] rounded-lg transition-colors whitespace-nowrap"
                  >
                    <ArrowUpRight className="w-3 h-3" />
                    Withdraw
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Recent Ledger Settlements */}
      <section className="bg-[#0B0F16] border border-white/[0.08] rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.08]">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">Recent Settlements</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Latest double-entry ledger postings across Master and Sub-Terminals
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('ledger')}
            className="inline-flex items-center gap-1 text-xs font-medium text-[#00E5FF] hover:text-[#5ceeff] transition-colors whitespace-nowrap"
          >
            Full Audit Log
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/[0.07] text-[11px] font-medium text-slate-400 bg-[#05070A]/40">
                <th className="py-2.5 px-5">Reference</th>
                <th className="py-2.5 px-4">Type</th>
                <th className="py-2.5 px-4">Counterparty</th>
                <th className="py-2.5 px-4 text-right">Amount</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-5 text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.05] text-xs">
              {recentTxs.map((tx) => (
                <tr key={tx.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="py-2.5 px-5 font-mono text-slate-200 whitespace-nowrap">
                    {tx.reference}
                  </td>
                  <td className="py-2.5 px-4 text-slate-300 capitalize whitespace-nowrap">
                    {tx.type.replace('_', ' ')}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-slate-400 whitespace-nowrap">
                    {truncateHash(tx.counterparty_terminal, 14, 6)}
                  </td>
                  <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-100 font-medium whitespace-nowrap">
                    {formatAssetAmount(tx.amount, tx.asset)}{' '}
                    <span className="text-slate-400">{tx.asset}</span>
                  </td>
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <span
                      className={`font-medium capitalize ${
                        tx.status === 'completed'
                          ? 'text-emerald-400'
                          : tx.status === 'pending' || tx.status === 'detected'
                            ? 'text-amber-400'
                            : 'text-red-400'
                      }`}
                    >
                      {tx.status}
                    </span>
                  </td>
                  <td className="py-2.5 px-5 font-mono tabular-nums text-right text-slate-400 whitespace-nowrap">
                    {formatTimestamp(tx.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
