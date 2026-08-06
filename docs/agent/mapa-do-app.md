# Mapa do app — "onde eu faço X?" (rotas/funcionalidades)

> Índice de alto nível dos módulos e rotas do Afiação/Colacor, para responder "onde que eu faço isso mesmo?" sem varrer o código. **Fonte viva: `src/App.tsx`** (~119 rotas lazy, agrupadas por gate). Este mapa é de MÓDULO/PREFIXO — para a rota exata de uma tela nova, `grep` no `App.tsx`. Roles/gates em `useAuth()` (CLAUDE.md §Auth). **Não** listar as 119 rotas aqui (apodrece) — manter alto nível.

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

> Manutenção: quando um módulo NOVO nascer (prefixo novo no `App.tsx`), acrescente 1 linha aqui. Telas individuais que mudam de rota NÃO precisam entrar — o `grep` no `App.tsx` é a fonte exata.
