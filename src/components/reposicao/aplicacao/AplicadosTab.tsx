// Aba "Aplicados (30d)": tabela do histórico de aplicações.
// Extraída verbatim de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type FilaItem } from "./types";

export function AplicadosTab({ filteredItens }: { filteredItens: FilaItem[] }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Aplicado em</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>EM</TableHead>
              <TableHead>PP</TableHead>
              <TableHead>Resultado</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredItens.map((it) => (
              <TableRow key={it.id}>
                <TableCell className="text-xs">
                  {it.aplicado_em
                    ? format(new Date(it.aplicado_em), "dd/MM/yyyy HH:mm", { locale: ptBR })
                    : "—"}
                </TableCell>
                <TableCell className="font-mono text-xs">{it.sku_codigo_omie}</TableCell>
                <TableCell className="min-w-[280px] whitespace-normal break-words">{it.sku_descricao}</TableCell>
                <TableCell>{it.estoque_minimo_novo}</TableCell>
                <TableCell>{it.ponto_pedido_novo}</TableCell>
                <TableCell>
                  {it.erro_omie ? (
                    <Badge variant="destructive" title={it.erro_omie}>
                      Erro
                    </Badge>
                  ) : (
                    <Badge className="bg-success/20 text-success">OK</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {filteredItens.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-6 text-muted-foreground">
                  Sem aplicações nos últimos 30 dias.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
