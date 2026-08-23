import { useNavigate } from 'react-router-dom';
import { Target, FileText } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { JANELA_FILA_DIAS, LIMITE_FILA, type FiltroFila } from '@/hooks/useTacticalPlan';
import { useFarmerTacticalPlan } from '@/components/farmer/tacticalPlan/useFarmerTacticalPlan';
import { GerarPlanoCard } from '@/components/farmer/tacticalPlan/GerarPlanoCard';
import { EfficiencyAlertDialog } from '@/components/farmer/tacticalPlan/EfficiencyAlertDialog';
import { PlanCard } from '@/components/farmer/tacticalPlan/PlanCard';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';

const ROTULO_FILA: Record<FiltroFila, string> = {
  pendentes: 'pendentes',
  concluidos: 'concluídos',
  expirados: 'expirados',
};

/**
 * Rodapé honesto da fila. O ponto do PR: a tela precisa DIZER quando existe plano
 * além dos exibidos — antes, 383 de 533 ficavam fora dos 50 slots sem sinal nenhum.
 *
 * `total === null` = contagem não apurada (query falhou). Nesse caso o rótulo OMITE
 * o total em vez de exibir 0 — "0 pendentes" seria fabricação (ausente ≠ zero).
 */
export function resumoDaFila(exibidos: number, total: number | null, filtro: FiltroFila): string {
  const rotulo = ROTULO_FILA[filtro];
  const janela = filtro === 'pendentes' ? ` · janela de ${JANELA_FILA_DIAS} dias` : '';
  if (total === null) return `${exibidos} ${rotulo} exibidos${janela}`;
  if (total > exibidos) return `Mostrando ${exibidos} de ${total} ${rotulo}${janela}`;
  return `${total} ${rotulo}${janela}`;
}

const FarmerTacticalPlan = () => {
  const navigate = useNavigate();
  const { isStaff } = useAuth();
  const {
    plans,
    loading,
    generating,
    totalNaFila,
    filtroFila,
    setFiltroFila,
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
    coberturaIndisponivel,
  } = useFarmerTacticalPlan();

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  return (
    <div className="min-h-screen bg-background pb-24">

      <main className="px-4 py-4 space-y-3 max-w-lg mx-auto">
        {coberturaIndisponivel && (
          <AvisoLeituraFalhou
            oque="as carteiras que você cobre"
            estado={coberturaIndisponivel}
            className="mb-0"
          />
        )}
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

        {/* Fila: recorte + contador honesto do que ficou de fora */}
        <Tabs value={filtroFila} onValueChange={(v) => setFiltroFila(v as FiltroFila)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="pendentes">Pendentes</TabsTrigger>
            <TabsTrigger value="concluidos">Concluídos</TabsTrigger>
            <TabsTrigger value="expirados">Expirados</TabsTrigger>
          </TabsList>
        </Tabs>

        {!loading && (
          <p className="text-[10px] text-muted-foreground px-1">
            {resumoDaFila(plans.length, totalNaFila, filtroFila)}
            {totalNaFila !== null && totalNaFila > LIMITE_FILA && ' — priorizados por risco de churn'}
          </p>
        )}

        {/* Plans List */}
        {loading ? (
          <PageSkeleton variant="list" />
        ) : plans.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center">
              <FileText className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs text-muted-foreground">
                {filtroFila === 'pendentes'
                  ? `Nenhum plano pendente nos últimos ${JANELA_FILA_DIAS} dias.`
                  : `Nenhum plano ${ROTULO_FILA[filtroFila]}.`}
              </p>
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
