/**
 * 3 KPIs de time no dashboard Master (substituem os placeholders "—").
 * Read-only, escopados na empresa do CompanySwitcher. Cada tile exibe fonte/escopo.
 * Receita = pedidos válidos do Omie; erro de query → "—" honesto (não R$0).
 * Receita · mês traz tendência MoM (vs. mesmo período do mês passado).
 * Definições validadas com codex (ver spec).
 */
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { Users, Briefcase, CalendarRange, type LucideIcon } from 'lucide-react';
import { useTeamKpis } from '@/hooks/useTeamKpis';
import { useCompany } from '@/contexts/CompanyContext';
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';

function Tile({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub?: ReactNode }) {
  return (
    <Card className="p-3 text-center text-xs text-muted-foreground">
      <Icon className="w-5 h-5 mx-auto mb-1 opacity-40" />
      {label}
      <div className="text-base font-medium text-foreground mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-2xs text-muted-foreground/70 mt-0.5 leading-tight">{sub}</div>}
    </Card>
  );
}

/** Linha de tendência MoM: ▲/▼ X% (colorida) ou null sem base. */
function trendMoM(v: number | null | undefined): ReactNode {
  if (v == null) return null;
  if (v === 0) return <div>= vs mês passado</div>;
  const pct = formatarFracaoPct(Math.abs(v));
  const seta = v > 0 ? '▲' : '▼';
  const cor = v > 0 ? 'text-status-success' : 'text-status-error';
  return <div className={`${cor} font-medium`}>{seta} {pct} vs mês passado</div>;
}

export function TeamKpiTiles() {
  const { data, isLoading, isError } = useTeamKpis();
  const { selection, companyInfo } = useCompany();
  const escopo = selection === 'all' ? 'todas as empresas' : companyInfo.shortName;

  const receita = (v: number | undefined): string =>
    isError ? '—' : isLoading || v === undefined ? '…' : formatBRL(v);
  const ativos = isError || isLoading || !data ? (isError ? '—' : '…') : String(data.ativosHoje);
  const ativosSub = isError ? 'indisponível' : data ? `ativos hoje · 7d: ${data.ativos7d}` : 'ativos hoje';
  const escopoSub = `pedidos Omie · ${escopo}`;
  const mesSub: ReactNode = isError ? (
    'indisponível'
  ) : (
    <>
      {data && trendMoM(data.variacaoMes)}
      <div>{escopoSub}</div>
    </>
  );

  return (
    <div className="grid grid-cols-3 gap-3">
      <Tile icon={Users} label="Vendedores ativos" value={ativos} sub={isLoading && !isError ? undefined : ativosSub} />
      <Tile icon={Briefcase} label="Receita time · hoje" value={receita(data?.receitaHoje)} sub={isError ? 'indisponível' : escopoSub} />
      <Tile icon={CalendarRange} label="Receita time · mês" value={receita(data?.receitaMes)} sub={mesSub} />
    </div>
  );
}
