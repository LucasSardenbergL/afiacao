// Tabela do ranking completo de candidatos da tela de negociação paralela.
// Extraída de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
// Apresentacional: recebe as linhas já paginadas/filtradas + callbacks.
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatBRL,
  formatPerc,
  percPromoBadgeClass,
  categoriaBadgeClass,
  categoriaLabel,
} from "./helpers";
import type { RankingRow } from "./types";

interface RankingTableProps {
  rows: RankingRow[];
  loading: boolean;
  paginaAtual: number;
  pageSize: number;
  skusComSugestao: Set<string>;
  highlightSku: string | null;
  onCriarSugestao: (r: RankingRow) => void;
}

export function RankingTable({
  rows,
  loading,
  paginaAtual,
  pageSize,
  skusComSugestao,
  highlightSku,
  onCriarSugestao,
}: RankingTableProps) {
  return (
    <Card>
      <CardContent className="p-0 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead className="w-[35%] min-w-[280px]">SKU</TableHead>
              <TableHead>Volume 12m</TableHead>
              <TableHead>Compras</TableHead>
              <TableHead>Preço médio</TableHead>
              <TableHead>% meses promo</TableHead>
              <TableHead className="w-[180px]">Score</TableHead>
              <TableHead>Categoria</TableHead>
              <TableHead>Ação</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin inline mr-2" />
                  Carregando ranking...
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-10 text-muted-foreground">
                  Nenhum SKU encontrado.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r, idx) => {
                const posicao = (paginaAtual - 1) * pageSize + idx + 1;
                const temSugestao = skusComSugestao.has(r.sku_codigo_omie);
                const isHighlight = highlightSku === r.sku_codigo_omie;
                const score = Number(r.score_final ?? 0);
                return (
                  <TableRow
                    key={r.sku_codigo_omie}
                    className={cn(isHighlight && "bg-primary/10 transition-colors")}
                  >
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {posicao}
                    </TableCell>
                    <TableCell>
                      <div className="space-y-0.5">
                        <p className="text-xs font-mono text-muted-foreground">
                          {r.sku_codigo_omie}
                        </p>
                        <p className="text-sm whitespace-normal break-words leading-snug">
                          {r.sku_descricao ?? "—"}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatBRL(r.volume_financeiro_12m)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <span className="font-medium">{r.num_compras_12m ?? "—"}</span>
                        {r.meses_com_compra !== null && (
                          <Badge variant="outline" className="text-[10px] w-fit">
                            em {r.meses_com_compra} meses
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{formatBRL(r.preco_medio_unitario)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={percPromoBadgeClass(r.perc_meses_com_promo)}>
                        {formatPerc(r.perc_meses_com_promo)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold w-10">{score.toFixed(1)}</span>
                        <Progress value={score} className="h-1.5 flex-1" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn("uppercase text-[10px]", categoriaBadgeClass(r.categoria))}
                      >
                        {categoriaLabel(r.categoria)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {temSugestao ? (
                        <Badge variant="outline" className="text-[10px]">
                          Já sugerido
                        </Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onCriarSugestao(r)}
                        >
                          <Sparkles className="h-3 w-3 mr-1" />
                          Criar sugestão
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
