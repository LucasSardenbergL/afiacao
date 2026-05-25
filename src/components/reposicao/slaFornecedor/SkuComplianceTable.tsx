// Tabela de compliance de SLA por SKU.
// Extraída verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { STATUS_LABEL, STATUS_VARIANT, desvioColorClass, fmtData, fmtNum } from "./config";
import { TendenciaIcon } from "./TendenciaIcon";
import type { SkuCompliance } from "./types";

interface SkuComplianceTableProps {
  skus: SkuCompliance[];
  loading: boolean;
  onSelectSku: (s: SkuCompliance) => void;
}

export function SkuComplianceTable({ skus: skusFiltrados, loading: loadingSkus, onSelectSku }: SkuComplianceTableProps) {
  return (
    <div className="border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[120px]">Status</TableHead>
            <TableHead>SKU</TableHead>
            <TableHead>Grupo</TableHead>
            <TableHead className="text-right">LT teór.</TableHead>
            <TableHead className="text-right">LT obs.</TableHead>
            <TableHead className="text-right">Recente 5</TableHead>
            <TableHead className="text-right">Desvio</TableHead>
            <TableHead>Último receb.</TableHead>
            <TableHead className="text-right">N obs.</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loadingSkus &&
            Array.from({ length: 6 }).map((_, i) => (
              <TableRow key={i}>
                <TableCell colSpan={9}><Skeleton className="h-6 w-full" /></TableCell>
              </TableRow>
            ))}
          {!loadingSkus && skusFiltrados.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="text-center text-sm text-muted-foreground py-8">
                Nenhum SKU encontrado com os filtros atuais.
              </TableCell>
            </TableRow>
          )}
          {!loadingSkus &&
            skusFiltrados.map((s) => {
              const clicavel = (s.n_observacoes ?? 0) >= 3;
              return (
                <TableRow
                  key={`${s.empresa}-${s.sku_codigo_omie}`}
                  className={clicavel ? "cursor-pointer" : "opacity-90"}
                  onClick={() => clicavel && onSelectSku(s)}
                >
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[s.status_sla]}>{STATUS_LABEL[s.status_sla]}</Badge>
                  </TableCell>
                  <TableCell className="align-top min-w-[280px]">
                    <div className="font-mono text-xs text-muted-foreground">{s.sku_codigo_omie}</div>
                    <div className="text-sm font-medium whitespace-normal break-words">
                      {s.sku_descricao ?? "—"}
                    </div>
                  </TableCell>
                  <TableCell>
                    {s.grupo_codigo ? (
                      <Badge variant="outline" className="text-xs">{s.grupo_codigo}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmtNum(s.lt_teorico, 1)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmtNum(s.lt_observado_medio, 1)}</TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1 font-mono text-xs">
                      {fmtNum(s.lt_recente_medio, 1)}
                      <TendenciaIcon t={s.tendencia} />
                    </div>
                  </TableCell>
                  <TableCell className={`text-right font-mono text-xs ${desvioColorClass(s.desvio_perc)}`}>
                    {s.desvio_perc == null ? "—" : `${s.desvio_perc > 0 ? "+" : ""}${s.desvio_perc}%`}
                  </TableCell>
                  <TableCell className="text-xs">{fmtData(s.ultimo_recebimento)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{s.n_observacoes ?? 0}</TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
    </div>
  );
}
