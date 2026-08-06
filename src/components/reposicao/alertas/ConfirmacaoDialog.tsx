// Dialog de confirmação da revisão de um alerta de outlier.
// Extraído de src/pages/AdminReposicaoAlertas.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import type { AcaoConfirm } from "./types";

export function ConfirmacaoDialog({
  acaoConfirm, onClose, selecionadosCount, justificativa, setJustificativa, onConfirm, isPending,
}: {
  acaoConfirm: AcaoConfirm | null;
  onClose: () => void;
  selecionadosCount: number;
  justificativa: string;
  setJustificativa: (s: string) => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={!!acaoConfirm} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {acaoConfirm?.lote
              ? `Marcar ${selecionadosCount} alerta(s) como revisado(s)`
              : "Marcar alerta como revisado"}
          </DialogTitle>
          <DialogDescription>
            {acaoConfirm?.lote && "Críticos não estão incluídos. "}
            A observação permanece no cálculo — esta tela registra a revisão, não altera parâmetros de reposição.
          </DialogDescription>
        </DialogHeader>
        {acaoConfirm?.lote && (
          <div>
            <Label className="text-xs">Justificativa em lote (opcional)</Label>
            <Textarea rows={2} value={justificativa} onChange={(e) => setJustificativa(e.target.value)} />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancelar</Button>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
