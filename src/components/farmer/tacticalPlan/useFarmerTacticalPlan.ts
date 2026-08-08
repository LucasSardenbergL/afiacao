// Hook de dados/estado do FarmerTacticalPlan.
// Extraído verbatim de src/pages/FarmerTacticalPlan.tsx (god-component split):
// state, carregamento de clientes, geração com checagem de eficiência e handlers.
import { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useMyActiveCoverage } from '@/hooks/useCoverage';
import { useUrlState } from '@/hooks/useUrlState';
import { useTacticalPlan, type PlanType, type FiltroFila } from '@/hooks/useTacticalPlan';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import type { FarmerClientScoreRow, ProfileRow, CustomerLite } from './types';

// Lote do `.in()` de profiles. 200 UUIDs ≈ 7,4 KB de query string — abaixo do teto de ~8 KB do
// PostgREST/proxy, com folga para o resto da URL. Ver o guard em `loadCustomers`.
const PROFILES_BATCH = 200;

const FILTROS_FILA: readonly FiltroFila[] = ['pendentes', 'concluidos', 'expirados'];

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
  const { plans, loading, generating, totalNaFila, loadPlans, generatePlan, checkEfficiency, recordResult } = useTacticalPlan();
  // Filtro na URL (convenção do repo p/ filtro de lista): sobrevive a F5 e é
  // compartilhável. ⚠️ A query string é input do usuário — `?fila=lixo` cairia num
  // recorte inexistente e a tela voltaria vazia sem explicação. Valor fora do
  // domínio degrada para `pendentes`.
  const [{ fila }, setUrlState] = useUrlState({ fila: 'pendentes' });
  const filtroFila: FiltroFila = (FILTROS_FILA as readonly string[]).includes(fila)
    ? (fila as FiltroFila)
    : 'pendentes';
  const setFiltroFila = (f: FiltroFila) => setUrlState({ fila: f });
  const [customers, setCustomers] = useState<CustomerLite[]>([]);
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [efficiencyAlert, setEfficiencyAlert] = useState<{ customerId: string; profitPerHour: number | null; motivo?: 'sem_margem' | 'indisponivel'; planType: PlanType } | null>(null);

  useEffect(() => {
    if (user?.id && isStaff) loadPlans(filtroFila);
    // effectiveUserId/coveredKey na dep: ao entrar/sair da lente OU mudar a cobertura,
    // recarrega os planos. `filtroFila` na dep: trocar de aba refaz a query.

  }, [user, isStaff, effectiveUserId, coveredKey, filtroFila]);

  // Separado do efeito acima DE PROPÓSITO: `loadCustomers` pagina a carteira inteira
  // (até 3.858 clientes em prod, vários round-trips) e não depende do filtro da fila.
  // Recarregá-la a cada troca de aba seria desperdício visível na tela.
  useEffect(() => {
    if (user?.id && isStaff) loadCustomers();

  }, [user, isStaff, effectiveUserId, coveredKey]);

  const loadCustomers = async () => {
    if (!ownerIds.length) return;
    // [GUARD money-path] PAGINADO. A consulta era single-shot e o PostgREST capa em 1.000 linhas
    // em SILÊNCIO — medido em prod (psql-ro, 2026-07-22): os três farmers têm 3.858, 1.528 e
    // 1.246 clientes, TODOS acima da capa, então o maior deles só conseguia gerar plano para 26%
    // da própria carteira. Num card chamado "Gerar Plano para QUALQUER Cliente", o cliente 1.001
    // simplesmente não existia. Desempate por `customer_user_id` (UNIQUE): `priority_score` tem
    // empates massivos (centenas de clientes com o mesmo valor) e, sem ordem total, a paginação
    // pula e repete linha entre páginas.
    const scores = await fetchAllPages<FarmerClientScoreRow>((de, ate) =>
      supabase
        .from('farmer_client_scores')
        .select('customer_user_id, health_score, churn_risk')
        .in('farmer_id', ownerIds)
        .order('priority_score', { ascending: false })
        .order('customer_user_id', { ascending: true })
        .range(de, ate), 'farmer_client_scores/plano-tatico');
    if (!scores.length) return;

    // [GUARD] LOTES. `.in()` com N ids vira query string: 3.858 UUIDs = ~143 KB de URL, contra um
    // teto de ~8 KB no PostgREST/proxy. A consulta falhava inteira, `data` voltava null, o mapa
    // ficava vazio — e o `|| 'Cliente'` abaixo transformava a FALHA em 1.000 clientes chamados
    // "Cliente", indistinguíveis de dado bom. Nenhuma busca por nome real encontrava nada, e o
    // card parecia apenas "sem resultados". Falha de consulta ≠ ausência de nome (#1524).
    const profiles: ProfileRow[] = [];
    let consultaFalhou = false;
    for (let i = 0; i < scores.length; i += PROFILES_BATCH) {
      const lote = scores.slice(i, i + PROFILES_BATCH).map((s) => s.customer_user_id);
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', lote);
      if (error) consultaFalhou = true;
      profiles.push(...((data ?? []) as ProfileRow[]));
    }

    const profileMap = new Map(profiles.map((p) => [p.user_id, p.name]));

    // Sem nome, o cliente é INALCANÇÁVEL pela busca (que filtra por `name`), então o rótulo tem
    // de dizer a verdade em vez de fabricar um nome plausível. Os dois casos são distintos e
    // ambos reais: perfil legitimamente ausente (aliases fiscais sem `profiles`) × consulta que
    // falhou. Um sufixo com o id curto mantém a linha identificável e buscável.
    const semNome = (id: string) =>
      `${consultaFalhou ? 'Nome indisponível' : 'Cliente sem cadastro'} (${id.slice(0, 8)})`;

    setCustomers(scores.map((s) => ({
      id: s.customer_user_id,
      name: profileMap.get(s.customer_user_id) || semNome(s.customer_user_id),
      healthScore: Number(s.health_score || 0),
      churnRisk: Number(s.churn_risk || 0),
    })));
  };

  const handleGenerateWithCheck = async (customerId: string, planType: PlanType) => {
    const check = await checkEfficiency(customerId);
    // `isAboveThreshold` é tri-estado: false (reprovou) e null (indecidível) ambos abrem o dialog,
    // que distingue os dois na mensagem. Só `true` gera direto.
    if (check.isAboveThreshold !== true) {
      setEfficiencyAlert({ customerId, profitPerHour: check.estimatedProfitPerHour, motivo: check.motivo, planType });
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
  };
}
