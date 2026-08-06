import { AlertTriangle, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  AVISO_FORMAS_DEGRADADAS,
  AVISO_FORMAS_INDISPONIVEIS,
  mensagemCondicoesIndisponiveis,
} from '@/services/orderSubmission/formasDegradacao';

interface AvisoFormasPagamentoProps {
  /** Edge declarou fallback (`degraded`/`source`) — lista genérica no lugar das reais. */
  degradado: boolean;
  /** A consulta falhou por inteiro: nem a lista genérica chegou. */
  erro?: boolean;
  /** Motivo declarado pelo edge (mensagem do erro do Omie), quando houver. */
  motivo?: string | null;
  /** Códigos que este cliente/pedido usa e sumiram da lista — prova positiva. */
  condicoesAusentes?: ReadonlyArray<string>;
  /** Refaz a consulta ao Omie. Sem saída, o bloqueio viraria beco sem saída. */
  onRecarregar?: () => void;
  /**
   * Substitui o texto padrão. Use quando a CONSEQUÊNCIA da degradação for outra — na
   * impressão não há "opções padrão" na tela: o rótulo é omitido e sai o código cru.
   */
  texto?: string;
  className?: string;
}

/**
 * Aviso inline da degradação da listagem de condições de pagamento (money-path §7: a
 * correção do edge #1597 só termina quando a degradação aparece na TELA).
 *
 * Dois níveis: `condicoesAusentes` não-vazio é a prova de que a lista NÃO serve para este
 * cliente (erro — acompanha o bloqueio do envio); degradação sem prova é aviso (warning —
 * a lista genérica pode até servir, mas o vendedor precisa saber que ela não é a do Omie).
 */
export function AvisoFormasPagamento({
  degradado,
  erro = false,
  motivo,
  condicoesAusentes = [],
  onRecarregar,
  texto,
  className,
}: AvisoFormasPagamentoProps) {
  if (!degradado && !erro) return null;

  const bloqueante = condicoesAusentes.length > 0;
  const mensagem = bloqueante
    ? mensagemCondicoesIndisponiveis(condicoesAusentes)
    : texto
      ?? (erro ? AVISO_FORMAS_INDISPONIVEIS : AVISO_FORMAS_DEGRADADAS);

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
        bloqueante
          ? 'bg-status-error-bg border-status-error/30 text-status-error'
          : 'bg-status-warning-bg border-status-warning/30 text-status-warning',
        className,
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        <p>{mensagem}</p>
        {motivo && <p className="opacity-70 break-words">Motivo: {motivo}</p>}
        {onRecarregar && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRecarregar}
            className="h-7 gap-1.5 text-xs"
          >
            <RefreshCw className="h-3 w-3" />
            Tentar de novo
          </Button>
        )}
      </div>
    </div>
  );
}
