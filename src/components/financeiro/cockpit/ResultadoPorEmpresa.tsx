// Card "Resultado por Empresa (último mês)" — DRE consolidado regime-aware.
// Extraído verbatim de src/pages/FinanceiroCockpit.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart3 } from 'lucide-react';
import { COMPANIES, type Company } from '@/contexts/CompanyContext';
import type { FinDRE } from '@/services/financeiroService';
import { fmt, fmtCompact, IMPOSTO_LABEL } from './format';
import type { FinConfiabilidadeRow } from './types';

interface ResultadoPorEmpresaProps {
  dreConsolidado: FinDRE[];
  confiabilidade: FinConfiabilidadeRow[];
}

export function ResultadoPorEmpresa({ dreConsolidado, confiabilidade }: ResultadoPorEmpresaProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="w-4 h-4" />
          Resultado por Empresa (último mês)
          <Badge variant="outline" className="text-[10px]">Regime de Caixa</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {dreConsolidado.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sem DRE calculado. Recalcule na aba DRE.</p>
        ) : (
          <div className="space-y-3">
            {dreConsolidado.map(d => {
              const mg = d.receita_liquida > 0 ? (d.lucro_bruto / d.receita_liquida) * 100 : 0;
              const conf = confiabilidade.find(c => c.company === d.company);
              const impostos = Object.entries(d.detalhamento?.impostos ?? {});
              return (
                <div key={d.company} className="p-3 rounded-lg bg-muted/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge variant="outline">{COMPANIES[d.company as Company]?.shortName}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][d.mes - 1]}
                      </span>
                      {d.detalhamento?.regime_tributario && (
                        <Badge variant="outline" className="text-[9px] capitalize">{d.detalhamento.regime_tributario}</Badge>
                      )}
                      {d.detalhamento?.caixa_estimado && (
                        <span className="text-xs text-status-warning">caixa estimado</span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-sm">
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">Receita</p>
                        <p className="font-medium">{fmtCompact(d.receita_liquida)}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">MB</p>
                        <p className={`font-bold ${mg >= 30 ? 'text-status-success' : 'text-status-warning'}`}>{mg.toFixed(1)}%</p>
                      </div>
                      <div className="text-right">
                        <p className="text-[10px] text-muted-foreground">Resultado</p>
                        <p className={`font-bold ${d.resultado_liquido >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                          {fmtCompact(d.resultado_liquido)}
                        </p>
                      </div>
                      {conf && (
                        <div className="text-right">
                          <p className="text-[10px] text-muted-foreground">Mapeado</p>
                          <p className={`text-xs font-medium ${(conf.pct_valor_mapeado || 0) >= 80 ? 'text-status-success' : 'text-status-warning'}`}>
                            {(conf.pct_valor_mapeado || 0).toFixed(0)}%
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Confiança banner quando confiança não é 'alta' */}
                  {d.detalhamento?.confianca && d.detalhamento.confianca.nivel !== 'alta' && (
                    <div className="rounded-md border p-2 text-xs text-status-warning">
                      Confiança <strong>{d.detalhamento.confianca.nivel}</strong>:
                      <ul className="list-disc ml-4">
                        {d.detalhamento.confianca.motivos.map((m, i) => <li key={i}>{m}</li>)}
                      </ul>
                    </div>
                  )}
                  {/* Deduções de impostos regime-aware */}
                  {impostos.length > 0 && (
                    <div className="border-t pt-2 space-y-0.5">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Deduções / Impostos</p>
                      {impostos.map(([k, v]) => (
                        <div key={k} className="flex justify-between text-sm">
                          <span className="text-muted-foreground">{IMPOSTO_LABEL[k] ?? k}</span>
                          <span className="tabular-nums">{fmt(v as number)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {d.detalhamento?.imposto_teorico && (
                    <div className="text-xs text-muted-foreground mt-1">
                      Imposto teórico esperado: {fmt(Object.values(d.detalhamento.imposto_teorico).reduce((s: number, v) => s + (v ?? 0), 0))}
                      {d.detalhamento.delta_imposto_pct != null && (
                        <span className={Math.abs(d.detalhamento.delta_imposto_pct) > 0.25 ? 'text-status-warning ml-1' : 'ml-1'}>
                          (Δ {(d.detalhamento.delta_imposto_pct * 100).toFixed(0)}% vs realizado)
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
