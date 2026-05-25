// Mini-card de KPI do Cockpit (margens/inadimplência/aging).
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).

export function MiniCard({ label, value, color, subtitle, onClick }: {
  label: string; value: string; color: string; subtitle?: string; onClick?: () => void;
}) {
  return (
    <div className={`p-3 rounded-md border bg-card text-center ${onClick ? 'cursor-pointer hover:bg-muted/30 transition-colors' : ''}`} onClick={onClick}>
      <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
      <p className={`kpi-value text-xl mt-1 ${color}`}>{value}</p>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">{subtitle}</p>}
    </div>
  );
}
