import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { classBadge, fmt, fmtBRL } from "@/lib/reposicao/sku-param";
import { type BadgeVariant } from "@/components/reposicao/revisao/types";
import type { RowBaixoGiro } from "./types";

interface BaixoGiroTableProps {
  rows: RowBaixoGiro[];
  selected: Set<number>;
  onToggle: (code: number) => void;
  onToggleAll: (codes: number[]) => void;
  onResolverBloqueio: (row: RowBaixoGiro) => void;
  onManter: (row: RowBaixoGiro) => void;
  onDescontinuar: (row: RowBaixoGiro) => void;
}

export function BaixoGiroTable({
  rows,
  selected,
  onToggle,
  onToggleAll,
  onResolverBloqueio,
  onManter,
  onDescontinuar,
}: BaixoGiroTableProps) {
  const sorted = [...rows].sort((a, b) => {
    const ca = a.capital_parado ?? -1;
    const cb = b.capital_parado ?? -1;
    return cb - ca;
  });

  const allCodes = sorted.map((r) => r.sku_codigo_omie);
  const allSelected =
    sorted.length > 0 && sorted.every((r) => selected.has(r.sku_codigo_omie));

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected}
                onCheckedChange={() => onToggleAll(allCodes)}
                aria-label="Selecionar todos"
              />
            </TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Fornecedor</TableHead>
            <TableHead>Classe</TableHead>
            <TableHead className="text-right">Capital parado</TableHead>
            <TableHead className="text-right">Estoque</TableHead>
            <TableHead className="text-right">Dias s/ vender</TableHead>
            <TableHead className="text-right">Giro</TableHead>
            <TableHead>Situação</TableHead>
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                Nenhum item.
              </TableCell>
            </TableRow>
          ) : (
            sorted.map((row) => {
              const situacaoClass =
                row.situacao_cta === "resolver_bloqueio"
                  ? "text-status-warning"
                  : row.situacao_cta === "em_dia"
                    ? "text-status-success"
                    : "text-muted-foreground";

              let capitalCell: React.ReactNode;
              if (row.capital_parado != null) {
                capitalCell = fmtBRL(row.capital_parado);
              } else if ((row.saldo ?? 0) > 0) {
                capitalCell = <span className="text-status-warning">sem custo</span>;
              } else {
                capitalCell = "—";
              }

              let acaoPrimaria: React.ReactNode;
              if (row.situacao_cta === "resolver_bloqueio") {
                acaoPrimaria = (
                  <Button size="sm" onClick={() => onResolverBloqueio(row)}>
                    Resolver
                  </Button>
                );
              } else {
                acaoPrimaria = (
                  <Button size="sm" onClick={() => onManter(row)}>
                    Manter 1/2
                  </Button>
                );
              }

              return (
                <TableRow key={row.sku_codigo_omie}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(row.sku_codigo_omie)}
                      onCheckedChange={() => onToggle(row.sku_codigo_omie)}
                      aria-label={`Selecionar SKU ${row.sku_codigo_omie}`}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{row.sku_codigo_omie}</div>
                    {row.sku_descricao && (
                      <div className="text-xs text-muted-foreground leading-snug">
                        {row.sku_descricao}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{row.fornecedor_nome ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant={classBadge(row.classe_consolidada) as BadgeVariant}>
                      {row.classe_consolidada ?? "—"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tnum">{capitalCell}</TableCell>
                  <TableCell className="text-right tnum">{fmt(row.saldo, 0)}</TableCell>
                  <TableCell className="text-right tnum">{row.dias_sem_vender ?? "—"}</TableCell>
                  <TableCell className="text-right tnum">
                    {fmt(row.demanda_media_diaria, 3)}/dia
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={situacaoClass}>
                      {row.situacao_label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      {acaoPrimaria}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onDescontinuar(row)}
                      >
                        Descontinuar
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
