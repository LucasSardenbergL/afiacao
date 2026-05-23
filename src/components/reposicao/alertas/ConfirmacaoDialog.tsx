// Dialog de confirmação de ação (aceitar/excluir/ignorar) dos Alertas de Outlier.
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
            Confirmar {acaoConfirm?.tipo === "aceitar" ? "aceitação" : acaoConfirm?.tipo === "excluir" ? "exclusão" : "ignorar"}
          </DialogTitle>
          <DialogDescription>
            {acaoConfirm?.lote
              ? `Aplicar a ${selecionadosCount} alerta(s). Críticos não estão incluídos.`
              : `Aplicar ao alerta selecionado.`}
            {acaoConfirm?.tipo === "excluir" && (
              <div className="mt-2 text-warning">⚠ Esta ação remove os eventos do cálculo estatístico e dispara recálculo automático dos parâmetros.</div>
            )}
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
          <Button
            variant={acaoConfirm?.tipo === "excluir" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Confirmar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
