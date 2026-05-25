// AI Ops — inteligência operacional (decisões e recomendações automatizadas).
// Composição: useAiOps (queries/mutations/filtros) + header + stats + tabs.
// God-component split de src/pages/AIops.tsx (comportamento 1:1).
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Brain, Zap, Shield, Target } from 'lucide-react';
import { useAiOps } from '@/components/aiOps/useAiOps';
import { AiOpsHeader } from '@/components/aiOps/AiOpsHeader';
import { StatsCards } from '@/components/aiOps/StatsCards';
import { DecisionList } from '@/components/aiOps/DecisionList';

export default function AIops() {
  const {
    confidenceFilter,
    setConfidenceFilter,
    activeTab,
    setActiveTab,
    isLoading,
    profileMap,
    prioridades,
    oportunidades,
    riscos,
    isRunningAgent,
    runAgent,
    accept,
    dismiss,
  } = useAiOps();

  return (
    <div className="space-y-6">
      {/* Header */}
      <AiOpsHeader
        confidenceFilter={confidenceFilter}
        onConfidenceChange={setConfidenceFilter}
        onRunAgent={runAgent}
        isRunningAgent={isRunningAgent}
      />

      {/* Stats */}
      <StatsCards
        prioridadesCount={prioridades.length}
        oportunidadesCount={oportunidades.length}
        riscosCount={riscos.length}
      />

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="prioridades" className="gap-1.5">
            <Target className="w-3.5 h-3.5" />
            Prioridades do Dia
          </TabsTrigger>
          <TabsTrigger value="oportunidades" className="gap-1.5">
            <Zap className="w-3.5 h-3.5" />
            Oportunidades
          </TabsTrigger>
          <TabsTrigger value="riscos" className="gap-1.5">
            <Shield className="w-3.5 h-3.5" />
            Riscos
          </TabsTrigger>
        </TabsList>

        {isLoading ? (
          <div className="space-y-3 mt-4">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        ) : (
          <>
            <TabsContent value="prioridades">
              <DecisionList
                decisions={prioridades}
                profileMap={profileMap}
                emptyIcon={Brain}
                emptyMessage="Nenhuma prioridade gerada. Execute o agente para gerar recomendações."
                onAccept={accept}
                onDismiss={dismiss}
              />
            </TabsContent>

            <TabsContent value="oportunidades">
              <DecisionList
                decisions={oportunidades}
                profileMap={profileMap}
                emptyIcon={Zap}
                emptyMessage="Nenhuma oportunidade identificada no momento."
                onAccept={accept}
                onDismiss={dismiss}
              />
            </TabsContent>

            <TabsContent value="riscos">
              <DecisionList
                decisions={riscos}
                profileMap={profileMap}
                emptyIcon={Shield}
                emptyMessage="Nenhum cliente em risco identificado."
                onAccept={accept}
                onDismiss={dismiss}
              />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  );
}
