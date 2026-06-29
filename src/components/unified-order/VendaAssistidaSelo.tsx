import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmt } from '@/hooks/useUnifiedOrder';
import { descreverSelo } from '@/lib/venda-assistida/selos';
import type { OpcaoResolvida } from '@/lib/venda-assistida/resolver-opcao';

/**
 * Selo "preparado" VENDEDOR-ONLY no card do produto (Fatia 2 v1 da venda assistida).
 *
 * Mostra o estado (em estoque / encomenda) + o R$/litro preparado **teórico** — ou
 * "sob consulta" quando o motor não fecha preço (catalisador obrigatório sem casamento,
 * componente ausente, etc.). Toda a lógica vive em `descreverSelo` (puro/testado); aqui
 * é só a apresentação. O preço é **teórico** (baseado no último praticado pra o cliente +
 * maior embalagem disponível), nunca um preço fechado — daí o rótulo "(teórico)".
 */
export function VendaAssistidaSelo({ option }: { option: OpcaoResolvida }) {
  const selo = descreverSelo(option);
  return (
    <div
      className="mt-1.5 flex items-center gap-1.5 text-[10px]"
      data-testid="venda-assistida-selo"
    >
      <Sparkles className="w-3 h-3 text-primary shrink-0" aria-hidden />
      <span className="text-muted-foreground">Preparado:</span>
      {selo.temPreco && selo.valorLitro != null ? (
        <span className="font-medium font-mono tabular-nums">{fmt(selo.valorLitro)}/L</span>
      ) : (
        <span className="font-medium">sob consulta</span>
      )}
      <span className="text-muted-foreground/60" aria-hidden>·</span>
      <span
        className={cn(
          'font-medium',
          selo.estadoTone === 'success' && 'text-status-success',
          selo.estadoTone === 'warning' && 'text-status-warning',
          selo.estadoTone === 'muted' && 'text-muted-foreground',
        )}
      >
        {selo.estadoLabel}
      </span>
      {selo.temPreco && <span className="text-muted-foreground/60">(teórico)</span>}
    </div>
  );
}
