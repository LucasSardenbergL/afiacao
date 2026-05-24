# Carteira vinda do Omie como fonte de verdade — Design

> **Status:** spec aprovado no brainstorm (2026-05-23, camada de KPIs adicionada 2026-05-24). Próximo passo: writing-plans.
> **Branch:** `feat/carteira-omie-fonte-verdade`
> **2ª opinião:** codex consult (2026-05-23 arquitetura da posse; 2026-05-24 KPIs/positivação) — recomendou Abordagem C + conjunto enxuto de KPIs; refinamentos incorporados.
> **Escopo:** modelo de posse da carteira (Fases 1-3) + camada de KPIs/positivação na tela de ligações (Fase 4).

## Problema

Hoje a **carteira** (qual cliente pertence a qual vendedor) que alimenta as sugestões de ligação/visita é **inferida de atividade**: a edge function `visit-score-recalc-batch` monta pares `(customer_user_id, farmer_id)` a partir de `farmer_calls` + `route_visits` dos últimos 30 dias e grava uma linha por par em duas tabelas de score (`customer_visit_scores`, `farmer_client_scores`), chaveadas por `(customer_user_id, farmer_id)`. Os hooks de front (`useMyVisitSuggestions`, `useMyCarteiraScores`) filtram por `eq('farmer_id', user.id)`.

Isso gera dois bugs de negócio:

1. **Contaminação cruzada.** Se o vendedor B liga uma vez pro cliente do vendedor A (A de férias), aquele cliente entra na lista de sugestões de B pelos 30 dias seguintes. Não existe "dono único".
2. **Lacuna silenciosa.** Cliente recém-designado a A no Omie, mas que A ainda não ligou, **nunca aparece** nas sugestões de A — porque o sistema só conhece a carteira por atividade passada.

## Fonte de verdade disponível

O ERP (Omie) guarda o vendedor designado por cliente, e **esse vendedor é a mesma pessoa que loga no app**. Já capturamos o dado:

- `omie_clientes(user_id uuid UNIQUE [conta do CLIENTE no app], omie_codigo_cliente bigint, omie_codigo_vendedor int nullable)`.

O que **falta** é a ponte `omie_codigo_vendedor (int) → user_id do vendedor (uuid)`. Hoje são ~3 vendedores (Lucas = Hunter; Regina, Tati = Farmers).

## Decisões do brainstorm (confirmadas com o founder)

1. **Omie é a fonte de verdade da posse.** Atividade (ligações/visitas) é rebaixada a **sinal de score** (recência), não define mais dono.
2. **Cliente sem vendedor no Omie → vai pro Hunter** (prospecção). Hunter é tag de grupo; hoje exatamente 1 usuário (também master).
3. **Modo cobertura (construir agora):** quando A está de férias, B enxerga a carteira de A na própria lista de sugestões, com clientes **selados** ("Cobertura — A"). O discador/busca já é universal — isto é só sobre a *lista de sugestões*.
4. **Conceito único de "dono" no app inteiro:** tanto a lista de sugestões quanto a tela "Minha Carteira" usam a designação do Omie.

## Abordagem escolhida (C — tabela dedicada de carteira)

Avaliamos 3 abordagens. **A** (materializar no recalc, `farmer_id` = dono-Omie) foi rejeitada por "vazar lógica de produto pro scoring". **B** (view viva no banco) foi rejeitada por virar "armadilha de RLS" (política de negócio enterrada em views/predicados). **C** foi a recomendação do codex e a escolha do founder:

**Posse é um conceito de produto, não um efeito do scoring.** Uma tabela dedicada de carteira vira o **contrato único de posse** do app. O score passa a ser propriedade do **cliente** (join por `customer_user_id`); quem vê o cliente é decidido pela carteira.

## Modelo de dados

### Objeto novo 1 — `omie_vendedor_map` (a ponte Omie → app)

```sql
CREATE TABLE public.omie_vendedor_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_account text NOT NULL,            -- 'oben' | 'colacor' | 'colacor_sc'
  omie_codigo_vendedor int NOT NULL,
  user_id uuid NOT NULL,                 -- conta do VENDEDOR no app
  nome text,                             -- nome do vendedor (cache p/ display/audit)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (omie_account, omie_codigo_vendedor)
);
```

