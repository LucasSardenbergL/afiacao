// Lista de aumentos agrupada por mês (colapsável) + estados de loading/empty.
// Extraído verbatim de src/pages/AdminReposicaoAumentos.tsx (god-component split).
import { Loader2, Upload, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { GrupoMensal } from "@/lib/agruparPorMes";
import { ESTADOS, estadoBadgeClass, formatDate } from "./config";
import type { AumentoComAgg } from "./types";

interface AumentosGruposProps {
  isLoading: boolean;
  grupos: GrupoMensal<AumentoComAgg>[];
  isCollapsed: (chave: string) => boolean;
  onToggleMes: (chave: string) => void;
  onUploadClick: () => void;
  onRowClick: (id: number) => void;
}

export function AumentosGrupos({
  isLoading,
  grupos,
  isCollapsed,
  onToggleMes,
  onUploadClick,
  onRowClick,
}: AumentosGruposProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }

  if (grupos.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-12 text-sm">
        Nenhum aumento cadastrado ainda.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto space-y-4">
      {grupos.map((grupo) => {
        const collapsed = isCollapsed(grupo.chave);
        return (
          <div key={grupo.chave} className="rounded-md border">
            <button
              type="button"
              onClick={() => onToggleMes(grupo.chave)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
            >
              <div className="flex items-center gap-2">
                {collapsed ? (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-semibold text-sm">{grupo.label}</span>
                <Badge variant="outline" className="text-xs">
                  {grupo.itens.length}{" "}
                  {grupo.itens.length === 1 ? "aumento" : "aumentos"}
                </Badge>
              </div>
            </button>

            {!collapsed && (
              grupo.vazio ? (
                <div className="flex items-center justify-between gap-3 px-3 py-4 text-sm">
                  <span className="text-muted-foreground">
                    Nenhum aumento cadastrado neste mês.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onUploadClick}
                  >
                    <Upload className="h-3.5 w-3.5" /> Upload PDF
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nome</TableHead>
                      <TableHead>Fornecedor</TableHead>
                      <TableHead>Vigência</TableHead>
                      <TableHead>Anúncio</TableHead>
                      <TableHead className="text-right">Categorias</TableHead>
                      <TableHead className="text-right">% médio</TableHead>
                      <TableHead>Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grupo.itens.map((a) => (
                      <TableRow
                        key={a.id}
                        className="cursor-pointer"
                        onClick={() => onRowClick(a.id)}
                      >
                        <TableCell className="font-medium">{a.nome}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {a.fornecedor_nome}
                        </TableCell>
                        <TableCell className="tabular-nums text-sm">
                          {formatDate(a.data_vigencia)}
                        </TableCell>
                        <TableCell className="tabular-nums text-sm text-muted-foreground">
                          {formatDate(a.data_anuncio)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {a.num_categorias}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.perc_medio !== null
                            ? `${a.perc_medio.toFixed(2)}%`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={estadoBadgeClass(a.estado)}
                          >
                            {ESTADOS.find((e) => e.value === a.estado)?.label ?? a.estado}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
