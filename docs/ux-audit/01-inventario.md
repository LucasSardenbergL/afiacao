# Fase 1 — Inventário de telas

> Data: 2026-05-13 · 119 rotas autenticadas + 3 públicas, mapeadas a partir de [src/App.tsx](../../src/App.tsx) e [src/components/AppShell.tsx](../../src/components/AppShell.tsx).

## Legenda

- **Perfil primário** — persona dominante (separador / conferente / comprador / vendedor externo / gestão / operador tintométrico / cliente / staff afiação / master). Algumas telas são compartilhadas; nesse caso destaco a persona crítica.
- **Densidade** — alta (B2B operacional, planilha/tabela), média (admin/CRUD), baixa (consumer-grade ou dashboard).
- **Plataforma** — mobile / desktop / ambos (responsivo real).
- **Freq.** — alta (uso diário) / média (semanal) / baixa (mensal ou eventual).
- **Crít.** — Operação para por 1h se essa tela cair? **Sim / Não**.

---

## 1. Home & autenticação

| Rota | Componente | Perfil primário | Jornada (1 frase) | Densidade | Plataforma | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/` | Index | staff + cliente (fork) | Porta de entrada — staff vê pedidos pendentes, customer vê dashboard de OS | média | ambos | alta | Não |
| `/auth` | Auth | qualquer | Login + signup com aprovação fail-closed | baixa | ambos | alta | Sim |
| `/reset-password` | ResetPassword | qualquer | Reset de senha por email | baixa | ambos | baixa | Não |
| `*` | NotFound | qualquer | Fallback 404 | baixa | ambos | baixa | Não |
| `/executive/dashboard` | ExecutiveDashboard | gestão (master) | Visão estratégica multi-empresa | baixa (KPI) | desktop | média | Não |

---

## 2. Cliente final — afiação de ferramentas

> Persona predominante: **cliente** (CNPJ/CPF de marcenaria ou serralheria) usando mobile.

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/orders` | Orders | cliente + staff | Lista de OS abertas/finalizadas | média | ambos | alta | Sim |
| `/orders/:id` | OrderDetail | cliente + staff | Detalhe da OS com chat e timeline | média | ambos | alta | Sim |
| `/new-order` | UnifiedOrder | cliente + staff | Wizard de criação de OS (escolha ferramentas + endereço + agendamento) | média | ambos | alta | Sim |
| `/tools` | Tools | cliente | Gerencia ferramentas cadastradas do cliente | média | mobile | média | Não |
| `/tools/:toolId` | ToolHistory | cliente | Histórico de afiações de uma ferramenta | baixa | mobile | média | Não |
| `/tools/:toolId/reports` | ToolReports | cliente | Relatórios de uso/economia da ferramenta | baixa | desktop | baixa | Não |
| `/tool/:toolId` | ToolPublicHistory (pública) | qualquer com link | QR pública pra histórico da ferramenta | baixa | mobile | baixa | Não |
| `/profile` | Profile | cliente + staff | Edita dados pessoais/empresa | baixa | ambos | baixa | Não |
| `/addresses` | Addresses | cliente | CRUD de endereços de coleta | baixa | mobile | baixa | Não |
| `/support` | Support | cliente | Canal de suporte (chat/contato) | baixa | mobile | baixa | Não |
| `/loyalty` | Loyalty | cliente | Programa de fidelidade — pontos e tiers | baixa | mobile | baixa | Não |
| `/gamification` | Gamification | cliente | Conquistas e certificados | baixa | mobile | baixa | Não |
| `/training` | Training | cliente | Treinamentos publicados | baixa | ambos | baixa | Não |
| `/savings` | SavingsDashboard | cliente | Economia gerada por afiar vs comprar | baixa | desktop | baixa | Não |
| `/recurring-schedules` | RecurringSchedules | cliente | Agendamentos recorrentes de coleta | média | desktop | baixa | Não |

---

## 3. Admin de afiação (operação interna do serviço)

