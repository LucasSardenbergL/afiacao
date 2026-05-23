// Seção 4 (Algoritmos Implementados) da Documentação Técnica.
// Extraída de src/pages/TechnicalDocs.tsx (god-component split).
import { Section } from '@/components/docs/primitives';

export function SecaoAlgoritmos() {
  return (
    <Section id="algoritmos" title="4. Algoritmos Implementados">

      <h3 className="font-bold text-lg mt-6 mb-3">4.1 Health Score do Cliente</h3>
      <p className="mb-2"><strong>Modelo:</strong> Score composto ponderado, 0-100.</p>
      <p className="mb-2"><strong>Fórmula:</strong></p>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Health = 100 × (0.35×RF + 0.20×M + 0.15×G + 0.15×X + 0.15×S)

Onde:
  RF = exp(-k2 × max((D / max(I,1)) - 1, 0))
     D = dias desde última compra
     I = intervalo médio de recompra (dias)
     k2 = fator de decaimento (default 1.0)

  M = log(1 + AvgMonthlySpend_180d) / log(1 + P95MonthlySpend)
     Normalizado pelo percentil 95 da população

  G = clamp((MargemBruta% - P10Margin) / (P90Margin - P10Margin), 0, 1)
     Normalizado pelo range P10-P90 da população

  X = clamp(QtdCategorias / CatTarget, 0, 1)
     CatTarget default = 5

  S = 0.7 × TaxaResposta60d + 0.3 × TaxaRespostaWhatsApp60d

Classificação:
  ≥80 = Saudável | ≥60 = Estável | ≥40 = Atenção | <40 = Crítico`}</pre>
      <p><strong>Limitações:</strong> Cálculo roda client-side, limitado a 1000 pedidos de venda (limite padrão query). Pesos configuráveis via farmer_algorithm_config mas sem UI de simulação para todos os parâmetros.</p>

      <h3 className="font-bold text-lg mt-6 mb-3">4.2 Churn Risk</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`ChurnRisk = 100 × (1 - exp(-k1 × max((D / max(I,1)) - 1, 0)))

k1 = fator de sensibilidade (default 1.0)
Quando D = I → risco ~0%
Quando D = 2×I → risco ~63%
Quando D = 3×I → risco ~86%`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.3 Priority Score</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Priority = 0.40×ChurnRisk + 0.30×RecoverScore + 0.20×ExpansionScore + 0.10×EffScore

RecoverScore = clamp(DelayedMonths × ExpectedMonthly / (P95Spend×6) × 100, 0, 100)
ExpansionScore = clamp((MixGap×0.6 + M×0.4) × 100, 0, 100)
EffScore = clamp((1 - min(DiasSemContato/SLA, 2)/2) × 100, 0, 100)
  SLA default = 14 dias`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.4 Agenda Diária</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Total slots = min(N_clientes, 20)
Cotas: Risco 50% | Expansão 30% | Follow-up 20%

Risco: top N por ChurnRisk desc
Expansão: top N por ExpansionScore desc (sem repetir)
Follow-up: restantes por PriorityScore desc`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.5 Cross-Sell LIE</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`LIE_ij = P_ij × M_ij × ComplexityFactor

P_ij = HistoricalRate × (HealthScore/100) × EngagementFactor × ClusterAdherence
  HistoricalRate = taxa histórica de conversão (default 15%)
  EngagementFactor = clamp(0.3 + 0.5×AnswerRate + 0.2×WhatsAppRate, 0.1, 1.0)
  ClusterAdherence = buyerCount / totalCustomers (mín 5%)

M_ij = (Preço - Custo) × ClusterVolume
  ClusterVolume = max(1, round(buyerCount/totalCustomers × 12))

ComplexityFactor aprendido: 1 / (1 + ln(1 + ProfitPerHour/100))
  Range: 0.5 a 1.5`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.6 Up-Sell LIE</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Filtros de elegibilidade:
  - Margem atual < 35%
  - Preço premium > 110% do atual
  - Margem premium > 120% da atual

P_ij = HistoricalRate × (HealthScore/100) × EngagementFactor × 0.8
  (fator 0.8 porque up-sell é mais difícil)

M_ij = (MargemPremium - MargemAtual) × QtdHistórica`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.7 Bundle Engine (Apriori)</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Mineração:
  1. Frequência de itens individuais → filtra por support ≥ 5%
  2. Frequência de pares → gera regras A→B se lift ≥ 1.2
  3. Frequência de triplos (mesmo critério)
  4. Detecção de sequencialidade (window = 90 dias)

Regras: confidence = P(B|A), lift = confidence / P(B)

Bundle LIE:
  P_bundle = avgConfidence × (avgLift/2) × (Health/100) × EngagementFactor
  M_bundle = Σ margens dos produtos
  LIE_bundle = P_bundle × M_bundle × avgComplexityFactor`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.8 Recommendation Engine (Server-side)</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Score_final = wA×score_assoc + wP×score_eip + wS×score_sim + wC×score_ctx

Modos:
  profit: maximiza margem imediata (EIP = probabilidade × margem)
  ltv: maximiza valor do ciclo (EILTV = EIP × retention factor)

Pesos configuráveis via recommendation_config
Penalidades: estoque zerado, margem negativa, item já no basket`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.9 IEE (Índice de Execução Estratégica)</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`IEE = 0.25×PTPL_usage + 0.25×ObjectiveAdherence + 0.15×QuestionsUsage 
    + 0.15×BundleOffered + 0.20×PostCallRegistration

PTPL_usage = min(100, (totalPlans/totalCalls) × 100)
ObjectiveAdherence = (plansFollowed/completedPlans) × 100
QuestionsUsage = (suggestionsUsed/suggestionsShown) × 100 (50 se sem dados)
BundleOffered = (plansWithBundle/totalPlans) × 100
PostCallRegistration = (completedPlans/totalPlans) × 100`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.10 IPF (Índice de Performance Farmer)</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`IPF = 0.25×IncrementalMargin + 0.25×MarginPerHour + 0.20×MixExpansion 
    + 0.15×LTVEvolution + 0.15×ChurnReduction

IncrementalMargin = min(100, (CombinedMargin/R$5000) × 100)
MarginPerHour = min(100, marginPerHour) [target R$100/h]
MixExpansion = min(100, (avgCategories/6) × 100)
LTVEvolution = min(100, (avgSpend/R$2000) × 100)
ChurnReduction = (clientesChurn<30% / totalClientes) × 100`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.11 Gamificação Score</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Total = 0.40×Consistência + 0.20×Organização + 0.15×Educação 
     + 0.15×Indicações + 0.10×Eficiência

Consistência = (ferramentasEmDia / totalFerramentas) × 100
Organização = médiaScoreQualidadeEnvio (0-100)
Educação = (treinamentosPassados / totalTreinamentos) × 100
Indicações = min(referralsConvertidos × 20, 100)
Eficiência = (pedidosNãoEmergenciais / totalPedidos) × 100

Níveis: Operacional(0) → Organizado(20) → Profissional(40) → EliteTécnica(65) → ParceiroEstratégico(85)`}</pre>

      <h3 className="font-bold text-lg mt-6 mb-3">4.12 Precificação (Pricing Engine)</h3>
      <pre className="text-xs bg-muted p-4 rounded mb-4">{`Hierarquia de resolução:
  1. Fórmula: se spec_filter tem _formula → preço = _multiplier × spec[_formula]
     Ex: Serra Circular Widea → preço = R$X × nº de dentes
  2. Preço fixo: se spec_filter = {} → retorna price direto
  3. Correspondência: match exato de todas as chaves do spec_filter com specs da ferramenta`}</pre>
    </Section>
  );
}
