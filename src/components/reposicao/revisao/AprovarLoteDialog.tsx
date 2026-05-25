// Dialog de confirmação de aprovação em lote de SKUs.
// Extraído verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type RowWithPrice, fmt } from "@/lib/reposicao/sku-param";

interface AprovarLoteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aggregateImpact: { count: number; capUnits: number };
  selectedRows: RowWithPrice[];
  batchJustificativa: string;
  setBatchJustificativa: (v: string) => void;
  onConfirm: () => void;
  isApproving: boolean;
}

export function AprovarLoteDialog({
  open,
  onOpenChange,
  aggregateImpact,
  selectedRows,
  batchJustificativa,
  setBatchJustificativa,
  onConfirm,
  isApproving,
}: AprovarLoteDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Aprovar {aggregateImpact.count} SKU(s)</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="rounded-md border p-3">
              <div className="text-muted-foreground">Total de SKUs</div>
              <div className="text-2xl font-semibold">{aggregateImpact.count}</div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-muted-foreground">Estoque máx. agregado (un)</div>
              <div className="text-2xl font-semibold">
                {fmt(aggregateImpact.capUnits, 0)}
              </div>
            </div>
          </div>

          <div className="max-h-48 overflow-y-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Classe</TableHead>
                  <TableHead className="text-right">Emax</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedRows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs align-top">{r.sku_codigo_omie}</TableCell>
                    <TableCell className="text-xs min-w-[260px] whitespace-normal break-words leading-snug align-top">
                      {r.sku_descricao}
                    </TableCell>
                    <TableCell className="align-top">{r.classe_consolidada}</TableCell>
                    <TableCell className="text-right align-top">{fmt(r.estoque_maximo, 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div>
            <Label>Justificativa (opcional, aplicada a todos)</Label>
            <Textarea
              value={batchJustificativa}
              onChange={(e) => setBatchJustificativa(e.target.value)}
              placeholder="Ex: Revisão trimestral aprovada pela operação."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={onConfirm} disabled={isApproving}>
            {isApproving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Confirmar aprovação
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
