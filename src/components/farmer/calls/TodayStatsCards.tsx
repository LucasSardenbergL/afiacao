// KPIs do dia (ligações, receita, duração média) da página de Ligações.
// Extraído de src/pages/FarmerCalls.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Phone, DollarSign, Clock } from 'lucide-react';
import { fmt, formatTimer } from './types';

export function TodayStatsCards({ count, revenue, avgDuration }: {
  count: number;
  revenue: number;
  avgDuration: number;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Card><CardContent className="p-3 text-center">
        <Phone className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
        <p className="text-lg font-bold">{count}</p>
        <p className="text-[10px] text-muted-foreground">Ligações hoje</p>
      </CardContent></Card>
      <Card><CardContent className="p-3 text-center">
        <DollarSign className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
        <p className="text-lg font-bold">{fmt(revenue)}</p>
        <p className="text-[10px] text-muted-foreground">Receita hoje</p>
      </CardContent></Card>
      <Card><CardContent className="p-3 text-center">
        <Clock className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
        <p className="text-lg font-bold">{formatTimer(avgDuration)}</p>
        <p className="text-[10px] text-muted-foreground">Duração média</p>
      </CardContent></Card>
    </div>
  );
}
