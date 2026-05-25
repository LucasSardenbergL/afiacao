// Card "Visão Econômica" (passivo estimado, taxa de resgate, top recompensas/saldos).
// Extraído verbatim de src/pages/AdminLoyalty.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DollarSign, BarChart3, Crown } from 'lucide-react';
import type { CustomerPoints } from './types';

interface EconomicInsightsProps {
  estimatedLiability: number;
  redemptionRate: string;
  topRewards: [string, number][];
  topBalanceUsers: CustomerPoints[];
}

export function EconomicInsights({ estimatedLiability, redemptionRate, topRewards, topBalanceUsers }: EconomicInsightsProps) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2 mb-1">
          <DollarSign className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Visão Econômica</h3>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg bg-muted p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Passivo estimado</p>
            <p className="text-lg font-bold text-foreground">
              R$ {estimatedLiability.toFixed(2)}
            </p>
            <p className="text-[10px] text-muted-foreground">se todos resgatassem</p>
          </div>
          <div className="rounded-lg bg-muted p-3">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Taxa de resgate</p>
            <p className="text-lg font-bold text-foreground">{redemptionRate}%</p>
            <p className="text-[10px] text-muted-foreground">resgatados / emitidos</p>
          </div>
        </div>

        {topRewards.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <BarChart3 className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Recompensas mais resgatadas</p>
            </div>
            <div className="space-y-1">
              {topRewards.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-sm">
                  <span className="text-foreground truncate">{name}</span>
                  <Badge variant="secondary" className="text-xs">{count}x</Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {topBalanceUsers.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Crown className="w-3.5 h-3.5 text-muted-foreground" />
              <p className="text-xs font-medium text-muted-foreground">Maiores saldos</p>
            </div>
            <div className="space-y-1">
              {topBalanceUsers.map(u => (
                <div key={u.user_id} className="flex items-center justify-between text-sm">
                  <span className="text-foreground truncate">{u.name}</span>
                  <span className="font-medium text-foreground">{u.balance} pts</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
