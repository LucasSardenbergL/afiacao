// Tabela de oportunidades ativas (loading/vazio/linhas).
// Extraída de src/pages/AdminReposicaoOportunidades.tsx (god-component split).
import type { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Loader2, ChevronRight, MoreVertical, EyeOff, ArrowRight } from "lucide-react";
import { EstadoVazio } from "./components";
import {
  formatBRL, formatNumber, formatDate, cenarioIcon, cenarioLabel, descontoBadgeClass,
  recomendacaoBadgeClass, RECOMENDACAO_LABEL,
} from "./shared";
import type { OportunidadeComDecisao } from "./types";

export function OportunidadesTable({
  isLoading, totalCount, rows, navigate, onOpenDrawer, onIgnorar,
}: {
  isLoading: boolean;
  totalCount: number;
  rows: OportunidadeComDecisao[];
  navigate: ReturnType<typeof useNavigate>;
  onOpenDrawer: (o: OportunidadeComDecisao) => void;
  onIgnorar: (sku: number) => void;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }
  if (totalCount === 0) {
    return <EstadoVazio navigate={navigate} />;
  }
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10"></TableHead>
            <TableHead>SKU / Descrição</TableHead>
            <TableHead>Fornecedor</TableHead>
            <TableHead className="text-right">Desconto total</TableHead>
            <TableHead className="text-right">Comprar</TableHead>
            <TableHead>Decisão</TableHead>
            <TableHead>Data limite</TableHead>
            <TableHead className="text-right">Net R$</TableHead>
            <TableHead className="text-right">Economia bruta</TableHead>
            <TableHead className="w-20 text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={10} className="text-center text-muted-foreground py-12">
                Nenhum SKU bate os filtros atuais.
              </TableCell>
            </TableRow>
          )}
          {rows.map((o) => (
            <TableRow key={`${o.sku_codigo_omie}-${o.cenario}`}>
              <TableCell>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex">{cenarioIcon(o.cenario)}</span>
                  </TooltipTrigger>
                  <TooltipContent>{cenarioLabel(o.cenario)}</TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell>
                <div className="font-medium tabular-nums text-xs text-muted-foreground">
                  {o.sku_codigo_omie}
                </div>
                <div className="text-sm">{o.sku_descricao ?? "—"}</div>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {o.fornecedor_nome ?? "—"}
              </TableCell>
              <TableCell className="text-right">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className={descontoBadgeClass(o.desconto_total_perc)}
                    >
                      {formatNumber(o.desconto_total_perc, 1)}%
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    <div className="space-y-1 text-xs">
                      <div>
                        Base promo: {formatNumber(o.desconto_promo_perc, 2)}%
                      </div>
                      {o.tem_negociacao_extra && (
                        <div>+ Extra negociado</div>
                      )}
                      {o.aumento_evitado_perc !== null &&
                        Number(o.aumento_evitado_perc) > 0 && (
                          <div>
                            + Aumento evitado:{" "}
                            {formatNumber(o.aumento_evitado_perc, 2)}%
                          </div>
                        )}
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-medium">
                      {formatNumber(o.decisao.q_base, 0)} →{" "}
                      {formatNumber(o.decisao.q_candidata, 0)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="text-xs space-y-1">
                      <div>
                        Demanda diária: {formatNumber(o.demanda_diaria, 2)}
                      </div>
                      <div>
                        Quantidade base EOQ: {formatNumber(o.qtde_base, 0)}
                      </div>
                      <div>
                        Qtde sugerida promo: {formatNumber(o.qtde_oportunidade, 0)}
                      </div>
                      <div>
                        Cobertura extra:{" "}
                        {formatNumber(o.decisao.dias_cobertura_extra, 1)} dias
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={recomendacaoBadgeClass(o.decisao.recomendacao)}
                >
                  {RECOMENDACAO_LABEL[o.decisao.recomendacao]}
                </Badge>
              </TableCell>
              <TableCell className="text-sm">
                <div className="tabular-nums">{formatDate(o.data_limite_acao)}</div>
                <div className="text-xs text-muted-foreground">
                  {o.dias_ate_limite !== null
                    ? `em ${o.dias_ate_limite} ${o.dias_ate_limite === 1 ? "dia" : "dias"}`
                    : ""}
                </div>
              </TableCell>
              <TableCell
                className={`text-right tabular-nums font-medium ${
                  o.decisao.beneficio_liquido_rs > 0
                    ? "text-status-success"
                    : o.decisao.beneficio_liquido_rs < 0
                      ? "text-status-error"
                      : "text-muted-foreground"
                }`}
              >
                {formatBRL(o.decisao.beneficio_liquido_rs)}
              </TableCell>
              <TableCell
                className={`text-right tabular-nums font-medium ${
                  Number(o.economia_bruta_estimada ?? 0) > 0
                    ? "text-status-success"
                    : "text-muted-foreground"
                }`}
              >
                {formatBRL(o.economia_bruta_estimada)}
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => onOpenDrawer(o)}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-8 w-8">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          navigate(
                            `/admin/reposicao/skus/${o.sku_codigo_omie}`,
                          )
                        }
                      >
                        <ArrowRight className="h-4 w-4 mr-2" />
                        Ir para SKU em reposição
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onIgnorar(o.sku_codigo_omie)}
                      >
                        <EyeOff className="h-4 w-4 mr-2" />
                        Ignorar hoje
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