> Persona: **staff afiação** (operador interno, gestão da Colacor SC).

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/admin` | Admin | staff | Hub admin antigo (provavelmente legacy) | média | desktop | média | Não |
| `/admin/approvals` | AdminApprovals | master | Aprova novos cadastros pendentes | média | desktop | média | Sim |
| `/admin/customers` | AdminCustomers | staff comercial | Lista/busca clientes, ficha 360 | alta | desktop | alta | Sim |
| `/admin/customers/:customerId` | AdminCustomers | staff comercial | Ficha individual do cliente | média | desktop | alta | Sim |
| `/admin/orders/:id` | AdminOrderDetail | staff afiação | Detalhe da OS interna, mudança de status, chat | alta | desktop | alta | Sim |
| `/admin/orders/:id/quality` | QualityChecklist | staff afiação | Checklist de qualidade pré-envio | média | desktop | alta | Sim |
| `/admin/demand-forecast` | AdminDemandForecast | gestão | Previsão de demanda (modelo) | baixa | desktop | baixa | Não |
| `/admin/route-planner` | AdminRoutePlanner | gestão logística | Planejamento de rota com Leaflet (nearest-neighbor) | média | desktop | média | Sim |
| `/admin/monthly-reports` | AdminMonthlyReports | gestão | Relatórios mensais consolidados | baixa | desktop | baixa | Não |
| `/admin/productivity` | AdminProductivity | gestão | Produtividade por operador | média | desktop | baixa | Não |
| `/admin/loyalty` | AdminLoyalty | gestão | Configura programa de fidelidade | média | desktop | baixa | Não |
| `/admin/gamification` | AdminGamification | gestão | Configura conquistas/badges | média | desktop | baixa | Não |
| `/admin/training` | AdminTraining | gestão | Cadastra/edita treinamentos | média | desktop | baixa | Não |
| `/admin/price-table` | AdminPriceTable | gestão | Tabela de preços de afiação | alta | desktop | média | Sim |
| `/admin/analytics-sync` | AdminAnalyticsSync | master | Sincronização de analytics | baixa | desktop | baixa | Não |
| `/admin/ajuda` | AdminAjuda | staff | Central de ajuda interna | baixa | ambos | baixa | Não |
| `/admin/des/trimestre-atual` | AdminDesTrimestreAtual | gestão | DES — desempenho trimestre atual | baixa | desktop | média | Não |
| `/admin/notificacoes` | AdminNotificacoes | gestão | Fila de notificações pendentes | média | desktop | média | Sim |
| `/admin/portal-sayerlack` | AdminPortalSayerlack | operador tintométrico | Envio de pedidos ao portal Sayerlack | média | desktop | média | Sim |

---

## 4. Vendas (módulo Oben / Colacor)

> Persona: **vendedor externo** (mobile, offline) + **gestão de vendas** (desktop).

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/sales` | SalesOrders | vendedor + gestão | Lista de pedidos de venda com filtros e status | alta | ambos | alta | Sim |
| `/sales/products` | SalesProducts | vendedor | Catálogo de produtos disponíveis | alta | ambos | alta | Sim |
| `/sales/new` | UnifiedOrder | vendedor | Criação de pedido (mesmo wizard de afiação) | média | ambos | alta | Sim |
| `/sales/print` | SalesPrintDashboard | gestão | Painel de impressão em lote de pedidos | média | desktop | média | Não |
| `/sales/quotes` | SalesQuotes | vendedor | Cotações abertas/enviadas | alta | ambos | alta | Sim |
| `/sales/edit/:id` | SalesOrderEdit | vendedor + gestão | Edita pedido existente | média | desktop | alta | Sim |
| `/vendas/ferramentas` | VendasFerramentas | vendedor | Ferramentas de venda (calculadoras, scripts) | média | ambos | média | Não |
| `/unified-order` | → redirect `/sales/new` | — | — | — | — | — | — |

---

## 5. Farmer / Inteligência comercial

