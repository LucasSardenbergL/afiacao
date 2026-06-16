// Linha de um alvo (cliente da carteira OU prospect do Radar) no universo de
// alvos do contexto campo. Clicar na info abre o detalhe (Sheet); o X remove da
// sessão (ponto F); o BotaoLigar liga (híbrido desktop/celular); o botão à direita
// marca/desmarca pra rota.
import { Plus, Check, X } from 'lucide-react';
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
  onAbrirDetalhe,
  onRemover,
}: {
  stop: RouteStop;
  naRota: boolean;
  onToggleRota: () => void;
  onAbrirDetalhe?: () => void;
  onRemover?: () => void;
}) {
  const cfg = STOP_CONFIG[stop.stopType];
  return (
    <Card className={naRota ? 'border-primary/50 bg-primary/5' : ''}>
      <CardContent className="py-2.5 px-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAbrirDetalhe}
            disabled={!onAbrirDetalhe}
            className="flex-1 min-w-0 text-left rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
            aria-label={`Ver detalhes de ${stop.customerName}`}
          >
            <div className="flex items-center gap-2">
              <p className="font-medium text-foreground truncate text-sm">{stop.customerName}</p>
              <Badge className={`text-[10px] px-1.5 py-0 ${cfg.bgClass} border-0`}>{cfg.label}</Badge>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {stop.address.street}
              {stop.address.number ? `, ${stop.address.number}` : ''} — {stop.address.neighborhood || stop.address.city}
            </p>
          </button>
          {stop.phone && (
            <BotaoLigar telefone={stop.phone} nomeCliente={stop.customerName} variant="icon" className="shrink-0" />
          )}
          {onRemover && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0 text-muted-foreground hover:text-status-error"
              onClick={onRemover}
              aria-label={`Remover ${stop.customerName} da lista`}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
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
