// Card de sugestão ativa da tela de negociação paralela.
// Extraído de src/pages/AdminReposicaoNegociacaoParalela.tsx (god-component split).
// Apresentacional: recebe a sugestão + callbacks; não detém estado próprio.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Eye, MoreVertical, Handshake } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  categoriaBadgeClass,
  categoriaLabel,
  statusBadgeClass,
  statusLabel,
  formatBRL,
  formatPerc,
} from "./helpers";
import type { Sugestao, RankingRow } from "./types";

interface SugestaoCardProps {
  s: Sugestao;
  rankingExtra?: RankingRow | undefined;
  onMarcarVisualizada: (s: Sugestao) => void;
  onIrAoRanking: (s: Sugestao) => void;
  onMarcarEmAndamento: (s: Sugestao) => void;
  onIgnorar: (s: Sugestao) => void;
  onFecharSemAcordo: (s: Sugestao) => void;
  onConverter: (s: Sugestao) => void;
}

export function SugestaoCard({
  s,
  rankingExtra,
  onMarcarVisualizada,
  onIrAoRanking,
  onMarcarEmAndamento,
  onIgnorar,
  onFecharSemAcordo,
  onConverter,
}: SugestaoCardProps) {
  const numCompras = rankingExtra?.num_compras_12m ?? null;
  const mesesCompra = rankingExtra?.meses_com_compra ?? null;
  const score = Number(s.score_final ?? 0);
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          {s.categoria && s.categoria !== "fraco" ? (
            <Badge variant="outline" className={cn("uppercase text-[10px] tracking-wide", categoriaBadgeClass(s.categoria))}>
              {categoriaLabel(s.categoria)}
            </Badge>
          ) : <span />}
          <Badge variant="outline" className={cn("text-[10px]", statusBadgeClass(s.status))}>
            {statusLabel(s.status)}
          </Badge>
        </div>
        <CardTitle className="text-base leading-snug mt-2 break-words">
          {s.sku_descricao ?? "Sem descrição"}
        </CardTitle>
        <p className="text-xs font-mono text-muted-foreground">{s.sku_codigo_omie}</p>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-4 pt-0">
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-medium">Score</span>
            <span className="font-semibold">{score.toFixed(1)}</span>
          </div>
          <Progress value={score} className="h-2" />
        </div>

        {s.motivo && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {(s.motivo_detalhes && (s.motivo_detalhes as Record<string, unknown>).motivo_legivel as string | undefined) || s.motivo}
          </p>
        )}

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground">Volume 12m</p>
            <p className="font-semibold">{formatBRL(s.volume_financeiro_12m)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Preço médio</p>
            <p className="font-semibold">{formatBRL(s.preco_medio_unitario)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Compras 12m</p>
            <p className="font-semibold">
              {numCompras ?? "—"}
              {mesesCompra !== null && (
                <span className="text-muted-foreground font-normal"> em {mesesCompra} meses</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">% meses com promo</p>
            <p className="font-semibold">{formatPerc(s.perc_meses_com_promo)}</p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs px-3 py-2 bg-muted/40 rounded-md border border-border">
          <span className="text-muted-foreground">
            Estoque: <span className="font-semibold text-foreground">{s.estoque_efetivo ?? 0}</span>
          </span>
          <span className="text-muted-foreground">
            PP: <span className="font-semibold text-foreground">{s.ponto_pedido ?? "—"}</span>
          </span>
        </div>

        <p className="text-xs text-muted-foreground">
          Expira em {s.dias_ate_expirar ?? "—"} dia{(s.dias_ate_expirar ?? 0) === 1 ? "" : "s"}
        </p>

        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            disabled={s.status !== "nova"}
            onClick={() => onMarcarVisualizada(s)}
          >
            <Eye className="h-3.5 w-3.5 mr-1.5" />
            Marcar visualizada
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreVertical className="h-3.5 w-3.5 mr-1.5" />
                Ações
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onIrAoRanking(s)}>Ir ao ranking</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onMarcarEmAndamento(s)}>
                Marcar como em andamento
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onIgnorar(s)}>Ignorar</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onFecharSemAcordo(s)}>
                Fechar sem acordo
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            className="ml-auto bg-status-success hover:bg-status-success/90 text-white"
            onClick={() => onConverter(s)}
          >
            <Handshake className="h-3.5 w-3.5 mr-1.5" />
            Registrar desconto fechado
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
