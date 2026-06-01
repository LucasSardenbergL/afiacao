// src/pages/FinanceiroValor.tsx
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useValor } from '@/hooks/useValor';
import { ValorInputsDialog } from '@/components/financeiro/ValorInputsDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import type { ValorEmpresaResult } from '@/services/financeiroService';

const EMPRESAS = ['colacor', 'oben', 'colacor_sc'] as const;
const NOME: Record<string, string> = { colacor: 'Colacor', oben: 'Oben', colacor_sc: 'Colacor SC' };

const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const brl = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
const dataBR = (iso: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—');

function nivelClasses(n: 'alta' | 'media' | 'baixa') {
  if (n === 'alta') return 'text-status-success bg-status-success-bg';
  if (n === 'media') return 'text-status-warning bg-status-warning-bg';
  return 'text-status-error bg-status-error-bg';
}

function EmpresaCard({ company, modo }: { company: string; modo: 'reportado' | 'normalizado' }) {
  const { data, isLoading, error } = useValor(company);
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <Card><CardContent className="py-6 text-sm text-status-error">Erro ao carregar {NOME[company]}: {error instanceof Error ? error.message : String(error)}</CardContent></Card>;
  if (!data) return null;
  const v = modo === 'normalizado' ? data.normalizado : data.reportado;
  const roic = v.roic; const spreadV = v.spread; const evaV = v.eva;
  const wacc = data.reportado.wacc; // WACC é o mesmo nos dois modos
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{NOME[company]} <span className="text-xs text-muted-foreground">({data.regime})</span></CardTitle>
        <span className={`text-xs px-2 py-0.5 rounded ${nivelClasses(data.confianca.nivel)}`}>confiança {data.confianca.nivel}</span>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <span className="text-muted-foreground">ROIC</span><span className="kpi-value text-right">{pct(roic)}</span>
          <span className="text-muted-foreground">WACC (hurdle)</span><span className="text-right">{pct(wacc)}</span>
          <span className="text-muted-foreground">Spread</span><span className={`text-right ${spreadV != null && spreadV < 0 ? 'text-status-error' : 'text-status-success'}`}>{pct(spreadV)}</span>
          <span className="text-muted-foreground">EVA</span><span className="text-right">{brl(evaV)}</span>
          <span className="text-muted-foreground">NOPAT (TTM)</span><span className="text-right">{brl(v.nopat)}</span>
          <span className="text-muted-foreground">Capital investido</span><span className="text-right">{brl(v.capital_investido)}{data.reportado.capital_parcial && !data.reportado.giro_indisponivel && modo === 'reportado' ? ' *' : ''}</span>
          {modo === 'reportado' && (<><span className="text-muted-foreground">Margem op. pré-imposto</span><span className="text-right">{pct(data.reportado.margem_operacional_pre_imposto)}</span></>)}
          <span className="text-muted-foreground">ROIC incremental</span><span className="kpi-value text-right">{pct(data.reportado.roic_incremental)}</span>
        </div>
        {data.reportado.giro_indisponivel && modo === 'reportado' && <p className="text-xs text-status-warning">Sem snapshot de NCG — capital de giro indisponível (rode a projeção de caixa). ROIC/EVA não calculáveis.</p>}
        {data.reportado.capital_parcial && !data.reportado.giro_indisponivel && modo === 'reportado' && <p className="text-xs text-status-warning">* capital parcial (sem ativo fixo)</p>}
        {modo === 'reportado' && data.reportado.giro_snapshot_at && (
          <p className={`text-xs ${data.reportado.giro_dias != null && data.reportado.giro_dias > 45 ? 'text-status-warning' : 'text-muted-foreground'}`}>
            NCG de {dataBR(data.reportado.giro_snapshot_at)}{data.reportado.giro_dias != null && data.reportado.giro_dias > 1 ? ` (${data.reportado.giro_dias}d atrás)` : ''}
          </p>
        )}
        {data.reportado.incremental.aviso && <p className="text-xs text-muted-foreground">{data.reportado.incremental.aviso}</p>}
        {modo === 'normalizado' && !data.normalizado.aplicado && <p className="text-xs text-status-warning">Sem inputs de normalização — igual ao reportado.</p>}
        {modo === 'normalizado' && data.normalizado.nopat_aproximado && <p className="text-xs text-muted-foreground">NOPAT normalizado é aproximado: o imposto absoluto (IRPJ+CSLL) não é recalculado sobre o EBIT ajustado.</p>}
        {data.confianca.motivos.length > 0 && (
          <details className="text-xs text-muted-foreground"><summary>Por que essa confiança?</summary><ul className="list-disc pl-4 mt-1">{data.confianca.motivos.map((m, i) => <li key={i}>{m}</li>)}</ul></details>
        )}
        <ValorInputsDialog company={company} atual={data.valor_inputs} />
      </CardContent>
    </Card>
  );
}

