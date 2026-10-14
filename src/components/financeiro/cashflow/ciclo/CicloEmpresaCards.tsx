import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCashflowProjection } from '@/hooks/useCashflowProjection';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import type { CoorteMes } from '@/hooks/useFinanceiroCiclo';
import { brl, dias } from './ciclo-format';

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

export function CicloEmpresaCard({ company, coorte, receitaDia }: { company: Company; coorte: CoorteMes[]; receitaDia: number | null }) {
  const { data, error, isLoading } = useCashflowProjection(company);
  const ind = error ? null : data?.indicadores;
  const motivos = error ? [] : data?.confianca_dados?.motivos ?? [];
  const meses = coorte.filter((m) => m.company === company);
  const concedido = pond(meses, 'prazoConcedido');
  const real = pond(meses, 'prazoReal');
  const pmr = ind?.prazo_medio_recebimento ?? null;
  const divergem = pmr !== null && real !== null && Math.abs(pmr - real) > 3;
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
          1 dia de PMR = {receitaDia === null ? '— (sem receita TTM)' : brl(receitaDia)}
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
