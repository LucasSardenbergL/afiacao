import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Aviso de leitura do ciclo de Reposição — superfície ÚNICA das três telas da sessão
 * (stepper do layout, grid de etapas, checklist da etapa).
 *
 * Por que compartilhado: os três consumiam `useReposicaoStatus` e, sob falha, mentiam cada um
 * do seu jeito — o layout FABRICAVA a etapa (`status?.current ?? 3` ⇒ "etapa atual 3. Pedidos"
 * sobre um ciclo que não foi lido), o grid e o checklist ficavam em SKELETON ETERNO (o guard
 * era `isLoading || !status`, e com `isLoading` já falso a tela finge carregar para sempre).
 * O contrato do §7 do money-path é um só — "indisponível COM O MOTIVO + retry" sem cache,
 * "último dado bom + aviso de stale" com cache — e texto duplicado em 3 arquivos é exatamente
 * como uma das cópias volta a mentir.
 */
export function AvisoLeituraDoCiclo({
  stale = false,
  onRetry,
  className,
}: {
  /** `true` = há último dado bom na tela; o aviso só marca que ele pode estar velho. */
  stale?: boolean;
  onRetry: () => void;
  className?: string;
}) {
  const texto = stale
    ? "A última leitura do ciclo falhou — os números abaixo podem estar desatualizados."
    : "Não consegui ler o ciclo de reposição de hoje — a etapa e os números ficam indisponíveis até a leitura voltar.";

  if (stale) {
    return (
      <div
        role="alert"
        className={cn(
          "flex items-center gap-2 rounded-md border border-status-warning/30 bg-status-warning/5 px-3 py-2 text-xs text-status-warning",
          className,
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0">{texto}</span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-xs"
          onClick={onRetry}
        >
          <RefreshCw className="h-3 w-3 mr-1" />
          Tentar novamente
        </Button>
      </div>
    );
  }

  return (
    <Card role="alert" className={cn("border-status-error/30 bg-status-error/5 p-4", className)}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-status-error mt-0.5" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-foreground">{texto}</p>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Tentar novamente
          </Button>
        </div>
      </div>
    </Card>
  );
}
