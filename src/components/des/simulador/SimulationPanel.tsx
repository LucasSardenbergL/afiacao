// Painel de simulação (estado local + chamada RPC + controles + resultado).
// Extraído verbatim de src/components/des/SimuladorTab.tsx (god-component split).
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PrazoOption, SimResult } from "./types";
import { SimulationControls } from "./SimulationControls";
import { SimulationResult } from "./SimulationResult";

interface SimulationPanelProps {
  empresa: string;
  ano: number;
  trimestre: number;
  prazos: PrazoOption[];
  defaultValor: number;
  defaultDias: number;
  defaultPrazo: string;
  faltamProximaFaixa: number | null;
  onClose?: () => void;
  title?: string;
}

export function SimulationPanel({
  empresa,
  ano,
  trimestre,
  prazos,
  defaultValor,
  defaultDias,
  defaultPrazo,
  faltamProximaFaixa,
  onClose,
  title,
}: SimulationPanelProps) {
  const [valorExtra, setValorExtra] = useState<number>(defaultValor);
  const [valorInput, setValorInput] = useState<string>(String(defaultValor));
  const [diasEstoque, setDiasEstoque] = useState<number>(defaultDias);
  const [prazoCodigo, setPrazoCodigo] = useState<string>(defaultPrazo);
  const [resultado, setResultado] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    setValorInput(String(valorExtra));
  }, [valorExtra]);

  async function simular() {
    if (valorExtra < 0) {
      toast.error("Valor extra deve ser ≥ 0");
      return;
    }
    if (diasEstoque < 1 || diasEstoque > 365) {
      toast.error("Dias de estoque extra deve estar entre 1 e 365");
      return;
    }
    const prazoValido = prazos.some((p) => p.codigo === prazoCodigo);
    if (!prazoValido) {
      toast.error("Prazo de pagamento inválido");
      return;
    }

    setLoading(true);
    try {
      const { data, error } = await supabase.rpc(
        "simular_puxar_volume_trimestre" as never,
        {
          p_empresa: empresa,
          p_ano: ano,
          p_trimestre: trimestre,
          p_valor_extra: valorExtra,
          p_prazo_pagamento_codigo: prazoCodigo,
          p_dias_estoque_extra: diasEstoque,
        } as never,
      );
      if (error) throw error;
      setResultado(data as unknown as SimResult);
      toast.success("Cenário simulado");
    } catch (err) {
      console.error(err);
      toast.error("Erro ao simular: " + (err instanceof Error ? err.message : "desconhecido"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="relative">
      {title && (
        <div className="absolute top-3 right-3 flex items-center gap-2">
          {onClose && (
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
      {title && (
        <CardHeader className="pb-3">
          <CardTitle className="text-sm text-muted-foreground">{title}</CardTitle>
        </CardHeader>
      )}
      <CardContent className={cn("space-y-6", !title && "pt-6")}>
        <SimulationControls
          valorInput={valorInput}
          setValorInput={setValorInput}
          valorExtra={valorExtra}
          setValorExtra={setValorExtra}
          diasEstoque={diasEstoque}
          setDiasEstoque={setDiasEstoque}
          prazoCodigo={prazoCodigo}
          setPrazoCodigo={setPrazoCodigo}
          prazos={prazos}
          faltamProximaFaixa={faltamProximaFaixa}
          loading={loading}
          onSimular={simular}
        />

        {/* LINHA 3 - Resultado */}
        {!resultado ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              Ajuste os parâmetros e clique em Simular.
            </p>
          </div>
        ) : (
          <SimulationResult
            resultado={resultado}
            showDetails={showDetails}
            setShowDetails={setShowDetails}
          />
        )}
      </CardContent>
    </Card>
  );
}
