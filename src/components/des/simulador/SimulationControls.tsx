// Controles do painel de simulação (valor extra, prazo, dias de estoque + botão).
// Extraído verbatim de src/components/des/SimuladorTab.tsx (god-component split).
import { Info, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PrazoOption } from "./types";
import { fmtBRL } from "./format";

interface SimulationControlsProps {
  valorInput: string;
  setValorInput: (v: string) => void;
  valorExtra: number;
  setValorExtra: (n: number) => void;
  diasEstoque: number;
  setDiasEstoque: (n: number) => void;
  prazoCodigo: string;
  setPrazoCodigo: (c: string) => void;
  prazos: PrazoOption[];
  faltamProximaFaixa: number | null;
  loading: boolean;
  onSimular: () => void;
}

export function SimulationControls({
  valorInput,
  setValorInput,
  valorExtra,
  setValorExtra,
  diasEstoque,
  setDiasEstoque,
  prazoCodigo,
  setPrazoCodigo,
  prazos,
  faltamProximaFaixa,
  loading,
  onSimular,
}: SimulationControlsProps) {
  return (
    <>
      {/* LINHA 1 - Controles */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Coluna A - Valor extra */}
        <div className="space-y-3">
          <Label className="text-xs font-medium">Valor extra a puxar (R$)</Label>
          <Input
            type="number"
            value={valorInput}
            onChange={(e) => setValorInput(e.target.value)}
            onBlur={() => {
              const n = Number(valorInput);
              if (!isNaN(n) && n >= 0) setValorExtra(n);
              else setValorInput(String(valorExtra));
            }}
            min={0}
            step={1000}
            className="text-sm"
          />
          <Slider
            value={[valorExtra]}
            onValueChange={(v) => setValorExtra(v[0])}
            min={0}
            max={200000}
            step={5000}
          />
          <p className="text-xs text-muted-foreground">
            R$ 0 — R$ 200.000
          </p>
          {faltamProximaFaixa != null && faltamProximaFaixa > 0 && (
            <button
              type="button"
              className="inline-flex items-center text-xs px-2 py-1 rounded-md bg-status-warning/10 text-status-warning border border-status-warning/30 hover:bg-status-warning/20 transition-colors"
              onClick={() => setValorExtra(Math.round(faltamProximaFaixa))}
            >
              Faltam para próxima faixa: {fmtBRL(faltamProximaFaixa)}
            </button>
          )}
        </div>

        {/* Coluna B - Prazo */}
        <div className="space-y-3">
          <Label className="text-xs font-medium">Prazo de pagamento</Label>
          <Select value={prazoCodigo} onValueChange={setPrazoCodigo}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              {prazos.map((p) => {
                const sinal = p.desconto_ou_encargo_perc >= 0 ? "+" : "";
                return (
                  <SelectItem key={p.codigo} value={p.codigo}>
                    {p.nome} ({sinal}
                    {p.desconto_ou_encargo_perc.toFixed(2).replace(".", ",")}%)
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Antecipado dá desconto. Prazos longos cobram encargo.
          </p>
        </div>

        {/* Coluna C - Dias estoque */}
        <div className="space-y-3">
          <TooltipProvider>
            <div className="flex items-center gap-1.5">
              <Label className="text-xs font-medium">Dias de estoque extra estimado</Label>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <p className="text-xs">
                    Quantos dias o volume extra vai ficar parado além do seu giro normal. Afeta o custo de capital.
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
          <Input
            type="number"
            value={diasEstoque}
            onChange={(e) => setDiasEstoque(Number(e.target.value))}
            min={1}
            max={365}
            step={1}
            className="text-sm"
          />
          <Slider
            value={[diasEstoque]}
            onValueChange={(v) => setDiasEstoque(v[0])}
            min={30}
            max={180}
            step={15}
          />
          <p className="text-xs text-muted-foreground">30 — 180 dias</p>
        </div>
      </div>

      {/* LINHA 2 - Botão */}
      <div className="flex justify-center">
        <Button size="lg" onClick={onSimular} disabled={loading} className="min-w-[200px]">
          {loading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Play className="h-4 w-4 mr-2" />
          )}
          Simular cenário
        </Button>
      </div>
    </>
  );
}
