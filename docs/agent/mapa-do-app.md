# Mapa do app — "onde eu faço X?" (rotas/funcionalidades)

> Índice de alto nível dos módulos e rotas do Afiação/Colacor, para responder "onde que eu faço isso mesmo?" sem varrer o código. **Fonte viva: `src/App.tsx`** (~119 rotas lazy, agrupadas por gate). Este mapa é de MÓDULO/PREFIXO — para a rota exata de uma tela nova, `grep` no `App.tsx`. Roles/gates em `useAuth()` (CLAUDE.md §Auth). **Não** listar as 119 rotas aqui (apodrece) — manter alto nível.

## Produto — o grupo e as 3 empresas

**Afiação/Colacor** é o sistema operacional B2B do grupo Colacor. As 3 empresas vivem em `src/contexts/CompanyContext.tsx`:

| Chave | Empresa | O que é |
|---|---|---|
| `colacor` | Colacor | indústria de abrasivos |
| `oben` | Oben Comercial | distribuidora moveleira (compra/revende) |
| `colacor_sc` | Colacor SC | serviços, Simples Nacional |

CNPJs distintos por vantagem fiscal — por isso **um cliente do grupo legitimamente tem 2 cadastros Omie** (`servicos`/Colacor SC + `vendas`/Oben). A consequência disso no banco (aliases fiscais, nunca deleção ad-hoc de `auth.users`) está em [database.md](database.md) §5.

## Como o `App.tsx` está organizado (gates)

Tudo autenticado vive em `<ProtectedRoute><AppShellLayout>` e se divide em faixas de acesso:
- **Abertas (cliente + staff)** — loja/afiação, tarefas.
- **`RequireFinanceiroAccess`** — tudo em `/financeiro`.
- **`RequireStaff`** (fail-closed: todo o resto) — o grosso do sistema operacional.
- Sub-gates: `RequireCaca` (`/caca`), sub-layout de sessão na Reposição.

## Módulos → prefixo → o que é

| Módulo | Prefixo de rota | Gate | Telas-chave |
|---|---|---|---|
| Afiação / Loja (cliente) | `/`, `/orders`, `/new-order`, `/tools`, `/loyalty`, `/gamification`, `/training`, `/savings` | aberto | pedido de afiação, histórico de ferramenta, fidelidade, treinamento |
| Tarefas | `/tarefas`, `/tarefas/templates` | aberto | tarefas operacionais + templates |
| Financeiro | `/financeiro/*` | `RequireFinanceiroAccess` | `capital-giro` (fluxo 13s/NCG), DRE, `tributario`, `mapping` de categoria, fechamento |
| Vendas | `/sales/*` | staff | pipeline / venda assistida por IA |
| Farmer / Inteligência | `/farmer/*`, `/meu-dia`, `/coaching`, `/intelligence`, `/executive/dashboard`, `/radar` | staff | plano tático, bundles, IPF, radar de empresas |
| Admin / CRM | `/admin/*` (customers, orders, approvals, price-table, demand-forecast) | staff | clientes, aprovações, tabela de preço, previsão de demanda |
| Tintométrico | `/tintometrico/*` | staff | catálogo, integração, fórmulas |
| Estoque / Recebimento | `/admin/estoque/*`, `/recebimento/*` | staff | picking, recebimento (offline-first) |
| Produção | `/producao/*` | staff | ordens de produção |
| Reposição / Compras | `/admin/reposicao/*`, `/admin/sku-mapeamento` | staff | pedidos do ciclo, sessão de compra, de-para Sayerlack |
| Governança / Gestão | `/governance/*`, `/gestao/*` | staff | saúde de dados, melhorias, grupos de cliente |
| Base de Conhecimento / Processos | `/admin/knowledge-base/*`, `/admin/standard-processes/*` | staff | boletim↔SKU, processos-padrão |
| Telefonia / WhatsApp / Rota | `/telefonia`, `/whatsapp/*`, `/rota/*` | staff | discador WebRTC, atendimento, roteirização |
| Caça (prospecção) | `/caca` | `RequireCaca` | prospecção de leads |
| Plataforma (config/design/docs) | `/ai-ops`, `/design-system`, `/settings`, `/docs`, `/admin/ajuda` | staff | ai-ops, design system, docs técnicas, ajuda |

## "Onde eu faço X?" (por intenção → módulo)

- **Caixa / DRE / inadimplência / fluxo 13 semanas** → `/financeiro`. Para ANÁLISE sem abrir tela, use as skills `cfo-colacor` (fechamento/controladoria) e `bi-colacor` (número rápido) — elas rodam via `psql-ro`.
- **Aprovar/disparar pedido de compra, ver ruptura/sugestões, estoque parado** → `/admin/reposicao` (número/diagnóstico sem tela → `bi-colacor`).
- **Picking / receber mercadoria** (chão de fábrica, offline-first) → `/recebimento`, `/admin/estoque`.
- **Preço de tinta / fórmula tintométrica** → `/tintometrico`.
- **Cadastro/aprovação de cliente, tabela de preço, previsão de demanda** → `/admin` (customers, approvals, price-table, demand-forecast).
- **Boletim técnico ↔ SKU (base de conhecimento)** → `/admin/knowledge-base`.
- **Saúde dos dados / sync / backlog de melhorias** → Governança/Gestão (`/gestao`, `/governance`). Sync quebrado → skill `diagnose-supabase-sync`.
- **Plano do dia do vendedor, radar de oportunidade, coaching** → `/meu-dia`, `/radar`, `/farmer`.
- **Telefonar (WebRTC) / WhatsApp / roteiro de visita** → `/telefonia`, `/whatsapp`, `/rota`.

## Princípios não-negociáveis (briefing do founder)

Os 6 compromissos de produto que o app assumiu, com o estado de cada um. Valem como critério de aceite para tela nova — não são aspiração:

| # | Princípio | Estado | Como está hoje |
|---|---|---|---|
| 1 | **Offline-first** no picking/recebimento | ✅ | Workbox + fila de mutação + optimistic |
| 2 | Latência <100ms no scan | 🟡 | `ScanBar` wedge HID; BarcodeDetector ainda não |
| 3 | Densidade alta em telas operacionais | ✅ | `density-compact` global |
| 4 | WCAG AA (AAA nas críticas) | ✅ | 44px touch global |
| 5 | Mobile-first no chão de fábrica / desktop-first no analítico | 🟡 | parcial |
| 6 | Cmd-K + atalhos consistentes | ✅ | `useRegisterCommands` / `useRegisterShortcuts` |

Ao mexer no estado de um deles, atualize a coluna aqui — o CLAUDE.md não carrega mais este placar.

> Manutenção: quando um módulo NOVO nascer (prefixo novo no `App.tsx`), acrescente 1 linha aqui. Telas individuais que mudam de rota NÃO precisam entrar — o `grep` no `App.tsx` é a fonte exata.
