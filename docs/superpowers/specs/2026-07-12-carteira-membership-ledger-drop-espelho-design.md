# Carteira membership ledger — aposentar o espelho `omie_clientes` (P0-B-bis, fatia final) — design

> money-path (identidade de cliente + carteira de vendedor). Conduzido por Claude + `/codex consult` (gpt-5.6-sol, high) que **refutou** a 1ª recomendação (A′) — refutação verificada por leitura direta. Decisão registrada: `06f5d418`. Levantamento por psql-ro (prod) + 2 subagentes de classificação. Deploy PENDENTE do founder. `prove-sql PG17 + REVISÃO INDEPENDENTE DO DIFF (Codex) PENDENTES por fatia`.

## 1. Problema

`omie_clientes` é o espelho `user_id → omie_codigo_cliente`. `empresa_omie` é 100% o default mentiroso `'colacor'` (nenhum dos 6 writers a seta) — código físico é um MIX de contas Omie (oben bulk + colacor_sc manual). Épico P0-B-bis já migrou: syncPedidos (#1285), leitores de display (#1296), writer vendedor→proof (#1293), carteira-rebuild VENDEDOR (#1303). Falta aposentar o espelho de vez.

**A última dependência dura** é a **LISTA de membros** da carteira: `carteira-rebuild` faz `.from('omie_clientes').select('user_id')` ([carteira-rebuild:251](../../../supabase/functions/carteira-rebuild/index.ts)) — só o CONJUNTO de user_ids. Vendedor, alias e flaggeds já vêm de fontes account-corretas. A "proof" account-correta (`omie_customer_account_map`, opção C de uma rodada anterior) é **document-first**, e ~1633 "clones" (user_ids Omie sem `profiles.document`) nunca entram nela.

### Fatos medidos (psql-ro, produção, 2026-07-12)
- `omie_clientes`: **6909** user_ids distintos.
- `omie_customer_account_map` (proof): **5276** distintos (todos com document).
- `proof ∪ customer_canonical_alias(active)` = **6909** = 100% do espelho. Órfãos (só no espelho) = **0**. Aritmética: 5276 + 1633 clones (no alias) = 6909.
- Docs ambíguos (mesmo doc, 2+ users) HOJE = **0**. Aliases: 1633, todos `active`.

## 2. A decisão — opção D (não A′)

Três candidatos ao problema "de onde vem a lista": **A′** (view de união `proof∪alias` + guard de não-encolhimento), **B** (tabela dedicada acumuladora), **C** (popular clones na proof).

**A′ foi REFUTADA pelo Codex e a refutação foi VERIFICADA.** O mecanismo:
- O `carteira-rebuild` faz **upsert-only sem reconciliar ausentes** ([:357](../../../supabase/functions/carteira-rebuild/index.ts), `onConflict: 'customer_user_id'`, sem DELETE). A propriedade que o espelho garante não é "cardinalidade estável" — é **"todo membro já visto continua na entrada para ser reprocessado"**.
- Se um user some da entrada (ex.: doc vira ambíguo → sync o deleta da proof em [omie-analytics-sync:444](../../../supabase/functions/omie-analytics-sync/index.ts) → some da view A′), o rebuild não gera row para ele → **o assignment antigo `U→V` persiste STALE** (vendedor errado continua válido). Isso é o pior resultado money-path — pior que "encolher".
- O guard de cardinalidade não distingue quebra × ambiguidade × consolidação × substituição (mesma contagem, conjunto diferente). Bomba concreta e executável hoje: `mapaConsolidacao` re-executado não-dry-run rebaixa os 1633 aliases `active→inactive` de uma vez ([:1868](../../../supabase/functions/omie-analytics-sync/index.ts), dry_run default false).

**C** é pior (mistura semântica document-first, colide com `UNIQUE(codigo,account)`, delete-de-ambíguos persiste). **B** é conceitualmente correta (membership é fato durável; proof/alias são projeções revogáveis) mas o risco real é o big-bang de 6 writers.

**Opção D = B feita direito.** Ordem de preferência do Codex: **D > B > manter `omie_clientes` > A′ > C**.

## 3. Arquitetura

Separar 4 conceitos que hoje estão colapsados no espelho:

| conceito | natureza | onde vive |
|---|---|---|
| **membership** | fato histórico, **acumulador** (nunca encolhe) | `carteira_membership_ledger` (NOVO) |
| **identity_state** | mutável: `verified`/`ambiguous`/`inactive`/`conflict` | coluna no ledger |
| **eligible** | projeção operacional | `carteira_assignments` (já existe; setado no rebuild) |
| **vendedor** | account-correto | `omie_customer_account_map(_fresco)` (proof, já usada) |

### `carteira_membership_ledger` (tabela nova, aditiva)
- `user_id uuid PK → auth.users ON DELETE CASCADE`
- `identity_state text NOT NULL DEFAULT 'verified' CHECK (identity_state IN ('verified','ambiguous','inactive','conflict'))`
- `first_seen_at timestamptz NOT NULL` — a data REAL do vínculo (backfill copia `omie_clientes.created_at`, ~março; preserva o que `analytics-sync:1566` precisa e a proof não tem)
- `source text CHECK (source IN ('backfill','trigger','rpc'))`
- `updated_at timestamptz DEFAULT now()`
- RLS espelhando `omie_clientes`: Staff ALL (`has_role master|employee`), user SELECT próprio. Índice `(identity_state)`.

**Invariante central:** um user_id, uma vez no ledger, **nunca é removido** — transições de identidade mudam `identity_state`, nunca a presença. "Ausente da entrada" **nunca** é interpretado como revogação.

### Fluxo do rebuild (novo)
1. Lê **todos** os membros do ledger (acumulador → cobertura estável, sem depender do frescor de sync).
2. Para cada membro: vendedor via proof oben; alias via `customer_canonical_alias`; flaggeds via `cliente_classificacao`.
3. `identity_state ∈ {ambiguous,conflict}` → **quarantined**: vendedor removido, `eligible=false`, membro preservado, **zero comissão** (transição correta do Codex para doc-ambíguo).
4. Reconcilia: todo membro do ledger → uma row em `carteira_assignments`.

### Quem seta `identity_state`
- backfill/trigger → `verified` (default).
- sync que deleta da proof por ambiguidade ([analytics-sync:444](../../../supabase/functions/omie-analytics-sync/index.ts)) → `ambiguous` no ledger (em vez de o user sumir).
- `mapaConsolidacao` alias `inactive`/`conflict` → reflete no ledger do clone.

## 4. Levantamento — 17 sítios de CÓDIGO (classificados; ruído de tipos/comentários/UI excluído)

> ⚠️ Esta seção varreu **apenas o repo** (edges + frontend). Objetos SQL criados no SQL Editor não aparecem num `grep` — estão na **§4-bis**, levantada depois.

### 🔴 ESCRITORES — 6 pontuais (migram p/ RPC `register_carteira_member` na Fatia 4) + 1 bulk (§9)
| sítio | fluxo | nota |
|---|---|---|
| `Auth.tsx:133` | signup (frontend direto) | grava `omie_codigo_cliente_integracao` (proof não tem) |
| `AdminApprovals.tsx:113` | aprovação (frontend direto) | gate-leitor `:92` (`already_linked`) é par indivisível |
| `omie-cliente:654` | `criar_perfil_local` (match doc) | fluxo de pedido |
| `omie-cliente:705` | `criar_perfil_local` (placeholder novo) | |
| `omie-cliente:829` | `sync_all_clients` (import massa) | único que grava `..._integracao` |
| `omie-sync:371` | write-back self-service | já anotado `TODO Fatia 4` |
| *(bulk)* `analytics-sync:468` | bulk oben (`account='vendas'`) | o principal; já popula a proof em `:482` |

### ⭐ Leitor da LISTA (o coração) → migra p/ ledger
- `carteira-rebuild:251`

### 🟡 Leitores de código/vendedor → migram p/ proof
- **6 OBEN (troca mecânica `.eq('account','oben')`, baixo risco):** `useBuscaClienteOmie:35/78`, `useCustomerSelection:209/247`, `FarmerCalls:213/312`
- **money-path pedido (JÁ neutralizados — filtram `empresa_omie` que nunca é real → retornam `[]` → fallback API):** `omie-vendas-sync:1751/2441`, `useUnifiedOrder:516/562`
- **edges:** `omie-cliente:627/750/909`, `ai-ops-agent:250` (vendedor), `analytics-sync:238/550/1566` (auto-consumo; `:1566` precisa de `created_at` → coberto pelo ledger)
- **JÁ migrado (não bloqueia):** `SalesPrintDashboard:215` (via view fresca)

## 4-bis. Objetos SQL NO BANCO — a classe que o grep do repo não vê (medido 2026-07-18)

> O inventário §4 varreu só **código** (edges + frontend). Função/view criada direto no SQL Editor do Lovable **não tem `CREATE` no repo** (`database.md` §3: ~210 objetos assim) → invisível a `grep`. Levantado no `/codex` challenge de 2026-07-17 (PR #1399) e **re-medido/CORRIGIDO** por psql-ro em 18/07. Varredura canônica agora versionada: [`db/preflight-dependencia-tabela.sql`](../../../db/preflight-dependencia-tabela.sql) (regra em `database.md` §5).

### ⚠️ A query `ilike '%omie_clientes%'` produz 3 FALSOS POSITIVOS
`omie_clientes` é **prefixo** de `omie_clientes_nao_vinculados` — tabela **diferente**, que sobrevive ao DROP. Use word-boundary: `~* '\momie_clientes\M'`.

| falso positivo | o que realmente toca |
|---|---|
| `finalize_nao_vinculados_snapshot` | só `omie_clientes_nao_vinculados` |
| `radar_recruzar_ja_cliente` | só `omie_clientes_nao_vinculados` |
| `v_clientes_nao_vinculados_atual` (view) | só `omie_clientes_nao_vinculados` |

→ o cron `nao-vinculados-refresh-diario` (30 8) **NÃO** depende de `omie_clientes`. Falsificação: rodando o preflight nos dois alvos, cada objeto aparece em **exatamente um** — bloqueadores reais são **3, não 6**.

### Os 3 bloqueadores reais + destino

| objeto | como usa hoje | destino | por quê |
|---|---|---|---|
| `_data_health_compute` | `max(omie_clientes.updated_at)` no check `vendas_cadastros` | **MIGRA → `omie_customer_account_map` (proof)** | o check mede **frescor de SYNC de cadastro**; a proof é escrita pelo mesmo bulk (`analytics-sync:468/482`) e está **mais fresca** que o espelho (05:40 × 05:02 em 18/07) |
| `seed_targets_faltantes` | `FROM omie_clientes` — universo do seed de `farmer_client_scores` | **MIGRA → `carteira_membership_ledger`** | é a **LISTA de membros**, exatamente o que o ledger passou a ser. Paridade medida: **6909 = 6909, diferença simétrica 0** |
| `omie_cliente_upsert_mapping` | writer (INSERT no espelho) | **APOSENTA JUNTO (`DROP FUNCTION`)** | **órfã**: zero chamador vivo; o único hit no código é o invariante que a **PROÍBE** (`edge-money-path-invariants.test.ts:281` — "backfill voltou … bloqueia o pedido"). **Não** é um dos 6 writers da Fatia 4 — é resíduo do P0-B (2026-07-05) já desarmado |

### Cai junto no DROP (correto, não bloqueia)
`trg_omie_clientes_to_ledger` (Fatia 0) · `update_omie_clientes_updated_at` · 2 índices · 2 policies · pkey/unique/check/defaults. `pg_depend` confirma: **todo objeto com `refobjid=omie_clientes` é da própria tabela**; zero externo.

### Medido ZERO (nenhum bloqueador escondido)
views/matviews · RLS policy em **outra** tabela · cron com SQL **inline** · FK entrante (`confrelid`) · constraint/default/índice-expressão externos.

### ⚠️ O ledger NÃO serve como fonte de frescor
`carteira_membership_ledger.updated_at` está **congelado há 5 dias** (18/07: max = 13/07 23:05) — é **acumulador**: `updated_at` só anda em transição de `identity_state`, e a Fatia 2 nem rodou. Migrar o check `vendas_cadastros` para o ledger deixaria o Sentinela **vermelho permanente**. Frescor-de-sync e membership-histórica são perguntas diferentes → fontes diferentes (**proof** × **ledger**).

### Risco de ordem / raio de explosão
- **`_data_health_compute` é `LANGUAGE sql` com um ÚNICO `UNION ALL`:** se `omie_clientes` some, a função **inteira** falha — não o check isolado. É **blackout dos 24 checks** do Sentinela, não degradação de um. Consumida por 2 crons (`data-health-watchdog` `*/30` e `fin-sync-heartbeat`), **ambos** com `vendas_cadastros` no IN-list.
- **É função QUENTE:** 5 migrations recentes, a última de **ontem** (`20260717160000`). `CREATE OR REPLACE` sem pré-flight `pg_get_functiondef` da PROD reverte trabalho de outra sessão (a última a recriar vence). Prod × repo conferidos em 18/07: **alinhados, 24 checks idênticos**.
- **`seed_targets_faltantes` é fail-closed** por design (`throw` em `calculate-scores:301`) → o DROP **para** o seed do scoring (cron `daily-calculate-scores` 0 6), não corrompe dado. Tem prova PG17 própria (`db/test-seed-targets-faltantes.sh`) — estender, não recriar.
- **O espelho ainda recebe escrita:** 5239 linhas em 18/07. A Fatia 4 não começou; o DROP está a **2 fatias** de distância.

### Ordem revisada da Fatia 5
1. `CREATE OR REPLACE _data_health_compute` (pré-flight `pg_get_functiondef` da PROD) — `vendas_cadastros` → proof.
2. `CREATE OR REPLACE seed_targets_faltantes` — `FROM carteira_membership_ledger`. **Paridade sem filtro de `identity_state`**: o quarantine governa vendedor/comissão, não a existência de score — mudar isso é escopo da Fatia 2, não da 5.
3. `DROP FUNCTION public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint)`.
4. **Só então** `DROP TABLE omie_clientes` + regenerar `types.ts`.
5. **prove-sql PG17 com falsificação** nos passos 1-2 (sabotar → exigir vermelho) + re-rodar o preflight exigindo **zero** linhas acionáveis.

## 4-ter. As 2 funções de CLONE — bloqueio DISSOLVIDO por deleção (PR-C, 2026-07-18)

> A PR-B escalou um bloqueio: `fetchAlvosSemProfile` + `fetchOmieCodigoPorUser` operam sobre os CLONES (user sem profile) e não podiam migrar para a proof — migrá-las zeraria `syncBackfillCadastro` e `mapaConsolidacao` em silêncio. **As duas premissas do bloqueio eram falsas.**

### Premissa falsa 1 — "só o espelho tem o par (clone → código)"
`customer_canonical_alias.alias_omie_codigo` tem o par; o ledger tem a data. Paridade medida em prod (18/07), sobre a tripla `(user_id, código, created_at/first_seen_at)`:

| fonte | linhas | só nela | só na outra |
|---|---|---|---|
| `omie_clientes` (espelho, hoje) | 1.633 | — | — |
| `carteira_membership_ledger ⋈ customer_canonical_alias` | **1.633** | **0** | **0** |

### Premissa falsa 2 — "existem 2 processos ativos que dependem delas"
Nenhuma tinha cron (**0 de 82**) nem chamador de UI. Rodaram **1× cada**, em jun/2026, e o `sync_state` guarda o desfecho.

### Por que DELETAR e não migrar
- **`syncBackfillCadastro` inseria 0 permanentemente.** Telemetria do único run (12/06): `alvos_total=1633` → `doc_em_outro_profile=1633` → `seriam_inseridos=0`. O gêmeo bloqueia por documento, e dar profile ao clone é **proibido** pela [spec da consolidação](2026-06-13-consolidacao-clientes-duplicados-design.md) (criaria 2 entradas para o mesmo cliente).
- **`mapaConsolidacao` era uma bomba armada.** Gravava `status:'inactive'` **fixo**, com `dry_run` default **false** — re-executá-la é, verbatim, o rollback da B-lite que o spec documenta (*"`update customer_canonical_alias set status='inactive'` + rodar o rebuild"*): rebaixaria os **1.633 aliases `active`** de uma vez. Já constava como "bomba concreta e executável hoje" no §2 deste design.
- **Migrar o mapa para o alias seria circular:** ele existe para *produzir* aliases; lê-los para achar clones só reencontraria os 1.633 que ele mesmo criou — para rebaixá-los.

### O que a deleção NÃO fecha (importante)
- **A canonicalização completa segue decisão legítima de produto** (`database.md` §clones, corrigido pelo `/codex challenge` #1399). Ela consome `customer_canonical_alias` como **ENTRADA** — e o `mapaConsolidacao` era o único capaz de destruí-la. **Deletar protege esse follow-up.**
- **Dano ativo medido (18/07):** **1.459 clones** têm `farmer_client_scores` + `customer_visit_scores` realimentados por cron diário (mais fresco: 06:00 do dia). `eligible` é convenção, não fronteira: scoring/agenda/RLS não filtram. Escopo próprio — **não** bloqueia a Fatia 5.
- **A Fatia 2 não depende delas:** o estado dos aliases vive na TABELA, não na função que a gerou.

### Escopo da PR-C
2 funções + 2 helpers de suporte (`fetchProfileDocNameMap`, `inserirProfilesComFallback`) + os puros `normalizarDocumento`/`cpf|cnpjDvValido`/`montarTelefone`/`decidirLinhaProfile` + as 2 actions do switch + `dry_run|limite|batch_id` do body + o helper espelhado `src/lib/clientes-cadastro/`. `fetchAllProfileDocs` **fica** (usada por `syncNaoVinculados`). Verificado por varredura de símbolos: nenhum escapa do bloco. Canário: `.toBe(4)` → **`.toBe(2)`** + guard `not.toContain` nos 5 símbolos, **falsificado** (reintroduzir a função → vermelho com a mensagem certa).

## 5. Fatiamento (multi-PR, aditivo → cada passo fail-safe)

- **Fatia 0 — fundação (migration):** cria `carteira_membership_ledger` + backfill dos 6909 (com `first_seen_at`=`omie_clientes.created_at`) + trigger `AFTER INSERT` em `omie_clientes` (`ON CONFLICT DO NOTHING`, `source='trigger'`). O trigger cobre os 6 writers **sem tocá-los** durante a transição. **prove-sql PG17** (CREATE + RLS sob `SET ROLE` + trigger + falsificação).
- **Fatia 1 — rebuild lê o ledger:** `carteira-rebuild:251` → ledger; reconcilia `identity_state`→eligible/quarantined; vendedor da proof. **prove-sql** (paridade do helper `rebuild-helpers` + guard). Fecha a decisão-chave.
- **Fatia 2 — popular `identity_state`:** sync marca `ambiguous` no ledger ao deletar da proof (`:444`); `mapaConsolidacao` reflete `inactive`/`conflict`. Torna o `quarantined` real. **Independente da Fatia 1:** até rodar, todos ficam `verified` (default) → rebuild = comportamento de hoje; a Fatia 2 só ATIVA o quarantine (aditivo, fail-safe).
- **Fatia 3 — migrar leitores de código → proof:** 6 OBEN + edges. Baixo risco (já degradados). Frontend Publish + edges.
  - **PR-C — as 2 funções de CLONE: DELETADAS, não migradas** (ver §4-ter). Fecha o bloqueio escalado na PR-B.
- **Fatia 4 — migrar 6 writers → RPC `register_carteira_member`:** escreve ledger (membership) + proof (`source='manual'` p/ o código account-correto) e **para** de escrever o espelho. Ordem: leitores antes dos writers; gate `AdminApprovals:92` casa com seu writer `:113`.
- **Fatia 5 — DROP:** removido o último leitor/escritor e o trigger ocioso → migrar os **3 objetos SQL do banco** (§4-bis: `_data_health_compute` → proof, `seed_targets_faltantes` → ledger, `DROP` da órfã `omie_cliente_upsert_mapping`) → `DROP TABLE omie_clientes` + regenerar `types.ts`. **prove-sql PG17 + lovable-db-operator**. Ordem detalhada e raio de explosão em **§4-bis**.

## 6. Invariantes / error handling
- Ledger **nunca** perde membro (acumulador). "Ausente" ≠ revogação.
- Doc ambíguo → `quarantined` (vendedor null, eligible=false, membro vivo, zero comissão) — **não** remove da lista, **não** deixa vendedor stale.
- Todo passo é aditivo: ledger/coluna vazios → consumidores degradam como hoje (fail-safe).
- Trigger + backfill cobrem 100% durante a transição; só a Fatia 4 desacopla os writers; só a Fatia 5 dropa.

## 7. Testing (prove-sql PG17, por fatia money-path/DDL)
- Fatia 0: CREATE real + RLS sob `SET ROLE authenticated` + GUC; backfill preserva `first_seen_at`; trigger idempotente (`ON CONFLICT`); falsificação (sabotar CHECK/trigger → exigir vermelho).
- Fatia 1: paridade `computeCarteira` edge×`src/lib/carteira/rebuild-helpers.ts`; asserts +/- do quarantined; guard de baseline preservado.
- Fatia 4/5: RPC prova positiva+negativa; DROP só após grep zero de leitor/escritor.

## 8. Deploy (ordem, por fatia)
Migration (SQL Editor) → edge (chat Lovable, verbatim) → rodar/backfill → validar (psql-ro: cobertura, 0 ambiguidade) → Publish frontend. Cada fatia é PR próprio (auto-merge no CI verde). Épico QUENTE: coordenar com `omie-identidade` (A1 #1298 / A2) e `carteira-vendedor-oben-hardening` antes de tocar `omie-analytics-sync` / `carteira-rebuild`.

## 9. Resíduos conhecidos
- ~~`omie_codigo_cliente_integracao`~~ **RESOLVIDO na Fatia 4: DESCARTADO.** Medição (psql-ro 18/07): 41 linhas de 6909 o tinham, **todas de março**, e nenhum leitor o consome. A proof **não** ganha a coluna.
- ~~`analytics-sync:468` (bulk oben) … pode ser o último a largar o espelho~~ **ENTROU na Fatia 4** — ver §10.

## 10. O que a Fatia 4 mediu e corrigiu no plano (2026-07-18)

Três premissas da §4 não sobreviveram à medição em produção. Registrado aqui porque a Fatia 5 depende disso.

**(a) `Auth.tsx:133` era writer MORTO — removido, não migrado.** Zero das 6909 linhas do espelho têm a assinatura `APP_%` que só ele produzia. A RLS de `omie_clientes` concede `ALL` apenas a staff (`has_role master|employee`) e quem executa o signup é o cliente recém-criado; o `insert` não checava `error` → falha silenciosa desde março. **Migrá-lo teria exigido `SECURITY DEFINER`, ABRINDO uma escrita que a RLS hoje fecha** (um customer poderia anexar-se a um código Omie arbitrário). É a falha ABERTA do CLAUDE.md: muda autorização e não comportamento, e o CI não vê. Por isso a RPC ficou **`SECURITY INVOKER`** — `service_role` (edges) bypassa RLS, staff (`AdminApprovals`) já tem `ALL` nas duas tabelas, e a autorização permanece idêntica à de hoje **sem gate custom**.

**(b) Os 6 writers pontuais estavam inertes; o bulk era o único vivo.** Último `INSERT` no espelho: **25/05** (1 linha); antes, 10/04 (1 linha) — dois em quatro meses. As 5239 escritas diárias batem 1:1 com `count(account='oben')` na proof: são o bulk `analytics-sync`. **Consequência:** migrar só os 6 pontuais não faria a escrita cessar nem destravaria a Fatia 5 — o bulk **entrou no escopo da Fatia 4**. Ele agora alimenta o ledger em massa (não pela RPC: 5239 chamadas seria o N+1 proibido em enumeração pesada), pela lista **code-first**, que cobre os ~1633 aliases fiscais que a proof document-first nunca vê. Usar a document-first **encolheria a membership** — exatamente o que a opção D existe para impedir.

**(c) ⚠️ A admissão de membro novo morreria no DROP — o design não cobria isto.** O ledger tem 6909 linhas, **todas `source='backfill'`**: zero `trigger`. A única via de entrada de membro novo era o trigger `AFTER INSERT` em `omie_clientes` (Fatia 0) — e nem o bulk o dispara, porque faz *upsert* (UPDATE, não INSERT). Quando a Fatia 5 dropar o espelho, **o trigger cai junto**: sem a RPC e sem o bulk escrevendo o ledger direto, nenhum cliente novo jamais entraria na carteira — sem vendedor, sem comissão, silenciosamente. **A Fatia 5 deve confirmar por psql-ro que `source IN ('rpc','sync')` aparece no ledger ANTES de dropar** — é a prova de que a via nova está viva. → **GATE CUMPRIDO em 18/07 19:39** (§11): `source='rpc'` = 91 linhas.

**(d) Correção de fato na baseline de invariantes.** O comentário de `edge-money-path-invariants.test.ts` afirmava que a leitura `analytics-sync:240` (`fetchOmieClienteUserMap`) era "par indivisível do writer e morre junto com ele na Fatia 4". **Não morreu:** `userByCodigo` também chaveia `tagsByUser` e a própria lista code-first que agora alimenta o ledger. Trocá-la pela proof document-first ENCOLHERIA a membership (a code-first cobre os ~1633 aliases fiscais).

**(e) O #1420 (PR-C) refutou o bloqueio que esta spec registrava.** A §4-bis dava as 2 funções de clone (`fetchAlvosSemProfile`/`fetchOmieCodigoPorUser`) como dependência dura do espelho, sob o argumento "só o espelho tem o par (clone→código)". **Era falso:** `customer_canonical_alias.alias_omie_codigo` tem o par e o ledger tem a data (paridade medida: 1.633, diferença simétrica 0). Elas foram **DELETADAS**, não migradas — eram invocáveis-bomba, não capacidade viva. Somando a deleção delas com o writer que a Fatia 4 removeu, o `omie-analytics-sync` foi de **4 → 1** leitura de `omie_clientes`: sobra só a `:240`, e **nenhuma escrita em edge nenhuma**.

## 11. Confirmação em PRODUÇÃO da Fatia 4 (2026-07-18, pós-deploy)

Deploy das 3 camadas verificado; a prova de comportamento (N3) veio de um `sync_all_clients` disparado à mão em `/admin/analytics-sync`, observado ao vivo por psql-ro. Em ~5 min o import trouxe **41 clientes novos**:

| tabela | antes | depois | leitura |
|---|---|---|---|
| `omie_clientes` (espelho) | 6909 · `05:02:40` | 6909 · **`05:02:40`** | **não se moveu** — o writer morreu |
| `omie_customer_account_map` | 15663 | 15704 (+41) | `source='manual'`, `oben`=73 · `colacor_sc`=20 |
| `carteira_membership_ledger` | 6909 (só `backfill`) | 6950 (+41) | **`source='rpc'` = 91** |
| `addresses` | 6104 | 6145 (+41) | lockstep — 1 endereço por cliente |

O teste é **discriminante**, não prova por ausência: os três destinos avançaram em lockstep enquanto o espelho ficou parado. "Nada aconteceu" está descartado (41 clientes entraram) e "edge velha" também (o espelho teria avançado).

**Detalhe que fecha o argumento:** a proof recebeu os slugs **canônicos** (`oben`/`colacor_sc`). Se o código estivesse passando o slug INTERNO do sync (`'vendas'`/`'servicos'`), o `CHECK chk_ocam_account` teria levantado `23514` e as linhas não existiriam — é o assert A6 do harness PG17 confirmado em produção.

**Ainda não observado:** `source='sync'` (o bulk). Ele só insere quando o cron `sync-customers-vendas-daily` (`0 5 * * *`) encontrar cliente novo que a RPC não pegou. Vale reconfirmar após o próximo run que `omie_clientes.updated_at` segue travado em `2026-07-18 05:02:40`.

## 11-bis. O `/codex` retroativo REFUTOU a Fatia 4 — 4 achados, 3 corrigidos no mesmo dia

O challenge adversarial (gpt-5.6-sol xhigh) rodou **depois** do deploy, quando a cota voltou, e achou 4 defeitos reais. Todos verificados por leitura direta antes de aceitos. Dano consumado era **zero** (0 docs ambíguos, 0 colisões), mas três eram dívida money-path com gatilho plausível. Lição de método: **o PG17 provou a RPC ISOLADA e ela estava correta — o que faltava era o sistema em volta dela.** Auto-prova cobre o intervalo, não substitui revisão independente.

| # | defeito | correção |
|---|---|---|
| **A** | `source='manual'` na proof dava **imunidade** ao delete de ambiguidade (que escopa `document` para preservar override humano). 393 linhas já gravadas ficavam fora do fail-closed — vínculo suspeito sobreviveria com vendedor possivelmente errado. **O aviso estava escrito em `db/omie_customer_account_map_fresco.sql`** ("se surgir 2º writer… promover `last_seen_sync_at`") e a Fatia 4 criou esse writer sem ler | `source='rpc'` (novo no CHECK) + `'rpc'` no filtro do delete + backfill das 393. O `ON CONFLICT` preserva `'manual'` de override humano |
| **B** | `criar_perfil_local` devolvia `user_id` de **sucesso** mesmo com `23505` — a UI anexaria ferramenta ao cliente errado. Tratamento herdado de quando o destino era o espelho, onde o erro era inócuo | fail-loud nos 2 ramos (HTTP 409, mensagem nomeando o código) |
| **C** | o bulk admitia membro novo pela lista **code-first**, que resolve por `userByCodigo` — o espelho poluído **sem conta**, que ainda vence o documento. Meu argumento ("cobre os 1633 aliases") confundiu cobertura de ESTOQUE (já garantida pelo backfill; o acumulador não encolhe) com correção de FLUXO | ledger passa a ser alimentado pela **document-first** (`accountMapByUser`) |
| **D** | race entre marcação e reversão de `ambiguous` (2 chamadas PostgREST independentes, sem single-flight): um run antigo pode reverter evidência mais nova. **Pré-existente da Fatia 2**, não introduzido aqui | **não corrigido** — precisa de lease por conta com fencing token. Fatia própria |

**Resíduo aceito conscientemente:** `updated_at`. A view `_fresco` define o campo como "última vez que o SYNC viu a linha", e a RPC também o escreve → renova o TTL de 7d sem o sync ter visto. Com `source='rpc'` a imunidade acaba e o dano money-path some; resta imprecisão de frescor. A correção completa (`last_seen_sync_at` atualizado só pelo sync) mexe na view e nos seus 2 consumidores — raio grande demais para o hotfix.

### Estado dos 3 bloqueadores da §4-bis (medido 18/07 pós-deploy)

| bloqueador | estado | ação da Fatia 5 |
|---|---|---|
| `omie_cliente_upsert_mapping` | **já DROPADA** (#1409) | nada — item cumprido |
| `_data_health_compute` | ainda referencia `omie_clientes` | `CREATE OR REPLACE` → proof (pré-flight `pg_get_functiondef` da PROD: função QUENTE) |
| `seed_targets_faltantes` | ainda referencia `omie_clientes` | `CREATE OR REPLACE` → ledger |

⚠️ **A paridade mudou e a Fatia 5 precisa saber:** ledger = **7151** × espelho = **6909**, com `só-no-espelho = 0`. O ledger deixou de ser igual ao espelho e virou um **superset** — ganhou os membros que a RPC admitiu depois do deploy. Isso é o acumulador funcionando como projetado, **não** divergência. Consequência prática: migrar `seed_targets_faltantes` para o ledger **aumenta** o universo do seed (7151 > 6909). O critério de aceite da Fatia 5 é `só-no-espelho = 0` (nenhum membro perdido), **não** contagem igual — exigir igualdade reprovaria o comportamento correto.
