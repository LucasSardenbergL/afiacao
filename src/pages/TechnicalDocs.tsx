import { useRef } from 'react';
import { Button } from '@/components/ui/button';
import { FileDown, Printer } from 'lucide-react';

const TechnicalDocs = () => {
  const contentRef = useRef<HTMLDivElement>(null);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Print controls - hidden on print */}
      <div className="print:hidden sticky top-0 z-50 bg-background/95 backdrop-blur border-b p-4 flex items-center justify-between">
        <h1 className="text-lg font-bold">Documentação Técnica</h1>
        <Button onClick={handlePrint} className="gap-2">
          <FileDown className="h-4 w-4" />
          Exportar PDF
        </Button>
      </div>

      {/* Document content */}
      <div ref={contentRef} className="max-w-4xl mx-auto p-8 print:p-4 print:max-w-none">
        <style>{`
          @media print {
            body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            .print\\:hidden { display: none !important; }
            h2 { page-break-before: always; }
            h2:first-of-type { page-break-before: avoid; }
            table { page-break-inside: avoid; }
            pre { page-break-inside: avoid; white-space: pre-wrap; }
          }
        `}</style>

        {/* Cover */}
        <div className="text-center mb-16 print:mb-8">
          <h1 className="text-4xl font-black mb-2 print:text-3xl">Documentação Técnica Completa</h1>
          <p className="text-xl text-muted-foreground mb-1">Sistema de Gestão de Afiação & Vendas B2B</p>
          <p className="text-sm text-muted-foreground">Versão: {new Date().toLocaleDateString('pt-BR')} — Gerado automaticamente</p>
        </div>

        {/* TOC */}
        <div className="mb-12 p-6 border rounded-lg bg-muted/30 print:bg-transparent">
          <h2 className="text-xl font-bold mb-4" style={{ pageBreakBefore: 'avoid' }}>Sumário</h2>
          <ol className="space-y-1 text-sm list-decimal list-inside">
            <li><a href="#visao" className="hover:underline">Visão Geral do Produto</a></li>
            <li><a href="#funcionalidades" className="hover:underline">Mapa Completo de Funcionalidades</a></li>
            <li><a href="#arquitetura" className="hover:underline">Arquitetura Técnica Atual</a></li>
            <li><a href="#algoritmos" className="hover:underline">Algoritmos Implementados</a></li>
            <li><a href="#regras" className="hover:underline">Regras de Negócio</a></li>
            <li><a href="#ocultas" className="hover:underline">Capacidades Ocultas ou Subutilizadas</a></li>
            <li><a href="#limitacoes" className="hover:underline">Limitações Atuais</a></li>
            <li><a href="#riscos" className="hover:underline">Riscos Técnicos</a></li>
            <li><a href="#features" className="hover:underline">Features Ativáveis Sem Alterar Arquitetura</a></li>
            <li><a href="#manual" className="hover:underline">Manual Operacional Simplificado</a></li>
          </ol>
        </div>

        {/* ───────────────── 1. VISÃO GERAL ───────────────── */}
        <Section id="visao" title="1. Visão Geral do Produto">
          <h3 className="font-semibold mt-4 mb-2">Objetivo Principal</h3>
          <p>Plataforma integrada de gestão de serviços de afiação industrial e vendas B2B, conectando clientes finais (madeireiras, marcenarias, indústrias) a uma empresa de afiação. O sistema gerencia todo o ciclo de vida: desde o cadastro de ferramentas, pedidos de serviço, logística, até vendas de produtos, com um módulo avançado de Farmer (inside sales) baseado em algoritmos proprietários de priorização e recomendação.</p>

          <h3 className="font-semibold mt-4 mb-2">Público-Alvo</h3>
          <ul className="list-disc list-inside space-y-1">
            <li><strong>Clientes (customer)</strong>: Empresas que enviam ferramentas para afiação — marcenarias, serrarias, indústrias moveleiras</li>
            <li><strong>Funcionários (employee)</strong>: Equipe interna — operadores, atendentes, Farmers (inside sales)</li>
            <li><strong>Administradores (admin)</strong>: Gestores com acesso total a dashboards, configurações e governança algorítmica</li>
          </ul>

          <h3 className="font-semibold mt-4 mb-2">Proposta de Valor</h3>
          <p>Automatizar operações de afiação (pedidos, rastreamento, qualidade) enquanto maximiza receita B2B através de algoritmos de scoring de clientes, recomendações cross-sell/up-sell, bundles baseados em market basket analysis, planos táticos gerados por IA e copiloto em tempo real para vendedores.</p>

          <h3 className="font-semibold mt-4 mb-2">Problemas que Resolve</h3>
          <ul className="list-disc list-inside space-y-1">
            <li>Gestão manual de pedidos de afiação sem rastreamento</li>
            <li>Falta de visibilidade sobre saúde e risco de churn de clientes</li>
            <li>Vendedores sem dados para priorizar contatos e ofertar produtos</li>
            <li>Ausência de integração entre sistema de afiação e ERP (Omie)</li>
            <li>Dificuldade em medir performance de vendedores internos</li>
            <li>Precificação inconsistente e sem histórico</li>
          </ul>
        </Section>

        {/* ───────────────── 2. FUNCIONALIDADES ───────────────── */}
        <Section id="funcionalidades" title="2. Mapa Completo de Funcionalidades">

          <Module
            name="2.1 Autenticação e Perfis"
            desc="Login por email/senha com suporte a autenticação biométrica (WebAuthn). Três papéis: admin, employee, customer. Perfil com dados de empresa (CNAE, documento, telefone). Fluxo de aprovação para novos cadastros."
            audience="Todos os perfis"
            deps="Lovable Cloud Auth, tabelas profiles e user_roles"
          />

          <Module
            name="2.2 Gestão de Ferramentas (Tools)"
            desc="CRUD de ferramentas do cliente com categorias (tool_categories), especificações técnicas dinâmicas (specifications JSON), QR Code individual por ferramenta, histórico de afiações, contador de uso, intervalo de afiação configurável, alertas de manutenção preventiva. Identificação por foto via IA (Edge Function identify-tool com modelo de visão)."
            audience="Clientes (próprias ferramentas), Staff (todas)"
            deps="Tabelas user_tools, tool_categories, Edge Function identify-tool"
          />

          <Module
            name="2.3 Pedidos de Serviço (Orders)"
            desc="Criação de pedidos de afiação com seleção de ferramentas cadastradas, tipo de serviço, opção de entrega (coleta/entrega/balcão), endereço, agendamento por horário. Limite de quantidade de serviços pela quantidade cadastrada da ferramenta. Pipeline Kanban para staff (pendente → em_andamento → pronto → entregue). Chat por pedido com mensagens em tempo real. Avaliação pós-serviço (rating 1-5 + comentário). Sincronização com Omie ERP via Edge Function (omie-sync). Suporte a staffContext para pedidos criados por funcionários em nome de clientes."
            audience="Clientes criam; Staff gerenciam via Kanban"
            deps="Tabelas orders, order_messages, order_reviews, omie_ordens_servico; Edge Function omie-sync"
          />

          <Module
            name="2.4 Vendas B2B (Sales)"
            desc="Catálogo de produtos sincronizados do Omie (omie_products). Criação de pedidos de venda com múltiplos itens, descontos por item, seleção de cliente. Histórico de preços por cliente/produto (sales_price_history). Motor de recomendações em tempo real durante criação de pedidos (Edge Function recommend). Custos de produtos mantidos em product_costs com múltiplas fontes (custo fixo, CMC, etc)."
            audience="Staff (employee/admin)"
            deps="Tabelas sales_orders, order_items, omie_products, product_costs, sales_price_history; Edge Functions recommend, omie-vendas-sync"
          />

          <Module
            name="2.5 Precificação Inteligente (Pricing Engine)"
            desc="Motor de precificação baseado em default_prices com 3 modos: preço fixo (spec_filter vazio), preço por correspondência de especificações (e.g. comprimento + espessura), preço por fórmula (multiplicador × valor de spec, usado para Serra Circular Widea: preço por dente). Usado na criação de pedidos de afiação."
            audience="Sistema interno, visível no fluxo de pedidos"
            deps="Tabela default_prices, hook usePricingEngine"
          />

          <Module
            name="2.6 Dashboard Farmer"
            desc="Painel central do vendedor interno. Exibe: carteira de clientes com health scores, agenda diária priorizada, métricas de performance (IEE/IPF), acesso rápido a planos táticos, recomendações, bundles e copiloto."
            audience="Employee (Farmer)"
            deps="Todos os hooks Farmer (useFarmerScoring, useCrossSellEngine, useBundleEngine, useTacticalPlan, useFarmerPerformance, useCopilotEngine)"
          />

          <Module
            name="2.7 Scoring de Clientes (Farmer Scoring)"
            desc="Algoritmo de Health Score multi-dimensional (RF, M, G, X, S) com classificação em 4 faixas. Cálculo de Priority Score ponderado por churn risk, recover score, expansion score e efficiency score. Geração automática de agenda diária com cotas por tipo (risco/expansão/follow-up). Detalhado na seção 4."
            audience="Employee/Admin"
            deps="Hook useFarmerScoring, tabelas farmer_client_scores, farmer_algorithm_config, farmer_calls, sales_orders, product_costs"
          />

          <Module
            name="2.8 Cross-Sell / Up-Sell Engine"
            desc="Motor de recomendações individuais. Cross-sell: produtos não comprados mas populares no cluster. Up-sell: substituições premium para produtos com margem baixa. Cálculo de LIE (Lucro Incremental Esperado) = P_ij × M_ij × ComplexityFactor. Auto-aprendizado via tabela farmer_category_conversion."
            audience="Employee (Farmer)"
            deps="Hook useCrossSellEngine, tabelas farmer_recommendations, farmer_category_conversion, farmer_client_scores"
          />

          <Module
            name="2.9 Bundle Engine (Market Basket Analysis)"
            desc="Mineração de regras de associação (Apriori-like) sobre transações históricas. Regras de pares e triplos. Regras sequenciais (produto A comprado antes de B). Geração de bundles de 2-3 produtos por cliente. Métricas: support, confidence, lift. LIE_bundle = P_bundle × M_bundle × ComplexityFactor."
            audience="Employee (Farmer)"
            deps="Hook useBundleEngine, tabelas farmer_bundle_recommendations, farmer_association_rules"
          />

          <Module
            name="2.10 Recommendation Engine (Edge Function)"
            desc="Motor server-side de recomendações contextual (Edge Function recommend). Aceita basket atual do pedido e gera sugestões em tempo real. Scoring multi-fator: score_assoc, score_sim, score_ctx, score_eip. Dois modos: profit (margem imediata) e ltv (valor do ciclo de vida). Logging de aceite/rejeição para aprendizado."
            audience="Employee durante criação de pedidos"
            deps="Edge Function recommend, tabelas recommendation_log, recommendation_config"
          />

          <Module
            name="2.11 Planos Táticos (PTPL)"
            desc="Geração de planos pré-ligação via IA (Edge Function generate-tactical-plan). Dois tipos: essencial (rápido) e estratégico (completo com LTV/cenários). Conteúdo gerado: perguntas diagnósticas SPIN, estratégia de abordagem A/B, transição para oferta, objeções prováveis com respostas técnicas/econômicas. Check de eficiência (R$/h) antes de gerar. Registro pós-ligação: plan_followed, resultado, margem real, duração, tipo de objeção."
            audience="Employee (Farmer)"
            deps="Hook useTacticalPlan, Edge Function generate-tactical-plan, tabela farmer_tactical_plans"
          />

          <Module
            name="2.12 Copiloto em Tempo Real"
            desc="Assistente IA durante ligações com transcrição de áudio (ElevenLabs/Scribe). Detecta intenções e fases da conversa. Sugere perguntas, rebatidas, ofertas em tempo real. Integração com plano tático ativo. Registro de sessões com métricas: suggestions_shown, suggestions_used, margin_generated."
            audience="Employee (Farmer)"
            deps="Hook useCopilotEngine, Edge Functions copilot-analyze, elevenlabs-scribe-token; tabelas farmer_copilot_sessions, farmer_copilot_events"
          />

          <Module
            name="2.13 Performance do Farmer (IEE/IPF)"
            desc="Dois índices compostos: IEE (Índice de Execução Estratégica) = uso PTPL 25% + aderência objetivo 25% + uso perguntas 15% + oferta bundle 15% + registro pós-call 20%. IPF (Índice de Performance Farmer) = margem incremental 25% + margem/hora 25% + expansão mix 20% + evolução LTV 15% + redução churn 15%."
            audience="Employee/Admin"
            deps="Hook useFarmerPerformance, tabela farmer_performance_scores"
          />

          <Module
            name="2.14 Governança Algorítmica"
            desc="Sistema de propostas para alterar parâmetros dos algoritmos. Fluxo: criação → simulação de impacto → aprovação por admin → aplicação. Auditoria completa via farmer_audit_log. Versionamento de algoritmos."
            audience="Employee propõe, Admin aprova"
            deps="Hooks useFarmerGovernance, tabelas farmer_governance_proposals, farmer_audit_log"
          />

          <Module
            name="2.15 Experimentos A/B"
            desc="Framework de testes A/B para farmers. Criação de experimentos com hipótese, métrica primária, tamanho mínimo de amostra, significância mínima. Alocação de clientes em grupos controle/teste. Cálculo de p-value e lift."
            audience="Employee/Admin"
            deps="Hook useFarmerExperiments, tabelas farmer_experiments, farmer_experiment_clients"
          />

          <Module
            name="2.16 Gamificação"
            desc="Score composto por: consistência (40%, ferramentas em dia), organização (20%, qualidade de envio), educação (15%, treinamentos), indicações (15%), eficiência (10%, pedidos não-emergenciais). 5 níveis: Operacional (0), Organizado (20), Profissional (40), Elite Técnica (65), Parceiro Estratégico (85). Certificado visual exportável."
            audience="Clientes"
            deps="Hook useGamificationScore, tabela gamification_scores"
          />

          <Module
            name="2.17 Fidelidade (Loyalty)"
            desc="Sistema de pontos por pedido. Histórico de pontos com tipos (earned/redeemed). Ranking entre clientes."
            audience="Clientes"
            deps="Tabela loyalty_points"
          />

          <Module
            name="2.18 Treinamentos"
            desc="Módulos de treinamento com quiz. Registro de conclusão (training_completions). Integrado com gamificação."
            audience="Clientes"
            deps="Tabelas training_modules, training_completions (admin cria, clientes consomem)"
          />

          <Module
            name="2.19 Coaching SPIN"
            desc="Página de referência com metodologia SPIN Selling adaptada. Guia de perguntas situacionais, problema, implicação e necessidade para contexto de afiação."
            audience="Employee (Farmer)"
            deps="Página estática CoachingSPIN"
          />

          <Module
            name="2.20 Integração Omie ERP"
            desc="Sincronização bidirecional: clientes (omie-cliente), produtos (omie-sync), pedidos de serviço (omie-sync com Ordem de Serviço), pedidos de venda (omie-vendas-sync), posição de estoque (inventory_position). Sincronização analítica periódica (omie-analytics-sync). Tabela de mapeamento category_mappings entre categorias de pedido e tool_categories."
            audience="Sistema (automático), Admin (configura e monitora)"
            deps="Edge Functions omie-sync, omie-cliente, omie-vendas-sync, omie-analytics-sync; tabelas omie_clientes, omie_ordens_servico, omie_products, omie_servicos, sync_state"
          />

          <Module
            name="2.21 Endereços"
            desc="CRUD de endereços por cliente. Marcação de endereço padrão. Flag is_from_omie para endereços sincronizados."
            audience="Clientes"
            deps="Tabela addresses"
          />

          <Module
            name="2.22 Agendamentos Recorrentes"
            desc="Configuração de pedidos automáticos com frequência em dias, ferramentas, endereço, opção de entrega. Processamento automático via Edge Function process-recurring-orders."
            audience="Clientes"
            deps="Tabela recurring_schedules, Edge Function process-recurring-orders"
          />

          <Module
            name="2.23 Checklist de Qualidade de Envio"
            desc="Avaliação de como o cliente envia ferramentas: limpeza, identificação, separação, embalagem. Score de 0-100. Integrado com gamificação (pilar organização)."
            audience="Staff avalia, Cliente vê resultado"
            deps="Tabela sending_quality_logs"
          />

          <Module
            name="2.24 Tabela de Preços (Admin)"
            desc="Gestão de default_prices pelo admin. Definição de preços por categoria + especificações. Suporte a fórmulas."
            audience="Admin"
            deps="Tabela default_prices, página AdminPriceTable"
          />

          <Module
            name="2.25 Dashboard Executivo"
            desc="Visão consolidada com métricas de receita, volume, performance de farmers, saúde da carteira. Gráficos comparativos."
            audience="Admin"
            deps="Página ExecutiveDashboard, dados agregados de múltiplas tabelas"
          />

          <Module
            name="2.26 Relatórios Mensais"
            desc="Geração de relatórios por período via Edge Function monthly-report. Consolidação de métricas operacionais e financeiras."
            audience="Admin"
            deps="Edge Function monthly-report, página AdminMonthlyReports"
          />

          <Module
            name="2.27 Sugestões de Afiação"
            desc="Motor de sugestões de serviços adicionais baseado em histórico e tipo de ferramenta. Hook useSharpeningSuggestions."
            audience="Staff durante criação de pedidos"
            deps="Hook useSharpenningSuggestions"
          />

          <Module
            name="2.28 Notificações Push"
            desc="Suporte a PWA com push notifications. Solicitação de permissão ao usuário. Hook usePushNotifications."
            audience="Todos"
            deps="Service Worker (vite-plugin-pwa), hook usePushNotifications"
          />

          <Module
            name="2.29 Histórico Público de Ferramenta"
            desc="Página acessível por QR Code sem autenticação (/tool/:toolId). Mostra histórico de afiações da ferramenta."
            audience="Público (qualquer pessoa com o link/QR)"
            deps="Página ToolPublicHistory, rota pública"
          />
        </Section>

        {/* ───────────────── 3. ARQUITETURA ───────────────── */}
        <Section id="arquitetura" title="3. Arquitetura Técnica Atual">
          <h3 className="font-semibold mt-4 mb-2">Stack</h3>
          <table className="w-full text-sm border-collapse mb-4">
            <tbody>
              <TableRow label="Frontend" value="React 18 + TypeScript + Vite + Tailwind CSS + shadcn/ui" />
              <TableRow label="State Management" value="React Query (TanStack), Context API (Auth, Company, AppShell)" />
              <TableRow label="Routing" value="React Router v6 com ProtectedRoute + AppShellLayout" />
              <TableRow label="Backend" value="Lovable Cloud (Supabase): PostgreSQL, Auth, Edge Functions (Deno), Storage" />
              <TableRow label="ERP" value="Omie API (REST, chamadas via Edge Functions)" />
              <TableRow label="IA" value="Lovable AI (Gemini/GPT) via Edge Functions para planos táticos e copiloto" />
              <TableRow label="Áudio" value="ElevenLabs Scribe para transcrição em tempo real" />
              <TableRow label="PWA" value="vite-plugin-pwa para instalação e notificações push" />
              <TableRow label="Gráficos" value="Recharts para visualizações" />
              <TableRow label="Mapas" value="Leaflet para planejador de rotas" />
              <TableRow label="Drag & Drop" value="@hello-pangea/dnd para Kanban" />
            </tbody>
          </table>

          <h3 className="font-semibold mt-4 mb-2">Fluxo de Dados</h3>
          <pre className="text-xs bg-muted p-4 rounded overflow-x-auto mb-4">{`
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   Cliente    │────▶│   React App     │────▶│  Lovable     │
│   Browser    │◀────│   (SPA)         │◀────│  Cloud DB    │
└─────────────┘     └────────┬────────┘     └──────┬───────┘
                             │                      │
                    ┌────────▼────────┐     ┌───────▼───────┐
                    │  Edge Functions │────▶│   Omie ERP    │
                    │  (Deno Runtime) │◀────│   (REST API)  │
                    └────────┬────────┘     └───────────────┘
                             │
                    ┌────────▼────────┐
                    │  Lovable AI     │
                    │  (Gemini/GPT)   │
                    └─────────────────┘
          `}</pre>

          <h3 className="font-semibold mt-4 mb-2">Client-side vs Server-side</h3>
          <table className="w-full text-sm border-collapse mb-4">
            <thead><tr className="border-b"><th className="text-left p-2">Client-side</th><th className="text-left p-2">Server-side (Edge Functions)</th></tr></thead>
            <tbody>
              <tr className="border-b"><td className="p-2">Scoring de clientes (useFarmerScoring)</td><td className="p-2">Sincronização Omie (omie-sync, omie-cliente)</td></tr>
              <tr className="border-b"><td className="p-2">Cross-sell/Up-sell (useCrossSellEngine)</td><td className="p-2">Recomendações contextuais (recommend)</td></tr>
              <tr className="border-b"><td className="p-2">Bundle mining (useBundleEngine)</td><td className="p-2">Plano tático IA (generate-tactical-plan)</td></tr>
              <tr className="border-b"><td className="p-2">Gamificação (useGamificationScore)</td><td className="p-2">Copiloto IA (copilot-analyze)</td></tr>
              <tr className="border-b"><td className="p-2">Performance IEE/IPF (useFarmerPerformance)</td><td className="p-2">Identificação por foto (identify-tool)</td></tr>
              <tr className="border-b"><td className="p-2">Precificação (usePricingEngine)</td><td className="p-2">Relatórios mensais (monthly-report)</td></tr>
            </tbody>
          </table>

          <h3 className="font-semibold mt-4 mb-2">Armazenamento</h3>
          <p>Banco PostgreSQL com 40+ tabelas. Dados críticos: profiles, orders, sales_orders, user_tools, farmer_client_scores, farmer_tactical_plans. Todas as tabelas com RLS (Row Level Security) ativo. Realtime habilitado para order_messages.</p>
        </Section>

        {/* ───────────────── 4. ALGORITMOS ───────────────── */}
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

        {/* ───────────────── 5. REGRAS DE NEGÓCIO ───────────────── */}
        <Section id="regras" title="5. Regras de Negócio">
          <h3 className="font-semibold mt-4 mb-2">Visibilidade por Perfil</h3>
          <table className="w-full text-sm border-collapse mb-4">
            <thead><tr className="border-b font-bold"><td className="p-2">Recurso</td><td className="p-2">Customer</td><td className="p-2">Employee</td><td className="p-2">Admin</td></tr></thead>
            <tbody>
              <tr className="border-b"><td className="p-2">Dashboard cliente</td><td className="p-2">✅ Próprio</td><td className="p-2">✅ Todos</td><td className="p-2">✅ Todos</td></tr>
              <tr className="border-b"><td className="p-2">Ferramentas</td><td className="p-2">✅ Próprias</td><td className="p-2">✅ Todas</td><td className="p-2">✅ Todas</td></tr>
              <tr className="border-b"><td className="p-2">Pedidos afiação</td><td className="p-2">✅ Próprios</td><td className="p-2">✅ Kanban todos</td><td className="p-2">✅ Kanban todos</td></tr>
              <tr className="border-b"><td className="p-2">Vendas B2B</td><td className="p-2">❌</td><td className="p-2">✅</td><td className="p-2">✅</td></tr>
              <tr className="border-b"><td className="p-2">Farmer (todos módulos)</td><td className="p-2">❌</td><td className="p-2">✅</td><td className="p-2">✅</td></tr>
              <tr className="border-b"><td className="p-2">Admin panel</td><td className="p-2">❌</td><td className="p-2">❌</td><td className="p-2">✅</td></tr>
              <tr className="border-b"><td className="p-2">Governança algo</td><td className="p-2">❌</td><td className="p-2">✅ Propõe</td><td className="p-2">✅ Aprova</td></tr>
              <tr className="border-b"><td className="p-2">Gamificação</td><td className="p-2">✅</td><td className="p-2">✅ Visualiza</td><td className="p-2">✅ Gerencia</td></tr>
              <tr className="border-b"><td className="p-2">Recomendações _admin</td><td className="p-2">❌</td><td className="p-2">❌</td><td className="p-2">✅ (campos _admin)</td></tr>
            </tbody>
          </table>

          <h3 className="font-semibold mt-4 mb-2">Restrições Chave</h3>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Quantidade de serviços por pedido limitada à quantidade cadastrada da ferramenta</li>
            <li>Pedidos criados por staff atribuídos ao cliente via staffContext (não ao funcionário)</li>
            <li>Cross-sell ignora produtos com margem ≤ 0</li>
            <li>Cross-sell ignora produtos com adesão de cluster &lt; 5%</li>
            <li>Up-sell só para produtos com margem atual &lt; 35%</li>
            <li>Agenda diária limitada a 20 clientes/dia</li>
            <li>Aprovação obrigatória para novos cadastros (is_approved = false por padrão)</li>
            <li>Edge Functions autenticadas via JWT — sem acesso anônimo</li>
          </ul>
        </Section>

        {/* ───────────────── 6. CAPACIDADES OCULTAS ───────────────── */}
        <Section id="ocultas" title="6. Capacidades Ocultas ou Subutilizadas">
          <ul className="list-disc list-inside space-y-2 text-sm">
            <li><strong>Regras sequenciais</strong>: O Bundle Engine já detecta padrões sequenciais (produto A seguido de B em 90 dias), mas a UI não diferencia visualmente regras sequenciais de associações simples. Potencial para sugestões proativas ("Cliente comprou X há 45 dias → provavelmente precisa de Y em breve").</li>
            <li><strong>Campos de custo avançados</strong>: product_costs tem cost_confidence e cost_source — permite implementar precificação dinâmica com margem de segurança baseada na confiança do custo.</li>
            <li><strong>Inventory position</strong>: Tabela inventory_position com saldo, CMC e preço médio sincronizados do Omie. Pode alimentar alertas de estoque baixo e bloquear recomendações de produtos sem estoque.</li>
            <li><strong>CNAE do cliente</strong>: Armazenado no perfil mas não usado para segmentação algorítmica. Permitiria clusters setoriais (madeireiras vs metalúrgicas) com recomendações especializadas.</li>
            <li><strong>Copilot events granulares</strong>: Tabela farmer_copilot_events registra cada sugestão e uso. Poderia alimentar um modelo de aprendizado sobre quais tipos de sugestão são mais eficazes por perfil de cliente.</li>
            <li><strong>Múltiplas contas Omie</strong>: sync_state e inventory_position têm campo "account" — o sistema já suporta multi-empresa na camada de dados, faltando apenas UI.</li>
            <li><strong>Farmer learning weights</strong>: Tabela farmer_learning_weights com pesos personalizados por farmer e sugestões de tamanho de carteira. Estrutura existe mas não é atualizada automaticamente.</li>
            <li><strong>Perguntas diagnósticas com tracking</strong>: farmer_diagnostic_questions rastreia effectiveness_score por pergunta — poderia gerar ranking das perguntas mais eficazes.</li>
            <li><strong>Modo LTV no Recommendation Engine</strong>: Server-side já suporta dois modos (profit/ltv), mas UI sempre usa profit. Ativar LTV para clientes de alto potencial seria imediato.</li>
            <li><strong>company_config</strong>: Tabela key-value para configurações dinâmicas — pode armazenar qualquer configuração sem migration.</li>
          </ul>
        </Section>

        {/* ───────────────── 7. LIMITAÇÕES ───────────────── */}
        <Section id="limitacoes" title="7. Limitações Atuais">
          <h3 className="font-semibold mt-4 mb-2">Técnicas</h3>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Algoritmos de scoring (Health, Cross-sell, Bundles) rodam client-side → limitados pela memória do browser e pelo limite de 1000 rows por query do banco</li>
            <li>Mineração Apriori é O(n³) para triplos — pode ser lento com &gt;500 produtos frequentes</li>
            <li>Sem cache server-side de scores calculados (recalcula a cada visita ao dashboard)</li>
            <li>PWA funcional mas sem sync offline para pedidos</li>
          </ul>

          <h3 className="font-semibold mt-4 mb-2">Estruturais</h3>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Sem sistema de notificação interna (apenas push browser)</li>
            <li>Sem fila de processamento para operações pesadas (tudo síncrono)</li>
            <li>Sem versionamento de preços (apenas último preço na default_prices)</li>
            <li>Multi-empresa preparado nos dados mas não na UI</li>
          </ul>

          <h3 className="font-semibold mt-4 mb-2">Dependência de Dados</h3>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Cross-sell e Bundles dependem de volume de vendas significativo para gerar regras com support ≥ 5%</li>
            <li>Health Score depende de sincronização regular com Omie para dados atualizados</li>
            <li>Custos de produto podem estar desatualizados se CMC não for sincronizado</li>
          </ul>

          <h3 className="font-semibold mt-4 mb-2">Escalabilidade</h3>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Cálculo client-side escala até ~500 clientes/farmer confortavelmente</li>
            <li>Persistência de scores usa upsert individual (não batch) — N+1 queries</li>
            <li>Bundle persistence também individual por bundle</li>
          </ul>
        </Section>

        {/* ───────────────── 8. RISCOS ───────────────── */}
        <Section id="riscos" title="8. Riscos Técnicos">
          <ul className="list-disc list-inside space-y-2 text-sm">
            <li><strong>Dependência Omie API</strong>: Se Omie ficar offline, sincronização falha silenciosamente. sync_state registra erros mas não há alerta automático.</li>
            <li><strong>Secrets em Edge Functions</strong>: Chaves Omie (OMIE_APP_KEY, OMIE_APP_SECRET) e ElevenLabs gerenciadas como secrets — rotação manual.</li>
            <li><strong>Cálculos client-side</strong>: Dados sensíveis (custos, margens) trafegam para o browser do farmer. RLS protege por farmer_id, mas o farmer vê todos os custos de seus clientes.</li>
            <li><strong>Sem rate limiting</strong>: Edge Functions não têm throttling — chamadas excessivas à Omie API podem exceder limites.</li>
            <li><strong>Tipo any extensivo</strong>: Muitos hooks usam `as any` para contornar tipagem do Supabase — erros de schema podem passar silenciosamente.</li>
            <li><strong>Sem backup automatizado</strong>: Dados dependem do backup do Lovable Cloud/Supabase — sem verificação independente.</li>
          </ul>
        </Section>

        {/* ───────────────── 9. FEATURES IMEDIATAS ───────────────── */}
        <Section id="features" title="9. Features Ativáveis Sem Alterar Arquitetura">
          <ol className="list-decimal list-inside space-y-2 text-sm">
            <li><strong>Modo LTV nas recomendações</strong>: Apenas mudar parâmetro na chamada da Edge Function recommend. Switch na UI do farmer.</li>
            <li><strong>Alerta de estoque baixo</strong>: inventory_position já tem saldo. Filtrar recomendações por estoque &gt; 0.</li>
            <li><strong>Segmentação por CNAE</strong>: Adicionar cluster_segment nos scores usando profile.cnae já disponível.</li>
            <li><strong>Dashboard de eficácia de perguntas</strong>: Agregar farmer_diagnostic_questions.effectiveness_score em gráfico.</li>
            <li><strong>Auto-ajuste de pesos do farmer</strong>: farmer_learning_weights existe — implementar atualização periódica baseada em resultados.</li>
            <li><strong>Ranking de farmers</strong>: farmer_performance_scores já persiste — criar leaderboard comparativo.</li>
            <li><strong>Alertas de churn</strong>: Push notification quando cliente ultrapassa SLA sem contato — dados já calculados.</li>
            <li><strong>Preço dinâmico por confiança</strong>: Usar cost_confidence para aplicar margem de segurança em produtos com custo incerto.</li>
            <li><strong>Relatório de regras de associação</strong>: farmer_association_rules já persistidas — visualizar em UI dedicada com filtros.</li>
            <li><strong>Multi-empresa</strong>: Filtrar dados por campo account nas tabelas que já o possuem. Adicionar seletor de empresa.</li>
          </ol>
        </Section>

        {/* ───────────────── 10. MANUAL ───────────────── */}
        <Section id="manual" title="10. Manual Operacional Simplificado">

          <h3 className="font-bold mt-6 mb-2">Para Clientes</h3>
          <ol className="list-decimal list-inside space-y-1 text-sm mb-4">
            <li>Cadastre-se com email e aguarde aprovação do admin</li>
            <li>Cadastre suas ferramentas em "Ferramentas" com categoria e especificações</li>
            <li>Crie pedidos de afiação em "Novo Pedido" — selecione ferramentas, serviço e entrega</li>
            <li>Acompanhe status em "Pedidos" — use o chat para comunicação</li>
            <li>Avalie o serviço após conclusão (1-5 estrelas)</li>
            <li>Acompanhe gamificação e certificado em "Gamificação"</li>
            <li>Configure agendamentos recorrentes para automação</li>
          </ol>

          <h3 className="font-bold mt-6 mb-2">Para Farmers (Inside Sales)</h3>
          <ol className="list-decimal list-inside space-y-1 text-sm mb-4">
            <li>Acesse o Dashboard Farmer para ver sua carteira e agenda diária</li>
            <li>A agenda é gerada automaticamente: 50% risco, 30% expansão, 20% follow-up</li>
            <li>Antes de ligar, gere um Plano Tático (essencial ou estratégico)</li>
            <li>Use o Copiloto durante a ligação para sugestões em tempo real</li>
            <li>Ao criar pedidos de venda, observe as recomendações contextuais</li>
            <li>Após cada ligação, registre o resultado no plano tático</li>
            <li>Acompanhe seus índices IEE (execução) e IPF (performance)</li>
            <li>Use Bundles para ofertas combinadas de maior valor</li>
            <li>Consulte Coaching SPIN para técnicas de venda</li>
          </ol>

          <h3 className="font-bold mt-6 mb-2">Para Administradores</h3>
          <ol className="list-decimal list-inside space-y-1 text-sm mb-4">
            <li>Aprove novos cadastros em "Admin → Aprovações"</li>
            <li>Gerencie pedidos de afiação pelo Kanban em "Admin"</li>
            <li>Configure preços em "Admin → Tabela de Preços"</li>
            <li>Monitore performance de farmers em "Dashboard Executivo"</li>
            <li>Revise propostas de alteração algorítmica em "Governança"</li>
            <li>Gere relatórios mensais em "Admin → Relatórios"</li>
            <li>Monitore sincronização Omie em "Admin → Analytics Sync"</li>
            <li>Configure gamificação e programas de fidelidade</li>
          </ol>
        </Section>

        {/* Footer */}
        <div className="mt-16 pt-8 border-t text-center text-xs text-muted-foreground">
          <p>Documentação gerada automaticamente — {new Date().toLocaleDateString('pt-BR', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
          <p>Sistema de Gestão de Afiação & Vendas B2B v1.0</p>
        </div>
      </div>
    </div>
  );
};

// ─── Helper Components ───────────────────────────────────────────
const Section = ({ id, title, children }: { id: string; title: string; children: React.ReactNode }) => (
  <section id={id} className="mb-12">
    <h2 className="text-2xl font-black mb-4 border-b-2 pb-2 border-primary/20">{title}</h2>
    {children}
  </section>
);

const Module = ({ name, desc, audience, deps }: { name: string; desc: string; audience: string; deps: string }) => (
  <div className="mb-6 pl-4 border-l-2 border-primary/30">
    <h4 className="font-bold text-base mb-1">{name}</h4>
    <p className="text-sm mb-2">{desc}</p>
    <p className="text-xs text-muted-foreground"><strong>Público:</strong> {audience}</p>
    <p className="text-xs text-muted-foreground"><strong>Dependências:</strong> {deps}</p>
  </div>
);

const TableRow = ({ label, value }: { label: string; value: string }) => (
  <tr className="border-b">
    <td className="p-2 font-semibold w-40">{label}</td>
    <td className="p-2">{value}</td>
  </tr>
);

export default TechnicalDocs;
