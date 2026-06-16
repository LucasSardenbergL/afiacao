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
  oportunidadesCount: number;
  totalEconomia: number;
  executando: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Gerar ciclo de oportunidade do dia</AlertDialogTitle>
          <AlertDialogDescription>
            Vai gerar pedidos de oportunidade para{" "}
            <strong>{oportunidadesCount} SKUs</strong>, com economia total
            estimada de{" "}
            <strong className="text-status-success">
              {formatBRL(totalEconomia)}
            </strong>
            . Continuar?
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
