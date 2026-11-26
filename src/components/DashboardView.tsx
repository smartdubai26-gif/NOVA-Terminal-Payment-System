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
import { useLocale } from '../context/LocaleContext';

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
  { nameEn: string; nameAr: string; subtitleEn: string; subtitleAr: string; accentClass: string; badgeText: string }
> = {
  USDT: {
    nameEn: 'Tether USD',
    nameAr: 'تيثر دولار',
    subtitleEn: 'TRC-20 Live · ERC-20 (Simulated)',
    subtitleAr: 'TRC-20 مباشر · ERC-20 (محاكاة)',
    accentClass: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    badgeText: 'USDT',
  },
  BTC: {
    nameEn: 'Bitcoin',
    nameAr: 'بيتكوين',
    subtitleEn: 'Native SegWit · Simulated Rail',
    subtitleAr: 'Native SegWit · شبكة محاكاة',
    accentClass: 'text-amber-800 bg-amber-50 border-amber-200',
    badgeText: 'BTC',
  },
  ETH: {
    nameEn: 'Ethereum',
    nameAr: 'إيثيريوم',
    subtitleEn: 'Mainnet · Arbitrum · Simulated',
    subtitleAr: 'الشبكة الرئيسية · Arbitrum · محاكاة',
    accentClass: 'text-[#1E40AF] bg-blue-50 border-blue-200',
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
  const { tr } = useLocale();

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
    onCopy(`ntps://terminal/${masterId}`, tr('Copied shareable Terminal URI', 'تم نسخ رابط المحطة'));
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
      {/* Hero Master Terminal & Portfolio Valuation — 60% Primary Cobalt Blue */}
      <section className="cobalt-hero-surface border border-[#24489B] rounded-xl p-6 lg:p-7 text-white">
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
          {/* Start Column: Master Terminal Identity */}
          <div className="xl:col-span-7 flex flex-col justify-between space-y-5">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-[#D6FF3D] text-[#0F172A] font-semibold tracking-wide">
                {tr('Master Terminal · Gold Tier', 'المحطة الرئيسية · الفئة الذهبية')}
              </span>
              <span className="text-blue-200/70" aria-hidden="true">
                /
              </span>
              <span className="inline-flex items-center gap-1.5 text-white font-medium">
                <ShieldCheck className="w-3.5 h-3.5 text-[#D6FF3D]" />
                {tr('Active', 'نشط')}
              </span>
              <span className="text-blue-200/70" aria-hidden="true">
                /
              </span>
              <span className="text-blue-100 tabular-nums">
                {subTerminals.filter((s) => s.status === 'active').length}{' '}
                {tr('Active Sub-Terminals', 'محطات فرعية نشطة')}
              </span>
            </div>

            <div>
              <p className="text-xs text-blue-100/85 mb-1.5">
                {tr('Primary Settlement Identifier', 'معرف التسوية الرئيسي')}
              </p>
              <div className="font-mono tabular-nums text-2xl sm:text-3xl lg:text-[2.15rem] font-bold tracking-wider text-white break-all">
                {masterId}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <button
                type="button"
                onClick={() =>
                  onCopy(masterId, tr('Copied Master Terminal ID', 'تم نسخ معرف المحطة الرئيسية'))
                }
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Copy className="w-3.5 h-3.5 text-[#D6FF3D]" />
                {tr('Copy ID', 'نسخ المعرف')}
              </button>
              <button
                type="button"
                onClick={onOpenQr}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <QrCode className="w-3.5 h-3.5 text-[#D6FF3D]" />
                {tr('QR Code', 'رمز QR')}
              </button>
              <button
                type="button"
                onClick={handleShare}
                className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                <Share2 className="w-3.5 h-3.5 text-blue-100" />
                {tr('Share', 'مشاركة')}
              </button>
              <button
                type="button"
                onClick={() => onNavigate('transfer')}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap shrink-0 ms-auto sm:ms-2 shadow-sm"
              >
                <ArrowLeftRight className="w-3.5 h-3.5" />
                {tr('Instant Transfer', 'تحويل فوري')}
              </button>
            </div>
          </div>

          {/* End Column: Total Portfolio Valuation */}
          <div className="xl:col-span-5 xl:border-s border-white/20 xl:ps-7 flex flex-col justify-between space-y-5">
            <div>
              <p className="text-xs text-blue-100/85">
                {tr('Total Consolidated Balance (USD Equivalent)', 'إجمالي الرصيد الموحد (المعادل بالدولار)')}
              </p>
              <div className="font-mono tabular-nums text-3xl sm:text-4xl font-bold text-white mt-1.5 tracking-tight">
                {formatUsd(totalPortfolioUsd)}
              </div>
              <div className="flex flex-wrap items-center gap-4 mt-3 text-xs text-blue-100/85">
                <span>
                  {tr('Master:', 'الرئيسية:')}{' '}
                  <strong className="font-mono tabular-nums text-white font-semibold">
                    {formatUsd(masterUsd)}
                  </strong>
                </span>
                <span className="text-blue-200/60" aria-hidden="true">
                  ·
                </span>
                <span>
                  {tr('Sub-Desks:', 'المكاتب الفرعية:')}{' '}
                  <strong className="font-mono tabular-nums text-[#D6FF3D] font-semibold">
                    {formatUsd(subUsd)}
                  </strong>
                </span>
              </div>
            </div>

            <div className="space-y-2 pt-3 border-t border-white/15">
              <div className="flex items-center justify-between text-xs">
                <span className="text-blue-100/85">
                  {tr('Daily Outbound Quota', 'الحصة اليومية الصادرة')}
                </span>
                <span className="font-mono tabular-nums text-white font-medium">
                  {formatUsd(dailyWithdrawnUsd)} / {formatUsd(masterTerminal.daily_limit_usd)}
                </span>
              </div>
              <div className="h-2 w-full bg-[#0F172A]/35 rounded-full overflow-hidden border border-white/15">
                <div
                  className="h-full bg-[#D6FF3D] transition-all duration-300"
                  style={{ width: `${dailyPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Interactive Asset Wallet Strip — 30% Snow White Cards */}
      <section aria-labelledby="wallet-strip-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="wallet-strip-heading" className="text-sm font-semibold text-[#0F172A]">
            {tr('Master Terminal Wallets', 'محافظ المحطة الرئيسية')}
          </h2>
          <span className="text-xs text-slate-600 font-mono tabular-nums">
            BTC {formatUsd(assetRates.BTC)} · ETH {formatUsd(assetRates.ETH)} · USDT {formatUsd(assetRates.USDT)}
            <span className="text-slate-500 ms-2">
              [{assetRatesSource === 'local_demo' ? tr('Demo Rates', 'أسعار تجريبية') : `Feed: ${assetRatesSource}`}]
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
                className="bg-white border border-[#E2E8F0] hover:border-[#1E40AF]/40 rounded-xl p-5 flex flex-col justify-between transition-colors shadow-xs"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`font-mono text-xs font-bold px-2 py-0.5 rounded border ${meta.accentClass}`}
                        >
                          {meta.badgeText}
                        </span>
                        <span className="text-xs font-medium text-slate-700">
                          {tr(meta.nameEn, meta.nameAr)}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        {tr(meta.subtitleEn, meta.subtitleAr)}
                      </p>
                    </div>

                    {asset === 'USDT' ? (
                      <div className="flex items-center bg-[#F4F7FA] border border-[#E2E8F0] rounded-md p-0.5 text-[11px]">
                        {(['ALL', 'TRC20', 'ERC20'] as const).map((net) => (
                          <button
                            key={net}
                            type="button"
                            onClick={() => setUsdtNetworkFilter(net)}
                            className={`px-2 py-0.5 rounded transition-colors whitespace-nowrap ${
                              usdtNetworkFilter === net
                                ? 'bg-[#1E40AF] text-white font-semibold'
                                : 'text-slate-600 hover:text-[#0F172A]'
                            }`}
                          >
                            {net === 'ALL' ? tr('All', 'الكل') : NETWORK_LABELS[net]}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span className="font-mono text-xs text-slate-500 tabular-nums">
                        {formatUsd(assetRates[asset])}
                      </span>
                    )}
                  </div>

                  <div className="mt-4 pb-4 border-b border-[#E2E8F0]">
                    <div className="font-mono tabular-nums text-2xl font-bold text-[#0F172A]">
                      {formatAssetAmount(totalUnits, asset)}{' '}
                      <span className="text-xs font-normal text-slate-500">{asset}</span>
                    </div>
                    <div className="font-mono tabular-nums text-xs text-[#1E40AF] font-semibold mt-0.5">
                      ≈ {formatUsd(usdEq)}
                    </div>
                  </div>

                  <div className="py-3.5 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">{tr('Available', 'متاح')}</span>
                      <span className="font-mono tabular-nums text-[#0F172A] font-semibold">
                        {formatAssetAmount(bal.available, asset)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">{tr('Pending', 'قيد الانتظار')}</span>
                      <span className="font-mono tabular-nums text-amber-700 font-medium">
                        {formatAssetAmount(bal.pending, asset)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">{tr('Locked', 'محجوز')}</span>
                      <span className="font-mono tabular-nums text-slate-500">
                        {formatAssetAmount(bal.locked, asset)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-[#E2E8F0]">
                  <button
                    type="button"
                    onClick={() => onNavigate('transfer', asset)}
                    className="flex items-center justify-center gap-1 py-2 px-2 text-xs font-semibold text-[#0F172A] bg-[#D6FF3D] hover:bg-[#c8f526] rounded-lg transition-colors whitespace-nowrap"
                  >
                    <ArrowLeftRight className="w-3 h-3" />
                    {tr('Send', 'إرسال')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('deposit_withdraw', asset, 'deposit')}
                    className="flex items-center justify-center gap-1 py-2 px-2 text-xs font-medium text-[#1E40AF] bg-[#F4F7FA] hover:bg-blue-50 border border-[#E2E8F0] rounded-lg transition-colors whitespace-nowrap"
                  >
                    <ArrowDownLeft className="w-3 h-3" />
                    {tr('Deposit', 'إيداع')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('deposit_withdraw', asset, 'withdraw')}
                    className="flex items-center justify-center gap-1 py-2 px-2 text-xs font-medium text-[#0F172A] bg-[#F4F7FA] hover:bg-slate-200/70 border border-[#E2E8F0] rounded-lg transition-colors whitespace-nowrap"
                  >
                    <ArrowUpRight className="w-3 h-3" />
                    {tr('Withdraw', 'سحب')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Recent Ledger Settlements */}
      <section className="bg-white border border-[#E2E8F0] rounded-xl overflow-hidden shadow-xs">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#E2E8F0]">
          <div>
            <h2 className="text-sm font-semibold text-[#0F172A]">
              {tr('Recent Settlements', 'التسويات الأخيرة')}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {tr(
                'Latest double-entry ledger postings across Master and Sub-Terminals',
                'أحدث قيود القيد المزدوج عبر المحطة الرئيسية والمحطات الفرعية'
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('ledger')}
            className="inline-flex items-center gap-1 text-xs font-semibold text-[#1E40AF] hover:text-[#24489B] transition-colors whitespace-nowrap"
          >
            {tr('Full Audit Log', 'سجل التدقيق الكامل')}
            <ChevronRight className="w-3.5 h-3.5 rtl:rotate-180" />
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-start border-collapse">
            <thead>
              <tr className="border-b border-[#E2E8F0] text-[11px] font-semibold text-[#0F172A] bg-[#F8FAFC]">
                <th className="py-2.5 px-5 text-start">{tr('Reference', 'المرجع')}</th>
                <th className="py-2.5 px-4 text-start">{tr('Type', 'النوع')}</th>
                <th className="py-2.5 px-4 text-start">{tr('Counterparty', 'الطرف المقابل')}</th>
                <th className="py-2.5 px-4 text-end">{tr('Amount', 'المبلغ')}</th>
                <th className="py-2.5 px-4 text-start">{tr('Status', 'الحالة')}</th>
                <th className="py-2.5 px-5 text-end">{tr('Timestamp', 'الوقت')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0] text-xs bg-white">
              {recentTxs.map((tx) => (
                <tr key={tx.id} className="hover:bg-[#F8FAFC] transition-colors">
                  <td className="py-2.5 px-5 font-mono tabular-nums text-[#0F172A] font-medium whitespace-nowrap">
                    {tx.reference}
                  </td>
                  <td className="py-2.5 px-4 text-slate-700 capitalize whitespace-nowrap">
                    {tx.type.replace('_', ' ')}
                  </td>
                  <td className="py-2.5 px-4 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                    {truncateHash(tx.counterparty_terminal, 14, 6)}
                  </td>
                  <td className="py-2.5 px-4 font-mono tabular-nums text-end text-[#0F172A] font-semibold whitespace-nowrap">
                    {formatAssetAmount(tx.amount, tx.asset)}{' '}
                    <span className="text-slate-500 font-normal">{tx.asset}</span>
                  </td>
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold capitalize ${
                        tx.status === 'completed'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : tx.status === 'pending' || tx.status === 'detected'
                            ? 'bg-amber-50 text-amber-800 border-amber-200'
                            : 'bg-red-50 text-red-700 border-red-200'
                      }`}
                    >
                      {tx.status}
                    </span>
                  </td>
                  <td className="py-2.5 px-5 font-mono tabular-nums text-end text-slate-500 whitespace-nowrap">
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
