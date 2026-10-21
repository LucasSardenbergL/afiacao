import { cn } from '@/lib/utils';
import { formatarPct, type EstadoTaxa } from '@/lib/venda-cliente/painel';

/**
 * Uma célula de taxa. Os quatro estados são visualmente distintos de propósito: "não consegui
 * medir" tem fundo hachurado para nunca ser lido como um número baixo, e nada aqui renderiza 0%
 * a partir de dado ausente.
 */
export function CelulaTaxa({ estado, className }: { estado: EstadoTaxa; className?: string }) {
  switch (estado.tipo) {
    case 'valor':
      return <span className={cn('font-medium tabular-nums', className)}>{formatarPct(estado.taxa)}</span>;
    case 'nao_medi':
      return (
        <span
          title={estado.motivo}
          className={cn(
            'inline-block rounded-sm px-1.5 py-0.5 text-xs text-muted-foreground',
            'bg-[repeating-linear-gradient(135deg,hsl(var(--muted))_0_4px,transparent_4px_8px)]',
            className,
          )}
        >
          não consegui medir
        </span>
      );
    case 'aguardando':
      return (
        <span
          title={`${estado.pendentes} sugestões com a janela de desfecho ainda aberta`}
          className={cn('text-xs text-muted-foreground', className)}
        >
          aguardando janela
        </span>
      );
    case 'sem_lista':
      return <span className={cn('text-muted-foreground', className)} aria-label="sem lista">—</span>;
  }
}
