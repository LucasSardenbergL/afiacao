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
import { useMetaPotencial } from '@/hooks/dashboard/useMetaPotencial';
import { agregarMeta, type MetaAgregada } from '@/lib/dashboard/meta-potencial';
import { MetaPotencialDetalhe } from '@/components/dashboard/MetaPotencialDetalhe';

/** Linha(s) de meta no tile do mês: % + ritmo por dia útil; indisponível é DITO, nunca R$ 0. */
function linhaMeta(m: MetaAgregada | null, carregando: boolean, erro: boolean): ReactNode {
  if (erro) return <div>meta indisponível</div>;
  if (carregando || !m) return null;
  if (m.meta == null) return <div className="text-status-warning">meta indisponível (sem calibração)</div>;
  const prov = m.status === 'provisoria' ? ' · provisória' : '';
  return (
    <>
      <div className="text-foreground/80">
        meta {formatBRL(m.meta)}
        {m.pct != null && ` · ${formatarFracaoPct(m.pct)}`}
        {prov}
      </div>
      <div>
        {m.batida
          ? 'meta batida'
          : m.ritmo == null
            ? 'sem dias úteis restantes'
            : `precisa ${formatBRL(m.ritmo)}/dia útil · ${m.diasRestantes} ${m.diasRestantes === 1 ? 'dia' : 'dias'}`}
      </div>
    </>
  );
}

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
  // Vendedores = vendedor registrado no Omie nos pedidos do mês (quem VENDEU, não dono da carteira).
  // Vem da MESMA leitura da receita: erro → "—", nunca "0" fabricado.
  const vendedores = isError ? '—' : isLoading || !data ? '…' : String(data.vendedoresMes);
  const vendedoresSub: ReactNode = isError
    ? 'indisponível'
    : data
      ? (
          <>
            <div>hoje: {data.vendedoresHoje} · vendedor no Omie</div>
            {data.pedidosSemVendedorMes > 0 && (
              <div className="text-status-warning">
                {data.pedidosSemVendedorMes} {data.pedidosSemVendedorMes === 1 ? 'pedido' : 'pedidos'} sem vendedor
              </div>
            )}
          </>
        )
      : undefined;
  const escopoSub = `pedidos Omie · ${escopo}`;
  const metaQ = useMetaPotencial();
  const meta = metaQ.data ? agregarMeta(metaQ.data, selection) : null;
  const mesSub: ReactNode = isError ? (
    'indisponível'
  ) : (
    <>
      {data && trendMoM(data.variacaoMes)}
      {linhaMeta(meta, metaQ.isLoading, metaQ.isError)}
      <div>{escopoSub}</div>
    </>
  );

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-3">
        <Tile icon={Users} label="Vendedores com pedido · mês" value={vendedores} sub={vendedoresSub} />
        <Tile icon={Briefcase} label="Receita time · hoje" value={receita(data?.receitaHoje)} sub={isError ? 'indisponível' : escopoSub} />
        <Tile icon={CalendarRange} label="Receita time · mês" value={receita(data?.receitaMes)} sub={mesSub} />
      </div>
      {meta && !meta.semLinhas && <MetaPotencialDetalhe m={meta} escopo={escopo} />}
    </div>
  );
}
