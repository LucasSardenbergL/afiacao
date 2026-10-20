# Venda por cliente — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** colocar o dia da farmer dentro do app — lista de quem ligar (recompra atrasada), ficha da ligação (recomprar · oferecer · preço aprovado), desfecho em 1 toque — com cada sugestão identificada e casada automaticamente com o pedido do Omie.

**Architecture:** tudo que decide fica no **servidor** (Postgres: funções SQL + crons), e a UI só lê RPCs. Uma tabela-espinha (`venda_sugestao`) registra cada sugestão com `fase` (`historico` | `sombra` | `ativa`); um job fecha o desfecho contra `order_items ⋈ sales_orders`. A UX reaproveita a Fila do Dia (`lib/fila`) com um adapter novo e promove o `FilaContextPanel` a ficha da ligação.

**Tech Stack:** Postgres/Supabase (SQL, `pg_cron`), edge Deno (`calculate-scores`), React 18 + TS strict + react-query + shadcn, vitest, harness PG17 `db/test-*.sh`.

**Spec:** `docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md` (aprovado 2026-10-20). Leia o spec antes de qualquer task; este plano só fixa nomes, interfaces, testes e ordem.

## Global Constraints

- Idioma: código, rotas, commits, PRs e textos de UI em **pt-BR**.
- **Comprador** = `customer_user_id` canônico: alias resolvido por `customer_canonical_alias(alias_user_id → canonical_user_id, status='active')`. Oben e Colacor do mesmo CNPJ já são o mesmo `customer_user_id`, separados por `sales_orders.account`.
- **Fonte de itens:** `order_items ⋈ sales_orders`, `sales_orders.deleted_at IS NULL`, status de venda = o universo de `src/lib/farmer/universo-pedidos.ts` (exclui `cancelado`, `rascunho`, `pendente`, `orcamento`); data do pedido = `COALESCE(order_date_kpi, (created_at AT TIME ZONE 'America/Sao_Paulo')::date)`.
- **Ausente ≠ zero:** valor/preço/intervalo sem base → `NULL`, nunca `0`. Desfecho tem 3 estados: `virou_pedido` | `nao_virou` | `nao_medivel`.
- **Farmer nunca vê custo.** Qualquer RPC que a farmer chama não devolve `cmc`, custo, markup nem `piso_*`; o gate de custo é `private.cap_custo_ler(auth.uid())`.
- **IA não precifica:** nenhum preço sai de LLM.
- **M-41:** nenhuma rota `/rota`, `/telefonia`, `/whatsapp`, `/tarefas` volta; `route_schedule` é só **lida** no SQL; a ficha usa `tel:`, nunca `BotaoLigar`/`CallButton`/WebRTC.
- **Migrations:** nome `supabase/migrations/YYYYMMDDHHMMSS_<slug>.sql` (Lovable **não** auto-aplica custom) — idempotente, `BEGIN; … COMMIT;`, bloco `DO $post$` de postcondição testado antes, query de validação no PR, nota "⚠️ migration manual", `bun run audit:migrations`. Use a skill `lovable-db-operator`. Funções novas: `REVOKE … FROM PUBLIC, anon` (provado por `has_function_privilege`), `SET search_path`, gate na fronteira. Tabela nova **sempre** com RLS. `DROP FUNCTION`+`CREATE` reseta ACL → reemitir REVOKE.
- **Teste SQL** executa a função (PL/pgSQL é late-bound) no harness PG17 `db/test-*.sh`, `-v ON_ERROR_STOP=1` + marcador positivo de fim; negativo captura a SQLSTATE esperada (nunca `WHEN OTHERS`); falsificar nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`) depois de commitar.
- **Cron** com `net.http_post` exige `timeout_milliseconds` explícito. Ordem noturna (UTC): `calculate-scores` 06:00/06:25 → `carteira-rebuild` 07:30 → recompra **07:50** → gerador **08:15** → desfecho **09:30**.
- Arquivo novo em `src/` tem dono em `src/lib/modulos/manifesto.ts` → módulo `farmer-inteligencia` (pastas novas `src/lib/venda-cliente/**`, `src/components/venda-cliente/**`).
- Sensores de UI pelo **ledger** (`registrarNoLedger` de `src/lib/analytics-ledger.ts`), eventos `venda.<acao>`.
- Janelas de desfecho: recompra **14 dias**, complemento **30 dias**, preço **30 dias**. Atrasado = `due_ratio ≥ 1,5`. Recompra exige **≥ 3 pedidos** do SKU em **540 dias**. Perdido = sem compra há mais que `max(3 × intervalo, 365)` dias. Teto "maiores atrasos" fora das cidades de amanhã = **10 por farmer/dia** (configurável).
- Gerador roda só para donos com `commercial_roles.commercial_role = 'farmer'`.
- Merge ≠ produção: cada PR declara as camadas (migration · edge · Publish) e quem faz cada uma.

## Review Focus

1. **Pedido feito no cadastro alias** — conta para o comprador canônico (recompra, situação e desfecho). Teste em Task 2 e Task 4.
2. **Sync de vendas atrasado na janela** — o desfecho vira `nao_medivel` (motivo `sync_atrasado`), nunca `nao_virou`. Teste em Task 1.
3. **Reconstrução olhando o futuro** — `venda_recompra_em(d)` ignora pedidos com data ≥ `d`. Teste em Task 2.
4. **Farmer lendo o que não é dela** — sugestões de outra farmer, linhas `historico`/`sombra`, ou custo via RPC de preço → negado/ausente. Testes em Task 1 e Task 6.
5. **Gerador rodando 2× no mesmo dia** — não duplica linhas (chave única). Teste em Task 4.

---

## Mapa de entregas (1 entrega = 1 sessão = 1 PR)

| Task | Entrega | Depende de | Pode rodar em paralelo com |
|---|---|---|---|
| 1 | Espinha: `venda_sugestao`, contato, config, desfecho | — | 2, 3, 5 |
| 2 | Recompra cliente × SKU + situação (SQL) | — | 1, 3, 5 |
| 3 | `calculate-scores`: intervalo real, frequência nula | — | 1, 2, 5 |
| 4 | Gerador D-1 + reconstrução histórica + sombra | 1, 2 | 5, 6 |
| 5 | Complemento por comprador | — | 1, 2, 3, 4 |
| 6 | Repasse de preço (money-path) | 2 | 4, 5 |
| 7 | Painel de adoção do founder (UI) | 1, 4 | 8 |
| 8 | Meu Dia + ficha + desfecho (UX, Onda 1) | 1, 2, 4 | 7 |
| 9 | Seções "Oferecer também" e "Preço" na ficha (Ondas 2–3) | 5, 6, 8 | — |

---

### Task 1: Espinha — sugestão com identidade, contato e desfecho automático

**Files:**
- Create: `supabase/migrations/<ts>_venda_cliente_espinha.sql`
- Create: `db/test-venda-espinha.sh`
- Modify: `src/integrations/supabase/types.ts` (tipos gerados das tabelas/RPCs novas)

**Interfaces:**
- Produces (tabelas):
  - `venda_config(chave text PK, valor jsonb NOT NULL, atualizado_em timestamptz)` — seeds: `onda_recompra` `false`, `onda_complemento` `false`, `onda_preco` `false`, `teto_maiores_atrasos` `10`, `janela_dias` `{"recompra":14,"complemento":30,"preco":30}`.
  - `venda_sugestao(id uuid PK, tipo text CHECK in ('recompra','complemento','preco'), fase text CHECK in ('historico','sombra','ativa'), dia_referencia date, gerada_em timestamptz, farmer_user_id uuid, comprador_id uuid, empresa text CHECK in ('oben','colacor','colacor_sc'), omie_codigo_produto bigint NULL, familia text NULL, qtd_ref numeric NULL, valor_ref numeric NULL, preco_alvo numeric NULL, motivo_entrada text, mostrada_em timestamptz NULL, desfecho text NULL CHECK in ('virou_pedido','nao_virou','nao_medivel'), desfecho_motivo text NULL, sales_order_id uuid NULL, valor_realizado numeric NULL, avaliado_em timestamptz NULL)` + `UNIQUE (dia_referencia, farmer_user_id, comprador_id, tipo, empresa, COALESCE(omie_codigo_produto,0), COALESCE(familia,''), fase)` (índice único por expressão).
  - `venda_contato(id uuid PK, farmer_user_id uuid, comprador_id uuid, dia date, resultado text CHECK in ('vendeu','vai_pedir','sem_interesse','nao_atendeu'), motivo text NULL, criado_em timestamptz)` + `UNIQUE (farmer_user_id, comprador_id, dia)` (último toque do dia vence via upsert).
- Produces (RPCs, `SECURITY DEFINER`, `authenticated`):
  - `venda_minhas_sugestoes(p_dia date DEFAULT current_date) RETURNS jsonb` — só `fase='ativa'` e `farmer_user_id = auth.uid()`; formato `{"dia": date, "compradores": [{"comprador_id","nome","telefone","motivo_entrada","valor_ref_total","sugestoes":[{"id","tipo","empresa","omie_codigo_produto","descricao","familia","qtd_ref","valor_ref","preco_alvo"}]}]}`.
  - `venda_marcar_mostrada(p_ids uuid[]) RETURNS int` — só linhas da própria farmer; primeira marcação vence (`COALESCE(mostrada_em, now())`).
  - `venda_registrar_contato(p_comprador uuid, p_resultado text, p_motivo text DEFAULT NULL) RETURNS uuid` — `auth.uid()` fixo; comprador precisa estar na carteira do chamador.
- Produces (cron/service, sem grant a `authenticated`):
  - `venda_fechar_desfechos(p_hoje date DEFAULT current_date) RETURNS int` — fecha linhas com `dia_referencia + janela ≤ p_hoje` e `desfecho IS NULL`.
  - Também nesta migration: `cron.unschedule('tactical-plans-batch-nightly')` (decisão do spec §5) — idempotente.

- [ ] **Step 1: Escrever `db/test-venda-espinha.sh` com os casos (todos falham sem a migration)**

```sql
-- fixture: farmer F1, F2; comprador C (canônico) e alias A→C; pedido de A com SKU 111 em d+5
-- 1. desfecho recompra casa pedido do ALIAS
SELECT venda_fechar_desfechos(d + 14);
-- assert: (SELECT desfecho, sales_order_id IS NOT NULL FROM venda_sugestao WHERE id = s1) = ('virou_pedido', true)
-- 2. pedido cancelado não conta → 'nao_virou'
-- 3. vendas_sync_heartbeat da empresa sem sucesso cobrindo a janela → ('nao_medivel','sync_atrasado')
-- 4. linha com janela aberta (p_hoje < dia+14) continua desfecho IS NULL
-- 5. sob SET ROLE authenticated + GUC sub=F2: venda_minhas_sugestoes() não contém comprador de F1
-- 6. sob F1: linhas fase 'sombra'/'historico' não aparecem em venda_minhas_sugestoes
-- 7. venda_marcar_mostrada 2×: mostrada_em não muda na 2ª
-- 8. venda_registrar_contato com comprador fora da carteira → SQLSTATE '42501'
-- 9. has_function_privilege('anon', 'venda_minhas_sugestoes(date)', 'EXECUTE') = false; idem PUBLIC; venda_fechar_desfechos sem EXECUTE para authenticated
-- 10. RLS: SELECT direto em venda_sugestao como authenticated F1 → só as próprias linhas 'ativa'
```

- [ ] **Step 2: Rodar e ver falhar** — Run: `bash db/test-venda-espinha.sh` · Expected: falha na criação da fixture (relação `venda_sugestao` inexistente).
- [ ] **Step 3: Escrever a migration** com as interfaces acima. Casamento do desfecho: pedido do comprador (alias resolvido) com data em `[dia_referencia, dia_referencia + janela]`, item com `omie_codigo_produto` igual (recompra/preço) ou produto cuja `omie_products.familia` = `familia` (complemento); para `preco`, `virou_pedido` só se `unit_price − desconto_valor/quantity ≥ preco_alvo × 0,99`. `valor_realizado` = soma dos itens casados. Sync: `vendas_sync_heartbeat` da `empresa` sem execução bem-sucedida após `dia_referencia + janela` → `nao_medivel`/`sync_atrasado`. Postcondição `DO $post$` confere tabelas, RLS ligada, ACLs e o cron do plano tático ausente.
- [ ] **Step 4: Rodar e ver passar** — `bash db/test-venda-espinha.sh` nos dois locales · Expected: marcador `FIM-OK venda-espinha` e exit 0.
- [ ] **Step 5: Falsificar** (depois de commitar): remover a resolução de alias → caso 1 vermelho; trocar `nao_medivel` por `nao_virou` → caso 3 vermelho; restaurar.
- [ ] **Step 6: Cron** `venda-fechar-desfechos` 09:30 UTC chamando `SELECT venda_fechar_desfechos()` (SQL direto, sem http).
- [ ] **Step 7: Commit + PR** — camadas: migration (eu no envelope / founder no SQL Editor) · sem edge · sem Publish.

---

### Task 2: Recompra cliente × SKU e situação do comprador

**Files:**
- Create: `src/lib/venda-cliente/recompra.ts` (oráculo puro TS)
- Create: `src/lib/venda-cliente/__tests__/recompra.test.ts`
- Create: `supabase/migrations/<ts>_venda_cliente_recompra.sql`
- Create: `db/test-venda-recompra.sh` (inclui paridade SQL × TS sobre fixture JSON compartilhada `db/fixtures/venda-recompra.json`)
- Modify: `src/lib/modulos/manifesto.ts` (`farmer-inteligencia` ganha `src/lib/venda-cliente/**`)

**Interfaces:**
- Produces (TS):
  ```ts
  export interface LinhaPedido { comprador_id: string; empresa: 'oben'|'colacor'|'colacor_sc'; omie_codigo_produto: number; quantidade: number; preco_unit_liquido: number | null; data_pedido: string /* YYYY-MM-DD */ }
  export interface RecompraSku { comprador_id: string; empresa: string; omie_codigo_produto: number; n_pedidos: number; cadencia_dias: number; qtd_sugerida: number; ultima_compra: string; ultimo_preco: number | null; due_ratio: number; atrasado: boolean; valor_esperado: number | null }
  export type SituacaoComprador = 'em_dia' | 'atrasado' | 'perdido' | 'sem_base';
  export function calcularRecompra(linhas: LinhaPedido[], hoje: string): RecompraSku[];
  export function situacaoComprador(skus: RecompraSku[], ultimaCompraQualquer: string | null, hoje: string): SituacaoComprador;
  ```
  Regras: só pedidos com `data_pedido < hoje` e `≥ hoje − 540`; agrupar por comprador × empresa × SKU; dias distintos de pedido ≥ 3; `cadencia_dias` = mediana dos intervalos entre dias distintos; `qtd_sugerida` = mediana da quantidade por dia de pedido; `ultimo_preco` = preço líquido do último dia (NULL se ausente); `due_ratio = (hoje − ultima_compra) / cadencia_dias`; `atrasado = due_ratio ≥ 1.5`; `valor_esperado = qtd_sugerida × ultimo_preco` ou NULL. Situação: `sem_base` se nenhum SKU qualificado e há < 3 dias de pedido no histórico; `perdido` se `hoje − ultimaCompraQualquer > max(3 × mediana das cadências, 365)`; `atrasado` se algum SKU atrasado; senão `em_dia`.
- Produces (SQL):
  - `venda_recompra_em(p_data date) RETURNS TABLE (comprador_id uuid, empresa text, omie_codigo_produto bigint, product_id uuid, n_pedidos int, cadencia_dias numeric, qtd_sugerida numeric, ultima_compra date, ultimo_preco numeric, due_ratio numeric, atrasado boolean, valor_esperado numeric)` — `STABLE`, sem grant a `authenticated`.
  - `venda_situacao_em(p_data date) RETURNS TABLE (comprador_id uuid, situacao text, dias_sem_compra int, valor_atrasado numeric)`.
  - Tabela snapshot `venda_recompra` (colunas de `venda_recompra_em` + `calculado_em`) e `venda_situacao` (+ `calculado_em`), RLS ligada sem policy para `authenticated` (leitura só via RPCs das Tasks 4/8).
  - `venda_recompra_atualizar() RETURNS int` + cron `venda-recompra` 07:50 UTC.

- [ ] **Step 1: Teste TS falhando** em `recompra.test.ts`:

```ts
it('cadência = mediana dos intervalos entre dias distintos; atrasado com due_ratio ≥ 1,5', () => {
  // pedidos do SKU 111 em 2026-01-01, 01-31, 03-02 (cadência 30); hoje 2026-04-20 → 49 dias / 30 = 1,63
  const [s] = calcularRecompra(linhas, '2026-04-20');
  expect(s.cadencia_dias).toBe(30); expect(s.atrasado).toBe(true);
});
it('menos de 3 dias de pedido → SKU fora', ...)                         // expect(calcularRecompra(duas, hoje)).toEqual([])
it('pedido em data ≥ hoje é ignorado (sem olhar o futuro)', ...)        // resultado igual com e sem o pedido futuro
it('preço ausente → ultimo_preco e valor_esperado null, nunca 0', ...)
it('perdido: 400 dias sem compra com cadência 30 → perdido', ...)        // situacaoComprador(...) === 'perdido'
it('cadência 200 → perdido só após 600 dias', ...)
```

- [ ] **Step 2:** `bun run test src/lib/venda-cliente` · Expected: FAIL (módulo inexistente).
- [ ] **Step 3:** implementar `calcularRecompra` e `situacaoComprador`.
- [ ] **Step 4:** `bun run test src/lib/venda-cliente` · Expected: PASS.
- [ ] **Step 5: Teste SQL** `db/test-venda-recompra.sh`: (a) paridade — carrega `db/fixtures/venda-recompra.json`, roda `venda_recompra_em('2026-04-20')` e compara com a saída esperada gerada pelo oráculo TS (script `scripts/venda-recompra-esperado.ts` emite o JSON esperado); (b) pedido do alias entra no comprador canônico; (c) pedido `cancelado` e `deleted_at` não entram; (d) `venda_recompra_em(d)` ignora pedido em `d`; (e) Oben e Colacor do mesmo `customer_user_id` ficam em linhas separadas por `empresa`. Rodar · Expected: FAIL.
- [ ] **Step 6:** migration com as funções, snapshots e cron. Rodar o teste nos dois locales · Expected: `FIM-OK venda-recompra`.
- [ ] **Step 7:** falsificar (trocar `<` por `<=` na data → caso d vermelho); restaurar.
- [ ] **Step 8: Medir em prod depois do apply** (query no PR): contagem por `situacao` e nº de compradores com ≥1 SKU atrasado por farmer. O PR registra os números.
- [ ] **Step 9: Commit + PR** — camadas: migration · sem edge · sem Publish.

---

### Task 3: `calculate-scores` — intervalo de recompra real, frequência nula sem base

**Files:**
- Modify: `supabase/functions/calculate-scores/index.ts` (seed `:693`, `freqScore` `:844`, `ScoreUpdate`, classe `:884-897`)
- Modify: `src/lib/scoring/*` (espelho TS — mesma regra) e seus testes de paridade existentes
- Modify: RPC `apply_score_updates` só se precisar aceitar `avg_repurchase_interval` (migration `supabase/migrations/<ts>_scores_intervalo_recompra.sql`; pré-flight `pg_get_functiondef` da prod)

**Interfaces:**
- Consumes: `get_customer_sales_summary()` (já existente) — acrescentar `intervalo_mediano_dias numeric NULL` (mediana dos gaps entre dias distintos de pedido, histórico inteiro; NULL com < 3 dias). VIEW/função só **acrescenta** coluna no fim.
- Produces: `farmer_client_scores.avg_repurchase_interval` = esse valor (NULL quando ausente — nunca 0/30); `freqScore = NULL` quando intervalo NULL (componente sai da média e o peso é redistribuído, como margem já faz).

- [ ] **Step 1: Testes falhando** no espelho TS (`src/lib/scoring/__tests__/…`): `cliente com 999 dias e intervalo null → classe 'critico'` (hoje sai 'atencao'); `cliente com 2 pedidos → frequência ausente, não 0 nem 80`; `cliente com intervalo 20 e compra há 10 dias → freqScore igual ao de hoje` (não regride).
- [ ] **Step 2:** `heavy bun run test src/lib/scoring` · Expected: FAIL nos dois primeiros.
- [ ] **Step 3:** aplicar a regra no espelho TS e na edge (mesmo texto); seed passa a gravar NULL; `ScoreUpdate` passa a levar `avg_repurchase_interval`.
- [ ] **Step 4:** `heavy bun run test src/lib/scoring` e `bun run test:edges` · Expected: PASS. `bun run edges:typecheck`, `bun run edges:sintaxe`, `bun run sonda:bump`, `bun run sonda:fingerprint -- --write`.
- [ ] **Step 5: Medir antes/depois** (query no PR): `SELECT health_class, count(*) FROM farmer_client_scores GROUP BY 1` antes do deploy e depois da 1ª rodada; e tamanho de `a_positivar` por farmer (`get_minha_positivacao_for`). Registrar no PR — "onde mais aparece": positivação, `BoardCarteira`, `AgendaTodayList`, Customer360.
- [ ] **Step 6: Commit + PR** — camadas: migration (se `apply_score_updates`/summary mudou) · **edge `calculate-scores`** (deploy manual; decidir por `bun run pendencias:deploy`) · sem Publish.

---

### Task 4: Gerador D-1, reconstrução histórica e sombra

**Files:**
- Create: `supabase/migrations/<ts>_venda_cliente_gerador.sql`
- Create: `db/test-venda-gerador.sh`

**Interfaces:**
- Consumes: `venda_sugestao`, `venda_config` (Task 1); `venda_recompra_em`, `venda_situacao_em` (Task 2); `carteira_assignments (owner_user_id, eligible)`; `commercial_roles`; `route_schedule (weekday, city, uf, is_daily, ativo)`; `customer_visit_scores.city_norm`.
- Produces:
  - `venda_cidades_alvo(p_dia date) RETURNS TABLE (city_norm text, uf text)` — porta SQL de `resolvePrepForWorkday` (`src/lib/whatsapp/route-schedule.ts`): rota do próximo dia útil + cidades `is_daily`, respeitando cancelamento lido em `src/queries/useRouteContactList.ts:234-244`. Paridade com o TS por fixture.
  - `venda_gerar_lista(p_dia date, p_fase text) RETURNS int` — para cada farmer: **união** de (a) compradores com SKU atrasado cuja `city_norm` ∈ `venda_cidades_alvo(p_dia)` e (b) os `teto_maiores_atrasos` compradores de maior `SUM(valor_esperado)` atrasado fora de (a); exclui `situacao='perdido'`; uma linha `tipo='recompra'` por SKU atrasado; `motivo_entrada` = `'entrega amanhã em <Cidade>'` ou `'maior atraso da carteira'`. Usa `venda_recompra_em(p_dia)` (não o snapshot) para valer no histórico. `INSERT … ON CONFLICT DO NOTHING`.
  - `venda_reconstruir_historico(p_de date, p_ate date) RETURNS int` — chama `venda_gerar_lista(d, 'historico')` dia a dia e depois `venda_fechar_desfechos(current_date)`; processável em lotes de 30 dias (timeout do SQL Editor).
  - Cron `venda-gerador` 08:15 UTC: `venda_gerar_lista(current_date, CASE WHEN (SELECT valor FROM venda_config WHERE chave='onda_recompra')::boolean THEN 'ativa' ELSE 'sombra' END)`.

- [ ] **Step 1: Testes falhando** em `db/test-venda-gerador.sh`: (1) comprador atrasado em cidade de amanhã entra com motivo `entrega amanhã em …`; (2) atrasado fora da rota entra só se estiver entre os 10 maiores; (3) comprador `perdido` não entra; (4) dono não-farmer (founder) não gera linhas; (5) rodar 2× o mesmo `p_dia` → mesma contagem; (6) `onda_recompra=false` → linhas `sombra`, `true` → `ativa`; (7) `venda_reconstruir_historico` para um dia passado usa só pedidos anteriores (pedido posterior não muda a lista, mas fecha o desfecho como `virou_pedido`); (8) paridade `venda_cidades_alvo` × `resolvePrepForWorkday` em sex→seg, feriado ausente, cidade diária.
- [ ] **Step 2:** rodar · Expected: FAIL.
- [ ] **Step 3:** migration.
- [ ] **Step 4:** rodar nos dois locales · Expected: `FIM-OK venda-gerador`. Falsificar (remover o filtro `perdido` → caso 3 vermelho).
- [ ] **Step 5: Depois do apply em prod:** rodar `venda_reconstruir_historico` em lotes de 30 dias cobrindo os 12 meses anteriores (bloco para o SQL Editor no PR) e registrar no PR a taxa semanal `virou_pedido / (virou_pedido + nao_virou)` e a fração `nao_medivel`.
- [ ] **Step 6: Commit + PR** — camadas: migration + carga histórica (founder no SQL Editor fora do envelope) · sem edge · sem Publish.

---

### Task 5: Complemento por comprador

**Files:**
- Create: `supabase/migrations/<ts>_venda_cliente_complemento.sql`
- Create: `db/test-venda-complemento.sh`

**Interfaces:**
- Consumes: lógica de `_carteira_mixgap_for_owner` (pisos `confidence ≥ 0.15`, `lift ≥ 1.5`, `sample_size ≥ 30`, supressão `convertido` e `recusado` < 90d de `farmer_mixgap_feedback`) — **extrair** o núcleo para `private._mixgap_gaps_comprador(p_comprador uuid)` e fazer `_carteira_mixgap_for_owner` chamá-lo (sem mudar a assinatura de `get_meu_mixgap`).
- Produces: `venda_complemento_comprador(p_comprador uuid) RETURNS jsonb` (staff; farmer só se o comprador é da carteira dela; senão `42501`) → `{"familias":[{"familia","empresa","confidence","lift","evidence_count","feedback_status","skus":[{"omie_codigo_produto","descricao"}]}]}` — até 3 famílias (ordem confidence × lift), até 3 SKUs por família (mais comprados, 12m, na mesma empresa, por compradores que têm o antecedente da regra).

- [ ] **Step 1: Testes falhando**: (1) comprador sem a família X e regra acima dos pisos → X aparece; (2) regra com `lift 1.4` → não aparece; (3) família `recusado` há 30 dias → some; há 100 dias → volta; (4) até 3 famílias; (5) farmer F2 pedindo comprador de F1 → `42501`; (6) **regressão**: `get_meu_mixgap_for(F1)` devolve exatamente o mesmo JSON antes e depois da extração.
- [ ] **Step 2:** rodar · Expected: FAIL.
- [ ] **Step 3:** migration (pré-flight `pg_get_functiondef` de `_carteira_mixgap_for_owner` na prod; reemitir REVOKE).
- [ ] **Step 4:** rodar nos dois locales · Expected: `FIM-OK venda-complemento`.
- [ ] **Step 5: Commit + PR** — camadas: migration · sem edge · sem Publish.

---

### Task 6: Repasse de preço (money-path)

> **Antes de qualquer código:** Codex consulta 1 (desenho, com seção `RÉGUA:`) sobre esta Task via `scripts/codex-async.sh`; depois do código, consulta 2. O PR registra `Codex: desenho=… · código=…`. Use a skill `prove-sql-money-path`.

**Files:**
- Create: `supabase/migrations/<ts>_venda_cliente_repasse.sql`
- Create: `db/test-venda-repasse.sh`

**Interfaces:**
- Consumes: núcleo de `get_defasagem_cliente` (tolerância 3pp, alta mínima 2%, âncora ≤ 18 meses, quarentena 50%, janela ±7d) — **extrair** para `private._defasagem_item(...)` e fazer `get_defasagem_cliente` chamá-lo (saída idêntica); `get_regua_preco` (`abaixo_piso`, só Oben, sem tinta); snapshot `venda_recompra` (Task 2).
- Produces:
  - `venda_repasse_candidatos() RETURNS jsonb` — **master + `cap_custo_ler`**; por comprador × SKU da `venda_recompra` (Oben, sem tinta): `status_defasagem`, `abaixo_piso`, último preço, preço sugerido pela regra, valor anual recuperável (`qtd_sugerida × 365 / cadencia_dias × (sugerido − último)`, NULL se faltar dado), evidência.
  - `venda_repasse_aprovado(id uuid PK, comprador_id uuid, empresa text, omie_codigo_produto bigint, preco_alvo numeric NOT NULL, valido_ate date NOT NULL, aprovado_por uuid, aprovado_em timestamptz, revogado_em timestamptz NULL)` + parcial `UNIQUE (comprador_id, empresa, omie_codigo_produto) WHERE revogado_em IS NULL`.
  - `venda_aprovar_repasse(p_comprador uuid, p_empresa text, p_codigo bigint, p_preco_alvo numeric, p_valido_ate date) RETURNS uuid` — master; recusa (`22023`) `p_preco_alvo` < último preço praticado; revoga o anterior vigente.
  - `venda_revogar_repasse(p_id uuid) RETURNS void` — master.
  - `venda_preco_alvo_comprador(p_comprador uuid) RETURNS jsonb` — farmer (carteira) / staff: `[{"empresa","omie_codigo_produto","ultimo_preco","preco_alvo","faixa_margem"}]` só para repasses vigentes; **sem** custo/markup/piso.
  - `venda_gerar_lista` (Task 4) passa a inserir também `tipo='preco'` para SKUs com repasse vigente quando `onda_preco=true`.

- [ ] **Step 1: Testes falhando**: (1) `get_defasagem_cliente` devolve o mesmo JSON antes/depois da extração (fixture com e sem cap); (2) `venda_repasse_candidatos` como farmer → `42501`; como master sem cap → `42501`; (3) aprovar alvo abaixo do último preço → `22023`; (4) `venda_preco_alvo_comprador` como farmer: JSON **não contém** as chaves `cmc`, `custo`, `markup_perc`, `piso_markup`, `piso_mc` (assert por chave); (5) repasse vencido (`valido_ate < hoje`) ou revogado não aparece; (6) SKU Colacor ou tinta nunca aparece em candidatos.
- [ ] **Step 2–4:** rodar (FAIL) → migration → rodar nos dois locales (`FIM-OK venda-repasse`) → falsificar o caso 4 (vazar `cmc`) e o 3.
- [ ] **Step 5: Commit + PR** com o registro do Codex — camadas: migration · sem edge · sem Publish (a UI é a Task 7/9).

---

### Task 7: Painel do founder — adoção e repasse

**Files:**
- Create: `supabase/migrations/<ts>_venda_cliente_painel.sql` (RPC de leitura)
- Create: `src/pages/VendaClientePainel.tsx`, `src/components/venda-cliente/painel/*`, `src/hooks/useVendaPainel.ts`
- Create: testes vitest co-localizados em `src/components/venda-cliente/painel/__tests__/`
- Modify: `src/App.tsx` (rota `/admin/venda-cliente`, gate master), `src/lib/modulos/manifesto.ts`

**Interfaces:**
- Produces: `venda_painel(p_de date, p_ate date) RETURNS jsonb` (master) → por farmer × semana: `na_lista`, `mostradas`, `contatados` (`venda_contato`), `compraram` (`virou_pedido`), `nao_medivel`, `receita_realizada`, `taxa_ativa`, `taxa_base_historico_mesma_semana`, `taxa_base_sombra`, `base_confiavel boolean` (false se |sombra − histórico das mesmas semanas| > 10 p.p. ou sombra < 2 semanas).
- UI: tabela por farmer/semana; aviso fixo **"antes × depois, não é prova causal"**; quando `nao_medivel` > 20% ou `base_confiavel=false` a célula da taxa mostra "não consegui medir", nunca 0. Aba "Repasses": lista de `venda_repasse_candidatos` com botão Aprovar (abre dialog com preço alvo ≥ último preço e validade) e Revogar.

- [ ] **Step 1: Testes falhando** (vitest): `renderiza 'não consegui medir' quando nao_medivel > 20%`; `renderiza aviso não causal`; `aprovar com preço abaixo do último bloqueia o botão`. SQL: `venda_painel` como farmer → `42501`.
- [ ] **Step 2–4:** FAIL → implementar → `heavy bun run test src/components/venda-cliente` e `bun run typecheck` PASS.
- [ ] **Step 5:** sensor `registrarNoLedger('venda.painel_aberto')`.
- [ ] **Step 6: Commit + PR** — camadas: migration · sem edge · **Publish** (founder).

---

### Task 8: Meu Dia + ficha da ligação + desfecho (Onda 1)

**Files:**
- Create: `src/lib/fila/adapters/recompra.ts` + `src/lib/fila/__tests__/recompra.test.ts`
- Create: `src/hooks/useMinhasSugestoes.ts`, `src/hooks/useRegistrarContato.ts`
- Create: `src/components/venda-cliente/FichaLigacao.tsx`, `SecaoRecomprar.tsx`, `SecaoHistorico.tsx`, `BotoesContato.tsx` + testes
- Move (re-hospedar, sem mudar comportamento): `src/lib/call/municao.ts`, `src/lib/call/historico.ts`, `src/hooks/useMunicaoLigacao.ts`, `src/hooks/useHistoricoCompras.ts`, `src/lib/omie/ultimo-preco.ts` → donos em `farmer-inteligencia` no `manifesto.ts` (ajustar `fronteiras-baseline.ts` removendo as exceções que deixam de existir)
- Modify: `src/lib/fila/types.ts` (novo `fonte: 'recompra'`, `payload.kind: 'recompra'`), `src/hooks/useFilaAcoes.ts` (fonte `recompra`; desligar `rota`, `tarefa`, `whatsappPendente`), `src/components/fila/FilaDoDia.tsx` (clique abre `FichaLigacao`; sem flag `filaContextPanel`), `src/components/fila/AcaoOutcomeMenu.tsx` (kind `recompra` → `BotoesContato`), `src/components/dashboard/FarmerDashboardV2.tsx` (remover modo antigo, `SlaCardMeuDia`, links para módulos congelados)

**Interfaces:**
- Consumes: `venda_minhas_sugestoes`, `venda_marcar_mostrada`, `venda_registrar_contato` (Task 1); `venda_config.onda_recompra`.
- Produces: `adaptarRecompra(resp: MinhasSugestoesResp): AcaoSugerida[]` — 1 ação por comprador, `categoria: 'esperado'`, `cta: 'ligar'`, `motivo` = `motivo_entrada` + "N itens atrasados", `valorEsperado` = `valor_ref_total` (null se null), `dedupeKey: 'recompra:<comprador_id>'`.
- `FichaLigacao({ compradorId })`: cabeçalho com nome, telefone como link `tel:` e munição (dias desde a última compra, ticket médio); `SecaoRecomprar` (SKU, descrição, qtd sugerida, dias de atraso, último preço); `SecaoHistorico` (últimos pedidos); link para `/admin/customers/:id/360`; `BotoesContato` com `vendeu` · `vai_pedir` · `sem_interesse` (+ motivo de `MOTIVOS_RECUSA`) · `nao_atendeu`. Ao abrir, chama `venda_marcar_mostrada` com os ids das sugestões exibidas.
- Sensores (ledger): `venda.ficha_aberta`, `venda.contato_registrado`, `venda.tel_clicado`.

- [ ] **Step 1: Testes falhando**: adapter (`comprador sem valor → valorEsperado null`, `dedupeKey estável`); `FichaLigacao` (`telefone vira link tel:`, `não renderiza BotaoLigar`, `marca mostrada uma vez por abertura`, `nao_atendeu registra com 1 clique`); `useFilaAcoes` (`fonte rota desligada não aparece em fontesComErro`); `FarmerDashboardV2` (`não contém link para /rota, /whatsapp, /telefonia`).
- [ ] **Step 2–4:** FAIL → implementar → `heavy bun run test` + `bun run typecheck` + `bun lint` PASS; `manifesto.gate` verde.
- [ ] **Step 5: Verificar no navegador** (`/meu-dia` com lente "Ver como" Regina): lista aparece, ficha abre, botão de desfecho bloqueado na lente (write-guard).
- [ ] **Step 6: Commit + PR** — camadas: sem migration · sem edge · **Publish** (founder). Go-live = founder liga `onda_recompra=true` (UPDATE em `venda_config`, bloco no PR) **depois** de ≥ 2 semanas de sombra.

---

### Task 9: "Oferecer também" e "Preço" na ficha (Ondas 2 e 3)

**Files:**
- Create: `src/components/venda-cliente/SecaoComplemento.tsx`, `SecaoPreco.tsx` + testes; `src/hooks/useComplementoComprador.ts`, `src/hooks/usePrecoAlvoComprador.ts`
- Modify: `src/components/venda-cliente/FichaLigacao.tsx`; `supabase/migrations/<ts>_venda_cliente_ondas23.sql` (`venda_gerar_lista` insere `tipo='complemento'` quando `onda_complemento=true`; `venda_minhas_sugestoes` expõe `ondas`)

**Interfaces:**
- Consumes: `venda_complemento_comprador` (Task 5), `venda_preco_alvo_comprador` (Task 6), `venda_config.onda_complemento|onda_preco`.
- Seções separadas, **sem score comum** com Recomprar. Complemento: família + SKUs + "clientes parecidos compram"; nunca exibe estoque sem fonte. Preço: último preço e preço alvo **só** para repasse vigente; faixa de margem.

- [ ] **Step 1: Testes falhando**: `onda_complemento=false → SecaoComplemento não renderiza`; `SKU sem repasse → mostra só último preço`; `SecaoPreco nunca renderiza as palavras 'custo' ou 'markup'`; SQL: `onda_complemento=true` gera linhas `complemento` com `familia` e janela de 30 dias.
- [ ] **Step 2–4:** FAIL → implementar → testes + typecheck PASS.
- [ ] **Step 5: Commit + PR** — camadas: migration · sem edge · **Publish**. Liberação: Onda 2 quando o painel mostrar ≥ 80% de contatos por 2 semanas; Onda 3 quando houver a 1ª leva de repasses aprovados.
