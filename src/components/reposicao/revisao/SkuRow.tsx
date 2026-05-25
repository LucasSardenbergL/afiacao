// Linha da tabela de revisão de um SKU.
// Extraída verbatim de src/pages/AdminReposicaoRevisao.tsx (god-component split).
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  checked: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  onOpenDetail: (row: RowWithPrice) => void;
}

export function SkuRow({ row: r, checked, onToggleSelect, onOpenDetail }: SkuRowProps) {
  return (
    <TableRow className={r.read_only ? "bg-muted/30" : undefined}>
      <TableCell>
        {r.read_only ? (
          <span className="inline-block h-4 w-4" aria-hidden />
        ) : (
          <Checkbox
            checked={!!checked}
            onCheckedChange={(v) => onToggleSelect(r.id, !!v)}
          />
        )}
      </TableCell>
      <TableCell className="font-mono text-xs align-top">{r.sku_codigo_omie}</TableCell>
      <TableCell className="min-w-[280px] align-top">
        <div className="whitespace-normal break-words leading-snug">{r.sku_descricao}</div>
        {r.read_only && r.fornecedor_nome && (
          <Badge
            variant="warning"
            className="mt-1 text-[10px] font-medium"
            title="Fornecedor pendente de habilitação para reposição"
          >
            🏭 {r.fornecedor_nome}
          </Badge>
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
        {r.read_only ? (
          <Badge
            variant="secondary"
            className="bg-muted text-muted-foreground border-muted-foreground/20"
            title="SKU bloqueado: fornecedor ainda não habilitado para reposição automática"
          >
            Aguardando fornecedor
          </Badge>
        ) : r.aprovado_em ? (
          <Badge variant="default">Aprovado</Badge>
        ) : (
          <Badge variant="outline">Pendente</Badge>
        )}
      </TableCell>
      <TableCell>
        <Button size="sm" variant="ghost" onClick={() => onOpenDetail(r)}>
          Detalhes
        </Button>
      </TableCell>
    </TableRow>
  );
}
