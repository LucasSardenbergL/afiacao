import { useEffect, useState } from "react";
import { Info, Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Props } from "./simulador/types";
import { useSimuladorData } from "./simulador/useSimuladorData";
import { SimulationPanel } from "./simulador/SimulationPanel";

export function SimuladorTab({ empresa, ano, trimestre }: Props) {
  const [showCompare, setShowCompare] = useState(false);
  const [comparePrazo, setComparePrazo] = useState<string>("");

  const { prazos, faltamProximaFaixa, defaultPrazo, compareDefault, isLoading } = useSimuladorData(
    empresa,
    ano,
    trimestre,
  );

  useEffect(() => {
    if (!comparePrazo && compareDefault) setComparePrazo(compareDefault);
  }, [compareDefault, comparePrazo]);

  if (isLoading) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-6">
      {/* Card explicativo */}
      <Card className="bg-status-info/5 border-status-info/30">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 text-status-info mt-0.5 shrink-0" />
            <p className="text-xs text-foreground leading-relaxed">
              Simule o impacto financeiro de puxar volume extra no trimestre atual. Considera todos os custos
              (perda de antecipado, encargos, frete, custo de capital) e o ganho futuro de subir de faixa DES no
              próximo trimestre.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Painel principal */}
      <SimulationPanel
        empresa={empresa}
        ano={ano}
        trimestre={trimestre}
        prazos={prazos}
        defaultValor={50000}
        defaultDias={60}
        defaultPrazo={defaultPrazo}
        faltamProximaFaixa={faltamProximaFaixa}
      />

      {/* Comparador */}
      {!showCompare ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={() => setShowCompare(true)} disabled={prazos.length < 2}>
            <Plus className="h-4 w-4 mr-2" />
            Comparar com outro prazo de pagamento
          </Button>
        </div>
      ) : (
        <SimulationPanel
          empresa={empresa}
          ano={ano}
          trimestre={trimestre}
          prazos={prazos}
          defaultValor={50000}
          defaultDias={60}
          defaultPrazo={comparePrazo || compareDefault}
          faltamProximaFaixa={faltamProximaFaixa}
          onClose={() => setShowCompare(false)}
          title="Cenário comparativo"
        />
      )}
    </div>
  );
}