> Persona: **vendedor externo + gestão comercial**. Conjunto que parece ser CRM tipo "customer farming" (cross-sell, copilot de bundle, plano tático). Heavy em IA.

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/farmer` | FarmerDashboard | gestão comercial | KPIs do farming (carteira, retenção, IPF) | média | desktop | alta | Não |
| `/farmer/calls` | FarmerCalls | vendedor | Fila de ligações sugeridas | alta | ambos | alta | Sim |
| `/farmer/governance` | FarmerGovernance | gestão comercial | Regras e experimentos do farming | média | desktop | baixa | Não |
| `/farmer/recommendations` | FarmerRecommendations | vendedor | Recomendações de oferta por cliente | alta | ambos | alta | Sim |
| `/farmer/locc` | FarmerLOCC | gestão comercial | Linha do Cliente / LOCC | média | desktop | média | Não |
| `/farmer/bundles` | FarmerBundles | vendedor | Bundles sugeridos para upsell | média | ambos | média | Não |
| `/farmer/copilot` | FarmerCopilot | vendedor | Copilot IA pra abordagem do cliente | média | ambos | média | Não |
| `/farmer/tactical-plan` | FarmerTacticalPlan | gestão comercial | Plano tático trimestral | média | desktop | baixa | Não |
| `/farmer/ipf` | FarmerIPFDashboard | gestão comercial | IPF (Índice de Performance do Farmer) | média | desktop | média | Não |
| `/coaching` | CoachingSPIN | gestão comercial | Coaching SPIN selling com vendedores | baixa | desktop | baixa | Não |

---

## 6. Estoque (picking + recebimento)

> Personas: **separador** (mobile/luva), **conferente** (desktop/teclado), **operador almox**.

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/admin/estoque/picking` | AdminEstoquePicking | separador + gestão | Lista de tasks de picking, FEFO compliance, scan endereço/SKU | alta | mobile + desktop | alta | **Sim** |
| `/admin/estoque/recebimento` | AdminEstoqueRecebimento | conferente + gestão | Dashboard de recebimentos em aberto | alta | desktop | alta | Sim |
| `/recebimento` | Recebimento | conferente | Lista de NF-e a receber | alta | desktop | alta | **Sim** |
| `/recebimento/:id` | RecebimentoConferencia | conferente | Conferência item-a-item com OCR de lote, FEFO, divergência | alta | desktop + mobile | alta | **Sim** |
| `/nfe-receipt` | NfeReceipt | almoxarife | Upload de NF-e XML/PDF e parser | média | desktop | alta | **Sim** |
| `/producao` | ProductionOrders | operador fábrica | Ordens de produção (Colacor abrasivos) | alta | desktop | alta | Sim |
| `/admin/sku-mapeamento` | AdminSkuMapeamento | comprador + gestão | Mapeamento de SKUs entre fornecedor/Omie/interno | alta | desktop | média | Sim |

---

## 7. Reposição inteligente (compras ABC-XYZ)

