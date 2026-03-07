import React, { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useUserRole } from '@/hooks/useUserRole';
import { useCommercialRole } from '@/hooks/useCommercialRole';
import { supabase } from '@/integrations/supabase/client';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Activity, BarChart3, ShieldCheck, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { IntelligenceOperationalTab } from '@/components/intelligence/IntelligenceOperationalTab';
import { IntelligenceManagerialTab } from '@/components/intelligence/IntelligenceManagerialTab';
import { IntelligenceStrategicTab } from '@/components/intelligence/IntelligenceStrategicTab';
import { IntelligenceUserSimulator } from '@/components/intelligence/IntelligenceUserSimulator';

export default function IntelligenceDashboard() {
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const { commercialRole, canViewManagerial, canViewStrategic, isSuperAdmin, loading } = useCommercialRole();
  const [simulatingAs, setSimulatingAs] = useState<string | null>(null);

  const effectiveFarmerId = simulatingAs || ((!canViewManagerial && !isAdmin) ? user?.id : undefined);
  const defaultTab = canViewStrategic ? 'strategic' : canViewManagerial ? 'managerial' : 'operational';

  const [runningScores, setRunningScores] = useState(false);
  const runScoreCalc = async () => {
    setRunningScores(true);
    try {
      const { error } = await supabase.functions.invoke('calculate-scores');
      if (error) throw error;
      toast.success('Scores recalculados com sucesso');
    } catch (e: any) {
      toast.error('Erro: ' + e.message);
    } finally {
      setRunningScores(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Inteligência Comercial</h1>
          <p className="text-sm text-muted-foreground">Análise de performance, carteira e métricas estratégicas</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isSuperAdmin && (
            <Button size="sm" variant="outline" onClick={runScoreCalc} disabled={runningScores} className="h-7 text-xs">
              <RefreshCw className={`w-3 h-3 mr-1 ${runningScores ? 'animate-spin' : ''}`} />
              Recalcular Scores
            </Button>
          )}
          {commercialRole && (
            <Badge variant="outline" className="text-xs capitalize">{commercialRole.replace('_', ' ')}</Badge>
          )}
          {isSuperAdmin && (
            <Badge className="text-xs bg-amber-500/20 text-amber-700 border-amber-500/30">
              <ShieldCheck className="w-3 h-3 mr-1" /> Acesso Total
            </Badge>
          )}
        </div>
      </div>

      {isSuperAdmin && (
        <IntelligenceUserSimulator onSelect={setSimulatingAs} currentSimulation={simulatingAs} />
      )}

      <Tabs defaultValue={defaultTab}>
        <TabsList className="h-8">
          <TabsTrigger value="operational" className="text-xs px-3 h-7">
            <Activity className="w-3 h-3 mr-1" /> Operacional
          </TabsTrigger>
          {(canViewManagerial || isAdmin) && (
            <TabsTrigger value="managerial" className="text-xs px-3 h-7">
              <BarChart3 className="w-3 h-3 mr-1" /> Gerencial
            </TabsTrigger>
          )}
          {(canViewStrategic || isAdmin) && (
            <TabsTrigger value="strategic" className="text-xs px-3 h-7">
              <ShieldCheck className="w-3 h-3 mr-1" /> Estratégico
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="operational" className="mt-4">
          <IntelligenceOperationalTab farmerId={effectiveFarmerId || undefined} />
        </TabsContent>

        {(canViewManagerial || isAdmin) && (
          <TabsContent value="managerial" className="mt-4">
            <IntelligenceManagerialTab />
          </TabsContent>
        )}

        {(canViewStrategic || isAdmin) && (
          <TabsContent value="strategic" className="mt-4">
            <IntelligenceStrategicTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
