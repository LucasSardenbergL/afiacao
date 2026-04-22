import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PosicaoAtualTab } from "@/components/des/PosicaoAtualTab";
import { CheckinQualitativoTab } from "@/components/des/CheckinQualitativoTab";
import { SimuladorTab } from "@/components/des/SimuladorTab";
import { HistoricoTab } from "@/components/des/HistoricoTab";

const EMPRESA = "OBEN";

function getCurrentQuarter(): { ano: number; trimestre: number } {
  const now = new Date();
  return {
    ano: now.getFullYear(),
    trimestre: Math.floor(now.getMonth() / 3) + 1,
  };
}

export default function AdminDesTrimestreAtual() {
  const [tab, setTab] = useState("posicao");
  const { ano, trimestre } = getCurrentQuarter();

  return (
    <div className="container mx-auto p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-2xl font-bold text-foreground">Avaliação Trimestral DES</h1>
        <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <span>Performance</span>
          <ChevronRight className="h-3.5 w-3.5" />
          <span className="text-foreground font-medium">Avaliação Trimestral</span>
          <span className="ml-2 text-xs">· {ano} · T{trimestre} · {EMPRESA}</span>
        </nav>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        <TabsList className="grid w-full grid-cols-2 md:grid-cols-4 max-w-2xl">
          <TabsTrigger value="posicao">Posição atual</TabsTrigger>
          <TabsTrigger value="checkin">Checkin qualitativo</TabsTrigger>
          <TabsTrigger value="simulador">Simulador</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>

        <TabsContent value="posicao" className="space-y-6 mt-6">
          <PosicaoAtualTab empresa={EMPRESA} ano={ano} trimestre={trimestre} />
        </TabsContent>

        <TabsContent value="checkin" className="space-y-6 mt-6">
          <CheckinQualitativoTab empresa={EMPRESA} ano={ano} trimestre={trimestre} />
        </TabsContent>

        <TabsContent value="simulador" className="space-y-6 mt-6">
          <SimuladorTab empresa={EMPRESA} ano={ano} trimestre={trimestre} />
        </TabsContent>

        <TabsContent value="historico" className="space-y-6 mt-6">
          <HistoricoTab empresa={EMPRESA} ano={ano} trimestre={trimestre} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
