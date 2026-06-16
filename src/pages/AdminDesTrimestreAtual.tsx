import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PosicaoAtualTab } from "@/components/des/PosicaoAtualTab";
import { CheckinQualitativoTab } from "@/components/des/CheckinQualitativoTab";
import { SimuladorTab } from "@/components/des/SimuladorTab";
import { HistoricoTab } from "@/components/des/HistoricoTab";
import { ConfiguracaoTab } from "@/components/des/ConfiguracaoTab";

const EMPRESA = "OBEN";

function getCurrentQuarter(): { ano: number; trimestre: number } {
  const now = new Date();
  return {
    ano: now.getFullYear(),
    trimestre: Math.floor(now.getMonth() / 3) + 1,
  };
}

export default function AdminDesTrimestreAtual() {
  const location = useLocation();
  // A rota /admin/des/configuracao é um atalho que abre direto a aba Configuração.
  const [tab, setTab] = useState(
    location.pathname.includes("/configuracao") ? "config" : "posicao",
  );
  const { ano, trimestre } = getCurrentQuarter();

  // Sincroniza a aba com a rota nos dois sentidos, mesmo se o componente não
  // remontar ao navegar entre /trimestre-atual e /configuracao (mesmo element).
  // Trocar de aba manualmente não muda o pathname, então não dispara este efeito.
  useEffect(() => {
    setTab(location.pathname.includes("/configuracao") ? "config" : "posicao");
  }, [location.pathname]);

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
        <TabsList className="grid w-full grid-cols-3 md:grid-cols-5 max-w-3xl">
          <TabsTrigger value="posicao">Posição atual</TabsTrigger>
          <TabsTrigger value="checkin">Checkin qualitativo</TabsTrigger>
          <TabsTrigger value="simulador">Simulador</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="config">Configuração</TabsTrigger>
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

        <TabsContent value="config" className="space-y-6 mt-6">
          <ConfiguracaoTab empresa={EMPRESA} ano={ano} trimestre={trimestre} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
