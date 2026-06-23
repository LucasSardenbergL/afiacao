// Hook de dados/estado do FarmerTacticalPlan.
// Extraído verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split):
// state, carregamento de clientes, geração com checagem de eficiência e handlers.
import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useMyActiveCoverage } from '@/hooks/useCoverage';
import { useTacticalPlan, type PlanType } from '@/hooks/useTacticalPlan';
import { supabase } from '@/integrations/supabase/client';
import type { FarmerClientScoreRow, ProfileRow, CustomerLite } from './types';

export function useFarmerTacticalPlan() {
  const { user, isStaff } = useAuth();
  // Lente "Ver como": o dropdown de clientes da carteira segue o id efetivo (o ALVO na
  // lente, o próprio usuário fora). A geração de plano (botões em GerarPlanoCard) é write
  // — bloqueada na lente pelo write-guard + disabled. Fora da lente effectiveUserId === user.id.
  const { effectiveUserId, isImpersonating } = useImpersonation();
  // Cobertura: o dropdown inclui também os clientes que EU cubro agora (paridade com
  // useMyCarteiraScores). Fora da lente: [eu, ...cobertos]; na lente: só o alvo.
  const { data: coverage } = useMyActiveCoverage();
  const coveredIds = (coverage ?? []).map((c) => c.covered_user_id);
  const coveredKey = coveredIds.join(',');
  const ownerIds = isImpersonating && effectiveUserId ? [effectiveUserId] : (user ? [user.id, ...coveredIds] : []);
  const { plans, loading, generating, loadPlans, generatePlan, checkEfficiency, recordResult } = useTacticalPlan();
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [efficiencyAlert, setEfficiencyAlert] = useState<{ customerId: string; profitPerHour: number; planType: PlanType } | null>(null);

  useEffect(() => {
    if (user?.id && isStaff) {
      loadPlans();
      loadCustomers();
    }
    // effectiveUserId/coveredKey na dep: ao entrar/sair da lente OU mudar a cobertura,
    // recarrega planos + dropdown (que passa a incluir os clientes cobertos).

  }, [user, isStaff, effectiveUserId, coveredKey]);

  const loadCustomers = async () => {
    if (!ownerIds.length) return;
    const { data: scoresData } = await supabase
      .from('farmer_client_scores')
      .select('customer_user_id, health_score, churn_risk')
      .in('farmer_id', ownerIds)
      .order('priority_score', { ascending: false });
    const scores = (scoresData ?? []) as FarmerClientScoreRow[];
    if (!scores.length) return;

    const ids = scores.map((s) => s.customer_user_id);
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('user_id, name')
      .in('user_id', ids);
    const profiles = (profilesData ?? []) as ProfileRow[];

    const profileMap = new Map(profiles.map((p) => [p.user_id, p.name]));

    setCustomers(scores.map((s) => ({
      id: s.customer_user_id,
      name: profileMap.get(s.customer_user_id) || 'Cliente',
      healthScore: Number(s.health_score || 0),
      churnRisk: Number(s.churn_risk || 0),
    })));
  };

  const handleGenerateWithCheck = async (customerId: string, planType: PlanType) => {
    const check = await checkEfficiency(customerId);
    if (!check.isAboveThreshold) {
      setEfficiencyAlert({ customerId, profitPerHour: check.estimatedProfitPerHour, planType });
      return;
    }
    generatePlan(customerId, planType);
  };

  const confirmGenerate = () => {
    if (efficiencyAlert) {
      generatePlan(efficiencyAlert.customerId, efficiencyAlert.planType);
      setEfficiencyAlert(null);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedText(text);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const filteredCustomers = searchTerm
    ? customers.filter(c => c.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : customers;

  const toggleExpanded = (planId: string) =>
    setExpandedPlan(expandedPlan === planId ? null : planId);

  return {
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
  };
}
