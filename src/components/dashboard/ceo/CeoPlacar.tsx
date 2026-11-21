/**
 * Placar da "Visão do CEO": 5 números que respondem quanto o grupo vendeu, com que margem e
 * quanto dinheiro a operação tem e exige. KPIs e ordem: parecer Codex 2026-11-20.
 *
 * - Vendas em pedidos MTD vs mesmos dias do mês anterior (`useTeamKpis`, segue o seletor). É
 *   PEDIDO, não receita contábil — o rótulo diz isso.
 * - Margem bruta do último mês fechado comum (DRE, regime visível).
 * - Saldo bancário líquido (soma dos CNPJs) + quais CNPJs estão negativos — caixa não é
 *   fungível entre CNPJs, então o total nunca aparece sozinho como "disponível".
 * - Recebíveis vencidos em R$ e % da carteira aberta.
 * - NCG (necessidade de capital de giro) com data do snapshot; a leitura do sinal (folga ×
 *   capital preso) só aparece com a NCG completa — sem estoque até o sinal pode virar.
 *
 * Ausente ≠ zero em todos: leitura que falha ou CNPJ faltando → "—". Falha de leitura diz
 * "leitura falhou" (nunca se disfarça de "sem dado"); CMV zerado → margem "—" com o motivo.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';
import { useCompany, COMPANIES, type Company } from '@/contexts/CompanyContext';
import { useTeamKpis } from '@/hooks/useTeamKpis';
import { useCeoPlacar } from '@/components/financeiro/cockpit/useCeoPlacar';
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';
import { formatarBRLCompacto } from '@/lib/dashboard/ceo-formato';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

type KpiId = 'vendas' | 'margem' | 'caixa' | 'vencidos' | 'ncg';

function Kpi({
  id,
  rotulo,
  valor,
  titulo,
  detalhe,
  para,
  carregando,
}: {
  id: KpiId;
  rotulo: string;
  valor: string;
  titulo?: string;
  detalhe?: ReactNode;
  para: string;
  carregando: boolean;
}) {
  return (
    <Link
      to={para}
      onClick={() => track('dashboard.ceo.kpi_click', { kpi: id })}
      className="group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`ceo-kpi-${id}`}
    >
      <Card className="h-full p-4 transition-colors group-hover:border-foreground/20">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">{rotulo}</div>
        <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight" title={titulo}>
          {carregando ? '…' : valor}
        </div>
        {detalhe && !carregando && <div className="mt-1 text-2xs leading-snug text-muted-foreground">{detalhe}</div>}
      </Card>
    </Link>
  );
}

function Variacao({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <>sem base no mês anterior</>;
  if (v === 0) return <>= mesmos dias do mês anterior</>;
  return (
    <>
      <span className={cn('font-medium', v > 0 ? 'text-status-success' : 'text-status-error')}>
        {v > 0 ? '▲' : '▼'} {formatarFracaoPct(Math.abs(v))}
      </span>{' '}
      vs mesmos dias do mês anterior
    </>
  );
}

function rotuloMes(mes: number | null): string {
  return mes === null ? '' : MESES[mes - 1];
}

function nomes(empresas: readonly Company[]): string {
  return empresas.map((e) => COMPANIES[e].shortName).join(', ');
}

/** NCG ≤ 0 = passivo operacional financia o giro (mesma régua do cockpit financeiro). */
function leituraNcg(valor: number, completa: boolean): string {
  if (!completa) return 'parcial · snapshot sem estoque';
  return valor <= 0 ? 'folga: fornecedores financiam o giro' : 'capital preso no giro';
}

function dataCurta(iso: string | null): string {
  if (!iso) return '';
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
}

