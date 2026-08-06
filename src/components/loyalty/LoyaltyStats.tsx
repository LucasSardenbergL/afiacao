// Grid de KPIs do módulo de fidelidade (circulação/ganhos/resgatados).
// Extraído verbatim de src/pages/AdminLoyalty.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, Plus, Gift } from 'lucide-react';

interface LoyaltyStatsProps {
  totalPointsCirculating: number;
  totalEarned: number;
  totalRedeemed: number;
}

export function LoyaltyStats({ totalPointsCirculating, totalEarned, totalRedeemed }: LoyaltyStatsProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Card className="text-center">
        <CardContent className="pt-4 pb-3">
          <TrendingUp className="w-5 h-5 mx-auto text-primary mb-1" />
          <p className="text-xl font-bold text-foreground">{totalPointsCirculating}</p>
          <p className="text-[10px] text-muted-foreground">Em circulação</p>
        </CardContent>
      </Card>
      <Card className="text-center">
        <CardContent className="pt-4 pb-3">
          <Plus className="w-5 h-5 mx-auto text-status-success mb-1" />
          <p className="text-xl font-bold text-foreground">{totalEarned}</p>
          <p className="text-[10px] text-muted-foreground">Total ganhos</p>
        </CardContent>
      </Card>
      <Card className="text-center">
        <CardContent className="pt-4 pb-3">
          <Gift className="w-5 h-5 mx-auto text-status-warning mb-1" />
          <p className="text-xl font-bold text-foreground">{totalRedeemed}</p>
          <p className="text-[10px] text-muted-foreground">Resgatados</p>
        </CardContent>
      </Card>
    </div>
  );
}
