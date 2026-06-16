// Aba "Experimentos" da tela FarmerLOCC (dona do próprio hook useFarmerExperiments).
// Extraída verbatim de src/pages/FarmerLOCC.tsx (god-component split).
import { memo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { FlaskConical } from 'lucide-react';
import { useFarmerExperiments } from '@/hooks/useFarmerExperiments';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { TabSkeleton } from './primitives';
import { ExperimentCard } from './ExperimentCard';
import { NewExperimentDialog } from './NewExperimentDialog';

export const ExperimentsTab = memo(() => {
  const { experiments, loading, createExperiment, startExperiment, measureExperiment, cancelExperiment } = useFarmerExperiments();
  // Lente "Ver como": criar/iniciar/medir/cancelar são writes — desabilitados (o
  // write-guard já bloqueia; o disable evita o erro/ruído). A lista é só leitura do alvo.
  const { isImpersonating } = useImpersonation();

  if (loading) {
    return <TabSkeleton />;
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Motor Experimental</span>
        <NewExperimentDialog onCreate={createExperiment} disabled={isImpersonating} />
      </div>

      {experiments.length === 0 ? (
        <Card>
          <CardContent className="p-6 text-center">
            <FlaskConical className="w-8 h-8 mx-auto mb-2 opacity-40" />
            <p className="text-xs text-muted-foreground">Nenhum experimento criado. Crie seu primeiro teste A/B.</p>
          </CardContent>
        </Card>
      ) : (
        experiments.map(exp => (
          <ExperimentCard
            key={exp.id}
            experiment={exp}
            onStart={startExperiment}
            onMeasure={measureExperiment}
            onCancel={cancelExperiment}
            disabled={isImpersonating}
          />
        ))
      )}
    </>
  );
});
ExperimentsTab.displayName = 'ExperimentsTab';
