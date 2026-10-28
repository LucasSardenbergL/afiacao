# Giro de corante WP — Fase 1 (advisory): plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: superpowers:executing-plans (nativo nesta sessão) ou superpowers:subagent-driven-development. Passos em checkbox (`- [ ]`).

**Objetivo:** coletar as dosagens da Dnaxis (`vendas_item` do SayerSystem) com cobertura provada, gravar o consumo por corante e mostrar, por WP, faixa, regra de pedido e excesso numa aba "Corantes" do baixo giro, sem mudar o motor de compra.

**Arquitetura:** o conector Go envia lotes de preparações e um **manifesto de extração** para `/preparations`. A edge saneia (sem `cliente`), grava no staging e enfileira o run. O tick da fila despacha runs `preparations` para a nova `tint_promote_preparacoes`, que converge o fato por preparação (monotônico por versão) e avança a cobertura só com a extração inteira promovida e contígua. Uma função `SECURITY INVOKER` com relógio por parâmetro calcula o giro, a view o expõe, e o app só renderiza.

**Stack:** Go 1.26 (`connector/sayersync`) · Postgres 17 / Supabase (migrations + `db/test-*.sh`) · Deno (edge `tint-sync-agent`) · React 18 + TS strict + vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md`. O plano argumenta a partir dela: leia as duas.

## Restrições globais

- Responder e nomear em pt-BR. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Motor de compra intocado: nenhuma escrita em `sku_parametros` nem mudança em `gerar_pedidos_sugeridos_ciclo`; a Fase 1 só LÊ `sku_parametros`, `sku_estoque_atual` e `inventory_position`.
- Nunca editar migration existente. Migrations novas: `20261028100000_…`, `20261028100100_…`, `20261028100200_…` (a última da main é `20261028000116`). Re-conferir antes do PR.
- Ausente ≠ zero: nada de `?? 0`, `COALESCE(x, 0)` ou `Number(null)` em grandeza de consumo, estoque ou dinheiro.
- `cliente` não entra no payload do conector, nem no staging, nem em `raw_data`, nem em `tint_sync_errors`.
- Constantes da política só em `public.tint_corante_constantes()`: `V = 365` d · `u = 810` ml (lata QT) · `H = 180` d · frescor `4` d corridos · cobertura mínima `60` d · cobertura plena `180` d · limite sem-ponte/rejeitada `0,01` · regime: janela `60` d, fator `2`. No conector: piso `400` d, re-scan `35` d (constantes Go nomeadas).
- Fuso: dia = `America/Sao_Paulo` (`(ts AT TIME ZONE 'America/Sao_Paulo')::date`). Proibido `current_date`, `now()::date` e `date_trunc` sem fuso (gates `fuso-da-sessao-*`, `relogio-nu-da-sessao-gate`).
- View: `WITH (security_invoker = on)`. Funções SECDEF: `SET search_path = public, pg_temp`, `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` provado por `has_function_privilege`.
- `CREATE OR REPLACE` de função viva: molde TRAVA → PRE (md5 do `prosrc` vivo) → CREATE/patch → PÓS. md5 lidos de prod em 2026-10-27: `tint_promocao_tick` = `d0e3beb394c932ad1979da5efc910943`, `analytics_ledger_registrar` = `6eaf1d41626ece3a6fe6b51617788f21`. Re-ler com psql-ro imediatamente antes de aplicar.
- Edge: os 6 gates (`test:edges` sem afrouxar `--no-remote` · `edges:typecheck` · `edges:sintaxe` · `bun run test` · `sonda:bump` · `sonda:fingerprint -- --write`).
- Provas SQL: `prove-sql-money-path` — PG17 executando a migration real, asserts negativos por SQLSTATE, falsificação com controle verde na mesma invocação, `HARNESS_LOCALE=C` e `pt_BR.UTF-8`; marca positiva `PASS=<n>  FAIL=<m>` + `exit 0` colado.

## Correções à spec (decididas no plano, vão ao Codex)

1. **Capital parado = excesso (L) × `cmc` do QT**, sem `÷ 0,81`. Medido em prod: os WP têm `unidade = 'L'` no Omie e `inventory_position.cmc` já é R$/L (WP01 QT: 101,08/L). A fórmula da spec inflaria o capital em 23%.
2. **Cabeçalho por preparação** (`tint_consumo_preparacao`) além do fato por item: a versão monotônica precisa sobreviver a uma preparação cujos itens sumiram, e as rejeitadas na origem precisam de lugar, sem item, para entrar no denominador.
3. **Versão de uma preparação = (`consultado_ate` do manifesto, `started_at` do run)**. O relógio da origem decide; o run só desempata. Um run antigo reprocessado nunca vence.
4. **Rejeitadas na origem contam como ausência:** fração > 1% das preparações da janela → faixa 1 (gêmeo do limite de sem-ponte).
5. **Retenção do staging por estado:** a própria promoção apaga o staging do run, na mesma transação. `tint_staging_purge` (md5 + pós-condição de 9 DELETEs) não é tocada.
6. **Teto do `CHECK` de `qtd_ml`:** provisório `18000` ml (a maior embalagem, BH de 18 L). Apertado depois pelo máximo medido no passo 0.
7. **Dado parado ≥ 4 dias:** `faixa = 'sem_recomendacao'` (motivo `dado_desatualizado`); `faixa_ultimo_calculo` traz a faixa da janela que termina na fronteira de cobertura, que a tela mostra como "último cálculo".
8. **`d = 0` com cobertura entre 60 e 179 dias** → faixa 1, motivo `sem_consumo_cobertura_parcial` (a spec só define "parado" com cobertura plena).

## Foco de revisão (falhas que nenhum teste "natural" pegaria)

1. O re-scan semanal limpa todos os HWMs → `vendas_item` refaria o backfill de 400 dias toda semana. Esperado: a janela do re-scan é de 35 dias. Teste na Task 12.
2. Lote com uma preparação inválida → a edge grava a metade válida e a cobertura alega o dia. Esperado: nada é gravado, `ok:false`, run `error`, sem enfileirar. Teste na Task 6.
3. Um lote da extração em erro → a extração seguinte avança a cobertura por cima do buraco. Esperado: cobertura parada até uma extração contígua (o re-scan cura). Prova na Task 2.
4. GL existe no Omie, mas sem linha em `sku_estoque_atual` → estoque somado como 0. Esperado: estoque `NULL` → excesso e capital "—". Prova na Task 3.
5. Usuário `customer` lê a view → precisa receber 0 linhas (RLS via `security_invoker`), não o giro. Prova na Task 3.

## Ordem de entrega (PRs) e deploy

| PR | Tasks | Bloqueio |
|---|---|---|
| A — banco | 1–4 | nenhum |
| B — edge | 5–6 | contrato da Task 1 |
| C — app | 7–8 | view da Task 3 |
| D — conector | 9–12 | 9–10: nenhum · 11–12: **passo 0 do founder** |

Deploy: migrations A → edge B → conector D (`release.sh`) → Publish C. A aba mostra "sem dado de cobertura" até o conector rodar, o que é honesto.

---

## Contrato do payload `/preparations` (fixado agora; o passo 0 só muda como o conector o PREENCHE)

```jsonc
{
  "manifesto": {
    "extracao_id": "uuid",            // um por extração; todos os lotes compartilham
    "lote": 1, "total_lotes": 3,      // 1 ≤ lote ≤ total_lotes; delta vazio = 1 lote vazio
    "modo": "backfill" | "incremental" | "rescan",
    "consultado_desde": "RFC3339",    // limite inferior da consulta na origem
    "consultado_ate": "RFC3339"       // relógio da origem no início da extração; > consultado_desde
  },
  "preparacoes": [{
    "preparacao_id": "texto não vazio",
    "data_dosagem": "RFC3339",
    "itens": [{ "ordem": 1, "id_corante_origem": "12", "codigo_corante_origem": "WP07" | null,
                "qtd_ml": 12.5, "peso_especifico": 1.95 | null }]   // 1 ≤ ordem ≤ 6, qtd finita > 0
  }],
  "rejeitadas": [{ "preparacao_id": "…", "data_dosagem": "RFC3339", "motivo": "slot_parcial" | "corante_nao_resolvido" | "unidade" | "peso_especifico_ausente" }]
}
```

Allowlist: qualquer outra chave, em qualquer nível, é descartada antes de validar, gravar ou logar. `preparacoes.length + rejeitadas.length ≤ 1000` (`MAX_BATCH_ITEMS`).

---

## PR A — Banco

### Task 1: Tabelas, staging saneado, capacidade e constantes

**Arquivos:**
- Criar: `supabase/migrations/20261028100000_tint_consumo_corante.sql` (Tasks 1 e 2 no mesmo arquivo: deploy atômico)
- Criar: `db/test-tint-consumo-corante.sh`
- Modificar: `scripts/authz-tabelas-fechadas.ts` (registrar as 4 tabelas `tint_consumo_*`, padrão `20261011120000`)

**Interfaces produzidas:**
- `tint_corante_constantes() RETURNS TABLE(validade_dias int, lata_ml numeric, lata_l numeric, horizonte_dias int, frescor_dias int, cobertura_min_dias int, cobertura_plena_dias int, limite_ausencia numeric, regime_janela_dias int, regime_fator numeric)`, `IMMUTABLE`, valores das Restrições globais (`lata_l = 0.81`).
- `tint_corantes`: `+ capacidade_canister_ml numeric NULL CHECK (capacidade_canister_ml IS NULL OR (capacidade_canister_ml > 0 AND capacidade_canister_ml < 'Infinity'))`, `+ capacidade_confirmada boolean NOT NULL DEFAULT false`. Seed: `capacidade_canister_ml = 2300` onde `account = 'oben' AND omie_product_id IS NOT NULL` (os 14 WP), confirmada `false`.
- `tint_staging_preparacoes`: `+ rejeicao_motivo text NULL`; `CHECK (cliente IS NULL)`; `CHECK (raw_data IS NULL OR NOT raw_data ? 'cliente')`. A coluna `data_preparacao` passa a carregar a `data_dosagem`.
- `tint_staging_preparacao_itens`: `+ codigo_corante text NULL`, `+ peso_especifico numeric NULL`. `id_corante` = id bruto da origem.
- `tint_staging_preparacao_manifestos(sync_run_id uuid PK REFERENCES tint_sync_runs ON DELETE CASCADE, account text NOT NULL, store_code text NOT NULL, extracao_id uuid NOT NULL, lote int NOT NULL, total_lotes int NOT NULL, modo text NOT NULL CHECK (modo IN ('backfill','incremental','rescan')), consultado_desde timestamptz NOT NULL, consultado_ate timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK (1 <= lote AND lote <= total_lotes), CHECK (consultado_desde < consultado_ate))`.
- `tint_consumo_preparacao(account, store_code, preparacao_id text, data_dosagem timestamptz NOT NULL, situacao text NOT NULL CHECK (situacao IN ('valida','rejeitada')), motivo_rejeicao text, versao_fonte_em timestamptz NOT NULL, run_criado_em timestamptz NOT NULL, sync_run_id uuid NOT NULL, PRIMARY KEY (account, store_code, preparacao_id))`, sem FK para `tint_sync_runs` (a poda de runs não pode apagar fato).
- `tint_consumo_corante(account, store_code, preparacao_id, ordem int CHECK (ordem BETWEEN 1 AND 6), id_corante_origem text NOT NULL, codigo_corante_origem text, tint_corante_id uuid NULL REFERENCES tint_corantes, qtd_ml numeric NOT NULL CHECK (qtd_ml > 0 AND qtd_ml <= 18000 AND qtd_ml <> 'NaN'), peso_especifico numeric, data_dosagem timestamptz NOT NULL, sync_run_id uuid NOT NULL, run_criado_em timestamptz NOT NULL, PRIMARY KEY (account, store_code, preparacao_id, ordem), FOREIGN KEY (account, store_code, preparacao_id) REFERENCES tint_consumo_preparacao ON DELETE CASCADE)`; índice `(account, tint_corante_id, data_dosagem)`.
- `tint_consumo_extracao_lotes(extracao_id uuid, lote int, total_lotes int NOT NULL, account, store_code, modo, consultado_desde, consultado_ate, sync_run_id uuid NOT NULL, promovido_em timestamptz NOT NULL, PRIMARY KEY (extracao_id, lote))`.
- `tint_consumo_cobertura(account text, store_code text, coberto_desde timestamptz NOT NULL, coberto_ate timestamptz NOT NULL, ultima_extracao_id uuid NOT NULL, avancada_por_run uuid NOT NULL, ultima_lacuna_em timestamptz NULL, atualizado_em timestamptz NOT NULL, PRIMARY KEY (account, store_code), CHECK (coberto_desde <= coberto_ate))`.
- As 4 `tint_consumo_*` e a de manifestos: RLS ligada. Policy SELECT `has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role)` (a mesma de `tint_staging_preparacoes`). `REVOKE INSERT, UPDATE, DELETE` de `anon`, `authenticated` e `service_role` nas `tint_consumo_*` (só a promoção SECDEF escreve). A de manifestos aceita INSERT do `service_role` (a edge grava).

- [ ] **Passo 1: prova vermelha.** Em `db/test-tint-consumo-corante.sh` (molde de `db/test-tint-promocao-assincrona.sh`: harness, snapshot `1851416fc`, `MIG=` com a migration real, modo `--falsificar`), escrever:
  - `C1` CHECK de `qtd_ml`: `0`, `-1`, `'NaN'`, `'Infinity'`, `18000.001` → `23514` cada (captura a SQLSTATE e re-lança o resto); `18000` e `0.01` aceitos.
  - `C2` staging: INSERT com `cliente = 'X'` → `23514`; com `raw_data = '{"cliente":"X"}'` → `23514`.
  - `C3` manifesto: `lote = 0`, `lote > total_lotes`, `consultado_desde = consultado_ate` → `23514`.
  - `C4` seed: exatamente 14 linhas `capacidade_canister_ml = 2300 AND capacidade_confirmada IS FALSE` no account `oben` (o teste semeia os 14 WP + 1 PU sem `omie_product_id`; o PU fica NULL).
  - `C5` ACL/RLS: `SET ROLE authenticated` com GUC de um customer → `SELECT` nas 4 tabelas devolve 0 linhas; INSERT direto como `authenticated` e `service_role` em `tint_consumo_corante` → `42501`.
  - `C6` re-apply: rodar a migration duas vezes → mesmo estado (idempotência).
- [ ] **Passo 2:** `bash db/test-tint-consumo-corante.sh` → FAIL (migration ausente).
- [ ] **Passo 3:** escrever a parte DDL da migration: idempotente (`IF NOT EXISTS`, `DO` condicional para constraints), sem `BEGIN/COMMIT` quando aplicada por `bun run db:aplicar` (ver `docs/agent/database.md` §1, envelope), com bloco `DO $post$` final que confere cada objeto por `to_regclass`/`to_regprocedure`, as constraints por `pg_constraint` e o seed por contagem.
- [ ] **Passo 4:** prova verde nos dois locales: `HARNESS_LOCALE=C bash db/test-tint-consumo-corante.sh` e `HARNESS_LOCALE=pt_BR.UTF-8 …` → `FAIL=0`, `exit 0`.
- [ ] **Passo 5:** commit `feat(tint): tabelas do consumo de corante + staging saneado [money-path]`.

### Task 2: Promoção `tint_promote_preparacoes` e despacho no tick

**Arquivos:**
- Modificar: `supabase/migrations/20261028100000_tint_consumo_corante.sql` (mesma migration, ainda não aplicada)
- Modificar: `db/test-tint-consumo-corante.sh`
- Re-exercer: `db/test-tint-promocao-assincrona.sh` com a migration nova no `MIG=`

**Interfaces:**
- Produz: `public.tint_promote_preparacoes(p_run_id uuid) RETURNS jsonb`, SECDEF, `search_path` fixo, ACL fechada. Retorno `{ok, preparacoes_aplicadas, preparacoes_ignoradas_mais_antigas, itens, itens_sem_ponte, rejeitadas, cobertura: 'avancou'|'iniciada'|'extracao_incompleta'|'nao_contigua'}`; `ok:false` com `motivo` quando o run não é `sync_type = 'preparations'` ou não tem manifesto.
- Produz: o tick despacha por tipo. Patch de UMA linha no corpo vivo via `pg_get_functiondef` + `replace` + `EXECUTE` (o padrão de `20261021203000`). Âncora `v_res := public.tint_promote_sync_run(v_run_id);` (presença conferida em prod, 2026-10-27) vira:
  ```sql
  v_res := CASE WHEN (SELECT sr.sync_type FROM tint_sync_runs sr WHERE sr.id = v_run_id) = 'preparations'
                THEN public.tint_promote_preparacoes(v_run_id)
                ELSE public.tint_promote_sync_run(v_run_id) END;
  ```
  A PRE exige md5 vivo ∈ {`d0e3beb394c932ad1979da5efc910943`, md5 do pós-patch} e a âncora presente exatamente 1×; a PÓS exige a âncora nova presente e `REVOKE` intacto.

Regras da promoção (o corpo é do construtor; os testes fixam):
1. Versão do run = (`manifesto.consultado_ate`, `tint_sync_runs.started_at`). Para cada preparação do staging do run: se o cabeçalho existente tem versão ≥ a do run → ignora (conta). Senão faz upsert do cabeçalho (`valida`, ou `rejeitada` com `rejeicao_motivo`), apaga TODOS os itens daquela preparação e insere os do run, resolvendo `tint_corante_id` por `tint_corantes(account = run.account, id_corante_sayersystem = id_corante_origem)`; sem match → `NULL`, mantido e contado.
2. Grava o lote em `tint_consumo_extracao_lotes` (`ON CONFLICT DO NOTHING`).
3. Se os lotes da `extracao_id` somam `total_lotes`: sem linha de cobertura → cria com `coberto_desde = consultado_desde`, `coberto_ate = consultado_ate` (`iniciada`); com linha e `consultado_desde <= coberto_ate` → `coberto_ate = greatest(coberto_ate, consultado_ate)` (`avancou`); senão grava `ultima_lacuna_em` e não avança (`nao_contigua`).
4. Apaga o staging do run (preparações em cascata com os itens, mais o manifesto) na mesma transação.

- [ ] **Passo 1: provas vermelhas** (seed: os 14 WP, 1 PU, runs `preparations` `complete` + `promocao_status = 'pendente'` montados como a edge os monta). Cada cenário chama `tint_promocao_tick()` até `fila_vazia`, nunca a promoção direta (prova o despacho):
  - `P1` o mesmo conteúdo em dois runs → mesmas linhas, mesma `sum(qtd_ml)`, mesmo `count`.
  - `P2` edição na origem: o run 2 traz a preparação X com os slots trocados de ordem e um a menos → itens de X = exatamente os do run 2; soma sem dobrar.
  - `P3` não regride: o run novo é promovido, depois o run antigo é re-enfileirado (`promocao_status = 'pendente'`) → itens = os do novo; `preparacoes_ignoradas_mais_antigas = 1`.
  - `P4` independência de ordem: as permutações de 3 runs com versões distintas → estado final idêntico (comparar `md5(string_agg(... ORDER BY ...))`).
  - `P5` corante `99` sem ponte → linha com `tint_corante_id IS NULL`, `itens_sem_ponte = 1`.
  - `P6` cobertura: extração de 2 lotes, só o lote 1 promovido → sem cobertura (`extracao_incompleta`); o lote 2 promovido → `iniciada`. Extração seguinte contígua → `avancou`. Extração com o lote 2 em `erro` (força `ok:false`) e a próxima não contígua → `coberto_ate` inalterado, `ultima_lacuna_em` preenchido.
  - `P7` delta vazio: 1 lote sem preparações, contíguo → a cobertura avança.
  - `P8` rejeitada: X chega rejeitada (sem itens) → cabeçalho `rejeitada`, 0 itens; depois chega válida com versão maior → `valida` com itens.
  - `P9` staging do run promovido apagado (0 linhas em `tint_staging_preparacoes`, `_itens` e `_manifestos` daquele run); o run em `erro` mantém o staging.
  - `P10` run `catalogs` pendente continua indo para `tint_promote_sync_run` (stub contador no teste): despacho não sequestra os outros tipos.
  - `P11` ACL: `has_function_privilege` de `anon`, `authenticated` e `PUBLIC` em `tint_promote_preparacoes(uuid)` = false; chamada como `authenticated` → `42501`.
  - `P12` run sem manifesto → `ok:false`, vai a `erro` sem retry; nada gravado.
- [ ] **Passo 2:** rodar → FAIL.
- [ ] **Passo 3:** implementar a função e o patch do tick na migration.
- [ ] **Passo 4:** falsificações na MESMA invocação, após o controle verde (cada uma exige o conjunto exato de vermelhos): (a) remover o teste de versão → `P3`, `P4` vermelhos; (b) trocar "apaga os itens" por upsert puro → `P2` vermelho; (c) avançar a cobertura sem checar `total_lotes` → `P6` vermelho; (d) aceitar extração não contígua → `P6` vermelho; (e) despachar todo run para preparações → `P10` vermelho.
- [ ] **Passo 5:** verde em `C` e `pt_BR.UTF-8`, controle e `--falsificar`. Re-rodar `db/test-tint-promocao-assincrona.sh` com a migration nova anexada ao `MIG=` → `FAIL=0`.
- [ ] **Passo 6:** registrar `db/test-tint-consumo-corante.sh` em `db/nucleo-ci.txt`; `bash db/roda-nucleo-ci.sh` verde.
- [ ] **Passo 7:** commit `feat(tint): promoção de preparações convergente + despacho no tick [money-path]`.

### Task 3: Giro por corante — função com relógio por parâmetro e views

**Arquivos:**
- Criar: `supabase/migrations/20261028100100_tint_corante_giro.sql`
- Criar: `db/test-tint-corante-giro.sh` (+ entrada em `db/nucleo-ci.txt`)

**Interfaces:**
- Produz: `public.tint_corante_consumo_diario_em(p_agora timestamptz) RETURNS TABLE(tint_corante_id uuid, wp_codigo text, dia date, qtd_ml numeric)`, `STABLE SECURITY INVOKER`: uma linha por WP × dia **coberto** da janela, com zero quando não houve dosagem. Fora da cobertura não há linha.
- Produz: `public.tint_corante_giro_em(p_agora timestamptz) RETURNS TABLE(...)`, `STABLE SECURITY INVOKER`, 14 linhas (os WP: `tint_corantes.account = 'oben' AND omie_product_id IS NOT NULL`), colunas:
  `tint_corante_id uuid, wp_codigo text, descricao text, faixa text, faixa_ultimo_calculo text, motivo text, consumo_ml_dia numeric, consumo_ml_dia_60d numeric, giro_mudando boolean, ponto_pedido_ml numeric, maior_dosagem_ml numeric, lt_dias_corridos int, lt_fonte text, recarga_ml numeric, k_latas int, teto_l numeric, estoque_fechado_l numeric, excesso_l numeric, cmc_l numeric, capital_parado numeric, demanda_motor_l_dia numeric, dias_cobertos int, confianca text, fresco boolean, coberto_ate timestamptz, capacidade_confirmada boolean`.
  Vocabulários: `faixa ∈ {sem_recomendacao, parado, muito_pouco, devagar, rapido}`; `motivo ∈ {mais_de_uma_loja, sem_cobertura, dado_desatualizado, cobertura_insuficiente, capacidade_nao_confirmada, lt_sem_fonte, dosagens_sem_ponte, preparacoes_rejeitadas, sem_consumo_cobertura_parcial}`, avaliados NESTA ordem; `lt_fonte ∈ {QT, GL, mediana_wp}`; `confianca ∈ {alta, baixa}`.
- Produz: `v_corante_consumo_diario` e `v_corante_giro` `WITH (security_invoker = on)` = `SELECT * FROM <fn>(now())`.

Definições (§5 da spec, com as correções 1, 4, 7 e 8):
- Janela: `fim = (coberto_ate AT TIME ZONE 'America/Sao_Paulo')::date − 1`; `inicio = fim − 179`. Dias cobertos = `[greatest(inicio, dia SP de coberto_desde), fim]`. `fresco = coberto_ate >= p_agora − 4 dias`.
- `d` = Σ `qtd_ml` dos itens válidos daquele WP nos dias cobertos ÷ `dias_cobertos`. `d60` idem nos últimos 60 dias da janela. `giro_mudando = d > 0 AND (d60 > 2·d OR d60 < d/2)`.
- LT: `n_sku = ceil(greatest(lt_medio_dias_uteis, lt_p95_dias))` de `sku_parametros` (`empresa = 'OBEN'`). Âncora = QT (`tint_corantes.omie_product_id → omie_products.omie_codigo_produto`); GL = `omie_products` (account `oben`) com descrição `^WPnn\.3900GL`, onde `WPnn` sai de `^(WP[0-9]{2})\.3900QT` do QT. Cadeia QT → GL → `percentile_disc(0.5)` dos `n` dos WP com fonte própria. `LTc = n + 2·ceil(n/5)`.
- `s = greatest(d·LTc, P90 das somas em janelas deslizantes de LTc dias inteiramente cobertas, maior dosagem única)` (`greatest` ignora NULL; sem janela inteira, o P90 é NULL).
- `u = least(810, capacidade_canister_ml)`. Faixa: `parado` se (`d = 0` e `dias_cobertos >= 180`) ou (`d > 0` e `u/d > 365`); `muito_pouco` se `2u/d − LTc > 365`; `devagar` se `s <= u`; senão `rapido` com `k = ceil((s − u)/u)`.
- Teto (L): parado/muito_pouco `0` · devagar `0.81` · rápido `(k+1)·u/1000`. Estoque fechado = `estoque_fisico` QT + GL de `sku_estoque_atual` (`empresa = 'OBEN'`); GL inexistente no Omie → parcela 0; GL existe e sem linha de estoque → `NULL`. `excesso = greatest(0, estoque − teto)`; `capital = excesso × inventory_position.cmc` do QT (`account = 'oben'`); `cmc` NULL → capital NULL.
- `demanda_motor_l_dia` = Σ `sku_parametros.demanda_media_diaria` QT + GL (L/dia); NULL se o QT não tiver.
- Faixa 1 prevalece sobre as outras: `faixa = 'sem_recomendacao'` com o primeiro `motivo` que casar. `faixa_ultimo_calculo` = a faixa ignorando só o motivo `dado_desatualizado`. `confianca = 'baixa'` se `dias_cobertos < 180`.
- Sem-ponte: Σ `qtd_ml` com `tint_corante_id IS NULL` ÷ Σ `qtd_ml` total, na janela, > 0,01 → faixa 1 em TODOS. Rejeitadas: `count(situacao = 'rejeitada')` ÷ `count(*)` dos cabeçalhos na janela > 0,01 → idem.
- `mais_de_uma_loja`: mais de um `store_code` em `tint_consumo_cobertura` do account `oben`.

- [ ] **Passo 1: provas vermelhas** (cada uma chama `tint_corante_giro_em('<instante fixo>')`, seed por SQL direto nas tabelas da Task 1 como `postgres`):
  - `G1` borda `s = u`: d·LTc = 810 exatos → `devagar`; +0,001 ml/dia → `rapido` com `k = 1`.
  - `G2` borda `2u/d − LTc = 365` → NÃO é `muito_pouco` (`>` estrito); 1 ml a menos no período → `muito_pouco`.
  - `G3` borda `u/d = 365` → não `parado`; um pouco abaixo de `d` → `parado`.
  - `G4` `d = 0` com 180 dias cobertos → `parado`; `d = 0` com 120 dias → `sem_recomendacao/sem_consumo_cobertura_parcial`; 59 dias → `cobertura_insuficiente`.
  - `G5` P90 = 0 com consumo recorrente (1 dosagem de 30 ml a cada 20 dias, LTc = 11) → `s >= 30` (piso da maior dosagem), nunca 0.
  - `G6` `capacidade_confirmada = false` → `capacidade_nao_confirmada`; `true` → faixa calculada.
  - `G7` duas lojas na cobertura → as 14 linhas `mais_de_uma_loja`.
  - `G8` frescor: `p_agora = coberto_ate + 4 dias − 1 s` → fresco; `+ 4 dias + 1 s` → `dado_desatualizado` e `faixa_ultimo_calculo` = a faixa de antes. Rodar também com a sessão em `TZ=UTC` e em `America/Sao_Paulo` → mesmo resultado.
  - `G9` dia sem linha fora da cobertura não vira zero: dosagens em 10 dias, cobertura só nos 5 últimos → `d` usa 5 dias.
  - `G10` LT: WP sem LT no QT e com GL `lt_medio = 7` → `lt_fonte = 'GL'`, `LTc = 11`; sem os dois → `mediana_wp`; nenhum WP com LT → `lt_sem_fonte`.
  - `G11` estoque: GL existe e sem linha em `sku_estoque_atual` → `estoque_fechado_l IS NULL`, `excesso_l IS NULL`, `capital_parado IS NULL`; GL inexistente → só o QT.
  - `G12` capital: excesso 1,62 L × cmc 101,076754 → `163.744…` (sem ÷ 0,81).
  - `G13` sem-ponte 1,01% do volume → as 14 linhas `dosagens_sem_ponte`; 0,99% → faixa calculada. Rejeitadas idem.
  - `G14` RLS: `SET ROLE authenticated` + GUC de customer → `v_corante_giro` sem linhas; staff → 14 linhas.
  - `G15` `reloptions` de `v_corante_giro` e `v_corante_consumo_diario` contém `security_invoker=on` (ou `=true`).
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** falsificações (`>=` no lugar de `>` em `G2`; `÷ 0,81` de volta em `G12`; `COALESCE(estoque_gl, 0)` em `G11`; denominador = 180 fixo em `G9`; tirar o piso da maior dosagem em `G5`) → cada uma vermelha só no seu G. **Passo 5:** verde em `C` e `pt_BR.UTF-8`; entrada no núcleo.
- [ ] **Passo 6:** commit `feat(tint): giro por corante — faixas, teto e excesso (advisory) [money-path]`.

### Task 4: Sensor da aba no ledger + consulta da reconciliação (gate da Fase 2)

**Arquivos:**
- Criar: `supabase/migrations/20261028100200_analytics_ledger_corantes.sql`. Molde de `20261020202720_analytics_ledger_venda_cliente.sql`: TRAVA → PRE (md5 vivo ∈ {`6eaf1d41626ece3a6fe6b51617788f21`, este}) → CREATE → PÓS exigindo todos os eventos antigos + `reposicao.corantes_aberta`.
- Modificar: `src/lib/analytics-ledger.ts` (membro `'reposicao.corantes_aberta'` no union `EventoLedger`); o teste de paridade `src/lib/__tests__/analytics-ledger-paridade.test.ts` tem de passar.
- Criar: `db/consultas/reconciliacao-corante-fase2.sql` (variáveis psql `:ate`; linha de base do §3 da spec embutida em `VALUES`) e `db/test-reconciliacao-corante.sh`.

**Interfaces:** a consulta devolve, por WP, `recebido_l`, `fisico_l`, `linha_base_l`, `retirado_l`, `dosado_l`, `elegivel`, `passa`; e uma linha agregada `veredito ∈ {passou, reprovou, nao_medido}` pelas regras do §11.2 da spec (elegível = `retirado >= 2 L`; ≥ 5 elegíveis; por WP `|dosado − retirado| <= C/1000 + 0,81` e `<= 25%` do retirado; agregado entre 0,85 e 1,15). O recebimento vem de `nfe_recebimento_itens` (o construtor confirma colunas e unidade com psql-ro antes).

- [ ] **Passo 1:** prova vermelha `R1` (dado consistente → `passou`), `R2` dosado zerado → `reprovou`, `R3` dosado × 1,95 → `reprovou`, `R4` só 4 WP elegíveis → `nao_medido`. **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** verde nos dois locales, `exit 0`.
- [ ] **Passo 5:** prova do ledger: aplicar a migration sobre o corpo predecessor → `analytics_ledger_registrar('reposicao.corantes_aberta', 'OBEN', '{}')` aceito; evento fora da allowlist recusado com a SQLSTATE atual da função.
- [ ] **Passo 6:** commit `feat(tint): sensor da aba Corantes + consulta da reconciliação da Fase 2`. **PR A**: abrir com o pré-voo de prod no corpo (md5 relidos), ligar o Auto-fix.

---

## PR B — Edge `tint-sync-agent`

### Task 5: Módulo puro de preparações

**Arquivos:**
- Criar: `supabase/functions/tint-sync-agent/preparacoes.ts`, `supabase/functions/tint-sync-agent/preparacoes_test.ts`

**Interfaces produzidas:**
```ts
export type ManifestoExtracao = { extracao_id: string; lote: number; total_lotes: number;
  modo: "backfill" | "incremental" | "rescan"; consultado_desde: string; consultado_ate: string };
