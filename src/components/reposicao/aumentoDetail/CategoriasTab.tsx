// Tab "Categorias e mapeamento" do detalhe de aumento.
// Extraído de src/pages/AdminReposicaoAumentoDetail.tsx (god-component split).
// Presentational: recebe os itens + callbacks; as mutações ficam na página.
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ItemRow } from "./ItemRow";
import type { Item } from "./types";

export function CategoriasTab({
  itens,
  familiasUnicasPorItem,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
  onMapeamentoChanged,
}: {
  itens: Item[];
  familiasUnicasPorItem: (itemId: number) => number;
  onAddItem: () => void;
  onUpdateItem: (id: number, patch: Partial<Item>) => void;
  onDeleteItem: (id: number) => void;
  onMapeamentoChanged: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Categorias do fornecedor</CardTitle>
        <Button size="sm" onClick={onAddItem}>
          <Plus className="h-4 w-4" /> Adicionar categoria
        </Button>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Categoria</TableHead>
                <TableHead className="w-[100px]">% aumento</TableHead>
                <TableHead className="w-[150px]">Vig. específica</TableHead>
                <TableHead className="w-[160px]">Mapeamento</TableHead>
                <TableHead className="w-[100px] text-center">Confirmado</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {itens.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground py-8"
                  >
                    Nenhuma categoria. Clique em "Adicionar categoria".
                  </TableCell>
                </TableRow>
              )}
              {itens.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  numFamilias={familiasUnicasPorItem(item.id)}
                  onUpdate={(patch) => onUpdateItem(item.id, patch)}
                  onDelete={() => onDeleteItem(item.id)}
                  onMapeamentoChanged={onMapeamentoChanged}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
