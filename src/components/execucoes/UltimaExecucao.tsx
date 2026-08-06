import { History } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useUltimaExecucao } from "./useUltimaExecucao";
import { rotuloUltimaExecucao } from "./rotulo";

const COR_POR_TOM = {
  muted: "text-muted-foreground",
  andamento: "text-primary",
  erro: "text-status-error",
} as const;

/**
 * Caption "última execução" de um botão de ação global. Par do useMutationComRegistro
 * (ou do registro server-side via _shared/registro-execucao.ts) — mesma acao/slug.
 * Aceita array quando o card tem 2+ botões da mesma família (mostra a mais recente).
 */
export function UltimaExecucao({ acao, className }: { acao: string | string[]; className?: string }) {
  const { data: execucao, isLoading } = useUltimaExecucao(acao);
  if (isLoading) return null;

  const { texto, tom } = rotuloUltimaExecucao(execucao ?? null, new Date());
  const conteudo = (
    <span className={cn("inline-flex items-center gap-1 text-xs", COR_POR_TOM[tom], className)}>
      <History className="h-3 w-3 shrink-0" aria-hidden />
      {texto}
    </span>
  );

  if (!execucao) return conteudo;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{conteudo}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {format(new Date(execucao.finalizado_em ?? execucao.iniciado_em), "dd/MM/yyyy 'às' HH:mm", {
          locale: ptBR,
        })}
        {" — "}
        <code className="font-mono">{execucao.acao}</code>
      </TooltipContent>
    </Tooltip>
  );
}
