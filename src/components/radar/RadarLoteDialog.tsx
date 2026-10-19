import { CheckCircle2, XCircle, CircleDashed, Loader2, Building2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { useRadarLoteOmie } from '@/queries/useRadarLote';
import type { ItemLote } from '@/lib/radar/lote-persistido';

type Lote = ReturnType<typeof useRadarLoteOmie>;

function IconeItem({ item }: { item: ItemLote }) {
  switch (item.estado.status) {
    case 'ok': return <CheckCircle2 className="w-4 h-4 text-status-success shrink-0" />;
    case 'falha': return <XCircle className="w-4 h-4 text-status-error shrink-0" />;
    case 'nao_iniciado': return <CircleDashed className="w-4 h-4 text-muted-foreground shrink-0" />;
    default: return <Loader2 className="w-4 h-4 text-muted-foreground shrink-0 animate-spin" />;
  }
}

function detalheItem(item: ItemLote): string {
  const e = item.estado;
  if (e.status === 'ok') return e.jaExistia ? `já existia no Omie · cód. ${e.codigo}${e.recuperado ? ' (recuperado)' : ''}` : `cadastrado · cód. ${e.codigo}`;
  if (e.status === 'falha') return `${e.etapa === 'radar' ? 'Omie OK, falhou gravar no Radar' : 'falhou no Omie'}: ${e.erro}`;
  if (e.status === 'nao_iniciado') return 'não iniciado (lote parado)';
  return 'aguardando…';
}

/**
 * Progresso do lote de cadastro Omie. Fica aberto enquanto roda; ao terminar, mostra o
 * resumo e oferece retentar SÓ o que não ficou ok. "Parar" interrompe novos disparos —
 * o item em voo termina (não há como desfazer uma chamada ao Omie já feita).
 */
export function RadarLoteDialog({ lote, open, onClose }: { lote: Lote; open: boolean; onClose: () => void }) {
  const { lote: estado, rodando, progresso, retomar, parar, esquecer } = lote;
  if (!estado || !progresso) return null;
  const pct = progresso.total ? Math.round((progresso.feitos / progresso.total) * 100) : 0;
  const pendentes = progresso.pendentes;
  const parouPorThrottling = estado.itens.some(
    (i) => i.estado.status === 'falha' && /OMIE_TRANSIENT|rate.?limit/i.test(i.estado.erro),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !rodando) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-4 h-4" /> Cadastro em massa no Omie (Oben)
          </DialogTitle>
          <DialogDescription>
            {rodando
              ? `Cadastrando ${progresso.feitos + 1 > progresso.total ? progresso.total : progresso.feitos + 1} de ${progresso.total}…`
              : `${progresso.ok} de ${progresso.total} confirmados · ${progresso.falhas} falha(s) · ${progresso.naoIniciados} não iniciado(s)`}
          </DialogDescription>
        </DialogHeader>

        <Progress value={pct} className="h-2" />
        {parouPorThrottling && !rodando && (
          <p className="text-xs text-status-warning">
            O Omie limitou as chamadas e o lote parou. Espere alguns minutos e retente só o que faltou.
          </p>
        )}

        <ul className="max-h-72 overflow-y-auto divide-y text-sm">
          {estado.itens.map((i) => (
            <li key={i.cnpj} className="flex items-start gap-2 py-1.5">
              <IconeItem item={i} />
              <div className="min-w-0">
                <div className="truncate font-medium">{i.nome}</div>
                <div className={cn('text-xs truncate', i.estado.status === 'falha' ? 'text-status-error' : 'text-muted-foreground')}>
                  {detalheItem(i)}
                </div>
              </div>
            </li>
          ))}
        </ul>

        <DialogFooter className="gap-2 sm:gap-2">
          {rodando ? (
            <Button variant="outline" onClick={parar}>Parar após o atual</Button>
          ) : (
            <>
              {pendentes > 0 && (
                <Button onClick={retomar}>Retentar {pendentes} pendente{pendentes === 1 ? '' : 's'}</Button>
              )}
              <Button variant="ghost" onClick={() => { esquecer(); onClose(); }}>
                {pendentes > 0 ? 'Esquecer lote' : 'Fechar'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
