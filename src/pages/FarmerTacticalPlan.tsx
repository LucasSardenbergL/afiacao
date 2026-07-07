import { useNavigate } from 'react-router-dom';
import { Target, FileText } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useFarmerTacticalPlan } from '@/components/farmer/tacticalPlan/useFarmerTacticalPlan';
import { GerarPlanoCard } from '@/components/farmer/tacticalPlan/GerarPlanoCard';
import { EfficiencyAlertDialog } from '@/components/farmer/tacticalPlan/EfficiencyAlertDialog';
import { PlanCard } from '@/components/farmer/tacticalPlan/PlanCard';

const FarmerTacticalPlan = () => {
  const navigate = useNavigate();
  const { isStaff } = useAuth();
  const {
    plans,
    loading,
    generating,
    searchTerm,
    setSearchTerm,
    filteredCustomers,
    expandedPlan,
    toggleExpanded,
    copiedText,
    handleCopy,
    efficiencyAlert,
    setEfficiencyAlert,
    confirmGenerate,
    handleGenerateWithCheck,
    recordResult,
  } = useFarmerTacticalPlan();

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  return (
    <div className="min-h-screen bg-background pb-24">

      <main className="px-4 py-4 space-y-3 max-w-lg mx-auto">
        {/* Header */}
        <Card className="bg-gradient-to-br from-primary/10 to-primary/5 border-primary/20">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Target className="w-5 h-5 text-primary" />
              <h2 className="text-sm font-bold">PTPL — Plano Tático Pré-Ligação</h2>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Dois modos: <strong>Essencial</strong> (rápido) ou <strong>Estratégico</strong> (completo com LTV, simulação e riscos).
            </p>
          </CardContent>
        </Card>

        {/* Generate for any customer */}
        <GerarPlanoCard
          searchTerm={searchTerm}
          onSearchChange={setSearchTerm}
          filteredCustomers={filteredCustomers}
          generating={generating}
          onGenerate={handleGenerateWithCheck}
        />

        {/* Efficiency Alert Dialog */}
        <EfficiencyAlertDialog
          alert={efficiencyAlert}
          onClose={() => setEfficiencyAlert(null)}
          onConfirm={confirmGenerate}
        />

        {/* Plans List */}
        {loading ? (
          <PageSkeleton variant="list" />
        ) : plans.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs text-muted-foreground">Nenhum plano tático gerado ainda.</p>
            </CardContent>
          </Card>
        ) : (
          plans.map(plan => (
            <PlanCard
              key={plan.id}
              plan={plan}
              expanded={expandedPlan === plan.id}
              onToggle={() => toggleExpanded(plan.id)}
              onCopy={handleCopy}
              copiedText={copiedText}
              onRecordResult={recordResult}
            />
          ))
        )}
      </main>

    </div>
  );
};

export default FarmerTacticalPlan;
