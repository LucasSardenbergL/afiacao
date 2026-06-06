import { Handshake, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBRL } from "./helpers";
import type { CandidatoNegociacao } from "./types";
import { avaliarNegociacao } from "@/lib/reposicao/negociacao-valor-helpers";

interface Props {
  candidato: CandidatoNegociacao;
  descontoPerc: number; // ex.: 8
  onSetDesconto: (sku: string, perc: number) => void;
  onVouNegociar: (c: CandidatoNegociacao) => void;
}

function fmtUn(n: number | null): string {
  return n == null ? "—" : `${Math.round(n)} un`;
}

export function OportunidadeCard({ candidato, descontoPerc, onSetDesconto, onVouNegociar }: Props) {
  const r = avaliarNegociacao(
    {
      sku_codigo_omie: candidato.sku_codigo_omie,
      sku_descricao: candidato.sku_descricao,
      consumo_anual: candidato.consumo_anual,
      preco_compra: candidato.preco_compra,
      cmc: candidato.cmc,
      custo_capital_anual: candidato.custo_capital_anual,
    },
    descontoPerc / 100,
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold leading-tight">{candidato.sku_descricao ?? candidato.sku_codigo_omie}</h3>
            <p className="text-xs text-muted-foreground font-tabular">{candidato.sku_codigo_omie}</p>
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            Gasto/ano {formatBRL(candidato.gasto_anual)}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Controle de desconto */}
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor={`desc-${candidato.sku_codigo_omie}`} className="text-xs">Desconto que você espera (%)</Label>
            <Input
              id={`desc-${candidato.sku_codigo_omie}`}
              type="number" min={1} max={50} step={1}
              value={descontoPerc}
              onChange={(e) => onSetDesconto(candidato.sku_codigo_omie, Number(e.target.value))}
              className="w-24 font-tabular"
            />
          </div>
          <p className="text-[11px] text-muted-foreground leading-snug pb-1">
            Em promoção, o gerente costuma dar no máximo ~3%.
          </p>
        </div>

        {/* Números */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">Economia/ano</p>
            <p className="kpi-value text-base">{formatBRL(r.premio_anual)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Sobra por negociação</p>
            <p className="kpi-value text-base">{formatBRL(r.net_negociacao)}</p>
          </div>
        </div>

        {/* Munição de negociação */}
        {r.elegivel ? (
          <div className="rounded-md bg-muted/50 border border-border p-3 text-sm">
            <div className="flex items-center gap-2 mb-1 text-status-success">
              <TrendingUp className="h-4 w-4" />
              <span className="font-medium">Quanto prometer</span>
            </div>
            <p className="text-foreground/90">
              Ideal <strong>{fmtUn(r.lote_otimo)}</strong> (~{r.meses_otimo?.toFixed(1)} meses de giro).
              Nunca acima de <strong>{fmtUn(r.teto_volume)}</strong> (~{r.meses_teto?.toFixed(1)} meses) —
              aí o capital parado come o desconto.
            </p>
          </div>
        ) : (
          <div className="rounded-md bg-status-warning/10 border border-status-warning/30 p-3 text-sm text-status-warning">
            {r.motivo_inelegivel === "sem_cmc"
              ? "Custo a confirmar (sem CMC no Omie) — economia estimada, sem teto calculado."
              : "Dados insuficientes para calcular o teto."}
          </div>
        )}

        <Button onClick={() => onVouNegociar(candidato)} className="w-full" disabled={!r.elegivel}>
          <Handshake className="h-4 w-4 mr-2" />
          Vou negociar este
        </Button>
      </CardContent>
    </Card>
  );
}
