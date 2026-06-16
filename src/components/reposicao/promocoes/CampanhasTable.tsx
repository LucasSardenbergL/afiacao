// Tabela de campanhas agrupada por mês (com colapso) da página de Promoções.
// Extraída de src/pages/AdminReposicaoPromocoes.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Upload, ChevronDown, ChevronRight } from "lucide-react";
import type { GrupoMensal } from "@/lib/agruparPorMes";
import { confiancaBadge } from "./badges";
import { ESTADOS, estadoBadgeClass, formatPeriodo, type CampanhaComContagem } from "./types";

export function CampanhasTable({
  isLoading, grupos, isCollapsed, toggleMes, onOpenUpload, onNavigate,
}: {
  isLoading: boolean;
  grupos: GrupoMensal<CampanhaComContagem>[];
  isCollapsed: (chave: string) => boolean;
  toggleMes: (chave: string) => void;
  onOpenUpload: () => void;
  onNavigate: (id: number) => void;
}) {
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
        Nenhuma campanha cadastrada ainda.
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
              onClick={() => toggleMes(grupo.chave)}
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
                  {grupo.itens.length === 1 ? "campanha" : "campanhas"}
                </Badge>
              </div>
            </button>

            {!collapsed && (
              grupo.vazio ? (
                <div className="flex items-center justify-between gap-3 px-3 py-4 text-sm">
                  <span className="text-muted-foreground">
                    Nenhuma campanha cadastrada neste mês.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={onOpenUpload}
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
                      <TableHead>Tipo</TableHead>
                      <TableHead>Período</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Itens</TableHead>
                      <TableHead>Confiança</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grupo.itens.map((c) => (
                      <TableRow
                        key={c.id}
                        className="cursor-pointer"
                        onClick={() => onNavigate(c.id)}
                      >
                        <TableCell className="font-medium">{c.nome}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {c.fornecedor_nome}
                        </TableCell>
                        <TableCell>
                          {c.tipo_origem === "negociacao_cliente" ? (
                            <Badge variant="outline" className="bg-status-info/15 text-status-info border-status-info/30">
                              Negociação
                            </Badge>
                          ) : (
                            <Badge variant="outline">Fornecedor</Badge>
                          )}
                        </TableCell>
                        <TableCell className="tabular-nums text-sm">
                          {formatPeriodo(c.data_inicio, c.data_fim)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={estadoBadgeClass(c.estado)}>
                            {ESTADOS.find((e) => e.value === c.estado)?.label ?? c.estado}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {c.num_itens}
                        </TableCell>
                        <TableCell>{confiancaBadge(c.extracao_confianca)}</TableCell>
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
