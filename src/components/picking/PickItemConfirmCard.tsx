import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Check, AlertTriangle, CloudUpload } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PickItem {
  id: string;
  product_descricao: string | null;
  quantidade: number;
  quantidade_separada: number;
  status: string;
  lote_fefo: string | null;
  lote_separado: string | null;
}

export interface ConfirmPayload {
  quantidadeSeparada: number;
  loteInformado: string | null;
  justificativa: string | null;
}

interface Props {
  item: PickItem;
  pending: boolean;
  onConfirm: (payload: ConfirmPayload) => void;
  disabled?: boolean;
}

export function PickItemConfirmCard({ item, pending, onConfirm, disabled }: Props) {
  const concluido = item.status === 'concluido' || item.quantidade_separada >= item.quantidade;
  const [mode, setMode] = useState<'idle' | 'divergencia'>('idle');
  const [qtd, setQtd] = useState<number>(item.quantidade);
  const [lote, setLote] = useState<string>(item.lote_fefo ?? '');
  const [justificativa, setJustificativa] = useState('');

  const isDivergente =
    qtd !== item.quantidade || (lote || null) !== (item.lote_fefo ?? null);
  const justObrigatoria = isDivergente && justificativa.trim().length === 0;

  const confirmFull = () =>
    onConfirm({ quantidadeSeparada: item.quantidade, loteInformado: item.lote_fefo, justificativa: null });

  const confirmDiv = () =>
    onConfirm({
      quantidadeSeparada: qtd,
      loteInformado: lote || null,
      justificativa: justificativa.trim() || null,
    });

  return (
    <Card className={cn(concluido && !pending && 'opacity-50')}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-base font-medium leading-snug">{item.product_descricao}</p>
          <div className="flex items-center gap-1 shrink-0">
            {pending && (
              <Badge variant="outline" className="text-[10px] gap-1 bg-status-info-bg text-status-info-bold border-status-info-bold/30">
                <CloudUpload className="w-3 h-3" /> pendente sync
              </Badge>
            )}
            {concluido && <Check className="w-5 h-5 text-status-success" />}
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Badge variant="outline" className="text-xs">{item.quantidade_separada} de {item.quantidade}</Badge>
          {item.lote_fefo && <Badge variant="outline" className="text-xs font-mono">FEFO: {item.lote_fefo}</Badge>}
        </div>

        {mode === 'idle' ? (
          <div className="flex gap-2">
            <Button size="touch" className="flex-1" onClick={confirmFull} disabled={disabled}>
              Confirmar separação
            </Button>
            <Button size="touch" variant="outline" onClick={() => setMode('divergencia')} disabled={disabled}>
              Divergência
            </Button>
          </div>
        ) : (
          <div className="space-y-3 border-t border-border pt-3">
            <div className="space-y-1">
              <Label htmlFor={`qtd-${item.id}`}>Quantidade separada</Label>
              <Input
                id={`qtd-${item.id}`}
                type="number"
                inputMode="numeric"
                value={qtd}
                onChange={(e) => setQtd(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`lote-${item.id}`}>Lote separado</Label>
              <Input id={`lote-${item.id}`} value={lote} onChange={(e) => setLote(e.target.value)} className="font-mono" />
            </div>
            {isDivergente && (
              <div className="space-y-1">
                <Label htmlFor={`just-${item.id}`} className="flex items-center gap-1 text-status-warning-bold">
                  <AlertTriangle className="w-3 h-3" /> Justificativa
                </Label>
                <Textarea
                  id={`just-${item.id}`}
                  value={justificativa}
                  onChange={(e) => setJustificativa(e.target.value)}
                  placeholder="Por que divergiu do FEFO / da quantidade?"
                  rows={2}
                />
              </div>
            )}
            <div className="flex gap-2">
              <Button size="touch" className="flex-1" onClick={confirmDiv} disabled={disabled || justObrigatoria}>
                Confirmar com divergência
              </Button>
              <Button size="touch" variant="ghost" onClick={() => setMode('idle')} disabled={disabled}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
