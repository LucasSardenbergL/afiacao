// Linha de um alvo (cliente da carteira OU prospect do Radar) no universo de
// alvos do contexto campo. Botão "Adicionar à rota" / "Na rota ✓" (toggle).
import { Plus, Check } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BotaoLigar } from '@/components/call/BotaoLigar';
import type { RouteStop } from './types';
import { STOP_CONFIG } from './constants';

export function FieldTargetCard({
  stop,
  naRota,
  onToggleRota,
}: {
  stop: RouteStop;
  naRota: boolean;
  onToggleRota: () => void;
}) {
  const cfg = STOP_CONFIG[stop.stopType];
  return (
    <Card className={naRota ? 'border-primary/50 bg-primary/5' : ''}>
      <CardContent className="py-2.5 px-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <p className="font-medium text-foreground truncate text-sm">{stop.customerName}</p>
              <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>{cfg.label}</Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {stop.address.street}
              {stop.address.number ? `, ${stop.address.number}` : ''} — {stop.address.neighborhood || stop.address.city}
            </p>
          </div>
          {stop.phone && (
            <BotaoLigar telefone={stop.phone} nomeCliente={stop.customerName} variant="icon" className="shrink-0" />
          )}
          <Button
            size="sm"
            variant={naRota ? 'default' : 'outline'}
            className="h-8 text-xs gap-1 shrink-0"
            onClick={onToggleRota}
          >
            {naRota ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
            {naRota ? 'Na rota' : 'Adicionar'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