> Persona: **comprador** (desktop, análise diária). 19 telas. Núcleo da operação Oben.

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/admin/reposicao/cockpit` | AdminReposicaoCockpit | comprador | **Cockpit central** — sugestões do dia, alertas, decisões de compra (2210 linhas) | alta | desktop | alta | **Sim** |
| `/admin/reposicao/pedidos` | AdminReposicaoPedidos | comprador | Pedidos de compra sugeridos hoje aguardando aprovação | alta | desktop | alta | **Sim** |
| `/admin/reposicao/revisao` | AdminReposicaoRevisao | comprador | Revisão fina de itens antes do disparo | alta | desktop | alta | Sim |
| `/admin/reposicao/alertas` | AdminReposicaoAlertas | comprador | Outliers e eventos críticos (estoque negativo, ruptura iminente) | alta | desktop | alta | Sim |
| `/admin/reposicao/aplicacao` | AdminReposicaoAplicacao | comprador | Aplicação em lote de parâmetros/políticas | alta | desktop | média | Sim |
| `/admin/reposicao/grupos-producao` | AdminReposicaoGruposProducao | comprador | Grupos de produção (compra conjunta) | média | desktop | média | Não |
| `/admin/reposicao/sla-fornecedor` | AdminReposicaoSlaFornecedor | comprador | SLA por fornecedor (lead time, fillrate) | alta | desktop | média | Não |
| `/admin/reposicao/cadeia-logistica` | AdminReposicaoCadeiaLogistica | comprador + gestão | Visão da cadeia logística | média | desktop | baixa | Não |
| `/admin/reposicao/promocoes` | AdminReposicaoPromocoes | comprador | Lista de promoções recebidas/aplicadas | alta | desktop | alta | Sim |
| `/admin/reposicao/promocoes/novo` | AdminReposicaoPromocaoDetail | comprador | Novo lançamento de promoção | média | desktop | média | Sim |
| `/admin/reposicao/promocoes/:id` | AdminReposicaoPromocaoDetail | comprador | Editar promoção | média | desktop | média | Sim |
| `/admin/reposicao/aumentos` | AdminReposicaoAumentos | comprador | Aumentos anunciados por fornecedores | alta | desktop | alta | Sim |
| `/admin/reposicao/aumentos/novo` | AdminReposicaoAumentoDetail | comprador | Novo aumento (com vigência) | média | desktop | média | Sim |
| `/admin/reposicao/aumentos/:id` | AdminReposicaoAumentoDetail | comprador | Editar aumento | média | desktop | média | Sim |
| `/admin/reposicao/oportunidades` | AdminReposicaoOportunidades | comprador | Oportunidades econômicas detectadas hoje | alta | desktop | alta | Sim |
| `/admin/reposicao/negociacao-paralela` | AdminReposicaoNegociacaoParalela | comprador | Sugestões de negociação paralela ativa | alta | desktop | alta | Sim |
| `/admin/reposicao/parametros` | AdminReposicaoParametros | comprador + gestão | Parâmetros matemáticos da reposição | alta | desktop | média | Sim |
| `/admin/reposicao/mercado` | AdminReposicaoMercado | comprador + gestão | Inteligência de mercado (preço de concorrente) | média | desktop | baixa | Não |
| `/admin/reposicao/cadastros` | AdminReposicaoCadastros | comprador + gestão | Cadastros e config do módulo | média | desktop | baixa | Não |
| `/admin/reposicao/historico` | AdminReposicaoHistorico | comprador + gestão | Histórico de decisões e disparos | média | desktop | baixa | Não |

---

## 8. Financeiro (cockpit CFO + Omie)

> Persona: **gestão financeira (CFO/controller)**. 13 telas. Sync Omie ERP.

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/financeiro` | FinanceiroDashboard | gestão financeira | Dashboard geral entrada | média | desktop | alta | Não |
| `/financeiro/cockpit` | FinanceiroCockpit | CFO | **Cockpit CFO** — caixa, DRE caixa, rentabilidade | alta | desktop | alta | Sim |
| `/financeiro/gestao` | FinanceiroGestao | gestão financeira | Hub de operações financeiras | alta | desktop | alta | Sim |
| `/financeiro/analise` | FinanceiroAnalise | gestão financeira | Análises ad-hoc e config | média | desktop | média | Não |
| `/financeiro/analytics` | FinanceiroAnalytics | CFO | Analytics financeiro avançado | média | desktop | média | Não |
| `/financeiro/sync` | FinanceiroSync | gestão financeira | Status e disparo de sync Omie | média | desktop | média | Sim |
| `/financeiro/mapping` | FinanceiroMapping | controller | Mapeamento conta Omie ↔ interno | alta | desktop | baixa | Não |
| `/financeiro/capital-giro` | FinanceiroCapitalGiro | CFO | Análise de capital de giro | média | desktop | média | Sim |
| `/financeiro/fechamento` | FinanceiroFechamento | controller | Fechamento mensal | alta | desktop | média | Sim |
| `/financeiro/conciliacao` | FinanceiroConciliacao | controller | Conciliação bancária | alta | desktop | alta | Sim |
| `/financeiro/orcamento` | FinanceiroOrcamento | CFO + gestão | Orçamento e budget vs realizado | alta | desktop | média | Não |
| `/financeiro/intercompany` | FinanceiroIntercompany | controller | Movimentações intercompany (Colacor/Oben/SC) | alta | desktop | média | Sim |
| `/financeiro/tributario` | FinanceiroTributario | controller | Visão tributária por regime | alta | desktop | média | Não |

---

## 9. Tintométrico (SAYERSYSTEM, ~477k fórmulas)

