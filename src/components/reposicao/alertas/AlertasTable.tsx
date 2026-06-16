// Tabela de alertas + paginação dos Alertas de Outlier.
// Extraída de src/pages/AdminReposicaoAlertas.tsx (god-component split).
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, ChevronLeft, ChevronRight } from "lucide-react";
import { sevBadge, statusBadge } from "./badges";
import { tipoLabel, fmt, type EventoOutlier } from "./types";

export function AlertasTable({
  lista, isLoading, selecionados, todosMarcados, selecionavelCount,
  toggleAll, toggleOne, onDrill, page, totalPages, setPage,
}: {
  lista?: { rows: EventoOutlier[]; total: number };
  isLoading: boolean;
  selecionados: Set<number>;
  todosMarcados: boolean;
  selecionavelCount: number;
  toggleAll: () => void;
  toggleOne: (id: number) => void;
  onDrill: (e: EventoOutlier) => void;
  page: number;
  totalPages: number;
  setPage: (value: number | ((prev: number) => number)) => void;
}) {
  return (
    <Card>
      <CardContent className="pt-4 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox checked={todosMarcados} onCheckedChange={toggleAll} disabled={selecionavelCount === 0} />
              </TableHead>
              <TableHead>Severidade</TableHead>
              <TableHead>Data evento</TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>Tipo</TableHead>
              <TableHead className="text-right">Observado</TableHead>
              <TableHead className="text-right">Esperado</TableHead>
              <TableHead className="text-right">σ</TableHead>
              <TableHead>Mensagem</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow><TableCell colSpan={12} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></TableCell></TableRow>
            )}
            {!isLoading && (lista?.rows.length ?? 0) === 0 && (
              <TableRow><TableCell colSpan={12} className="text-center py-8 text-muted-foreground">Nenhum alerta encontrado</TableCell></TableRow>
            )}
            {lista?.rows.map((r) => {
              const podeSelecionar =
                r.status === "pendente" && r.severidade !== "critico" && r.tipo !== "sku_sem_grupo";
              return (
                <TableRow key={r.id} className="hover:bg-muted/50">
                  <TableCell>
                    <Checkbox
                      checked={selecionados.has(r.id)}
                      onCheckedChange={() => toggleOne(r.id)}
                      disabled={!podeSelecionar}
                    />
                  </TableCell>
                  <TableCell>{sevBadge(r.severidade)}</TableCell>
                  <TableCell className="text-sm">{new Date(r.data_evento).toLocaleDateString("pt-BR")}</TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{r.sku_codigo_omie}</TableCell>
                  <TableCell className="text-sm min-w-[260px] max-w-[360px] whitespace-normal break-words" title={r.sku_descricao ?? undefined}>{r.sku_descricao ?? "—"}</TableCell>
                  <TableCell><Badge variant="outline">{tipoLabel(r.tipo)}</Badge></TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmt(r.valor_observado, 0)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmt(r.valor_esperado, 1)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmt(r.desvios_padrao, 1)}</TableCell>
                  <TableCell className="text-xs min-w-[280px] max-w-[420px] whitespace-normal break-words text-muted-foreground" title={r.detalhes?.mensagem ?? undefined}>{r.detalhes?.mensagem ?? "—"}</TableCell>
                  <TableCell>{statusBadge(r.status)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => onDrill(r)}>Detalhes</Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>

        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-muted-foreground">{lista?.total ?? 0} alerta(s)</div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm">{page} / {totalPages}</span>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