function Ranking({ modo }: { modo: 'reportado' | 'normalizado' }) {
  // Hooks chamados individualmente (regra dos hooks: não chamar dentro de .map())
  const qColacor = useValor('colacor');
  const qOben = useValor('oben');
  const qColacorSc = useValor('colacor_sc');
  const queries: Array<{ company: string; q: ReturnType<typeof useValor> }> = [
    { company: 'colacor', q: qColacor },
    { company: 'oben', q: qOben },
    { company: 'colacor_sc', q: qColacorSc },
  ];
  const rows: Array<{ company: string; incr: number | null; spread: number | null }> = queries.map(({ company, q }) => ({
    company,
    incr: (q.data as ValorEmpresaResult | undefined)?.reportado.roic_incremental ?? null,
    spread: (q.data as ValorEmpresaResult | undefined)?.[modo].spread ?? null,
  }));
  const byIncr = [...rows].sort((a, b) => (b.incr ?? -Infinity) - (a.incr ?? -Infinity));
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Ranking — onde o próximo R$1 rende mais</CardTitle></CardHeader>
      <CardContent className="text-sm space-y-1">
        {byIncr.map((row, i) => (
          <div key={row.company} className="flex justify-between border-b border-border py-1 last:border-0">
            <span>{i + 1}. {NOME[row.company]}</span>
            <span className="font-mono">ROIC incr. {pct(row.incr)} · spread {pct(row.spread)}</span>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-2">ROIC incremental = ΔNOPAT / Δcapital (TTM atual vs −12m). "—" = histórico insuficiente ou Δcapital pequeno/negativo.</p>
      </CardContent>
    </Card>
  );
}

export default function FinanceiroValor() {
  const { isMaster } = useAuth();
  const [modo, setModo] = useState<'reportado' | 'normalizado'>('reportado');
  if (!isMaster) {
    return <div className="p-6"><Card><CardContent className="py-8 text-center text-sm text-muted-foreground">Acesso restrito — Retorno &amp; Valor é visível apenas para master.</CardContent></Card></div>;
  }
  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl">Retorno &amp; Valor</h1>
          <p className="text-sm text-muted-foreground">ROIC, WACC (hurdle-rate), EVA e spread por empresa — alocação de capital entre Colacor, Oben e Colacor SC.</p>
        </div>
        <div className="flex gap-2">
          <Button variant={modo === 'reportado' ? 'default' : 'outline'} size="sm" onClick={() => setModo('reportado')}>Reportado</Button>
          <Button variant={modo === 'normalizado' ? 'default' : 'outline'} size="sm" onClick={() => setModo('normalizado')}>Normalizado</Button>
        </div>
      </div>
      <Ranking modo={modo} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {EMPRESAS.map((c) => <EmpresaCard key={c} company={c} modo={modo} />)}
      </div>
      <p className="text-xs text-muted-foreground">
        Direcional: melhora a decisão de alocação de capital, mas leases/quase-dívida, capex de manutenção × crescimento, eliminação intercompany e registro automático de ativo fixo estão deferidos (ver spec A2).
      </p>
    </div>
  );
}
