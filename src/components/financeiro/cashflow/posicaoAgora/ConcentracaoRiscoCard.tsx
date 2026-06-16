// Card de concentração de risco (Top 5 clientes/fornecedores).
// Extraído verbatim de src/components/financeiro/cashflow/PosicaoAgora.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ShieldCheck } from 'lucide-react';
import type { CapitalDeGiro } from '@/services/financeiroService';

export function ConcentracaoRiscoCard({ active }: { active: CapitalDeGiro }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <ShieldCheck className="w-4 h-4" />
          Concentração de Risco
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-sm text-muted-foreground mb-2">Recebíveis — Top 5 clientes</p>
            <div className="flex items-center gap-3">
              <Progress
                value={active.top5_cr_pct}
                className={`h-3 ${active.top5_cr_pct > 70 ? '[&>div]:bg-status-error' : active.top5_cr_pct > 50 ? '[&>div]:bg-status-warning' : '[&>div]:bg-status-success'}`}
              />
              <span className="text-sm font-bold">{active.top5_cr_pct.toFixed(0)}%</span>
            </div>
            {active.top5_cr_pct > 60 && (
              <p className="text-xs text-status-warning mt-1">Alta concentração — diversifique a base de clientes</p>
            )}
          </div>
          <div>
            <p className="text-sm text-muted-foreground mb-2">Payables — Top 5 fornecedores</p>
            <div className="flex items-center gap-3">
              <Progress
                value={active.top5_cp_pct}
                className={`h-3 ${active.top5_cp_pct > 70 ? '[&>div]:bg-status-warning' : '[&>div]:bg-status-info'}`}
              />
              <span className="text-sm font-bold">{active.top5_cp_pct.toFixed(0)}%</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