- Chaveado por `(omie_account, omie_codigo_vendedor)` porque o código de vendedor **não é único entre contas** Oben/Colacor (risco que o codex apontou).
- **Vários códigos → mesmo `user_id`** é permitido (não há UNIQUE em `user_id`): a mesma pessoa pode ter códigos diferentes por conta Omie.
- Seed inicial: 3 linhas. O founder confirma qual código = qual pessoa (a partir de uma query que lista `omie_codigo_vendedor` distintos + nome resolvido via Omie `ListarVendedores`).

### Objeto novo 2 — `carteira_assignments` (dono primário, 1 por cliente)

```sql
CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,        -- o cliente (conta no app)
  owner_user_id uuid NOT NULL,           -- o vendedor dono
  source text NOT NULL CHECK (source IN ('omie','hunter_orphan')),
  omie_account text,
  omie_codigo_vendedor int,
  eligible boolean NOT NULL DEFAULT true, -- entra no denominador de positivação? master pode desmarcar (duplicado/atribuição errada/não-comercial)
  valid_from timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,            -- lag de sync fica VISÍVEL, não escondido
  UNIQUE (customer_user_id)              -- um único dono primário por cliente
);
```

- Reconstruída a partir do Omie (job idempotente).
- Cliente sem vendedor mapeado → `source='hunter_orphan'`, `owner_user_id` = o Hunter.
- **Cobertura NÃO mora aqui** — cobertura é visibilidade, não posse (refinamento do codex). Cliente coberto continua com `owner_user_id = A`; B o enxerga via `carteira_coverage`.

### Objeto novo 3 — `carteira_coverage` (cobertura no nível do dono)

```sql
CREATE TABLE public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  covering_user_id uuid NOT NULL,        -- quem cobre (ex.: Tati)
  covered_user_id uuid NOT NULL,         -- quem está coberto (ex.: Regina)
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,               -- NULL = até cancelar manualmente
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (covering_user_id <> covered_user_id)
);
```

- Cobertura no nível do **dono**, não por cliente — evita explodir centenas de linhas. "Tati cobre Regina de D1 a D2" é uma linha.
- Múltiplas coberturas ativas são permitidas; a leitura faz dedupe por cliente.
- **Quem cria:** só master/admin **ou** o próprio dono coberto (`covered_user_id = auth.uid()`). Nunca auto-concessão de um terceiro.

### Scores — `farmer_id` redefinido = dono da carteira (Opção A; 2ª opinião codex 2026-05-24)

> **Revisão de rumo (2026-05-24):** o plano original era dropar `farmer_id` (score por-cliente). Uma auditoria do motor de scoring revelou raio de impacto grande (~18 callsites, recriação de índices, migração de dados) **e** que métricas por-vendedor (`useFarmerPerformance`, `IntelligenceManagerialTab`) agregam por `farmer_id` — quebrariam. 2º codex consult recomendou **Opção A**: manter a coluna, mas **`farmer_id` passa a significar "dono da carteira"** (não mais "quem teve atividade"). Comercialmente idêntico a dropar; muito menos risco.

`customer_visit_scores` e `farmer_client_scores` continuam `(customer_user_id, farmer_id)`, mas:

- O recalc **deixa de enumerar pares de atividade** (farmer_calls/route_visits) e passa a enumerar **`carteira_assignments` (customer, owner)** — `farmer_id` gravado = `owner_user_id`. Assim **todo cliente da carteira ganha score** (não só os contatados).
- Valores dos scores seguem intrínsecos ao cliente (histórico de compra). `signal_modifiers` usa as ligações **do dono** (cobertura é visibilidade, não muda atribuição).
- **Recompute com cursor/continuação** (lotes resumíveis com estado de job) — recomputar ~3.600 clientes num run único estouraria o timeout de 50s da edge.
- **Anti-drift:** nada pode voltar a seedar score por "quem teve atividade". Travar em naming/comentário + um teste afirmando que o score deriva de `carteira_assignments`.
- Leituras quase não mudam (`eq('farmer_id', eu)` já significa "minha carteira"); cobertura expande pra `farmer_id IN [eu, ...donos cobertos]` (sem duplicar linhas).
- **Dívida semântica aceita:** o nome `farmer_id` fica "ressignificado" como dono; renomear pra `owner_user_id` é trabalho futuro opcional, sem pressa.

## Fluxo de dados — rebuild da carteira

Job idempotente acoplado ao sync noturno do Omie (nova edge function `carteira-rebuild`, ou passo no sync existente):

