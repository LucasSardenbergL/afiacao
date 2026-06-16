// Dialogs de confirmação: aplicação em lote (delta > 50%) e individual.
// Extraídos verbatim de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { type FilaItem } from "./types";

interface AplicacaoConfirmDialogsProps {
  confirmLote: { ids: number[]; maxDelta: number } | null;
  setConfirmLote: (v: { ids: number[]; maxDelta: number } | null) => void;
  confirmIndividual: FilaItem | null;
  setConfirmIndividual: (v: FilaItem | null) => void;
  onAplicar: (ids: number[]) => void;
}

export function AplicacaoConfirmDialogs({
  confirmLote,
  setConfirmLote,
  confirmIndividual,
  setConfirmIndividual,
  onAplicar,
}: AplicacaoConfirmDialogsProps) {
  return (
    <>
      {/* Confirmação lote com delta > 50% */}
      <AlertDialog open={!!confirmLote} onOpenChange={(o) => !o && setConfirmLote(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delta elevado detectado</AlertDialogTitle>
            <AlertDialogDescription>
              Há SKUs com delta acima de 50% (máximo: {confirmLote?.maxDelta.toFixed(0)}%). Tem
              certeza de que quer aplicar este lote no Omie?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmLote) onAplicar(confirmLote.ids);
                setConfirmLote(null);
              }}
            >
              Confirmar aplicação
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmação individual */}
      <AlertDialog
        open={!!confirmIndividual}
        onOpenChange={(o) => !o && setConfirmIndividual(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Aplicar parâmetros no Omie?</AlertDialogTitle>
            <AlertDialogDescription>
              SKU {confirmIndividual?.sku_codigo_omie} — {confirmIndividual?.sku_descricao}.
              <br />
              EM: {confirmIndividual?.estoque_minimo_omie_atual ?? "—"} →{" "}
              {confirmIndividual?.estoque_minimo_novo}
              <br />
              PP: {confirmIndividual?.ponto_pedido_omie_atual ?? "—"} →{" "}
              {confirmIndividual?.ponto_pedido_novo}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmIndividual) onAplicar([confirmIndividual.id]);
                setConfirmIndividual(null);
              }}
            >
              Aplicar agora
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
