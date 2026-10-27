// Card de projeção de caixa de 30 dias (KPIs + waterfall + alerta).
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Target, AlertTriangle } from 'lucide-react';
import type { CapitalDeGiro } from '@/services/financeiroService';
import { fmtCompact } from './format';
import { WaterfallBar } from './WaterfallBar';

export function Projecao30dCard({ active }: { active: CapitalDeGiro }) {
  // Saldo CC indisponível (sem extrato fresco) → o projetado também: "—" + motivo, sem barra de
  // CC/Projetado e sem alerta de déficit — nunca projeção montada sobre um R$ 0 fabricado.
  const cc = active.saldo_cc;
  const projetado = active.saldo_projetado_30d;
  const max = Math.max(cc ?? 0, projetado ?? 0, active.entradas_30d);
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
              <p className={`text-lg font-bold ${cc == null ? 'text-muted-foreground' : 'text-status-info'}`}>
                {cc == null ? '—' : fmtCompact(cc)}
              </p>
            </div>
            <div className="p-3 rounded-lg bg-muted/50">
              <p className="text-xs text-muted-foreground">Fluxo Líquido 30d</p>
              <p className={`text-lg font-bold ${active.entradas_30d - active.saidas_30d >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                {fmtCompact(active.entradas_30d - active.saidas_30d)}
              </p>
            </div>
            <div className={`p-3 rounded-lg ${projetado == null ? 'bg-muted/50' : projetado >= 0 ? 'bg-status-success-bg' : 'bg-status-error-bg'}`}>
              <p className="text-xs text-muted-foreground">Saldo Projetado</p>
              <p className={`text-lg font-bold ${projetado == null ? 'text-muted-foreground' : projetado >= 0 ? 'text-status-success' : 'text-status-error'}`}>
                {projetado == null ? '—' : fmtCompact(projetado)}
              </p>
            </div>
          </div>

          {active.saldo_cc_motivo && (
            <p className="text-xs text-muted-foreground">{active.saldo_cc_motivo}</p>
          )}

          {/* Waterfall visual */}
          <div className="flex items-end justify-center gap-2 h-32">
            {cc != null && <WaterfallBar label="CC Atual" value={cc} max={max} color="bg-status-info" />}
            <WaterfallBar label="Entradas" value={active.entradas_30d} max={max} color="bg-status-success" />
            <WaterfallBar label="Saídas" value={active.saidas_30d} max={max} color="bg-status-error" />
            {projetado != null && (
              <WaterfallBar label="Projetado" value={projetado} max={max} color={projetado >= 0 ? 'bg-status-success' : 'bg-status-error'} />
            )}
          </div>

          {projetado != null && projetado < 0 && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-status-error-bg border border-status-error/30">
              <AlertTriangle className="w-4 h-4 text-status-error mt-0.5" />
              <div>
                <p className="text-sm font-medium text-status-error-fg">Projeção negativa</p>
                <p className="text-xs text-status-error mt-1">
                  Déficit projetado de {fmtCompact(Math.abs(projetado))} nos próximos 30 dias.
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
