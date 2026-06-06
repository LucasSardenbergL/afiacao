// Linha da tabela de revisão de um SKU.
// Extraída verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  type RowWithPrice,
  fonteBadgeVariant,
  fonteBadgeLabel,
  classBadge,
  fmt,
  fmtBRL,
} from "@/lib/reposicao/sku-param";
import { type BadgeVariant } from "./types";

interface SkuRowProps {
  row: RowWithPrice;
  onOpenDetail: (row: RowWithPrice) => void;
  onPromover?: (sku: number) => void;
  promovendo?: boolean;
}

export function SkuRow({ row: r, onOpenDetail, onPromover, promovendo }: SkuRowProps) {
  const isCandidato = r.status_sugestao === "CANDIDATO_PRIMEIRA_COMPRA";
  const umClienteSo = isCandidato && r.recorrencia_clientes_180d === 1;
  return (
    <TableRow className={r.read_only ? "bg-muted/30" : undefined}>
      <TableCell className="font-mono text-xs align-top">{r.sku_codigo_omie}</TableCell>
      <TableCell className="min-w-[280px] align-top">
        <div className="whitespace-normal break-words leading-snug">{r.sku_descricao}</div>
        {isCandidato ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {r.fornecedor_nome && (
              <Badge variant="outline" className="text-[10px] font-medium">🏭 {r.fornecedor_nome}</Badge>
            )}
            <span className="text-[11px] text-muted-foreground">
              🔁 {r.recorrencia_meses_180d ?? "—"} meses · {r.recorrencia_nfs_180d ?? "—"} NFs ·{" "}
              {r.recorrencia_clientes_180d ?? "—"} cliente(s) · últ. há {r.dias_desde_ultima_venda ?? "—"}d
            </span>
            {umClienteSo && (
              <Badge variant="warning" className="text-[10px] font-medium" title="Recorrência concentrada em um único cliente — avalie antes de promover">
                ⚠ 1 cliente só
              </Badge>
            )}
            {r.ja_habilitado === true && (
              <Badge variant="secondary" className="text-[10px] font-medium" title="Já está habilitado pra reposição automática, mas sem parâmetros — por isso não comprava. Promover preenche os números.">
                já habilitado, sem nº
              </Badge>
            )}
          </div>
        ) : (
          r.read_only && r.fornecedor_nome && (
            <Badge
              variant="warning"
              className="mt-1 text-[10px] font-medium"
              title="Fornecedor pendente de habilitação para reposição"
            >
              🏭 {r.fornecedor_nome}
            </Badge>
          )
        )}
      </TableCell>
      <TableCell>
        <Badge variant={classBadge(r.classe_consolidada) as BadgeVariant}>
          {r.classe_consolidada}
        </Badge>
      </TableCell>
      <TableCell className="text-right">{fmt(r.demanda_media_diaria)}</TableCell>
      <TableCell className="text-right">{fmtBRL(r.preco_compra_real)}</TableCell>
      <TableCell className="text-right">{fmtBRL(r.preco_venda_medio)}</TableCell>
      <TableCell>
        <Badge variant={fonteBadgeVariant(r.fonte_preco) as BadgeVariant}>
          {fonteBadgeLabel(r.fonte_preco)}
        </Badge>
      </TableCell>
      <TableCell className="text-right">{fmt(r.lt_medio_dias_uteis, 1)}</TableCell>
      <TableCell className="text-right">{fmt(r.estoque_minimo, 0)}</TableCell>
      <TableCell className="text-right">{fmt(r.ponto_pedido, 0)}</TableCell>
      <TableCell className="text-right">{fmt(r.estoque_maximo, 0)}</TableCell>
      <TableCell>
        {isCandidato ? (
          <Badge
            variant="secondary"
            className="bg-status-info-bg text-status-info border-status-info/20"
            title="Vende com recorrência mas está fora da reposição automática. Revise e promova: entra no fluxo normal de compra (qtde-teste capada)."
          >
            Candidato 1ª compra
          </Badge>
        ) : r.read_only ? (
          <Badge
            variant="secondary"
            className="bg-muted text-muted-foreground border-muted-foreground/20"
            title="SKU bloqueado: fornecedor ainda não habilitado para reposição automática"
          >
            Aguardando fornecedor
          </Badge>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {isCandidato && onPromover && (
            <Button
              size="sm"
              onClick={() => onPromover(r.sku_codigo_omie)}
              disabled={promovendo}
              title="Comprar ~estoque-alvo de teste e habilitar a reposição normal deste SKU"
            >
              {promovendo ? <Loader2 className="h-4 w-4 animate-spin" /> : "Promover"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onOpenDetail(r)}>
            Detalhes
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
