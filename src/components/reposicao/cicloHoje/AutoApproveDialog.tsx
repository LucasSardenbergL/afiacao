// Dialog de confirmação de aprovação automática (elegíveis + itens que ficam para revisão manual).
// Extraído verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import { AlertTriangle, Loader2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AutoApprovalGroup, ManualReviewItem } from "./useCicloHoje";

interface AutoApproveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eligibleCount: number;
  autoApprovalGroups: AutoApprovalGroup[];
  manualReviewItems: ManualReviewItem[];
  busy: boolean;
  onConfirm: () => void;
}

export function AutoApproveDialog({
  open,
  onOpenChange,
  eligibleCount,
  autoApprovalGroups,
  manualReviewItems,
  busy,
  onConfirm,
}: AutoApproveDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" /> Aprovar elegíveis automaticamente
          </DialogTitle>
          <DialogDescription>
            {eligibleCount} pedido(s) serão aprovados automaticamente.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-56 overflow-y-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornecedor</TableHead>
                <TableHead className="text-right">Qtd</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {autoApprovalGroups.map((group) => (
                <TableRow key={group.fornecedor}>
                  <TableCell>{group.fornecedor}</TableCell>
                  <TableCell className="text-right tabular-nums">{group.qtd}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {manualReviewItems.length > 0 && (
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <AlertTriangle className="h-4 w-4 text-status-warning" />
              {manualReviewItems.length} pedido(s) ficarão para aprovação manual
            </div>
            <div className="max-h-40 overflow-y-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fornecedor</TableHead>
                    <TableHead>Motivo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {manualReviewItems.map(({ item, suggestion }) => (
                    <TableRow key={item.id}>
                      <TableCell className="text-xs">
                        {item.fornecedor_nome ?? "Sem fornecedor"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {suggestion.reasons.join("; ")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} disabled={busy || eligibleCount === 0}>
            {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Confirmar aprovação automática
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