> Persona: **operador tintométrico** (balcão, desktop touchscreen) + **gestão** (config).

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/tintometrico` | TintDashboard | gestão tinta | Visão geral, erros de sync, fórmulas/dia | média | desktop | alta | Sim |
| `/tintometrico/catalogo` | TintCatalogo | operador + gestão | Catálogo de fórmulas + preços | alta | desktop touchscreen | alta | **Sim** |
| `/tintometrico/formulas` | TintFormulas | operador tintométrico | **Busca fórmula** durante atendimento (~477k) | alta | desktop touchscreen | alta | **Sim** |
| `/tintometrico/corantes` | TintCorantes | gestão tinta | Cadastro de corantes e bases | alta | desktop | média | Sim |
| `/tintometrico/precos` | TintPricing | gestão tinta | Preços por fórmula/litragem | alta | desktop | média | Sim |
| `/tintometrico/importar` | TintImport | gestão tinta | Importação SAYERSYSTEM (lote) | média | desktop | baixa | Não |
| `/tintometrico/mapeamento` | TintMapping | gestão tinta | Mapeamento fórmula ↔ SKU | alta | desktop | baixa | Não |
| `/tintometrico/integracao` | TintIntegracao | gestão tinta | Hub de integração | média | desktop | baixa | Não |
| `/tintometrico/integracoes` | TintIntegrations | gestão tinta | Lista de integrações ativas (legacy?) | média | desktop | baixa | Não |
| `/tintometrico/reconciliacao` | TintReconciliation | gestão tinta | Reconciliação de fórmulas | alta | desktop | baixa | Não |
| `/tintometrico/sync-runs` | TintSyncRuns | gestão tinta | Logs de execução de sync | média | desktop | baixa | Não |
| `/tintometrico/api-contract` | TintApiContract | dev/master | Contrato da API tintométrica | baixa | desktop | baixa | Não |

---

## 10. Governança (master/admin)

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/governance/users` | GovernanceUsers | master | CRUD de usuários | alta | desktop | média | Sim |
| `/governance/permissions` | GovernancePermissions | master | Gerencia permissões/roles | alta | desktop | baixa | Sim |
| `/governance/math` | GovernanceMathParams | master | Parâmetros matemáticos globais (ABC-XYZ, EOQ, safety stock) | alta | desktop | baixa | Sim |
| `/governance/audit` | GovernanceAudit | master | Log de auditoria | alta | desktop | baixa | Não |
| `/governance/settings` | GovernanceSettings | master | Configurações globais do app | média | desktop | baixa | Não |
| `/governance/companies` | GovernanceCompanies | master | Config das 3 empresas | média | desktop | baixa | Sim |
| `/gestao/admin` | GestaoAdmin | master | Hub de admin/relatórios consolidados | média | desktop | média | Não |
| `/gestao/governanca` | GestaoGovernanca | master | Hub de governança consolidado | média | desktop | baixa | Não |

---

