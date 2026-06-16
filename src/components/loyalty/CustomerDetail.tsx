// Visão de detalhe de um cliente (saldo, ações, histórico).
// Extraído verbatim de src/pages/AdminLoyalty.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Plus, Minus } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { getTier } from './config';
import type { CustomerPoints, PointRecord } from './types';

interface CustomerDetailProps {
  customer: CustomerPoints;
  history: PointRecord[];
  onAddPoints: () => void;
  onRedeem: () => void;
  onBack: () => void;
}

export function CustomerDetail({ customer: selectedCustomer, history: customerHistory, onAddPoints, onRedeem, onBack }: CustomerDetailProps) {
  const tier = getTier(selectedCustomer.balance);
  return (
    <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-xs text-muted-foreground uppercase">Saldo</p>
              <p className="text-3xl font-bold text-foreground">{selectedCustomer.balance} pts</p>
            </div>
            <div className="text-center">
              <span className="text-3xl">{tier.icon}</span>
              <p className="text-xs font-medium text-muted-foreground">{tier.name}</p>
            </div>
          </div>
          <div className="flex gap-4 text-sm text-muted-foreground">
            <span>Ganhos: <strong className="text-foreground">{selectedCustomer.total_earned}</strong></span>
            <span>Resgatados: <strong className="text-foreground">{selectedCustomer.total_redeemed}</strong></span>
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={onAddPoints}
        >
          <Plus className="w-4 h-4 mr-1" /> Adicionar Pontos
        </Button>
        <Button
          variant="outline"
          className="flex-1"
          onClick={onRedeem}
        >
          <Minus className="w-4 h-4 mr-1" /> Resgatar
        </Button>
      </div>

      <h3 className="font-display font-bold text-foreground">Histórico</h3>
      <div className="space-y-2">
        {customerHistory.map(item => (
          <Card key={item.id}>
            <CardContent className="p-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">{item.description || 'Pontos'}</p>
                <p className="text-xs text-muted-foreground">
                  {format(new Date(item.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                </p>
              </div>
              <Badge variant={item.type === 'earn' ? 'default' : 'destructive'}>
                {item.type === 'earn' ? '+' : ''}{item.points} pts
              </Badge>
            </CardContent>
          </Card>
        ))}
        {customerHistory.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">Sem histórico</p>
        )}
      </div>

      <Button variant="ghost" className="w-full" onClick={onBack}>
        ← Voltar à lista
      </Button>
    </main>
  );
}
