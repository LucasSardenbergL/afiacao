// Card de projeção de caixa de 30 dias (KPIs + waterfall + alerta).
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Target, AlertTriangle } from 'lucide-react';
import type { CapitalDeGiro } from '@/services/financeiroService';
import { fmtCompact } from './format';
import { WaterfallBar } from './WaterfallBar';

export function Projecao30dCard({ active }: { active: CapitalDeGiro }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Target className="w-4 h-4" />
          Projeção de Caixa — Próximos 30 dias
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div className="p-3 rounded-lg bg-status-info-bg">
              <p className="text-xs text-muted-foreground">Saldo Atual CC</p>
              <p className="text-lg font-bold text-status-info">{fmtCompact(active.saldo_cc)}</p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground">Fluxo Líquido 30d</p>
              <p className={`text-lg font-bold ${active.entradas_30d - active.saidas_30d >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                {fmtCompact(active.entradas_30d - active.saidas_30d)}
              </p>
            </div>
            <div className={`p-3 rounded-lg ${active.saldo_projetado_30d >= 0 ? 'bg-status-success-bg' : 'bg-status-error-bg'}`}>
              <p className="text-xs text-muted-foreground">Saldo Projetado</p>
              <p className={`text-lg font-bold ${active.saldo_projetado_30d >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                {fmtCompact(active.saldo_projetado_30d)}
              </p>
            </div>
          </div>

          {/* Waterfall visual */}
          <div className="flex items-end justify-center gap-2 h-32">
            <WaterfallBar label="CC Atual" value={active.saldo_cc} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color="bg-status-info" />
            <WaterfallBar label="Entradas" value={active.entradas_30d} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color="bg-status-success" />
            <WaterfallBar label="Saídas" value={active.saidas_30d} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color="bg-status-error" />
            <WaterfallBar label="Projetado" value={active.saldo_projetado_30d} max={Math.max(active.saldo_cc, active.saldo_projetado_30d, active.entradas_30d)} color={active.saldo_projetado_30d >= 0 ? 'bg-status-success' : 'bg-status-error'} />
          </div>

          {active.saldo_projetado_30d < 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-status-error-bg border border-status-error/30">
              <AlertTriangle className="w-4 h-4 text-status-error mt-0.5" />
              <div>
                <p className="text-sm font-medium text-status-error-fg">Projeção negativa</p>
                <p className="text-xs text-status-error mt-1">
                  Déficit projetado de {fmtCompact(Math.abs(active.saldo_projetado_30d))} nos próximos 30 dias.
                  Ação necessária: antecipar recebíveis, renegociar prazos de CP, ou injetar capital.
                </p>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
