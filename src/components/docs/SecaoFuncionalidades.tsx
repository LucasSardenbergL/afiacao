// Seção 2 (Mapa Completo de Funcionalidades) da Documentação Técnica.
// Extraída de src/pages/TechnicalDocs.tsx (god-component split).
import { Section, Module } from '@/components/docs/primitives';

export function SecaoFuncionalidades() {
  return (
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
        desc="Motor de recomendações individuais. Cross-sell: produtos não comprados mas populares no cluster. Up-sell: substituições premium para produtos com margem baixa. Cálculo de LIE (Lucro Incremental Esperado) = P_ij × M_ij × ComplexityFactor. A taxa de conversão e o fator de complexidade são PREMISSAS FIXAS, não aprendidas: o desfecho das recomendações nunca chegou a ser registrado, então não há histórico para calibrar. O LIE serve para ORDENAR (o ranking não depende dessas constantes); o valor absoluto em R$ é estimativa não calibrada."
        audience="Employee (Farmer)"
        deps="Hook useCrossSellEngine, tabelas farmer_recommendations, farmer_client_scores"
      />

      <Module
        name="2.9 Bundle Engine (Market Basket Analysis)"
        desc="Mineração de regras de associação (Apriori-like) sobre transações históricas. Regras de pares e triplos. Regras sequenciais (produto A comprado antes de B). Geração de bundles de 2-3 produtos por cliente. Métricas: support, confidence, lift. LIE_bundle = P_bundle × M_bundle × ComplexityFactor, com o ComplexityFactor sendo premissa fixa (não aprendida) — vale para ordenar, não como previsão de R$."
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
        deps="Edge Functions omie-sync, omie-cliente, omie-vendas-sync, omie-analytics-sync; tabelas omie_customer_account_map, carteira_membership_ledger, customer_canonical_alias, omie_ordens_servico, omie_products, omie_servicos, sync_state"
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
        deps="Hook useSharpeningSuggestions"
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

      <Module
        name="2.30 Dashboard de Inteligência Comercial"
        desc="Painel consolidado (/intelligence) que agrega métricas de todas as empresas do grupo (Oben, Colacor Vendas e Colacor Afiação) em KPIs únicos. Visibilidade segmentada por nível comercial: Operacional (Health/Priority Scores, SPIN), Gerencial (comparativos de equipe), Estratégico (projeção LTV 3 anos, estimativa CAC, elasticidade de preço, sensibilidade a desconto, Market Share). Super Admins possuem funcionalidade 'Simular como...' para visualizar o sistema sob a perspectiva de qualquer colaborador."
        audience="Staff (visibilidade por nível RBAC comercial)"
        deps="Página IntelligenceDashboard, tabelas farmer_client_scores, farmer_performance_scores, commercial_roles"
      />

      <Module
        name="2.31 RBAC Hierárquico Comercial"
        desc="Sistema de papéis comerciais para funcionários com 4 níveis: OPERACIONAL (acesso básico a carteira e scoring), GERENCIAL (comparativos de equipe), ESTRATÉGICO (métricas avançadas e auditoria de margem) e SUPER_ADMIN (acesso irrestrito + simulação de qualquer usuário). Override absoluto para CPF master configurado em company_config. Trigger automático auto_assign_commercial_super_admin para o CPF master."
        audience="Staff (definido por admin/super_admin)"
        deps="Tabela commercial_roles, enum commercial_role, funções is_super_admin(), get_commercial_role()"
      />

      <Module
        name="2.32 Governança de Usuários"
        desc="Gestão centralizada de papéis e permissões (/governance/users). Listagem de todos os usuários com seus papéis (app_role) e papéis comerciais (commercial_role). Possibilidade de alterar papéis com registro em log de auditoria."
        audience="Admin / Super Admin"
        deps="Página GovernanceUsers, tabelas user_roles, commercial_roles, permission_change_log"
      />

      <Module
        name="2.33 Governança de Permissões"
        desc="Sistema de overrides de permissão granular (/governance/permissions). Permite conceder ou revogar permissões específicas por usuário, independente do papel base. Registro completo de alterações."
        audience="Admin / Super Admin"
        deps="Página GovernancePermissions, tabela permission_overrides, permission_change_log"
      />

      <Module
        name="2.34 Parâmetros Matemáticos"
        desc="Interface para visualizar e alterar parâmetros dos algoritmos de scoring (/governance/math). Configuração de pesos, thresholds e fatores de decaimento. Alterações passam pelo fluxo de governança (proposta → aprovação)."
        audience="Admin / Super Admin"
        deps="Página GovernanceMathParams, tabela farmer_algorithm_config, farmer_governance_proposals"
      />

      <Module
        name="2.35 Auditoria de Governança"
        desc="Log completo de todas as alterações em parâmetros, papéis e permissões (/governance/audit). Registro de quem alterou, valores anteriores e novos, timestamp e versão do algoritmo."
        audience="Admin / Super Admin"
        deps="Página GovernanceAudit, tabela farmer_audit_log"
      />

      <Module
        name="2.36 Pedido Unificado com Split Automático"
        desc="Tela única (/sales/new) que consolida produtos (Oben/Colacor) e serviços (Afiação). A seleção do cliente persiste entre todos os catálogos. No checkout, o sistema realiza split automático: gera Pedidos de Venda (PV) independentes nas contas Oben e Colacor, e uma Ordem de Serviço (OS) na conta Afiação. Suporte completo a recursos de IA (voz, imagem), fotos e logística. Resolução automática de user_id e ferramentas do cliente via CNPJ/CPF. Carrinho com rolagem interna e barra flutuante de resumo para pedidos extensos."
        audience="Staff (employee/admin)"
        deps="Página UnifiedOrder, Edge Functions omie-sync, omie-vendas-sync, omie-cliente"
      />

      <Module
        name="2.37 Listagem Unificada de Pedidos"
        desc="Página (/sales/orders) que consolida Pedidos de Venda (Oben/Colacor) e Ordens de Serviço (Afiação) em interface única. Dados normalizados e categorizados por abas com filtros por empresa e status. Navegação contextualizada para detalhamento específico."
        audience="Staff e Clientes (próprios pedidos)"
        deps="Página SalesOrders, tabelas sales_orders, orders"
      />

      <Module
        name="2.38 Algoritmo A — Auditoria de Margem"
        desc="Motor de auditoria (Edge Function algorithm-a-audit) que calcula em background a Margem Potencial vs Margem Real. Identifica Margem Potencial comparando preços atuais contra o maior valor histórico praticado por SKU. O Margin Gap é registrado em margin_audit_log, permitindo que usuários Estratégicos ou Super Admins identifiquem perdas de oportunidade financeira. Execução automatizada semanalmente (domingos 03:00 UTC)."
        audience="Estratégico / Super Admin"
        deps="Edge Function algorithm-a-audit, tabela margin_audit_log, sales_price_history"
      />

      <Module
        name="2.39 Pipeline de Inteligência (Master)"
        desc="Seção exclusiva no dashboard principal (/) para o usuário Master que centraliza gatilhos manuais para população e sincronização de dados: Importar Clientes (bulk sync tri-empresa), Calcular Scores e Auditoria de Margem. Monitoramento de progresso em tempo real para garantir execução na ordem correta."
        audience="Super Admin (CPF master)"
        deps="Página Index, Edge Functions calculate-scores, algorithm-a-audit, omie-cliente"
      />

      <Module
        name="2.40 Sincronização Automática (Cron Jobs)"
        desc="Cadência automatizada via pg_cron: Estoque a cada 30min; Pedidos incremental a cada 2h; Reprocessamento de janela móvel operacional (7 dias) a cada 2h e estratégica (30 dias) diariamente 02:30 UTC; Produtos e Clientes diariamente 06:00 UTC; Scores diariamente 06:00 UTC; Auditoria de margem semanalmente domingos 03:00 UTC; Recálculo de custos 07:00 UTC; Regras de associação 07:30 UTC. Status monitorado via sync_state e sync_reprocess_log."
        audience="Sistema automático"
        deps="pg_cron, Edge Functions omie-sync, omie-vendas-sync, omie-analytics-sync, calculate-scores, algorithm-a-audit, sync-reprocess"
      />

      <Module
        name="2.41 Economia e Savings Dashboard"
        desc="Dashboard (/savings) que mostra ao cliente quanto economizou com manutenção preventiva vs substituição de ferramentas. Cálculos baseados em histórico de afiações e preços de reposição."
        audience="Clientes"
        deps="Página SavingsDashboard, tabelas orders, user_tools"
      />

      <Module
        name="2.42 Configurações do Sistema"
        desc="Página (/settings) para gerenciar configurações dinâmicas do sistema armazenadas em company_config (key-value). Inclui master_cnpj, master_cpf e outras configurações operacionais."
        audience="Admin"
        deps="Página SettingsConfig, tabela company_config"
      />

      <Module
        name="2.43 Design System e UX Rules"
        desc="Páginas de referência interna (/design-system, /ux-rules) documentando os componentes visuais, tokens de design e regras de UX do sistema para consistência no desenvolvimento."
        audience="Desenvolvimento interno"
        deps="Páginas DesignSystem, UXRules"
      />

      <Module
        name="2.44 Produtividade Operacional"
        desc="Dashboard (/admin/productivity) para análise de produtividade operacional da equipe. Métricas de volume de pedidos processados, tempo médio de atendimento e throughput."
        audience="Admin"
        deps="Página AdminProductivity"
      />

      <Module
        name="2.45 Previsão de Demanda"
        desc="Ferramenta (/admin/demand-forecast) para análise de tendências e previsão de demanda de serviços baseada em dados históricos."
        audience="Admin"
        deps="Página AdminDemandForecast"
      />

      <Module
        name="2.46 Planejador de Rotas"
        desc="Interface (/admin/route-planner) com mapa interativo (Leaflet) para planejamento de rotas de coleta e entrega de ferramentas."
        audience="Admin / Staff"
        deps="Página AdminRoutePlanner, Leaflet"
      />
    </Section>
  );
}