export type ItemPreparacao = { ordem: number; id_corante_origem: string; codigo_corante_origem: string | null;
  qtd_ml: number; peso_especifico: number | null };
export type PreparacaoSaneada = { preparacao_id: string; data_dosagem: string; itens: ItemPreparacao[] };
export type RejeitadaSaneada = { preparacao_id: string; data_dosagem: string; motivo: string };
export type LotePreparacoes = { manifesto: ManifestoExtracao; preparacoes: PreparacaoSaneada[]; rejeitadas: RejeitadaSaneada[] };
export type ErroLote = { preparacao_id: string | null; motivo: string };   // NUNCA carrega o objeto bruto
export function sanearLotePreparacoes(body: unknown): { ok: true; lote: LotePreparacoes } | { ok: false; erros: ErroLote[] };
export function linhasDeStaging(lote: LotePreparacoes, ctx: { sync_run_id: string; account: string; store_code: string }): {
  preparacoes: Record<string, unknown>[]; itens: (prepIndex: number, stagingId: string) => Record<string, unknown>[]; manifesto: Record<string, unknown> };
```

- [ ] **Passo 1: testes Deno vermelhos** (`deno test --no-remote`):
  - `"descarta cliente e chaves fora da allowlist em todos os níveis"`: entrada com `cliente`, `preco`, `nome_cor`, `itens[0].cliente` → `JSON.stringify(lote)` não contém `cliente` nem `preco`.
  - `"preparação inválida reprova o lote inteiro"`: 3 válidas + 1 com `qtd_ml: 0` → `ok:false`, 1 erro com `preparacao_id` e `motivo: "qtd_ml_fora_da_faixa"`.
  - `"erro nunca carrega o objeto bruto"`: preparação inválida com `cliente: "Fulano"` → `JSON.stringify(erros)` não contém `Fulano`.
  - `"manifesto obrigatório e coerente"`: ausente → `manifesto_ausente`; `lote > total_lotes` → `manifesto_lote`; `consultado_desde >= consultado_ate` → `manifesto_janela`.
  - `"ordem 1..6 sem repetição na preparação"`: ordem 7 ou repetida → erro.
  - `"qtd_ml finita, > 0 e <= 18000"`: `NaN`, `Infinity`, `-1`, `18000.5` → erro; `18000` aceito.
  - `"delta vazio é um lote válido"`: `preparacoes: []`, `rejeitadas: []` com manifesto → `ok:true`.
  - `"linhasDeStaging não tem cliente e grava raw_data saneado"`.
- [ ] **Passo 2:** `bun run test:edges` → FAIL. **Passo 3:** implementar (teto `18000` como constante exportada `QTD_ML_MAX`, espelho do CHECK). **Passo 4:** PASS. **Passo 5:** commit.

### Task 6: Handler `/preparations`

**Arquivos:**
- Modificar: `supabase/functions/tint-sync-agent/index.ts:672-759` (handler), `:78-91` (remover `TintPreparacaoPayload`), `versao.ts` (`VERSAO = "v1.3-preparacoes-manifesto"`), `supabase/functions/_shared/sonda-fingerprints.ts` (gerado)
- Modificar, se a contagem mudar: as baselines de `src/__tests__/escrita-critica-gate.test.ts`, `single-shot-truncado-gate.test.ts`, `erro-object-object-gate.test.ts`
- Criar: `src/__tests__/tint-preparacoes-sem-cliente.test.ts` (vitest textual)

**Interfaces:** consome a Task 5 e `concluirEEnfileirar` (`index.ts:267`). Fluxo: `checkIdempotency` → `validateBatchSize(body, ["preparacoes","rejeitadas"])` → `sanearLotePreparacoes(body)` **antes de qualquer log** → `createSyncRun(agent, "preparations")` → lote inválido: `logError` só com `{preparacao_id, motivo}`, `completeSyncRun(…, "error")`, resposta `{ok:false, error_count, errors}`, sem staging nem fila → lote válido: 3 inserts em lote via `escritaCritica` (preparações+rejeitadas com `returning id`, itens, manifesto) → `concluirEEnfileirar(agent, runId, stats, resp)`.

- [ ] **Passo 1:** teste vitest vermelho, lendo `index.ts` como texto: no bloco `/preparations`, nenhuma chamada `logError(` recebe `p`, `body` nem `raw`; o bloco termina por `concluirEEnfileirar(`; nenhuma ocorrência de `cliente:`.
- [ ] **Passo 2:** FAIL. **Passo 3:** reescrever o handler. **Passo 4:** os 6 gates, cada um com `exit 0` colado:
  `bun run test:edges` · `bun run edges:typecheck` · `bun run edges:sintaxe` · `heavy bun run test` · `bun run sonda:bump tint-sync-agent` · `bun run sonda:fingerprint -- --write` (commitar o fingerprint).
- [ ] **Passo 5:** commit `feat(tint-sync-agent): /preparations com manifesto, saneada e enfileirada [money-path]`; **PR B** com Auto-fix ligado; deploy = chat Lovable depois do PR A aplicado.

---

## PR C — App

### Task 7: Leitura tipada da view

**Arquivos:**
- Modificar: `src/integrations/supabase/types.ts` (à mão: `v_corante_giro` em `Views`, com as colunas da Task 3; padrão do #2c9b8197e)
- Criar: `src/components/reposicao/corantes/types.ts`, `useGiroCorantes.ts`, `__tests__/useGiroCorantes.test.ts`
- Criar: `src/lib/reposicao/corantes-helpers.ts`, `src/lib/reposicao/__tests__/corantes-helpers.test.ts`

**Interfaces:**
- `type FaixaCorante = 'sem_recomendacao' | 'parado' | 'muito_pouco' | 'devagar' | 'rapido'`; `type GiroCorante` = linha da view com `faixa: FaixaCorante`.
- `paraGiroCorante(l: Tables<'v_corante_giro'>): GiroCorante` (lança fora do vocabulário, padrão `src/lib/financeiro/borda-tabelas.ts`).
- `useGiroCorantes(): { linhas: GiroCorante[] | undefined; query: UseQueryResult }`: `supabase.from('v_corante_giro').select('*').order('wp_codigo')`, `if (error) throw error; if (data == null) throw new Error('v_corante_giro: data=null sem error')`, `linhasCom(...)`.
- `regraDaFaixa(faixa: FaixaCorante, k: number | null): string`, com o texto exato da coluna "Regra" do §5.2 da spec (faixa 5: "Pedir quando, ao abrir uma lata, sobrarem {k} ou menos fechadas"). `rotuloMotivo(motivo: string): string` para os 9 motivos da Task 3.

- [ ] **Passo 1:** testes vermelhos: `regraDaFaixa('devagar', null)` === `"No máximo 1 lata fechada. Pedir 1 QT ao abrir a última."`; `regraDaFaixa('rapido', 2)` contém `"2 ou menos"`; `regraDaFaixa('sem_recomendacao', null)` === `"—"`; `paraGiroCorante` lança com `faixa: 'x'`; `rotuloMotivo` cobre os 9 motivos (teste por tabela).
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `heavy bun run test src/lib/reposicao src/components/reposicao/corantes` PASS. **Passo 5:** commit.

### Task 8: Aba "Corantes" + sensor

**Arquivos:**
- Criar: `src/components/reposicao/corantes/CorantesTab.tsx`, `CorantesTable.tsx`, `__tests__/CorantesTab.test.tsx`
- Modificar: `src/pages/AdminReposicaoBaixoGiro.tsx:109-119` (`TabsTrigger value="corantes"` só quando `useReposicaoEmpresa().empresa === 'OBEN'`) e o conteúdo `<TabsContent value="corantes"><CorantesTab /></TabsContent>`
- Modificar: `src/lib/modulos/manifesto.ts` (`testes` do módulo reposicao: os 3 testes novos)

**Comportamento:**
- Estado por `estadoDeLeitura(query)`: `carregando` → `<PageSkeleton variant="list" />`; `erro`/`sem-rede` → `<AvisoLeituraFalhou oque="o giro dos corantes" estado={…} />`; lista vazia → `<EmptyState tone="operational" title="Sem dado de cobertura" …>`.
- Colunas (§6 peça 4): WP · faixa · regra · consumo (ml/dia) · demanda do motor (L/dia) · ponto de pedido (ml) · LT (dias corridos + fonte) · estoque fechado (L) · teto (L) · excesso (L e R$) · confiança · frescor · motivo. Valor `null` → "—" (nunca 0). `giro_mudando` → selo "giro mudando". `fresco = false` → faixa "—" + "último cálculo: {faixa_ultimo_calculo} · desatualizado desde {coberto_ate}" (formatado em SP).
- Status por `text-status-*`. A aba não escreve; o texto do rodapé aponta para "Manter em estoque" e para o mínimo forçado.
- Sensor: ao montar com leitura `pronta`, `registrarNoLedger('reposicao.corantes_aberta', 'OBEN')` uma vez por montagem. Denominador para o §11.3 = dias úteis desde o Publish (query no PR).

- [ ] **Passo 1:** testes vermelhos (jsdom, supabase mockado, molde `AdminReposicaoBaixoGiro.erro-honesto.test.tsx`):
  - `"erro de leitura não vira 'sem consumo'"`: o mock devolve `error` → `data-testid` do `AvisoLeituraFalhou` presente, nenhum `"0 ml"` na tela.
  - `"null aparece como —"`: linha com `excesso_l: null` → célula "—".
  - `"desatualizado mostra o último cálculo"`: `fresco: false, faixa: 'sem_recomendacao', faixa_ultimo_calculo: 'devagar'` → textos "desatualizado desde" e "gira devagar".
  - `"registra o sensor uma vez quando pronta"`: `registrarNoLedger` chamado 1× com `('reposicao.corantes_aberta','OBEN')`; com erro de leitura, 0×.
  - `"aba só na OBEN"`: com o provider em `COLACOR`, o trigger "Corantes" não existe.
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `heavy bun run test` · `bun lint` · `bun run typecheck`, cada um com `exit 0`.
- [ ] **Passo 5:** commit `feat(reposicao): aba Corantes no baixo giro (advisory)`; **PR C** com Auto-fix.

---

## PR D — Conector `sayersync`

### Task 9: `ExtractDelta` rastreia o HWM pelo nome lógico (independe do passo 0)

**Arquivos:** modificar `connector/sayersync/pg.go:133` e `:199-224`; teste em `pg_test.go`.

**Interfaces:** extrair `func maxDataAtualizacao(rows []map[string]any) time.Time` (pura, lê `row["data_atualizacao"]`); `scanRows` passa a receber o nome lógico e delegar a ela.

- [ ] **Passo 1:** teste vermelho `TestExtractDelta_HWMComNomeFisicoDiferente`: o fixture `pg_test.go:202-224` (`data_atualizacao → data_alteracao`), 2 linhas montadas pelo mesmo caminho de chave lógica de `scanRows` → `maxDA` = a maior data. Sabotagem: devolver `time.Time{}` → vermelho.
- [ ] **Passo 2:** `cd connector/sayersync && go test ./... -run HWMComNome` FAIL. **Passo 3:** corrigir. **Passo 4:** `go test ./...` PASS (exit 0). **Passo 5:** commit `fix(sayersync): HWM do ExtractDelta lido pelo nome lógico`.

### Task 10: Validação por entidade e seam do `RunCycle` (independe do passo 0)

**Arquivos:** `mapping.go` (`resolveMapping`, :428-458), `sync.go` (:591-632), testes em `mapping_test.go`/`sync_test.go`.

**Interfaces:**
- `var entidadesIsoladas = map[string]bool{"vendas_item": true}`; `ResolvedMapping.Isoladas map[string]EstadoIsolada`, com `type EstadoIsolada struct{ OK bool; Faltando []string }`. Coluna ausente de entidade isolada nunca entra em `diff.Missing` nem derruba `diff.OK`.
- Seams de pacote: `var conectar = Connect`, `var validar = Validate`, `var novoExtractor = func(db *sql.DB, rm *ResolvedMapping) Extractor { return &pgExtractor{db, rm} }`.

- [ ] **Passo 1:** testes vermelhos: `TestResolveMapping_VendasItemQuebradoNaoDerrubaCatalogo` (`diff.OK == true`, `rm.Isoladas["vendas_item"].OK == false`); `TestRunCycle_VendasItemQuebradoCatalogoSegue` (seams falsos; `produto` enviado a `/catalogs`, `vendas_item` registrado em `failed`).
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `go test ./...` PASS. **Passo 5:** commit.

### Task 11: Entidade `vendas_item` — 🚧 só após o passo 0

**Parâmetros que o passo 0 preenche (nada mais fica em aberto):** `P0.chave` (coluna da chave única) · `P0.corante` (`id` numérico ou código) · `P0.unidade` (`ml` ou `g`) e a fonte do peso específico se for `g` · `P0.data` (coluna física de `data_dosagem`) · `P0.status` (coluna/valor que separa dosagem executada; ausente = toda linha conta) · teto de `qtd` (ajusta `QTD_ML_MAX`, o CHECK e o espelho na edge).

**Arquivos:** `mapping.go` (entrada `vendas_item` em `expectedMappings`, `:309-322`, com `data_atualizacao ← P0.data` e os slots `corante1..6`/`qtd1..6` resolvidos por `flatFormulaSlotCandidates`), `pg.go` (`buildDeltaSelectCols` e a agregação incluem `vendas_item`), novo `preparacoes.go` + `preparacoes_test.go`.

**Interfaces:** `func montarPreparacoes(rows []map[string]any, lk *Lookups) (validas []PreparacaoEnvio, rejeitadas []RejeitadaEnvio)`; `PreparacaoEnvio`/`RejeitadaEnvio` = o contrato do payload (sem campo `cliente` no struct). Não usa `traduzItensCorante`: `id_corante_origem` = bruto, `codigo_corante_origem = lk.CoranteIdent[bruto]` (ausente → `null`; a ponte é pelo bruto).

- [ ] **Passo 1:** testes vermelhos: slots com corante denso (WP07, 1,95) e `P0.unidade = g` → `qtd_ml = g ÷ 1,95` com `peso_especifico = 1.95` no item; slot com corante sem qtd → preparação inteira em `rejeitadas` com `slot_parcial`; `json.Marshal` de uma preparação montada de linha COM `cliente` não contém `cliente`; id bruto `"12"` + código `"WP07"` separados.
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `go test ./...` PASS + sabotagem de valor de predicado (`ml = g × peso` no lugar de `÷`) → vermelho. **Passo 5:** commit.

### Task 12: `syncPreparacoes` — manifesto, piso e re-scan (contrato fixo; colunas do passo 0)

**Arquivos:** `sync.go` (novo `syncPreparacoes`, registro em `runEntityCycles` via `record("vendas_item", …)`, `clearAllHWM` preserva `vendas_item`), `api.go` (`AgentResponse.SyncRunID string \`json:"sync_run_id"\``), testes em `sync_test.go`.

**Interfaces:**
- `const pisoPreparacoesDias = 400`, `const janelaRescanPreparacoesDias = 35`.
- `func desdePreparacoes(st *State, originNow time.Time, rescan bool) (desde time.Time, modo string)`: sem HWM → `originNow − 400 d`, `backfill`; `rescan` → `max(originNow − 400 d, min(hwm, originNow − 35 d))`, `rescan`; senão `max(originNow − 400 d, hwm)`, `incremental`.
- `func syncPreparacoes(ctx, ex Extractor, cli *Client, st *State, counts map[string]int, rm *ResolvedMapping, lk *Lookups, originNow time.Time, rescan bool) error`: extrai a partir de `desde`; `consultado_ate = originNow`; lotes de até 1000 (válidas + rejeitadas); `extracao_id` novo por chamada; POST `/preparations` mesmo com delta vazio (1 lote vazio); `advanceHWM` só se TODOS os lotes `loteConfirmado`.

- [ ] **Passo 1:** testes vermelhos com `fakeExtractor` + `captureServer`: delta vazio → exatamente 1 POST com `total_lotes = 1` e `preparacoes = []`; 2.500 linhas → 3 POSTs com o mesmo `extracao_id` e lotes 1..3; lote 2 com `ok:false` → HWM inalterado; `desdePreparacoes` sem HWM = `originNow − 400 d`; com `rescan = true` e HWM ontem = `originNow − 35 d`; `iniciarFullRescan` não apaga `st.HWM["vendas_item"]`; nenhum corpo capturado contém `cliente`.
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `go test ./...` PASS. **Passo 5:** `./release.sh 0.3.0` (entidade nova = minor); registrar o sha256 no PR. **Passo 6:** commit, **PR D** com Auto-fix.

---

## Verificação de pronto (por camada, com evidência)

- Migrations aplicadas (envelope da sessão ou SQL Editor) → psql-ro: as 5 tabelas, as 2 colunas + 14 linhas de seed, a ACL de `tint_promote_preparacoes`, `reloptions` das views, o md5 do tick pós-patch, a allowlist do ledger.
- Edge → `bun run pendencias:deploy` mostra `tint-sync-agent` com `v1.3-preparacoes-manifesto` servido + sonda.
- Conector → heartbeat `agent_version = 0.3.0`; `tint_consumo_cobertura` com `coberto_desde` ≈ a primeira dosagem e `coberto_ate` < 4 dias; `tint_sync_runs` `preparations` todos `promovido`.
- Publish → `lovable-deploy-verify`; a aba abre com 14 linhas.
- Capacidade → o Lucas confirma o canister do "400"; `UPDATE tint_corantes SET capacidade_confirmada = true …` → psql-ro.
