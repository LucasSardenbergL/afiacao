import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCashflowProjection } from '@/hooks/useCashflowProjection';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';
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

export function CicloEmpresaCard({ company, coorte, receitaDia, receitaMeses, receitaErro, resumo, resumoErro, hoje, cpEmpresa, cpErro }: {
  company: Company; coorte: CoorteMes[]; receitaDia: number | null; receitaMeses?: number; receitaErro?: boolean;
  resumo: ResumoCliente[] | undefined; resumoErro?: boolean; hoje: string; cpEmpresa?: CpEmpresa; cpErro?: boolean;
}) {
  const { data, error, isLoading } = useCashflowProjection(company);
  const ind = error ? null : data?.indicadores;
  const motivos = error ? [] : data?.confianca_dados?.motivos ?? [];
  const meses = coorte.filter((m) => m.company === company);
  const concedido = pond(meses, 'prazoConcedido');
  const real = pond(meses, 'prazoReal');
  const pmr = ind?.prazo_medio_recebimento ?? null;
  const divergem = pmr !== null && real !== null && Math.abs(pmr - real) > 3;
  const cob = resumo === undefined ? null : coberturaPorValor(resumo, company, hoje);
  const cobTexto = resumoErro ? '— (erro de leitura)' : cob === null ? '— (carregando)' : cob.ok ? `${cob.pct.toFixed(0)}%` : `— (${cob.motivo})`;
  const valores: Array<[string, number | null | undefined]> = [
    ['PME', ind?.prazo_medio_estoque],
    ['PMR', ind?.prazo_medio_recebimento],
    ['PMP', ind?.prazo_medio_pagamento],
    ['Ciclo', ind?.cash_conversion_cycle],
  ];
  return (
    <Card data-testid={`ciclo-card-${company}`}>
      <CardHeader className="pb-2"><CardTitle className="text-sm">{COMPANIES[company].shortName}</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-4 gap-2 text-center">
          {valores.map(([rotulo, v]) => (
            <div key={rotulo}>
              <div className="text-xs text-muted-foreground">{rotulo}</div>
              <div className="font-mono text-lg">{isLoading ? '…' : dias(v)}</div>
            </div>
          ))}
        </div>
        <div className="text-xs text-muted-foreground">
          1 dia de PMR = {receitaErro ? '— (erro de leitura da receita TTM)' : receitaDia === null ? '— (sem receita TTM)' : brl(receitaDia)}
          {receitaDia !== null && receitaMeses !== undefined && receitaMeses < 12 && ` (base: ${receitaMeses} de 12 meses)`}
        </div>
        {cpErro
          ? <div className="text-xs text-status-error">PMP de compras: — (erro de leitura)</div>
          : cpEmpresa && <LinhaPmpCompras cp={cpEmpresa} />}
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
