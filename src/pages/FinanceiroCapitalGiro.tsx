import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PosicaoAgora } from '@/components/financeiro/cashflow/PosicaoAgora';
import { EventosManager } from '@/components/financeiro/cashflow/EventosManager';
import { Button } from '@/components/ui/button';
import { Settings } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function FinanceiroCapitalGiro() {
  const { isMaster } = useAuth();
  const [showConfig, setShowConfig] = useState(false);

  return (
    <div className="container mx-auto py-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-display">Capital de Giro</h1>
        {isMaster && (
          <Button size="sm" variant="ghost" onClick={() => setShowConfig(true)} title="Configuração (master)">
            <Settings className="h-4 w-4" />
          </Button>
        )}
      </div>

      <Tabs defaultValue="posicao">
        <TabsList>
          <TabsTrigger value="posicao">Posição agora</TabsTrigger>
          <TabsTrigger value="fluxo">Fluxo 13 semanas</TabsTrigger>
          <TabsTrigger value="ncg">NCG</TabsTrigger>
          <TabsTrigger value="eventos">Eventos</TabsTrigger>
        </TabsList>

        <TabsContent value="posicao"><PosicaoAgora /></TabsContent>
        <TabsContent value="fluxo">
          <div className="text-center text-muted-foreground py-12">Fluxo 13s — disponível na Phase 4</div>
        </TabsContent>
        <TabsContent value="ncg">
          <div className="text-center text-muted-foreground py-12">NCG — disponível na Phase 5</div>
        </TabsContent>
        <TabsContent value="eventos"><EventosManager /></TabsContent>
      </Tabs>

      {showConfig && isMaster && (
        <div className="text-center text-muted-foreground py-4">Configuração — Phase 6</div>
      )}
    </div>
  );
}
