// Tabela de associação SKU→Grupo + paginação.
// Extraída de src/pages/AdminReposicaoGruposProducao.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2 } from "lucide-react";
import { PAGE_SIZE, SEM_GRUPO, type Grupo, type SkuRow } from "./types";

export function SkuTable({
  skus, loadingSkus, selecionados, toggleSel, toggleAll, gruposParaSku,
  onMoverSku, moverSkuPending, page, setPage, totalSkus,
}: {
  skus: SkuRow[];
  loadingSkus: boolean;
  selecionados: Set<string>;
  toggleSel: (sku: number) => void;
  toggleAll: () => void;
  gruposParaSku: (fornecedor: string | null) => Grupo[];
  onMoverSku: (sku: number, novoGrupo: string | null) => void;
  moverSkuPending: boolean;
  page: number;
  setPage: (value: number | ((prev: number) => number)) => void;
  totalSkus: number;
}) {
  return (
    <>
      {/* Tabela SKUs */}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={skus.length > 0 && selecionados.size === skus.length}
                  onCheckedChange={toggleAll}
                />
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>Fornecedor</TableHead>
              <TableHead className="w-[260px]">Grupo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loadingSkus && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Carregando…
                </TableCell>
              </TableRow>
            )}
            {!loadingSkus && skus.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                  Nenhum SKU encontrado.
                </TableCell>
              </TableRow>
            )}
            {!loadingSkus && skus.map((r) => {
              const opts = gruposParaSku(r.fornecedor_nome);
              const k = String(r.sku_codigo_omie);
              return (
                <TableRow key={k}>
                  <TableCell>
                    <Checkbox
                      checked={selecionados.has(k)}
                      onCheckedChange={() => toggleSel(r.sku_codigo_omie)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.sku_codigo_omie}</TableCell>
                  <TableCell className="max-w-[320px] truncate">{r.sku_descricao || "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {r.fornecedor_nome || "—"}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={r.grupo_codigo || SEM_GRUPO}
                      onValueChange={(v) =>
                        onMoverSku(r.sku_codigo_omie, v === SEM_GRUPO ? null : v)
                      }
                      disabled={opts.length === 0 || moverSkuPending}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder={opts.length === 0 ? "Sem grupos do fornecedor" : "Selecionar…"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={SEM_GRUPO}>— Sem grupo —</SelectItem>
                        {opts.map((g) => (
                          <SelectItem key={g.id} value={g.grupo_codigo}>
                            {g.grupo_codigo} ({g.lt_producao_dias}d)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Paginação */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Mostrando {skus.length} de {totalSkus} SKUs
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Anterior
          </Button>
          <span>Página {page + 1}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={(page + 1) * PAGE_SIZE >= totalSkus}
            onClick={() => setPage((p) => p + 1)}
          >
            Próxima
          </Button>
        </div>
      </div>
    </>
  );
}
