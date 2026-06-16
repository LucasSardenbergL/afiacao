// Tab "SKUs afetados" do detalhe de aumento.
// Extraído de src/pages/AdminReposicaoAumentoDetail.tsx (god-component split).
// Presentational puro: recebe a lista de SKUs afetados já resolvida.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { SkuAfetado } from "./types";

export function SkusAfetadosTab({ skusAfetados }: { skusAfetados: SkuAfetado[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          SKUs afetados ({skusAfetados.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead>Família</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead>Vigência</TableHead>
                <TableHead className="text-right">% aumento</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {skusAfetados.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground py-8"
                  >
                    Nenhum SKU afetado. Configure mapeamentos na aba anterior.
                  </TableCell>
                </TableRow>
              )}
              {skusAfetados.map((sku) => (
                <TableRow key={sku.sku_codigo_omie}>
                  <TableCell className="font-mono text-xs">
                    {sku.sku_codigo_omie}
                  </TableCell>
                  <TableCell className="text-sm">{sku.sku_descricao}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {sku.familia}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {sku.categoria_fornecedor}
                  </TableCell>
                  <TableCell className="tabular-nums text-sm">
                    {sku.data_vigencia_efetiva}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {Number(sku.aumento_perc).toFixed(2)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