## 11. Inteligência / IA / Performance

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/intelligence` | IntelligenceDashboard | gestão | Dashboard de inteligência cross-módulo | média | desktop | média | Não |
| `/ai-ops` | AIops | gestão | Operações de IA — modelos, prompts, runs | média | desktop | baixa | Não |
| `/performance` | PerformanceHub | gestão | Hub de performance multi-time | média | desktop | média | Não |

---

## 12. Config / Documentação

| Rota | Componente | Perfil | Jornada | Dens. | Plat. | Freq. | Crít. |
|---|---|---|---|---|---|---|---|
| `/settings` | SettingsConfig | qualquer | Preferências do usuário | baixa | ambos | baixa | Não |
| `/design-system` | DesignSystem | dev | Documentação do design system | média | desktop | baixa | Não |
| `/ux-rules` | UXRules | dev | Regras de UX | baixa | desktop | baixa | Não |
| `/docs` | TechnicalDocs | dev | Docs técnicas | baixa | desktop | baixa | Não |

---

## Sumário quantitativo

- **Total**: 119 rotas autenticadas + 3 públicas
- **Crítica (Sim)**: 53 rotas (~45%) — concentradas em Estoque, Reposição, Financeiro, Vendas, Tintométrico
- **Alta frequência**: 36 rotas (~30%)
- **Mobile primário**: 7 rotas (Picking + boa parte da operação cliente afiação + Vendedor externo no farmer/sales)
- **Desktop touchscreen** (balcão): 2 rotas (TintFormulas, TintCatalogo)

---

## Top 10 candidatas à Fase 2 (heurística)

Critério: **criticidade SIM + frequência ALTA + persona operacional distinta** (cobrir as 5 personas-chave para que a análise não fique monocultura). Em parênteses, persona que vai pilotar a análise.

| # | Rota | Componente | Persona | Justificativa de seleção |
|---|---|---|---|---|
| 1 | `/admin/estoque/picking` | AdminEstoquePicking | **Separador** (mobile/luva) | Única tela mobile-crítica com scan + FEFO. Falha = chão para. |
| 2 | `/recebimento/:id` | RecebimentoConferencia | **Conferente** (desktop+OCR) | Conferência item-a-item de NF-e — gargalo diário do almox. |
| 3 | `/admin/reposicao/cockpit` | AdminReposicaoCockpit | **Comprador** | 2210 linhas — coração da decisão de compra. Maior tela analítica densa. |
| 4 | `/admin/reposicao/pedidos` | AdminReposicaoPedidos | **Comprador** | Aprovação diária dos pedidos sugeridos antes do disparo. Decisão financeira direta. |
| 5 | `/sales` | SalesOrders | **Vendedor externo / gestão vendas** | Lista densa de pedidos — ponto central da rotina comercial. |
| 6 | `/sales/new` (= `/new-order`) | UnifiedOrder | **Vendedor externo** (mobile) | Wizard de pedido. Sem isso não emite venda. Tem que rodar offline. |
| 7 | `/financeiro/cockpit` | FinanceiroCockpit | **CFO / gestão** | Cockpit CFO — visibilidade financeira diária do grupo. |
| 8 | `/tintometrico/formulas` | TintFormulas | **Operador tintométrico** (touchscreen) | Busca de fórmula no balcão (~477k registros). Latência define UX de atendimento. |
| 9 | `/nfe-receipt` | NfeReceipt | **Conferente** | Entrada de NF-e via XML/OCR — primeiro passo de tudo do almox. |
| 10 | `/admin/customers` | AdminCustomers | **Gestão comercial** | CRM/ficha 360 — uso transversal de vendas e atendimento. |

### Personas cobertas pelo top 10

- **Separador**: #1 ✓
- **Conferente**: #2, #9 ✓
- **Comprador**: #3, #4 ✓
- **Vendedor externo**: #5, #6 ✓
- **Operador tintométrico**: #8 ✓
- **Gestão (CFO / comercial)**: #7, #10 ✓

Todas as 5 personas + master/gestão estão representadas. Nenhuma persona fica sem auditoria.

### Telas que ficaram de fora mas merecem nota

Pode valer revisitar na Fase 4 (execução) ou em rounds futuros:

- `/admin/reposicao/alertas` — ponto único de outliers críticos. Subiu para nota 4★ mas perdi pra Cockpit/Pedidos por economia de horas.
- `/recebimento` (lista) — auditável junto com `/recebimento/:id` se sobrar tempo. Padrões devem ser comuns.
- `/admin/orders/:id` (AdminOrderDetail) — coração do staff afiação. Mas afiação é hoje um módulo menor frente ao restante.
- `/farmer/calls` + `/farmer/recommendations` — alta frequência pro vendedor externo mas a heurística vai ter padrões duplicados com `/sales`.
- `/financeiro/conciliacao` — alta dor operacional do controller, mas o cockpit captura os padrões macros.
- `/producao` — ordens de produção da Colacor (abrasivos). Faltou tempo de leitura — registro como gap.

---

## Observações fora do escopo de UX

Coisas notadas durante a varredura que não são UX mas merecem atenção em outra trilha:

- **Rota duplicada conceitual**: `/tintometrico/integracoes` (TintIntegrations, plural) e `/tintometrico/integracao` (TintIntegracao, singular) coexistem. Provável uma é legado pós-consolidação.
- **`/admin` (Admin.tsx) vs `/gestao/admin` (GestaoAdmin)**: dois hubs admin coexistem — sinal de migração incompleta.
- **`/unified-order` redireciona para `/sales/new`**: redirect mantido por compatibilidade — provavelmente seguro de remover após dados de log mostrarem zero uso.
- **`UnifiedOrder` é reaproveitado em `/new-order` e `/sales/new`**: bom — aliviou divergência. Mas a página em si tem 269 linhas dum hook gigante (`useUnifiedOrder` com 30k+ linhas) — auditável como refactor.
- **`DesignSystem` cita "HubSpot Canvas + Polaris + Gong"** (já registrado em CLAUDE.md §4): realinhar nos artefatos de execução.
- **Branding `Scissors` + "Central"** na sidebar (`AppShell.tsx:331-337`): identidade visual ainda afiação-centric.
- **`Bell` topbar é ornamental** (sem onClick, sem badge): UX-mentira — ou implementar central de notificações, ou remover.
- **53 rotas críticas** sem nenhuma com offline-first real (Workbox NetworkOnly em quase tudo de operação). Vai virar item top do roadmap.