1. Para cada `omie_clientes` com `user_id` (cliente) + `omie_codigo_vendedor`: resolve dono via `omie_vendedor_map` → upsert `carteira_assignments(customer_user_id, owner_user_id, source='omie', omie_account, omie_codigo_vendedor, last_synced_at=now())`.
2. `omie_clientes` com `user_id` mas vendedor `null`/não-mapeado → `source='hunter_orphan'`, `owner_user_id` = o Hunter.
3. Atualiza `last_synced_at`. Expor monitor de "sync velho" (ex.: aviso se `max(last_synced_at)` > 48h).

> **Match sem `account` em `omie_clientes`:** a tabela `omie_clientes` é chaveada por `user_id UNIQUE` e **não guarda `omie_account`** — ou seja, na hora do rebuild temos o `omie_codigo_vendedor`, mas não a conta de onde ele veio. Estratégia para a Fase 1: resolver **por código** contra o `omie_vendedor_map` ignorando a conta. Se um código resolver para **exatamente 1** vendedor → atribui. Se resolver para **2+** vendedores distintos (colisão real de código entre contas) → **não adivinha**: registra como conflito (log/relatório) e deixa o cliente sem dono primário até resolução manual. Com 3 vendedores a colisão é improvável. **Future hardening (fora do escopo da Fase 1):** adicionar coluna `omie_account` em `omie_clientes`, populada pelos syncs (`omie-sync`, `omie-vendas-sync`), e passar o match a usar a chave completa `(omie_account, omie_codigo_vendedor)`.

## Visibilidade (regra única do app)

Usuário `U` vê o cliente `X` se:

- `carteira_assignments.owner_user_id = U` (próprio), **OU**
- existe `carteira_coverage` com `covering_user_id = U`, `active`, `(valid_until IS NULL OR valid_until > now())`, e `covered_user_id = owner(X)` (cobertura), **OU**
- `U` é master.

Essa é a **única** regra de visibilidade de carteira, vivendo num só lugar (helper `SECURITY DEFINER`, ex.: `carteira_visivel_para(customer_user_id, uid)` ou um RPC `minha_carteira()` — **sem parâmetro de uid**, usa `auth.uid()` internamente pra evitar IDOR, já que SECURITY DEFINER bypassa RLS — que retorna os `customer_user_id` visíveis + flag `coberto_de` = dono original ou `null` se próprio).

## Cobertura (UI)

Tela enxuta (em `/settings` ou página admin de cobertura):

- Master ou o próprio dono coberto cria uma cobertura: `covering`, `covered`, `valid_until`.
- Lista as coberturas ativas; permite desativar.
- Na lista de sugestões, cliente vindo de cobertura entra **com selo "Cobertura — {nome}"**; se o cliente também for próprio, mostra só uma vez (dedupe, prioridade ao próprio).

## RLS

- `omie_vendedor_map`: SELECT staff; escrita só master/service-role.
- `carteira_assignments`: SELECT pela regra de visibilidade (helper `SECURITY DEFINER`); escrita só service-role (rebuild) + master.
- `carteira_coverage`: SELECT onde `covering_user_id = auth.uid()` OU `covered_user_id = auth.uid()` OU master; INSERT/UPDATE por master OU `covered_user_id = auth.uid()`.
- `customer_visit_scores` / `farmer_client_scores`: SELECT liberado pra staff (métrica de cliente, não é dado sensível de posse — posse agora vive na carteira). Mantém gate de staff existente.

## Frontend

- `useMyVisitSuggestions` e `useMyCarteiraScores` deixam de fazer `eq('farmer_id', user.id)`. Passam a:
  1. Buscar meus clientes visíveis via `minha_carteira()` (próprios + cobertura ativa), com flag de cobertura.
  2. Buscar scores por `customer_user_id IN (...)`.
  3. `pickDailyMix` como hoje (lógica de missões/mix inalterada).
- Selo de cobertura ("Cobertura — {nome}") vem da flag da carteira.
- A tela "Minha Carteira" usa a mesma fonte.

## Clientes ERP não-vinculados

Cliente que existe no Omie mas **não tem conta no app** (sem `customer_user_id`) não entra em sugestões hoje — nem entrava (limitação pré-existente, não nova). Em vez de sumir em silêncio, expor uma **contagem/relatório "não-vinculados"** pra o founder saber que existem. Vincular de fato (criar conta/stub) é **trabalho futuro, fora do escopo**.