export function CeoPlacar() {
  const { selection, companyInfo } = useCompany();
  const vendas = useTeamKpis();
  const p = useCeoPlacar();
  const escopo = selection === 'all' ? 'Grupo (3 empresas)' : companyInfo.shortName;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi
          id="vendas"
          rotulo="Vendas no mês · pedidos"
          valor={vendas.isError ? '—' : formatarBRLCompacto(vendas.data?.receitaMes)}
          titulo={vendas.data ? formatBRL(vendas.data.receitaMes) : undefined}
          detalhe={vendas.isError ? 'leitura falhou' : <Variacao v={vendas.data?.variacaoMes} />}
          para="/meu-dia"
          carregando={vendas.isLoading}
        />
        <Kpi
          id="margem"
          rotulo="Margem bruta"
          valor={formatarFracaoPct(p.margem.valor)}
          detalhe={
            p.erro.dre
              ? 'leitura da DRE falhou'
              : p.margem.semCmv.length > 0
                ? `${rotuloMes(p.margem.mes)}: CMV não classificado em ${nomes(p.margem.semCmv)}`
                : p.margem.mes === null
                  ? 'sem mês anterior com receita em todas'
                  : `${rotuloMes(p.margem.mes)} · DRE ${p.regime === 'caixa' ? 'caixa' : 'competência'}`
          }
          para="/financeiro/cockpit"
          carregando={p.carregando.dre}
        />
        <Kpi
          id="caixa"
          rotulo={selection === 'all' ? 'Saldo bancário líquido' : 'Saldo bancário'}
          valor={formatarBRLCompacto(p.caixa.saldo)}
          titulo={p.caixa.saldo === null ? undefined : formatBRL(p.caixa.saldo)}
          detalhe={
            p.erro.resumo
              ? 'leitura falhou'
              : p.caixa.saldo === null
                ? 'saldo de alguma conta indisponível'
                : p.caixa.empresasNegativas.length > 0
                  ? (
                      <span className="text-status-warning">
                        {selection === 'all' ? `compensa saldo negativo: ${nomes(p.caixa.empresasNegativas)}` : 'conta no negativo'}
                      </span>
                    )
                  : 'soma das contas bancárias'
          }
          para="/financeiro/cockpit"
          carregando={p.carregando.resumo}
        />
        <Kpi
          id="vencidos"
          rotulo="Recebíveis vencidos"
          valor={formatarBRLCompacto(p.vencidos.valor)}
          titulo={p.vencidos.valor === null ? undefined : formatBRL(p.vencidos.valor)}
          detalhe={
            p.erro.resumo
              ? 'leitura falhou'
              : p.vencidos.pct === null
                ? 'títulos indisponíveis'
                : `${formatarFracaoPct(p.vencidos.pct)} da carteira aberta`
          }
          para="/financeiro/cockpit"
          carregando={p.carregando.resumo}
        />
        <Kpi
          id="ncg"
          rotulo="Capital de giro (NCG)"
          valor={formatarBRLCompacto(p.ncg.valor)}
          titulo={p.ncg.valor === null ? undefined : formatBRL(p.ncg.valor)}
          detalhe={
            p.erro.ncg
              ? 'leitura falhou'
              : p.ncg.valor === null
                ? 'snapshot ausente em alguma empresa'
                : `${leituraNcg(p.ncg.valor, p.ncg.completa)} · ${dataCurta(p.ncg.dataReferencia)}`
          }
          para="/financeiro/capital-giro"
          carregando={p.carregando.ncg}
        />
      </div>

      {p.porEmpresa.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums" data-testid="ceo-por-empresa">
            <caption className="sr-only">Placar por empresa</caption>
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 text-left font-normal">Empresa</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">Margem bruta</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">Caixa</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">Vencidos</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">NCG</th>
              </tr>
            </thead>
            <tbody>
              {p.porEmpresa.map((l) => (
                <tr key={l.empresa} className="border-b border-border last:border-0">
                  <th scope="row" className="px-4 py-2 text-left font-medium">{COMPANIES[l.empresa].shortName}</th>
                  <td className="px-4 py-2 text-right">
                    {l.margem.semCmv.length > 0 ? (
                      <span className="text-status-warning" title="CMV não classificado no mês — margem não calculada">sem CMV</span>
                    ) : (
                      formatarFracaoPct(l.margem.valor)
                    )}
                    {l.margem.mes !== null && <span className="ml-1 text-muted-foreground">{rotuloMes(l.margem.mes)}</span>}
                  </td>
                  <td className={cn('px-4 py-2 text-right', l.caixa.saldo !== null && l.caixa.saldo < 0 && 'text-status-warning')}>
                    {formatarBRLCompacto(l.caixa.saldo)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatarBRLCompacto(l.vencidos.valor)}
                    {l.vencidos.pct !== null && (
                      <span className="ml-1 text-muted-foreground">{formatarFracaoPct(l.vencidos.pct)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatarBRLCompacto(l.ncg.valor)}
                    {l.ncg.valor !== null && !l.ncg.completa && <span className="ml-1 text-muted-foreground">parcial</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <p className="text-2xs text-muted-foreground">
        Escopo: {escopo}. Todos os números seguem o seletor de empresa; o cockpit financeiro de destino mostra o grupo.
      </p>
    </div>
  );
}
