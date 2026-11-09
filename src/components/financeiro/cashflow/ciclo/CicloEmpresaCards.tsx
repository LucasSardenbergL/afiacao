import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCashflowProjection } from '@/hooks/useCashflowProjection';
import { filaCicloEdge, retryDelayCiclo } from '@/lib/financeiro/ciclo-fila';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import type { CoorteMes, ReguaEmpresa } from '@/hooks/useFinanceiroCiclo';
import { dsoPontual, pmeEstoqueMedio } from '@/lib/financeiro/regua-ciclo-helpers';
import type { CpEmpresa } from '@/hooks/useFinanceiroCicloFornecedor';
import type { ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';
import { brl, coberturaPorValor, dias } from './ciclo-format';

/** Média ponderada pelo valor pago; sem peso → null (nunca 0). */
function pond(meses: CoorteMes[], campo: 'prazoConcedido' | 'prazoReal') {
  let s = 0;
  let w = 0;
  for (const m of meses) {
    const v = m[campo];
    if (v !== null && m.valorPago > 0) { s += v * m.valorPago; w += m.valorPago; }
  }
  return w > 0 ? s / w : null;
}

/** Ponte PMP do motor → PMP de COMPRAS (só mercadoria, matéria-prima, frete e serviço de compra). R$ de 1 dia sobre
 *  compras, não CMV. É cenário de caixa — prazo com fornecedor tem preço, então não é meta de alongar. */
export function LinhaPmpCompras({ cp }: { cp: CpEmpresa }) {
  const pmp = cp.pmpComprasPond === null ? '—' : `${cp.pmpComprasPond.toFixed(1).replace('.', ',')} d`;
  return (
    <div className="text-xs text-muted-foreground" data-testid="ciclo-pmp-compras" title="O PMP acima inclui imposto, empréstimo e folha; o de compras não.">
      {cp.pmpEngineControle !== null && `PMP do motor ${cp.pmpEngineControle.toFixed(0)} d → `}PMP de compras: {pmp} · pagar 1 dia antes consome ≈ {brl(cp.rsPorDia)} de caixa; 1 dia depois retém ≈ {brl(cp.rsPorDia)} · cenário
    </div>
  );
}

const TOOLTIP_PMR_DSO = 'PMR = só títulos PAGOS (média ponderada pelo valor baixado; vencido não entra). '
  + 'DSO = carteira ABERTA toda (a vencer + vencido) ÷ receita de competência TTM × 365. Bases distintas: não compare um com o outro.';
const TOOLTIP_CICLO = 'Ciclo = PME + PMR − PMP soma bases distintas: foto do estoque de giro, prazo só dos títulos pagos e CP total. É régua, não medida.';

/** Hora:minuto e dia/mês de SP de um instante ISO; vazio se inválido. */
function quandoSp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function CicloEmpresaCard({ company, coorte, receitaDia, receitaMeses, receitaErro, resumo, resumoErro, hoje, cpEmpresa, cpErro, regua, reguaErro, crAberto, crErro }: {
  company: Company; coorte: CoorteMes[]; receitaDia: number | null; receitaMeses?: number; receitaErro?: boolean;
  resumo: ResumoCliente[] | undefined; resumoErro?: boolean; hoje: string; cpEmpresa?: CpEmpresa; cpErro?: boolean;
  regua?: ReguaEmpresa; reguaErro?: boolean; crAberto?: number | null; crErro?: boolean;
}) {
  const { data, error, isLoading } = useCashflowProjection(company, 'realista', 13, { fila: filaCicloEdge, retryDelay: retryDelayCiclo });
  const ind = error ? null : data?.indicadores;
  const motivos = error ? [] : data?.confianca_dados?.motivos ?? [];
  const meses = coorte.filter((m) => m.company === company);
  const concedido = pond(meses, 'prazoConcedido');
  const real = pond(meses, 'prazoReal');
  const pmr = ind?.prazo_medio_recebimento ?? null;
  const divergem = pmr !== null && real !== null && Math.abs(pmr - real) > 3;
  const cob = resumo === undefined ? null : coberturaPorValor(resumo, company, hoje);
  const cobTexto = resumoErro ? '— (erro de leitura)' : cob === null ? '— (carregando)' : cob.ok ? `${cob.pct.toFixed(0)}%` : `— (${cob.motivo})`;
  const estoqueTexto = !ind || ind.estoque_fonte === undefined ? null
    : ind.estoque_fonte === null || ind.estoque_valor == null ? '— (sem fonte de estoque)'
    : `${brl(ind.estoque_valor)} (${ind.estoque_fonte === 'omie' ? 'Omie, agora' : `manual, ${(ind.estoque_data_ref ?? '').split('-').reverse().slice(0, 2).join('/')}`})`;
  // Régua honesta (Frente A): DSO da carteira toda ao lado do PMR dos pagos; PME em R$/dia = CMV TTM ÷ 365.
  // DSO depende SÓ de CR aberto + receita TTM: erro na régua de estoque não o apaga (Codex, 2026-10-31).
  const dsoCarregando = crAberto === undefined && !crErro;
  const dso = crErro ? { dias: null, motivo: 'erro de leitura da carteira' }
    : receitaErro ? { dias: null, motivo: 'erro de leitura da receita TTM' }
    : dsoPontual(crAberto === undefined ? null : crAberto, receitaDia, receitaMeses);
  const cmvDia = regua?.cmvTtm.valor == null ? null : regua.cmvTtm.valor / 365;
  const pmeMedio = regua ? pmeEstoqueMedio(regua.estoqueSerie, regua.cmvTtm.valor, hoje) : null;
  const valores: Array<[string, number | null | undefined, string | undefined]> = [
    ['PME', ind?.prazo_medio_estoque, undefined],
    ['PMR', ind?.prazo_medio_recebimento, TOOLTIP_PMR_DSO],
    ['DSO', dsoCarregando ? undefined : dso.dias, TOOLTIP_PMR_DSO],
    ['PMP', ind?.prazo_medio_pagamento, undefined],
    ['Ciclo', ind?.cash_conversion_cycle, TOOLTIP_CICLO],
  ];
  return (
    <Card data-testid={`ciclo-card-${company}`}>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{COMPANIES[company].shortName}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-5 gap-2 text-center">
          {valores.map(([rotulo, v, dica]) => (
            <div key={rotulo} title={dica} data-testid={`ciclo-${rotulo.toLowerCase()}-${company}`}>
              <div className="text-xs text-muted-foreground">{rotulo}{rotulo === 'Ciclo' && <span className="block text-[10px] leading-tight">soma de bases distintas</span>}</div>
              <div className="font-mono text-lg">{(rotulo === 'DSO' ? v === undefined : isLoading) ? '…' : dias(v)}</div>
            </div>
          ))}
        </div>
        {!dsoCarregando && dso.dias === null && dso.motivo && (
          <div className="text-xs text-muted-foreground" data-testid={`ciclo-dso-motivo-${company}`}>DSO: — ({dso.motivo})</div>
        )}
        <div className="text-xs text-muted-foreground">
          1 dia de PMR = {receitaErro ? '— (erro de leitura da receita TTM)' : receitaDia === null ? '— (sem receita TTM)' : brl(receitaDia)}
          {receitaDia !== null && receitaMeses !== undefined && receitaMeses < 12 && ` (base: ${receitaMeses} de 12 meses)`}
        </div>
        {cpErro
          ? <div className="text-xs text-status-error">PMP de compras: — (erro de leitura)</div>
          : cpEmpresa && <LinhaPmpCompras cp={cpEmpresa} />}
        <div className="text-xs text-muted-foreground" data-testid={`ciclo-pme-dia-${company}`}>
          1 dia de PME = {reguaErro ? '— (erro de leitura do CMV)' : regua === undefined ? '…' : cmvDia === null ? `— (${regua.cmvTtm.motivo ?? 'sem CMV TTM'})` : `${brl(cmvDia)} de CMV`}
        </div>
        {estoqueTexto !== null && (
          <div className="text-xs text-muted-foreground" data-testid={`ciclo-estoque-${company}`}>
            Estoque de giro (base do PME): {estoqueTexto}
            {regua && regua.estoqueSyncEm !== null && ` · sync ${quandoSp(regua.estoqueSyncEm)}`}
            {regua && regua.estoqueSyncEm === null && ' · sem sync registrado'}
            {regua && regua.custoCobertura.pct !== null && ` · custo cobre ${regua.custoCobertura.pct.toFixed(0)}% dos SKUs de giro`}
            {regua && regua.custoCobertura.pct === null && ' · cobertura de custo não lida'}
          </div>
        )}
        {(pmeMedio || reguaErro) && (
          <div className="text-xs text-muted-foreground" data-testid={`ciclo-pme-medio-${company}`}>
            PME pelo estoque médio 90 d: {reguaErro || !pmeMedio ? '— (erro de leitura)'
              : pmeMedio.pme === null ? `— (${pmeMedio.motivo})`
              : `${dias(pmeMedio.pme)} (média ${brl(pmeMedio.estoqueMedio)}, ${pmeMedio.diasCobertos} dias desde ${(pmeMedio.desde ?? '').split('-').reverse().join('/')})`}
          </div>
        )}
        <div className="text-xs text-muted-foreground" data-testid={`ciclo-cobertura-${company}`}>
          Cobertura: {cobTexto} do valor pago vem de clientes com confiança média
        </div>
        {concedido !== null && real !== null && (
          <div className="text-xs">
            Prazo concedido {concedido.toFixed(1)}d → real {real.toFixed(1)}d
            <span className={real - concedido > 0 ? 'text-status-warning' : 'text-status-success'}>
              {' '}({real - concedido >= 0 ? '+' : ''}{(real - concedido).toFixed(1)}d de atraso)
            </span>
          </div>
        )}
        {divergem && <div className="text-xs text-status-warning">Fontes divergem: motor {dias(pmr)} × coorte {dias(real)}</div>}
        {error && <div className="text-xs text-status-error">Motor de caixa indisponível para esta empresa</div>}
        {motivos.length > 0 && <div className="text-xs text-muted-foreground">{motivos.join(' · ')}</div>}
        {company === 'colacor_sc' && (
          <div className="text-xs text-muted-foreground">Serviços — poucos documentos por cliente; leitura majoritariamente de baixa confiança.</div>
        )}
      </CardContent>
    </Card>
  );
}
