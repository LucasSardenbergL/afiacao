// Tabela de grupos de produção cadastrados (Seção 1).
// Extraída de src/pages/AdminReposicaoGruposProducao.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Pencil } from "lucide-react";
import type { Grupo } from "./types";

export function GruposTable({
  grupos, loading, contagensSku, onEdit,
}: {
  grupos: Grupo[];
  loading: boolean;
  contagensSku: Record<string, number>;
  onEdit: (g: Grupo) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fornecedor</TableHead>
            <TableHead>Código</TableHead>
            <TableHead>Descrição</TableHead>
            <TableHead className="text-right">LT (dias)</TableHead>
            <TableHead>Unidade</TableHead>
            <TableHead>Corte</TableHead>
            <TableHead className="text-right">SKUs</TableHead>
            <TableHead className="w-[80px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grupos.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                Nenhum grupo cadastrado.
              </TableCell>
            </TableRow>
          )}
          {grupos.map((g) => (
            <TableRow key={g.id}>
              <TableCell className="font-medium">{g.fornecedor_nome}</TableCell>
              <TableCell>
                <Badge variant="outline">{g.grupo_codigo}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {g.descricao || "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {g.lt_producao_dias}
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className="text-xs">
                  {g.lt_producao_unidade === "uteis" ? "úteis" : "corridos"}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {g.horario_corte ? g.horario_corte.slice(0, 5) : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">
                {contagensSku[g.grupo_codigo] || 0}
              </TableCell>
              <TableCell>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onEdit(g)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
