// Dialog de confirmação "Gerar ciclo de oportunidade do dia".
// Extraído de src/pages/AdminReposicaoOportunidades.tsx (god-component split).
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";
import { formatBRL } from "./shared";

export function GerarCicloDialog({
  open, onOpenChange, oportunidadesCount, totalEconomia, executando, onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** `null` = a lista de oportunidades não pôde ser lida (não é "0 SKUs"). */
  oportunidadesCount: number | null;
  totalEconomia: number | null;
  executando: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Gerar ciclo de oportunidade do dia</AlertDialogTitle>
          <AlertDialogDescription>
            {oportunidadesCount == null || totalEconomia == null ? (
              // Sem leitura da lista, a tela NÃO sabe quantos SKUs nem quanto — e não diz "0".
              // O ciclo é calculado no servidor, então gerar continua possível.
              <>
                Vai gerar os pedidos de oportunidade do dia.{" "}
                <span className="text-status-warning">
                  A lista de oportunidades não pôde ser carregada agora, então a quantidade de SKUs e
                  a economia estimada não estão disponíveis
                </span>
                . Continuar?
              </>
            ) : (
              <>
                Vai gerar pedidos de oportunidade para{" "}
                <strong>{oportunidadesCount} SKUs</strong>, com economia total
                estimada de{" "}
                <strong className="text-status-success">
                  {formatBRL(totalEconomia)}
                </strong>
                . Continuar?
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={executando}>
            Cancelar
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={executando}
          >
            {executando && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Confirmar e gerar
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
