// Aba "Prontos para aplicar": filtros + tabela com seleção e ação por linha.
// Extraída verbatim de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type FilaItem } from "./types";
import { DeltaArrow } from "./DeltaArrow";

interface ProntosTabProps {
  filteredItens: FilaItem[];
  isLoading: boolean;
  search: string;
  setSearch: (v: string) => void;
  deltaFilter: string;
  setDeltaFilter: (v: string) => void;
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  toggleAll: () => void;
  hasBloqueados: boolean;
  aplicarPending: boolean;
  onAplicarLote: (ids: number[]) => void;
  onConfirmIndividual: (it: FilaItem) => void;
}

export function ProntosTab({
  filteredItens,
  isLoading,
  search,
  setSearch,
  deltaFilter,
  setDeltaFilter,
  selected,
  setSelected,
  toggleAll,
  hasBloqueados,
  aplicarPending,
  onAplicarLote,
  onConfirmIndividual,
}: ProntosTabProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8 w-64"
              placeholder="Buscar SKU ou descrição"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={deltaFilter} onValueChange={setDeltaFilter}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Filtrar por delta" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos os deltas</SelectItem>
              <SelectItem value="<10">&lt; 10%</SelectItem>
              <SelectItem value="10-25">10–25%</SelectItem>
              <SelectItem value="25-50">25–50%</SelectItem>
              <SelectItem value=">50">&gt; 50%</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          disabled={selected.size === 0 || aplicarPending || hasBloqueados}
          onClick={() => onAplicarLote(Array.from(selected))}
        >
          Aplicar selecionados ({selected.size})
        </Button>
      </CardHeader>
      <CardContent>
        {hasBloqueados && (
          <div className="mb-3 rounded-md border border-warning bg-warning/5 px-3 py-2 text-xs">
            Há SKUs bloqueados. Aplicação em lote desabilitada — triê-los primeiro.
          </div>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={
                    filteredItens.length > 0 && selected.size === filteredItens.length
                  }
                  onCheckedChange={toggleAll}
                />
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>EM (atual → novo)</TableHead>
              <TableHead>PP (atual → novo)</TableHead>
              <TableHead>Emax (atual → novo)</TableHead>
              <TableHead>Δ máx</TableHead>
              <TableHead className="text-right">Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-6">
                  Carregando…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && filteredItens.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-6 text-muted-foreground">
                  Nenhum SKU pronto. Clique em "Gerar fila".
                </TableCell>
              </TableRow>
            )}
            {filteredItens.map((it) => (
              <TableRow key={it.id}>
                <TableCell>
                  <Checkbox
                    checked={selected.has(it.id)}
                    onCheckedChange={(v) => {
                      const n = new Set(selected);
                      if (v) n.add(it.id);
                      else n.delete(it.id);
                      setSelected(n);
                    }}
                  />
                </TableCell>
                <TableCell className="font-mono text-xs">{it.sku_codigo_omie}</TableCell>
                <TableCell className="min-w-[280px] whitespace-normal break-words">{it.sku_descricao}</TableCell>
                <TableCell>
                  <DeltaArrow
                    novo={it.estoque_minimo_novo}
                    atual={it.estoque_minimo_omie_atual}
                  />
                </TableCell>
                <TableCell>
                  <DeltaArrow
                    novo={it.ponto_pedido_novo}
                    atual={it.ponto_pedido_omie_atual}
                  />
                </TableCell>
                <TableCell>
                  <DeltaArrow
                    novo={it.estoque_maximo_novo}
                    atual={it.estoque_maximo_omie_atual}
                  />
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      (it.delta_max_perc ?? 0) > 50
                        ? "destructive"
                        : (it.delta_max_perc ?? 0) > 25
                        ? "secondary"
                        : "outline"
                    }
                  >
                    {(it.delta_max_perc ?? 0).toFixed(0)}%
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onConfirmIndividual(it)}
                  >
                    Aplicar
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
