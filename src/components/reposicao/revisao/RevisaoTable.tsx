// Card da tabela de revisão (cabeçalho + aprovar selecionados + tabela + paginação).
// Extraído verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import { ChevronLeft, ChevronRight, CheckCircle2, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type RowWithPrice } from "@/lib/reposicao/sku-param";
import { SkuRow } from "./SkuRow";

interface RevisaoTableProps {
  total: number;
  page: number;
  totalPages: number;
  isLoading: boolean;
  rows: RowWithPrice[];
  selected: Record<string, boolean>;
  allChecked: boolean;
  toggleAll: () => void;
  onToggleSelect: (id: string, checked: boolean) => void;
  onOpenDetail: (row: RowWithPrice) => void;
  selectedCount: number;
  onAprovarSelecionados: () => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onPromover?: (sku: number) => void;
  promovendo?: boolean;
}

export function RevisaoTable({
  total,
  page,
  totalPages,
  isLoading,
  rows,
  selected,
  allChecked,
  toggleAll,
  onToggleSelect,
  onOpenDetail,
  selectedCount,
  onAprovarSelecionados,
  onPrevPage,
  onNextPage,
  onPromover,
  promovendo,
}: RevisaoTableProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          {total} SKU(s) encontrados — página {page + 1} de {totalPages}
        </CardTitle>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={selectedCount === 0}
            onClick={onAprovarSelecionados}
          >
            <CheckCircle2 className="mr-2 h-4 w-4" />
            Aprovar selecionados ({selectedCount})
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="overflow-x-auto -mx-6 px-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>SKU</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead>Classe</TableHead>
                <TableHead className="text-right">D/dia</TableHead>
                <TableHead className="text-right">R$ compra</TableHead>
                <TableHead className="text-right">R$ venda</TableHead>
                <TableHead>Fonte</TableHead>
                <TableHead className="text-right">LT (du)</TableHead>
                <TableHead className="text-right">EM</TableHead>
                <TableHead className="text-right">PP</TableHead>
                <TableHead className="text-right">Emax</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <SkuRow
                  key={r.id}
                  row={r}
                  checked={!!selected[r.id]}
                  onToggleSelect={onToggleSelect}
                  onOpenDetail={onOpenDetail}
                  onPromover={onPromover}
                  promovendo={promovendo}
                />
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={14} className="text-center text-muted-foreground py-8">
                    Nenhum SKU encontrado para os filtros atuais.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-4">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={onPrevPage}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            {page + 1}/{totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= totalPages}
            onClick={onNextPage}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