## Camada de KPIs / Positivação (Fase 4)

> Decisão (2026-05-24): a camada de KPIs faz parte desta feature (consome a carteira) e entra como **Fase 4**. 2ª opinião do codex incorporada. KPI "Receita vs Meta" **fica fora por ora** (não há meta mensal por vendedor cadastrada) — adicionar quando houver meta.

### Positivação — definição canônica

> **% da carteira elegível que comprou ≥1 vez no mês comercial corrente.**

```
positivacao_mes = clientes_distintos_da_carteira_com_≥1_pedido_válido_no_mês
                  ÷ clientes_distintos_da_carteira_elegíveis
```

- **Janela:** mês calendário (MTD) — rotina/meta/comissão de distribuidora rodam por mês. Não usar 30d rolantes.
- **Denominador = carteira elegível:** `carteira_assignments` do vendedor com `eligible = true`. Exclui duplicado/atribuição-errada/não-comercial (master desmarca `eligible`). **Não** exclui cliente em risco/churn — esses são exatamente quem a positivação deve pressionar.
- **Numerador = "pedido válido":** pedido faturado/confirmado no mês (não cancelado), por `customer_user_id`. (Definir o status-filtro exato contra `orders`/`sales_orders` no plano.)

### Conjunto de KPIs (7 — "Receita vs Meta" adiado)

| KPI | Definição | Tipo | Pra quem |
|---|---|---|---|
| **Positivação MTD** | carteira elegível que comprou no mês ÷ carteira elegível | lagging | Farmer |
| **Clientes a Positivar** | carteira elegível com 0 pedidos no mês, ordenada por `revenue_potential`/`churn_risk`/`recover_score` | **leading** | Farmer |
| **Cobertura de Contato MTD** | carteira contatada (`farmer_calls`) ou visitada (`route_visits`) no mês ÷ elegível | leading | Farmer |
| **Recência Crítica** | nº de clientes da carteira com `days_since_last_purchase` acima da cadência esperada ou `churn_risk` alto | leading | Farmer |
| **Ticket Médio MTD** | receita MTD ÷ nº de clientes compradores no mês | lagging | ambos |
| **Mix / Gap de Cross-sell** | compradores do mês sem categoria-chave esperada (usa `order_items`/categorias) | leading | Farmer/Hunter |
| **Novos Clientes Positivados** | clientes órfãos/prospect com 1ª compra válida no mês | lagging | **Hunter** |

**A lista "Clientes a Positivar" é o coração da tela** — a % diz status, a lista diz o que fazer agora. Ela deve reaproveitar o `pickDailyMix`/scoring existente, filtrando por "0 pedidos no mês".

### Placement na tela de ligações (`FarmerCalls`)

- **Hero (topo), Farmer:** Positivação MTD · Clientes a Positivar · Cobertura de Contato MTD.
- **Hero (topo), Hunter:** Novos Clientes Positivados · Clientes a Positivar (pool órfão) · Recência Crítica.
- **Linha secundária:** Ticket Médio MTD · Mix/Gap · Recência Crítica (a que não estiver no hero).
- **Rebaixar pra secundário** os KPIs atuais (`calls_today`, `revenue_today`, `margin_today`, `avg_ticket_today`, `pending_link_count`) — são de atividade/operacional, não de progresso comercial. `pending_link_count` continua como tarefa de qualidade de dado, não KPI de venda.
- **Não** colocar na tela do vendedor (fica em visão de gestor): ranking entre vendedores, balanceamento de carteira, coortes de churn de longo prazo, benchmark de produtividade de ligação — distraem e induzem gaming mid-call.

### Vanity / armadilhas a evitar (codex)

`calls_today` como hero; `revenue_today` só-de-ligações como principal (atribuição incompleta — pedido via ERP sem ligação fica de fora); ticket/margem **diário** (amostra ruidosa); `pending_link_count` como KPI de venda; receita-de-carteira **sem** positivação (esconde perda de amplitude); cobertura **sem qualidade** (contatar muito sem pedido/próximo-passo não é sucesso).

### Snapshot mensal (decisão de modelo — provisionar agora)

Como a **posse muda no tempo**, calcular positivação histórica com a tabela de dono de *hoje* corrompe a tendência. Congelar cada mês fechado:

```sql
CREATE TABLE public.carteira_positivacao_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mes date NOT NULL,                       -- 1º dia do mês comercial
  customer_user_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,             -- dono NAQUELE mês (congelado)
  eligible boolean NOT NULL,
  had_order_in_month boolean NOT NULL,
  first_order_date_in_month date,
  revenue_month numeric,
  margin_month numeric,
  contacted_in_month boolean NOT NULL DEFAULT false,
  visited_in_month boolean NOT NULL DEFAULT false,
  days_since_last_purchase_at_month_start int,
  health_score_at_month_start numeric,
  churn_risk_at_month_start numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mes, customer_user_id)
);
```

- **KPIs do mês corrente:** computados **ao vivo** (carteira atual × `orders` × atividade MTD).
- **Meses anteriores:** lidos do snapshot (dono congelado, elegibilidade congelada).
- **Job:** cron mensal (fechamento do mês anterior) materializa o snapshot. Idempotente (upsert por `(mes, customer_user_id)`).

## Escopo e faseamento (para o writing-plans)

Tamanho médio. Faseamento sugerido para reduzir risco:

- ✅ **Sub-PR A — Posse (Fase 1, ENTREGUE PR #236):** `omie_vendedor_map` + `carteira_assignments` + `carteira_coverage` + `carteira-rebuild` + RLS + helper de visibilidade + seed do mapa. Em produção: 6908 clientes (Lucas 3434 / Regina 1890 / Tati 1584), cron ativo.
- **Sub-PR B — Carteira ativa (Fases 2+3 fundidas, Opção A):** o recalc (`scoring-recalc-batch`/`-client`, `visit-score-recalc-batch`/`-client`) passa a enumerar `carteira_assignments` (customer, owner) com `farmer_id = owner`, recomputando **todos** os clientes da carteira via **cursor/continuação**; teste anti-drift; leituras (`useMyVisitSuggestions`/`useMyCarteiraScores`) ganham expansão de cobertura (`farmer_id IN [eu, ...cobertos]`) + selo; **UI de cobertura**. Sem dropar `farmer_id` (ver seção de scores acima). Risco baixo, sem migração de dados destrutiva.
- **Sub-PR D — KPIs / Positivação (Fase 4):** `carteira_positivacao_snapshot` + helper puro de positivação/MTD (TDD) + hook de KPIs (estende/substitui `useMyKpis`) + revamp da tela `FarmerCalls` (heros por Farmer/Hunter, atuais rebaixados) + cron mensal de snapshot. "Receita vs Meta" fora (sem meta).

## YAGNI (cortado de propósito)

- **Sem CRM de território temporal/bitemporal.** A posse é **estado-atual** (uma linha por cliente). O `carteira_positivacao_snapshot` congela **fatos de KPI por mês** (pra tendência de positivação) — isso **não** é versionamento histórico de posse com intervalos de validade; não guardamos o "diário" de reatribuições, só a foto mensal.
- **"Receita vs Meta" adiado** — não há meta mensal por vendedor cadastrada (decisão 2026-05-24). Entra quando houver meta.
- Sem vinculação automática de clientes ERP sem conta (só relatório).
- Sem auto-distribuição de órfãos entre múltiplos Hunters (hoje 1 Hunter; regra de round-robin fica para quando houver 2+).

## Operacional (constraints do projeto)

- **DB só via Lovable** (SQL Editor). Migrations custom aplicadas manualmente, um bloco por mensagem, terminando em `SELECT '... OK' AS status`.
- **Edge functions** deployadas via chat do Lovable (ler `supabase/functions/<nome>/index.ts` verbatim do repo).
- TDD em helpers puros (`bun run test` / vitest é canônico) espelhados nas edge functions Deno, seguindo o padrão das ondas do financeiro e do PR-VISIT-INTELLIGENCE.

## Riscos conhecidos (do codex)

1. `omie_codigo_vendedor` não-único entre contas → resolvido por chave `(omie_account, omie_codigo_vendedor)`.
2. Vendedor com múltiplos códigos → suportado (N códigos → 1 user_id).
3. Clientes ERP sem conta no app → rastreados como não-vinculados (relatório), não silenciados.
4. Sobreposição de coberturas → múltiplas permitidas, dedupe na leitura, campos explícitos (`covering`/`covered`/`valid_until`/`created_by`).
5. Quem ativa cobertura → restrito a master ou dono coberto.
6. Lag de sync → `last_synced_at` + monitor; "posse ao vivo" não justifica enfraquecer o modelo.
