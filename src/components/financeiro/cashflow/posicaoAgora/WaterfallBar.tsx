// Barra do waterfall de projeção de caixa do PosicaoAgora.
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { fmtCompact } from './format';

export function WaterfallBar({ label, value, max, color }: {
  label: string; value: number; max: number; color: string;
}) {
  const pct = max > 0 ? Math.min((Math.abs(value) / max) * 100, 100) : 0;
  return (
    <div className="flex flex-col items-center gap-1 flex-1">
      <div className="w-full flex items-end justify-center h-24">
        <div
          className={`w-full max-w-[48px] rounded-t ${color} transition-all`}
          style={{ height: `${Math.max(pct, 5)}%` }}
        />
      </div>
      <span className="text-[10px] text-muted-foreground text-center">{label}</span>
      <span className="text-xs font-bold">{fmtCompact(value)}</span>
    </div>
  );
}
