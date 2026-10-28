# Giro de corante WP — Fase 1 (advisory): plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: superpowers:executing-plans (nativo nesta sessão) ou superpowers:subagent-driven-development. Passos em checkbox (`- [ ]`).

**Objetivo:** coletar as dosagens da Dnaxis (`vendas_item` do SayerSystem) com cobertura provada, gravar o consumo por corante e mostrar, por WP, faixa, regra de pedido e excesso numa aba "Corantes" do baixo giro, sem mudar o motor de compra.

**Arquitetura:** o **servidor planeja** a extração. A cada ciclo, o conector pede a `/preparations/plano` até 2 janelas por **data de dosagem**, alinhadas à meia-noite SP: a frente, ou o re-scan, e uma de cura do buraco mais antigo. Para cada janela, ele extrai e envia lotes de preparações com um **manifesto de extração** a `/preparations`. Sem HWM local para preparações. A edge saneia (sem `cliente`), grava no staging e enfileira o run. O tick da fila (raia própria para preparações) despacha para a nova `tint_promote_preparacoes`, que converge o fato por preparação (monotônico por versão) e registra cada extração completa e coerente. A **cobertura é derivada**: a ilha mais recente da união das extrações completas, a partir da primeira dosagem promovida, contando só dias SP inteiros. Uma função `SECURITY INVOKER` com relógio por parâmetro calcula o giro, a view o expõe, e o app só renderiza.

**Stack:** Go 1.26 (`connector/sayersync`) · Postgres 17 / Supabase (migrations + `db/test-*.sh`) · Deno (edge `tint-sync-agent`) · React 18 + TS strict + vitest.

**Spec:** `docs/superpowers/specs/2026-10-27-giro-corante-reposicao-design.md`. O plano argumenta a partir dela: leia as duas.

## Restrições globais

- Responder e nomear em pt-BR. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Motor de compra intocado: nenhuma escrita em `sku_parametros` nem mudança em `gerar_pedidos_sugeridos_ciclo`; a Fase 1 só LÊ `sku_parametros`, `sku_estoque_atual` e `inventory_position`.
- Nunca editar migration existente. Migrations novas: `20261028100000_…`, `20261028100100_…`, `20261028100200_…` (a última da main é `20261028000116`). Re-conferir antes do PR.
- Ausente ≠ zero: nada de `?? 0`, `COALESCE(x, 0)` ou `Number(null)` em grandeza de consumo, estoque ou dinheiro.
- `cliente` não entra no payload do conector, nem no staging, nem em `raw_data`, nem em `tint_sync_errors`.
- Constantes da política só em `public.tint_corante_constantes()`: `V = 365` d · `u = 810` ml (lata QT) · `H = 180` d · frescor `4` d corridos · cobertura mínima `60` d · cobertura plena `180` d · limite sem-ponte/rejeitada `0,01` · regime: janela `60` d, fator `2` · extração: piso `400` d, janela máxima `35` d, janela inicial `7` d, alvo `10` lotes por janela, máximo `20` lotes por extração, revisita a cada `7` d nos últimos `35` d e a cada `30` d antes disso, fila máxima `6` runs pendentes por loja, plano válido por `30` min, compactação depois de `2` d, tolerância do relógio da origem `10` min. O conector não tem constante de política, só executa o plano. A única exceção é o espelho de `QTD_ML_MAX`, com teste de paridade.
- Fuso: dia = `America/Sao_Paulo` (`(ts AT TIME ZONE 'America/Sao_Paulo')::date`). Proibido `current_date`, `now()::date` e `date_trunc` sem fuso (gates `fuso-da-sessao-*`, `relogio-nu-da-sessao-gate`).
- View: `WITH (security_invoker = on)`. Funções SECDEF: `SET search_path = public, pg_temp`, `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` provado por `has_function_privilege`.
- `CREATE OR REPLACE` de função viva: molde TRAVA → PRE (md5 do `prosrc` vivo) → CREATE → PÓS, **com dois ramos**: md5 = predecessor → substitui; md5 = o do corpo novo → só verifica (re-apply = no-op); qualquer outro → `RAISE`. md5 lidos de prod em 2026-10-27: `tint_promocao_tick` = `d0e3beb394c932ad1979da5efc910943`, `analytics_ledger_registrar` = `6eaf1d41626ece3a6fe6b51617788f21`. Re-ler com psql-ro imediatamente antes de aplicar. O md5 do corpo novo sai do harness (primeiro verde) e é fixado no arquivo.
- Edge: os 6 gates (`test:edges` sem afrouxar `--no-remote` · `edges:typecheck` · `edges:sintaxe` · `bun run test` · `sonda:bump` · `sonda:fingerprint -- --write`).
- Provas SQL: `prove-sql-money-path` — PG17 executando a migration real, asserts negativos por SQLSTATE, falsificação com controle verde na mesma invocação, `HARNESS_LOCALE=C` e `pt_BR.UTF-8`; marca positiva `PASS=<n>  FAIL=<m>` + `exit 0` colado.

## Correções à spec (decididas no plano, vão ao Codex)

1. **Capital parado = excesso (L) × `cmc` do QT**, sem `÷ 0,81`. Medido em prod: os WP têm `unidade = 'L'` no Omie e `inventory_position.cmc` já é R$/L (WP01 QT: 101,08/L). A fórmula da spec inflaria o capital em 23%.
2. **Cabeçalho por preparação** (`tint_consumo_preparacao`) além do fato por item: a versão monotônica precisa sobreviver a uma preparação cujos itens sumiram, e as rejeitadas na origem precisam de lugar, sem item, para entrar no denominador.
3. **Versão de uma preparação = (`started_at`, `id`) do run: a ordem de CHEGADA no servidor** (Codex 2, P1 #2). O relógio da origem pode regredir, então `consultado_em` só prova a janela (`>= janela_ate`, `<= started_at + 10 min`) e nunca ordena versões. A chegada é monótona na consulta porque há um agente por loja, que extrai e envia as janelas em sequência (Task 12). Um run antigo reprocessado nunca vence.
4. **Rejeitadas na origem contam como ausência:** fração > 1% das preparações da janela → faixa 1 (gêmeo do limite de sem-ponte).
5. **Retenção do staging por estado:** a própria promoção apaga o staging do run, na mesma transação. `tint_staging_purge` (md5 + pós-condição de 9 DELETEs) não é tocada. Um replay do run já aplicado é reconhecido pelo registro durável do lote (`ja_aplicado`, `ok:true`, sem efeito).
6. **Teto do `CHECK` de `qtd_ml` = `18000` ml, permanente:** é limite FÍSICO, porque uma preparação não dosa mais corante que o volume da maior embalagem (BH, 18 L). O passo 0 não o altera. Se um dia precisar mudar, entra uma migration nova; a de A não é editada.
7. **Dado parado ≥ 4 dias** (`coberto_ate <= p_agora − 4 d`, igualdade incluída): `faixa = 'sem_recomendacao'` (motivo `dado_desatualizado`); `faixa_ultimo_calculo` traz a faixa da janela que termina na fronteira de cobertura, que a tela mostra como "último cálculo".
8. **`d = 0` com cobertura entre 60 e 179 dias** → faixa 1, motivo `sem_consumo_cobertura_parcial` (a spec só define "parado" com cobertura plena).
9. **Plano de extração no servidor, por data de dosagem (Codex P0/P1, 2026-10-27).** Substitui o HWM de `data_alteracao` e a tabela `tint_consumo_cobertura`. A cobertura é derivada: as extrações **completas e coerentes** (`tint_consumo_extracoes`) formam ilhas por união de intervalos meio-abertos `[janela_desde, janela_ate)`. A ilha que contém o `janela_ate` mais recente é a cobertura. Dia coberto = dia SP **inteiro** dentro da ilha e ≥ o dia SP da primeira dosagem promovida da loja (spec §5.3: "entre a primeira dosagem da fonte e a fronteira"). Buraco de qualquer idade dentro do piso se cura sozinho: o plano manda uma janela de cura do buraco mais antigo a cada ciclo, sem segurar a frente. O **servidor emite o `extracao_id`** (`tint_consumo_planos`) e admite uma extração em voo por loja. Cada dia coberto é **relido** (`rescan`) a cada 7 d nos últimos 35 d e a cada 30 d antes disso (Codex 2, P1 #1): uma edição antiga converge em até 30 d. O tamanho da janela se adapta à densidade de preparações por dia. A spec (§6/§7) fala em HWM e em `tint_consumo_cobertura`. O mecanismo é do construtor (§6, "o mecanismo é do construtor") e a semântica de cobertura da spec fica preservada.
10. **Consumidor próprio das preparações** (Codex 2, P1 #5): `tint_preparacoes_tick()`, com lock e cron próprios. O tick atual só passa a EXCLUIR runs `preparations` (um predicado). Uma preparação lenta, travada ou em backoff não segura catálogos, fórmulas nem snapshots, cuja ordem relativa fica idêntica. A mensagem de `ok:false` do consumidor nomeia `tint_promote_preparacoes`.
11. **`demanda_motor_l_dia` desconhecida quando falta parcela esperada:** GL existente sem linha em `sku_parametros` → `NULL` (não soma só o QT).
12. **Compactação das extrações** (Codex 2, P2): a frente roda a cada ciclo (~144 extrações/dia). Extração completa há mais de 2 d e contida noutra completa, consultada depois, é apagada (com plano e lotes). A cobertura e a revisita não mudam. Fica ~1 extração por dia SP.

## Parecer Codex 1 (2026-10-27, `logs/giro-corante/codex-plano.out`): onde cada achado foi resolvido

P0 cobertura fabricada → correção 9 + P16/G9 · P1#2 re-scan não cura → plano com janela de `cura` + P15/P17 · #3 lotes incoerentes → `tint_consumo_extracoes` imutável + contagens + P13/P14 · #4 relógio/limite superior → `janela_ate = min(ate, originNow)`, `consultado_em >= janela_ate`, tolerância de 10 min, sem `time.Now()` para preparações · #5 identidade → `preparacao_id` único + ids gerados na edge · #6 replay após poda → `ja_aplicado` (P3/P3b) · #7 re-apply do patch → `CREATE OR REPLACE` inteiro com PRE de dois ramos · #8 `greatest(0, NULL)` → `CASE` (G11) · #9 G5 não falsificava → fixture esparsa · #10 seams → resolução real + `test-pg17.sh` · #11 `CoranteIdent` → `lk.CoranteCodigo` · #12 lote venenoso → anomalia na origem = rejeitada, `extracao_id` novo por ciclo · #13 privacidade → `processarPreparacoes` executado com sentinela · #14 isolamento do tick → raia + `fila_cheia` (P18) · #15 deploy → teto físico permanente + publicação do Storage explícita · P2#16 → frescor estrito + correção 11 · P2#17 → mensagem nomeia o RPC.

## Parecer Codex 2 (2026-10-27, `logs/giro-corante/codex-plano2.out`): P0 encerrado; os P1 novos

#1 edição antiga nunca relida → revisita 7 d/30 d (correção 9, P19) · #2 regressão do relógio → versão pela chegada (correção 3, P3) · #3 lotes incoerentes e idempotência cega → faixa de ids por lote + `lotes_sobrepostos` + chave idempotente com hash (P13) · #4 `fila_cheia` não limita → `extracao_id` do servidor + `em_andamento` + `max_lotes` (P17) · #5 tick global → consumidor próprio (correção 10, P18 com lock segurado por outra sessão) · #6 rescan > 35 d → termina na meia-noite de hoje (P17 às 15h) · P2 piso móvel e custo → P15 + compactação (correção 12, P20) · teatro de P15/P17/P3/P18 → aninhados, simulação ponta a ponta (P19), regressão do relógio, lock real.

## Parecer Codex pré-merge do PR A (2026-10-28, `logs/giro-corante/codex-pra.out`)

Recebido somava `quantidade_nfe` (prod: as 4 NF de WP têm `quantidade_conferida = 0`) → só NF conferida por inteiro conta, senão o WP não é medido (R8) · elegibilidade desconhecida aprovava o gate → `nao_medido` (R7) · `capacidade_confirmada` com capacidade NULL virava 810 ml → CHECK `confirmada ⇒ capacidade` + gate · compactação destruía o replay → recibo durável `tint_consumo_runs_aplicados` (P20.replay) · esperados das falsificações do giro preenchidos · P2: P90 discriminante (G16) e desvios opostos (R6).

## Parecer Codex PR B (2026-10-28, `logs/giro-corante/codex-prb.out`, gpt-6-astra · max · 627 s)

1 P1 + 4 P2, nenhum P0; sem vazamento de `cliente` demonstrado. P1 200 sem enfileiramento em loja `shadow_mode`/`csv_only` → `modoPromove` recusa (422 `modo_sem_promocao`) antes de qualquer escrita, também no plano · P2 falha transitória prendia a chave em 409 até o plano expirar → a falha de escrita libera `idempotency_key` do run em `error` · P2 ns × µs do Postgres (`…59.9999999` arredonda para o `ate`) e `Date.parse` normalizando `02-30` → `instanteNs` recusa fração além do µs e data inexistente · P2 faixa mais larga que o lote passava na edge e caía na promoção → extremos = min/max exatos · P2 plano com `max_lotes: 0`, `motivo` fora do vocabulário ou `desde > ate` → 500. Cada correção tem teste que fica vermelho sob a sabotagem correspondente (falsificação com 13 sabotagens, controle verde na mesma invocação). Prod (2026-10-28): a única loja (`oben/M01`) está em `automatic_primary`.

## Parecer Codex PR C (2026-10-28, `logs/giro-corante/codex-prc.out`, gpt-6-astra · max · 464 s)

3 P1 + 1 P2, nenhum P0; as 26 colunas/tipos à mão conferem com o SQL. P1 `motivo`/`confianca`/`lt_fonte` com vocabulário aberto deixavam a aba "pronta" → `paraGiroCorante` lança (aviso de leitura, sensor não dispara) · P1 regra da faixa rápida sem unidade de `k` → "latas QT; GL conta pelo equivalente em QT" · P1 gate de empresa: `AdminReposicaoBaixoGiro` não tem `ReposicaoEmpresaProvider` (vale para a página inteira, que lê sempre o default `OBEN`); a view é só OBEN por construção, então a aba rotula "OBEN" e não mostra dado de outra empresa — ligar a página ao seletor global é outra entrega · P2 capital nulo com excesso conhecido sem teste → teste novo. Falsificação: 9 sabotagens vermelhas, controle verde.

## Parecer Codex PR D, Tasks 9–10 (2026-10-28, `logs/giro-corante/codex-prd.out`, gpt-6-astra · max · 352 s)

Sem P0/P1; 4 P2. Plano aceitava qualquer 2xx (um 202 com zero janelas virava "nada a fazer") → exige 200 exato · `motivo`/cardinalidade/UUID do plano não validados → vocabulário, ≤ 2 janelas, UUID · o `continue` da entidade isolada tirava a entrada legada da `vendas_item` do fingerprint (mudava a identificação do schema em prod) → a entrada LEGADA volta intocada ao `expectedMappings` e a isolada é resolvida num laço à parte; teste fixa os hashes do 0.2.x (origin/main 083d25745) em 3 schemas · falha isolada sumia do resultado (`once` saía 0) → sucesso do catálogo governa o full re-scan, sucesso global exige as isoladas. Falsificação: 10 sabotagens vermelhas, controle verde. Follow-up: a edge não persiste `last_cycle_errors` do heartbeat; até lá, uma `vendas_item` quebrada aparece como `dado_desatualizado` na aba (fail-closed).

Tasks 11–12: 🚧 aguardam o passo 0 do founder (não entregues neste PR).

## Foco de revisão (falhas que nenhum teste "natural" pegaria)

1. Um lote da extração falha na promoção, e a lacuna envelhece além de 35 dias → a cobertura para para sempre, ou uma extração posterior "pula" o buraco. Esperado: a ilha recente não atravessa o buraco, e o plano manda uma janela de cura do buraco mais antigo, de qualquer idade dentro do piso, até ele fechar. Prova P15/P17 (Task 2).
2. Lote com uma preparação inválida → a edge grava a metade válida e a cobertura alega o dia. Esperado: nada é gravado, `ok:false`, run `error`, sem enfileirar. Teste na Task 6.
3. Cobertura começando no meio de um dia (16h55) ou antes da primeira dosagem → dias inteiros fabricados. Esperado: só dias SP inteiros e ≥ o dia da primeira dosagem. Prova P16 (Task 2) e G9 (Task 3).
4. GL existe no Omie, mas sem linha em `sku_estoque_atual` → `greatest(0, NULL) = 0` vira excesso zero. Esperado: estoque `NULL` → excesso e capital `NULL` ("—"). Prova G11 (Task 3).
5. Usuário `customer` lê a view → precisa receber 0 linhas (RLS via `security_invoker`), não o giro. Prova G14 (Task 3).

## Ordem de entrega (PRs) e deploy

| PR | Tasks | Bloqueio |
|---|---|---|
| A — banco | 1–4 | nenhum |
| B — edge | 5–6 | contrato da Task 1 |
| C — app | 7–8 | view da Task 3 |
| D — conector | 9–12 | 9–10: nenhum · 11–12: **passo 0 do founder** |

Deploy: migrations A → edge B → conector D → Publish C. A aba mostra "sem dado de cobertura" até o conector rodar, o que é honesto. O conector: `./release.sh 0.3.0` só gera `dist/` e NÃO publica. O founder sobe no Storage (bucket `releases`, pasta `sayersync/`) **primeiro o `.exe`, depois o `manifest.json`**, e só depois de A aplicada (psql-ro) e B servida (`pendencias:deploy`). Um conector novo contra uma edge velha manda `/preparations/plano` a uma rota inexistente: falha isolada da entidade, sem dano, mas sem dado.

---

## Contrato do payload `/preparations` (fixado agora; o passo 0 só muda como o conector o PREENCHE)

**Plano** (`POST /preparations/plano`, corpo `{}`; resposta da edge = o jsonb de `tint_consumo_plano_extracao`):

```jsonc
{ "ok": true, "janelas": [ { "extracao_id": "uuid (emitido pelo servidor)",
                             "modo": "backfill" | "incremental" | "rescan" | "cura",
                             "desde": "RFC3339 (meia-noite SP)", "ate": "RFC3339" } ],   // 0..2 janelas
  "max_lotes": 20,
  "motivo": "em_andamento" | "fila_cheia" | null }
```

O conector extrai, por janela, as preparações com `desde <= data_dosagem < ate_efetivo`, onde `ate_efetivo = min(ate, originNow)`. Sem `originNow` (falha da consulta ao relógio da origem), a entidade falha isolada no ciclo, nunca com `time.Now()`. Cada janela é UMA extração, com o `extracao_id` do plano e 1..N lotes. As preparações saem **ordenadas por `preparacao_id` em ordem de bytes** (a de Go = `COLLATE "C"`), e os lotes são fatias contíguas dessa ordem. Mais de `max_lotes` → não envia a janela e a entidade falha no ciclo, fechada.

**Lote** (`POST /preparations`, cabeçalho `Idempotency-Key = <extracao_id>:<lote>`; a edge usa como chave efetiva `<cabeçalho>:<sha256 do lote saneado canônico>`, então um reenvio com corpo diferente não recebe a resposta antiga e cai em `lote_duplicado` na promoção):

```jsonc
{
  "manifesto": {
    "extracao_id": "uuid",            // um por janela; todos os lotes compartilham, com metadados IDÊNTICOS
    "lote": 1, "total_lotes": 3,      // 1 ≤ lote ≤ total_lotes; janela sem dosagem = 1 lote vazio
    "modo": "backfill" | "incremental" | "rescan" | "cura",   // o da janela do plano
    "janela_desde": "RFC3339",        // = janela.desde
    "janela_ate": "RFC3339",          // = ate_efetivo; > janela_desde
    "consultado_em": "RFC3339",       // originNow lido ANTES da consulta; >= janela_ate
    "n_preparacoes": 812, "n_rejeitadas": 3, "n_itens": 2240,  // contagens DESTE lote
    "primeira_preparacao_id": "…" | null, "ultima_preparacao_id": "…" | null   // faixa do lote (válidas+rejeitadas); null só no lote vazio
  },
  "preparacoes": [{
    "preparacao_id": "texto não vazio",
    "data_dosagem": "RFC3339",
    "itens": [{ "ordem": 1, "id_corante_origem": "12", "codigo_corante_origem": "WP07" | null,
                "qtd_ml": 12.5, "peso_especifico": 1.95 | null }]   // 1 ≤ ordem ≤ 6, qtd finita > 0
  }],
  "rejeitadas": [{ "preparacao_id": "…", "data_dosagem": "RFC3339", "motivo": "slot_parcial" | "corante_nao_resolvido" | "unidade" | "peso_especifico_ausente" | "qtd_fora_da_faixa" }]
}
```

Allowlist: qualquer outra chave, em qualquer nível, é descartada antes de validar, gravar ou logar. `preparacoes.length + rejeitadas.length ≤ 1000` (`MAX_BATCH_ITEMS`). `preparacao_id` único no lote, válidas e rejeitadas juntas. Toda `data_dosagem` dentro de `[janela_desde, janela_ate)`. As contagens do manifesto batem com o corpo.

**Anomalia conhecida da origem ≠ violação de protocolo** (Codex P1 #12). Quantidade fora de `(0, QTD_ML_MAX]`, slot parcial, peso ausente e corante sem id são classificados pelo **conector** como `rejeitadas`. Isso entra no denominador da faixa 1 e não trava a entidade. Um item "válido" que viole a faixa, uma duplicata, uma data fora da janela ou uma contagem divergente é bug de protocolo: o lote inteiro é reprovado (`ok:false`, nada gravado, diagnóstico `{preparacao_id, motivo}`). O plano seguinte repete a janela com `extracao_id` novo, sem 409 de idempotência. Um lote venenoso persistente para só aquela janela: a frente fica desatualizada e aparece como `dado_desatualizado`, falhando FECHADO, nunca como cobertura falsa.

---

## PR A — Banco

### Task 1: Tabelas, staging saneado, capacidade e constantes

**Arquivos:**
- Criar: `supabase/migrations/20261028100000_tint_consumo_corante.sql` (Tasks 1 e 2 no mesmo arquivo: deploy atômico)
- Criar: `db/test-tint-consumo-corante.sh`
- **Depois do apply em prod** (PR próprio, carimbo regravado — registrar antes trava o CI em `CARIMBO_CONTRATO_MUDOU`, #2199): `scripts/authz-tabelas-fechadas.ts` + `scripts/authz-grants.test.ts` com as 6 `tint_consumo_*` e `tint_staging_preparacao_manifestos`

**Interfaces produzidas:**
- `tint_corante_constantes() RETURNS TABLE(validade_dias int, lata_ml numeric, lata_l numeric, horizonte_dias int, frescor_dias int, cobertura_min_dias int, cobertura_plena_dias int, limite_ausencia numeric, regime_janela_dias int, regime_fator numeric, piso_dias int, janela_max_dias int, rescan_janela_dias int, rescan_intervalo_dias int, fila_max_pendentes int, relogio_tolerancia interval)` mais `janela_inicial_dias int, lotes_alvo int, max_lotes_extracao int, revisita_recente_janela_dias int, revisita_recente_dias int, revisita_antiga_dias int, plano_validade interval, compactacao_idade interval` no lugar de `rescan_janela_dias`/`rescan_intervalo_dias`, `IMMUTABLE`, valores das Restrições globais (`lata_l = 0.81`, `relogio_tolerancia = '10 minutes'`, `plano_validade = '30 minutes'`, `compactacao_idade = '2 days'`).
- `tint_consumo_planos(extracao_id uuid PK DEFAULT gen_random_uuid(), account text NOT NULL, store_code text NOT NULL, modo text NOT NULL CHECK (modo IN (…4…)), janela_desde timestamptz NOT NULL, janela_ate timestamptz NOT NULL, criado_em timestamptz NOT NULL, expira_em timestamptz NOT NULL, CHECK (janela_desde < janela_ate))`; índice `(account, store_code, expira_em)`. `tint_consumo_extracoes.extracao_id` → FK para `tint_consumo_planos ON DELETE CASCADE`; `tint_consumo_extracao_lotes.extracao_id` → `ON DELETE CASCADE`.
- `tint_corantes`: `+ capacidade_canister_ml numeric NULL CHECK (capacidade_canister_ml IS NULL OR (capacidade_canister_ml > 0 AND capacidade_canister_ml < 'Infinity'))`, `+ capacidade_confirmada boolean NOT NULL DEFAULT false`. Seed: `capacidade_canister_ml = 2300` onde `account = 'oben' AND omie_product_id IS NOT NULL` (os 14 WP), confirmada `false`.
- `tint_staging_preparacoes`: `+ rejeicao_motivo text NULL`; `CHECK (cliente IS NULL)`; `CHECK (raw_data IS NULL OR NOT raw_data ? 'cliente')`. A coluna `data_preparacao` passa a carregar a `data_dosagem`.
- `tint_staging_preparacao_itens`: `+ codigo_corante text NULL`, `+ peso_especifico numeric NULL`. `id_corante` = id bruto da origem.
- `tint_staging_preparacao_manifestos(sync_run_id uuid PK REFERENCES tint_sync_runs ON DELETE CASCADE, account text NOT NULL, store_code text NOT NULL, extracao_id uuid NOT NULL, lote int NOT NULL, total_lotes int NOT NULL, modo text NOT NULL CHECK (modo IN ('backfill','incremental','rescan','cura')), janela_desde timestamptz NOT NULL, janela_ate timestamptz NOT NULL, consultado_em timestamptz NOT NULL, n_preparacoes int NOT NULL CHECK (n_preparacoes >= 0), n_rejeitadas int NOT NULL CHECK (n_rejeitadas >= 0), n_itens int NOT NULL CHECK (n_itens >= 0), primeira_preparacao_id text NULL, ultima_preparacao_id text NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK (1 <= lote AND lote <= total_lotes), CHECK (janela_desde < janela_ate), CHECK (janela_ate <= consultado_em), CHECK ((primeira_preparacao_id IS NULL) = (ultima_preparacao_id IS NULL)), CHECK (primeira_preparacao_id IS NULL OR primeira_preparacao_id COLLATE "C" <= ultima_preparacao_id COLLATE "C"))`. Os lotes de extração ganham as mesmas 2 colunas.
- `tint_consumo_preparacao(account, store_code, preparacao_id text, data_dosagem timestamptz NOT NULL, situacao text NOT NULL CHECK (situacao IN ('valida','rejeitada')), motivo_rejeicao text, versao_fonte_em timestamptz NOT NULL, run_criado_em timestamptz NOT NULL, sync_run_id uuid NOT NULL, PRIMARY KEY (account, store_code, preparacao_id))`, sem FK para `tint_sync_runs` (a poda de runs não pode apagar fato).
- `tint_consumo_corante(account, store_code, preparacao_id, ordem int CHECK (ordem BETWEEN 1 AND 6), id_corante_origem text NOT NULL, codigo_corante_origem text, tint_corante_id uuid NULL REFERENCES tint_corantes, qtd_ml numeric NOT NULL CHECK (qtd_ml > 0 AND qtd_ml <= 18000 AND qtd_ml <> 'NaN'), peso_especifico numeric, data_dosagem timestamptz NOT NULL, sync_run_id uuid NOT NULL, run_criado_em timestamptz NOT NULL, PRIMARY KEY (account, store_code, preparacao_id, ordem), FOREIGN KEY (account, store_code, preparacao_id) REFERENCES tint_consumo_preparacao ON DELETE CASCADE)`; índice `(account, tint_corante_id, data_dosagem)`.
- `tint_consumo_extracoes(extracao_id uuid PK, account text NOT NULL, store_code text NOT NULL, modo text NOT NULL, janela_desde timestamptz NOT NULL, janela_ate timestamptz NOT NULL, consultado_em timestamptz NOT NULL, total_lotes int NOT NULL CHECK (total_lotes >= 1), criada_em timestamptz NOT NULL, completa_em timestamptz NULL, CHECK (janela_desde < janela_ate AND janela_ate <= consultado_em))`. Os metadados são IMUTÁVEIS: o 1º lote cria a linha, e os seguintes têm de bater campo a campo. Índice `(account, store_code, janela_ate) WHERE completa_em IS NOT NULL`.
- `tint_consumo_extracao_lotes(extracao_id uuid REFERENCES tint_consumo_extracoes, lote int CHECK (lote >= 1), sync_run_id uuid NOT NULL UNIQUE, n_preparacoes int NOT NULL, n_rejeitadas int NOT NULL, n_itens int NOT NULL, promovido_em timestamptz NOT NULL, PRIMARY KEY (extracao_id, lote))`. `lote <= total_lotes` é garantido pela promoção (CHECK não cruza tabela). PK + faixa ⇒ "`count = total_lotes`" equivale a "exatamente os lotes `1..N`".
- Sem tabela de cobertura: a cobertura é derivada (Task 2, `tint_consumo_cobertura_em`).
- As 4 `tint_consumo_*` e a de manifestos: RLS ligada. Policy SELECT `has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role)` (a mesma de `tint_staging_preparacoes`). `REVOKE INSERT, UPDATE, DELETE` de `anon`, `authenticated` e `service_role` nas `tint_consumo_*` (só a promoção SECDEF escreve). A de manifestos aceita INSERT do `service_role` (a edge grava).

- [ ] **Passo 1: prova vermelha.** Em `db/test-tint-consumo-corante.sh` (molde de `db/test-tint-promocao-assincrona.sh`: harness, snapshot VIVO `supabase/schema-snapshot.sql` (já traz o tick e o staging de preparações), `MIG=` com a migration real, modo `--falsificar`), escrever:
  - `C1` CHECK de `qtd_ml`: `0`, `-1`, `'NaN'`, `'Infinity'`, `18000.001` → `23514` cada (captura a SQLSTATE e re-lança o resto); `18000` e `0.01` aceitos.
  - `C2` staging: INSERT com `cliente = 'X'` → `23514`; com `raw_data = '{"cliente":"X"}'` → `23514`.
  - `C3` manifesto: `lote = 0`, `lote > total_lotes`, `janela_desde = janela_ate`, `consultado_em < janela_ate`, `n_itens = -1`, `modo = 'x'` → `23514`.
  - `C4` seed: exatamente 14 linhas `capacidade_canister_ml = 2300 AND capacidade_confirmada IS FALSE` no account `oben` (o teste semeia os 14 WP + 1 PU sem `omie_product_id`; o PU fica NULL).
  - `C5` ACL/RLS: `SET ROLE authenticated` com GUC de um customer → `SELECT` nas 4 tabelas devolve 0 linhas; INSERT direto como `authenticated` e `service_role` em `tint_consumo_corante` → `42501`.
  - `C6` re-apply: rodar a migration duas vezes → mesmo estado (idempotência).
- [ ] **Passo 2:** `bash db/test-tint-consumo-corante.sh` → FAIL (migration ausente).
- [ ] **Passo 3:** escrever a parte DDL da migration: idempotente (`IF NOT EXISTS`, `DO` condicional para constraints), sem `BEGIN/COMMIT` quando aplicada por `bun run db:aplicar` (ver `docs/agent/database.md` §1, envelope), com bloco `DO $post$` final que confere cada objeto por `to_regclass`/`to_regprocedure`, as constraints por `pg_constraint` e o seed por contagem.
- [ ] **Passo 4:** prova verde nos dois locales: `HARNESS_LOCALE=C bash db/test-tint-consumo-corante.sh` e `HARNESS_LOCALE=pt_BR.UTF-8 …` → `FAIL=0`, `exit 0`.
- [ ] **Passo 5:** commit `feat(tint): tabelas do consumo de corante + staging saneado [money-path]`.

### Task 2: Promoção `tint_promote_preparacoes`, cobertura, plano e consumidor próprio

**Arquivos:**
- Modificar: `supabase/migrations/20261028100000_tint_consumo_corante.sql` (mesma migration, ainda não aplicada)
- Modificar: `db/test-tint-consumo-corante.sh`
- Re-exercer: `db/test-tint-promocao-assincrona.sh` com a migration nova no `MIG=`

**Interfaces:**
- Produz: `public.tint_promote_preparacoes(p_run_id uuid) RETURNS jsonb`, SECDEF, `search_path` fixo, ACL fechada. Retorno `{ok, acao: 'aplicado'|'ja_aplicado', preparacoes_aplicadas, preparacoes_ignoradas_mais_antigas, itens, itens_sem_ponte, rejeitadas, extracao: 'incompleta'|'completa'}`. `ok:false` com `motivo ∈ {tipo_errado, sem_manifesto, extracao_nao_planejada, contagem_divergente, preparacao_duplicada, preparacao_fora_da_faixa_do_lote, dosagem_fora_da_janela, relogio_origem_adiantado, extracao_grande, item_invalido, extracao_divergente, lote_fora_da_faixa, lote_duplicado, lotes_sobrepostos}`, sem gravar nada.
- Produz: `public.tint_consumo_cobertura_em(p_agora timestamptz) RETURNS TABLE(account text, store_code text, primeira_dosagem_dia date, ilha_desde timestamptz, ilha_ate timestamptz, primeiro_dia_coberto date, ultimo_dia_coberto date, lacuna_desde timestamptz)`, `STABLE SECURITY INVOKER`, uma linha por loja com extração completa:
  - ilhas = união das `[janela_desde, janela_ate)` das extrações com `completa_em IS NOT NULL` e `janela_ate > piso`, onde `piso = meia-noite SP de (p_agora − piso_dias)`. A união é por **máximo acumulado** do `ate` (aninhados e encostados fundem; `LAG(ate)` simples NÃO serve).
  - `ilha_*` = a ilha com o maior `ate`. `primeira_dosagem_dia` = dia SP de `min(data_dosagem)` em `tint_consumo_preparacao` da loja (válidas e rejeitadas).
  - `primeiro_dia_coberto` = `greatest(1º dia SP inteiro da ilha, primeira_dosagem_dia, dia SP do piso)`, onde o 1º dia inteiro = o dia de `ilha_desde` se for meia-noite SP, senão o seguinte. `ultimo_dia_coberto` = dia SP de `ilha_ate` − 1. `primeiro > ultimo` ou `primeira_dosagem_dia IS NULL` → os dois NULL.
  - `lacuna_desde` = o primeiro instante ≥ `piso` não coberto por ilha nenhuma, se for anterior a `ilha_desde`; senão NULL. Uma ilha que começou no piso de ONTEM ainda contém o piso de hoje: não é lacuna.
- Produz: `public.tint_consumo_plano_extracao(p_account text, p_store_code text, p_agora timestamptz) RETURNS jsonb`, SECDEF, ACL fechada (só `service_role`). Emite até 2 janelas `{extracao_id, modo, desde, ate}` e registra cada uma em `tint_consumo_planos` (`expira_em = p_agora + plano_validade`). Toda `desde` é meia-noite SP, e toda janela tem no máximo `w` dias:
  1. Existe plano da loja não expirado e sem extração completa → `{ok:true, janelas:[], motivo:'em_andamento'}`. ≥ `fila_max_pendentes` runs `preparations` pendentes → `motivo:'fila_cheia'`. É a admissão: uma extração em voo por loja, nunca a mesma janela duas vezes ao mesmo tempo.
  2. `w` = `least(janela_max_dias, greatest(1, floor(lotes_alvo · 1000 / densidade)))`, onde `densidade` = o maior nº de preparações num dia SP da loja (últimos `piso_dias`). Sem nenhuma preparação ainda → `janela_inicial_dias`.
  3. Frente: sem ilha → `[piso, least(piso + w, p_agora))`, `backfill`. Com ilha → `[meia-noite SP do dia de ilha_ate, least(+w, p_agora))`, `incremental`.
  4. Mais UMA, na ordem: **cura** (se `lacuna_desde`): `[meia-noite SP do dia de lacuna_desde, least(+w, p_agora))`. Senão **revisita**: `última_leitura(d)` = o maior `consultado_em` das extrações completas cuja janela contém o dia SP `d` inteiro. O dia coberto mais atrasado (`última_leitura < p_agora − revisita_recente_dias` para `d ≥ hoje − revisita_recente_janela_dias`; `− revisita_antiga_dias` para os mais velhos; ordem: maior atraso, depois o dia mais antigo) → `[meia-noite SP de d, least(+w, meia-noite SP de hoje))`, `rescan`. Janela vazia (d = hoje) → não emite.
- Produz: `public.tint_preparacoes_tick() RETURNS jsonb`, SECDEF, ACL fechada, **consumidor próprio** (correção 10): FIFO por loja só dos runs `preparations`, com lock `hashtext('tint_preparacoes_tick')` e as mesmas regras do tick (status `complete` exigido, 3 tentativas com backoff, `ok:false` → `erro` direto com a mensagem nomeando `tint_promote_preparacoes`). Cron `tint-preparacoes-tick` a cada minuto, comando com `SET statement_timeout = '50s'` (o padrão do cron do tick).
- Produz: o tick atual só EXCLUI preparações: `CREATE OR REPLACE` do corpo inteiro, partindo do corpo do snapshot vivo, que no harness tem de dar md5 `d0e3beb394c932ad1979da5efc910943` (asserção, não suposição). Diferença única: o ramo de runs da CTE `fila` ganha `AND sr.sync_type IS DISTINCT FROM 'preparations'`. A ordem catálogo→fórmula→snapshot fica intocada. PRE de dois ramos (Restrições globais); PÓS: md5 = o novo, e `has_function_privilege` de `anon`/`authenticated`/`PUBLIC` = false nas 4 funções SECDEF.
- Compactação (correção 12): `public.tint_consumo_compactar(p_agora timestamptz) RETURNS int`, SECDEF, chamada pelo consumidor quando a fila esvazia (relógio real) e pelas provas (relógio simulado). Idade medida por `consultado_em`: apaga planos e extrações (em cascata com os lotes) completas há mais de `compactacao_idade` cuja janela está contida na de outra extração completa com `consultado_em` ≥. Também apaga planos expirados há mais de `compactacao_idade` sem extração. A cobertura (P15) e a revisita ficam iguais antes e depois (prova P20).

Regras da promoção (o corpo é do construtor; os testes fixam), em ordem:
1. Run não é `preparations` → `tipo_errado`. Já existe linha em `tint_consumo_extracao_lotes` com este `sync_run_id` → `{ok:true, acao:'ja_aplicado'}`, sem efeito (replay depois da poda). Sem manifesto → `sem_manifesto`.
2. Identidade: `extracao_id` ∈ `tint_consumo_planos` da mesma loja, com o mesmo `modo` e `janela_desde`, e `janela_ate <= ate planejado` → senão `extracao_nao_planejada`. A expiração do plano NÃO recusa um lote atrasado: ela só libera um novo plano.
3. Coerência do lote: as contagens do staging = `n_*` do manifesto; `preparacao_id` único no run; todo id em `[primeira_preparacao_id, ultima_preparacao_id]` sob `COLLATE "C"`; toda `data_dosagem` em `[janela_desde, janela_ate)`; `consultado_em <= run.started_at + relogio_tolerancia`; `total_lotes <= max_lotes_extracao`. Senão, o `motivo` correspondente.
4. Coerência da extração: sem linha em `tint_consumo_extracoes` → cria. Com linha → `janela_ate`, `consultado_em` e `total_lotes` batem, senão `extracao_divergente`. `lote > total_lotes` → `lote_fora_da_faixa`. `(extracao_id, lote)` já gravado por outro run → `lote_duplicado`. Faixa `[primeira, ultima]` que cruza a de outro lote da extração → `lotes_sobrepostos`. Assim a mesma preparação não aparece em dois lotes de uma extração "completa".
5. Versão do run = (`run.started_at`, `run.id`): a ORDEM DE CHEGADA no servidor (correção 3). Por preparação: cabeçalho existente com versão ≥ → ignora (conta). Senão faz upsert do cabeçalho (`valida`, ou `rejeitada` com o motivo), apaga TODOS os itens da preparação e insere os do run, resolvendo `tint_corante_id` por `tint_corantes(account = run.account, id_corante_sayersystem = id_corante_origem)`; sem match → `NULL`, mantido e contado.
6. Grava o lote (com a faixa de ids); se `count(lotes) = total_lotes` → `completa_em = clock_timestamp()`; compacta.
7. Apaga o staging do run (preparações em cascata com os itens, mais o manifesto) na mesma transação.

- [ ] **Passo 1: provas vermelhas** (seed: os 14 WP, 1 PU, runs `preparations` `complete` + `promocao_status = 'pendente'` montados como a edge os monta, via helper `_t_lote(run, extracao, lote, total, specs[])`, com a extração saída de um `tint_consumo_plano_extracao` real ou de um plano semeado). Cada cenário chama `tint_preparacoes_tick()` até `fila_vazia`, nunca a promoção direta (prova o consumidor):
  - `P1` o mesmo conteúdo em duas extrações → mesmas linhas, mesma `sum(qtd_ml)`, mesmo `count`.
  - `P2` edição na origem: a extração 2 traz X com os slots trocados de ordem e um a menos → itens de X = exatamente os da 2; soma sem dobrar.
  - `P3` versão = chegada: o run B chega DEPOIS do A com `consultado_em` MENOR (relógio da origem regrediu) → B vence nos ids comuns. Cura de janela antiga promovida depois de um rescan → a cura vence nos ids comuns.
  - `P3b` replay depois da poda: B volta a `pendente` → `acao = 'ja_aplicado'`, `promovido`, estado idêntico (md5).
  - `P4` independência da ordem de PROMOÇÃO: 3 runs com chegada distinta, promovidos em permutações (o `started_at` fixa a versão) → estado final idêntico (`md5(string_agg(... ORDER BY ...))`).
  - `P5` corante `99` sem ponte → `tint_corante_id IS NULL`, `itens_sem_ponte = 1`.
  - `P6` extração de 2 lotes, só o 1 promovido → `completa_em IS NULL` e `tint_consumo_cobertura_em` sem a loja; o 2 promovido → completa, a ilha = a janela.
  - `P7` janela sem dosagem: 1 lote vazio → extração completa, ilha criada.
  - `P8` rejeitada: X chega rejeitada (sem itens) → cabeçalho `rejeitada`, 0 itens; depois chega válida (run posterior) → `valida` com itens.
  - `P9` staging do run promovido apagado (0 linhas nas 3 tabelas de staging daquele run); o run em `erro` mantém o staging.
  - `P10` separação dos consumidores: `tint_promocao_tick()` deixa o run `preparations` `pendente` (`fila_vazia`), e `tint_preparacoes_tick()` não toca o run `catalogs`.
  - `P11` ACL: `has_function_privilege` de `anon`, `authenticated` e `PUBLIC` em `tint_promote_preparacoes(uuid)`, `tint_consumo_plano_extracao(text,text,timestamptz)`, `tint_preparacoes_tick()` e `tint_promocao_tick()` = false; chamada como `authenticated` → `42501`.
  - `P12` recusas determinísticas, cada uma vira `erro` sem retry, nada gravado e a mensagem nomeando `tint_promote_preparacoes`: sem manifesto · `extracao_id` fora dos planos · `n_itens` divergente · `preparacao_id` repetido · id fora da faixa do lote · `data_dosagem = janela_ate` · `consultado_em = started_at + 11 min` · `total_lotes = 21`.
  - `P13` extração divergente: lote 2 com `consultado_em` ou `total_lotes` diferentes → `extracao_divergente`; lotes 1 `[A..M]` e 2 `[K..Z]` → `lotes_sobrepostos`; a extração nunca completa.
  - `P14` `lote_duplicado`: outro run com o mesmo `(extracao_id, lote)` → recusado; o lote original segue.
  - `P15` ilhas: E1 `[d0, d35)` completa, E2 `[d35, d70)` com o lote em `erro`, E3 `[d70, d105)` completa → ilha recente = `[d70, d105)`, `lacuna_desde = d35`; E4 `cura` `[d35, d70)` completa 90 dias depois → ilha `[d0, d105)`, `lacuna_desde` NULL. Aninhados `[0,35)`, `[5,10)`, `[30,60)`, inseridos em 3 ordens diferentes → UMA ilha `[0,60)`. Piso móvel: a ilha que começou no piso de ontem → `lacuna_desde` NULL hoje.
  - `P16` dias inteiros e primeira dosagem: ilha `[16h55 do dia D, …)` → `primeiro_dia_coberto = D+1`; backfill a partir do piso com a 1ª dosagem em D+40 → `primeiro_dia_coberto = D+40`. Sessão em `TZ=UTC` e `America/Sao_Paulo` → mesmo resultado.
  - `P17` plano (às 15h SP, nunca à meia-noite): sem ilha → 1 janela `backfill` de `janela_inicial_dias` no piso; plano em voo → `em_andamento`, 0 janelas; 6 pendentes → `fila_cheia`; com buraco → frente + `cura`; sem buraco e um dia da última semana lido há 8 dias → frente + `rescan` terminando na meia-noite de hoje; densidade de 2.000/dia → `w = 5`; nenhuma janela com mais de `w` dias, toda `desde` à meia-noite SP.
  - `P18` isolamento de execução: uma 2ª sessão segura o lock do consumidor de preparações (`pg_advisory_lock(hashtext('tint_preparacoes_tick'))`) e uma linha de `tint_consumo_preparacao` em transação aberta; o `tint_promocao_tick()` desta sessão promove o `catalogs` pendente em menos de 5 s.
  - `P19` convergência ponta a ponta (simulação no próprio PG, relógio por parâmetro): uma tabela-fonte `_t_fonte` com 400 dias de dosagens; laço de 236 ciclos de 6 h (59 dias simulados), lotes de 40: `plano → extrai de _t_fonte pela janela → monta o lote como a edge → tick de preparações` (promovendo só em ciclos alternados, para atrasar um ciclo); no dia 20, uma dosagem de D−100 muda de 10 para 100 ml na fonte. Ao fim: `lacuna_desde` NULL, `ilha_ate` a menos de 12 h (2 ciclos) do fim, o fato = a fonte (soma e contagem por WP), e a edição de D−100 refletida até `revisita_antiga_dias` + 1 dia depois.
  - `P20` compactação: depois de P19, as extrações são ≤ ~1 por dia SP mais as dos últimos 2 dias, e `tint_consumo_cobertura_em` + o plano seguinte são idênticos aos de antes da compactação.
- [ ] **Passo 2:** rodar → FAIL.
- [ ] **Passo 3:** implementar as funções, o consumidor + cron e o tick na migration; fixar o md5 novo do tick.
- [ ] **Passo 4:** falsificações na MESMA invocação, após o controle verde, sabotando uma camada por vez, cada uma exigindo o conjunto exato de vermelhos: (a) versão por `consultado_em` → `P3`; (b) upsert de itens no lugar de "apaga e insere" → `P2`; (c) completar sem conferir `total_lotes` → `P6`; (d) sem o teste de sobreposição de faixas → `P13`; (e) união por `LAG(ate)` → `P15`; (f) dia de `ilha_desde` contado mesmo sem meia-noite → `P16`; (g) plano sem a admissão `em_andamento` → `P17`; (h) o tick atual sem o filtro de preparações → `P10`; (i) revisita desligada → `P19`; (j) compactação sem exigir "contida" → `P20`.
- [ ] **Passo 5:** verde em `C` e `pt_BR.UTF-8`, controle e `--falsificar`. O tick atual fica provado por `P10.patch_so_predicado`: desfazer a troca do predicado no corpo novo devolve EXATAMENTE o md5 do predecessor, então nada além do predicado mudou, e a prova antiga (`test-tint-promocao-assincrona.sh`, snapshot de 2026-09-05) segue valendo para o resto do corpo. Re-apply da migration inteira (C6) → no-op, incluindo o ramo "md5 já é o novo" do tick e o `cron.schedule` idempotente.
- [ ] **Passo 6:** registrar `db/test-tint-consumo-corante.sh` em `db/nucleo-ci.txt`; `bash db/roda-nucleo-ci.sh` verde.
- [ ] **Passo 7:** commit `feat(tint): promoção de preparações convergente + consumidor próprio [money-path]`.

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
- Cobertura = `tint_consumo_cobertura_em(p_agora)` (Task 2); `coberto_ate = ilha_ate`. Janela: `fim = ultimo_dia_coberto`; `inicio = fim − 179`. Dias cobertos = `[greatest(inicio, primeiro_dia_coberto), fim]`. `fresco = coberto_ate > p_agora − 4 dias` (estrito: exatamente 4 dias já é desatualizado).
- `d` = Σ `qtd_ml` dos itens válidos daquele WP nos dias cobertos ÷ `dias_cobertos`. `d60` idem nos últimos 60 dias da janela. `giro_mudando = d > 0 AND (d60 > 2·d OR d60 < d/2)`.
- LT: `n_sku = ceil(greatest(lt_medio_dias_uteis, lt_p95_dias))` de `sku_parametros` (`empresa = 'OBEN'`). Âncora = QT (`tint_corantes.omie_product_id → omie_products.omie_codigo_produto`); GL = `omie_products` (account `oben`) com descrição `^WPnn\.3900GL`, onde `WPnn` sai de `^(WP[0-9]{2})\.3900QT` do QT. Cadeia QT → GL → `percentile_disc(0.5)` dos `n` dos WP com fonte própria. `LTc = n + 2·ceil(n/5)`.
- `s = greatest(d·LTc, P90 das somas em janelas deslizantes de LTc dias inteiramente cobertas, maior dosagem única)` (`greatest` ignora NULL; sem janela inteira, o P90 é NULL).
- `u = least(810, capacidade_canister_ml)`. Faixa: `parado` se (`d = 0` e `dias_cobertos >= 180`) ou (`d > 0` e `u/d > 365`); `muito_pouco` se `2u/d − LTc > 365`; `devagar` se `s <= u`; senão `rapido` com `k = ceil((s − u)/u)`.
- Teto (L): parado/muito_pouco `0` · devagar `0.81` · rápido `(k+1)·u/1000`. Estoque fechado = `estoque_fisico` QT + GL de `sku_estoque_atual` (`empresa = 'OBEN'`); GL inexistente no Omie → parcela 0; GL existe e sem linha de estoque → `NULL`. `excesso = CASE WHEN estoque IS NULL OR teto IS NULL THEN NULL ELSE greatest(0, estoque − teto) END`. Atenção: no Postgres, `greatest(0, NULL)` dá `0`, e é por isso que o `CASE` tem de vir antes. `capital = excesso × inventory_position.cmc` do QT (`account = 'oben'`); `cmc` NULL → capital NULL.
- `demanda_motor_l_dia` = Σ `sku_parametros.demanda_media_diaria` QT + GL (L/dia). NULL se o QT não tiver, ou se o GL existir no Omie sem linha/valor em `sku_parametros` (correção 11).
- Faixa 1 prevalece sobre as outras: `faixa = 'sem_recomendacao'` com o primeiro `motivo` que casar. `faixa_ultimo_calculo` = a faixa ignorando só o motivo `dado_desatualizado`. `confianca = 'baixa'` se `dias_cobertos < 180`.
- Sem-ponte: Σ `qtd_ml` com `tint_corante_id IS NULL` ÷ Σ `qtd_ml` total, na janela, > 0,01 → faixa 1 em TODOS. Rejeitadas: `count(situacao = 'rejeitada')` ÷ `count(*)` dos cabeçalhos na janela > 0,01 → idem.
- `mais_de_uma_loja`: mais de um `store_code` do account `oben` em `tint_consumo_cobertura_em(p_agora)`.
- O seed das provas G monta a cobertura por extrações completas (`tint_consumo_extracoes` + lotes), não por coluna, para passar pelo mesmo caminho da produção.

- [ ] **Passo 1: provas vermelhas** (cada uma chama `tint_corante_giro_em('<instante fixo>')`, seed por SQL direto nas tabelas da Task 1 como `postgres`):
  - `G1` borda `s = u`: d·LTc = 810 exatos → `devagar`; +0,001 ml/dia → `rapido` com `k = 1`.
  - `G2` borda `2u/d − LTc = 365` → NÃO é `muito_pouco` (`>` estrito); 1 ml a menos no período → `muito_pouco`.
  - `G3` borda `u/d = 365` → não `parado`; um pouco abaixo de `d` → `parado`.
  - `G4` `d = 0` com 180 dias cobertos → `parado`; `d = 0` com 120 dias → `sem_recomendacao/sem_consumo_cobertura_parcial`; 59 dias → `cobertura_insuficiente`.
  - `G5` P90 = 0 com consumo esparso: 2 dosagens de 30 ml, a ~90 dias uma da outra, em 180 dias cobertos, LT = 5 → `LTc = 7`; 14 das 174 janelas de 7 dias são não-nulas → P90 = 0; `d·LTc ≈ 2,33` → exigir `ponto_pedido_ml = 30` exato (o piso da maior dosagem decide). A falsificação "sem o piso" dá 2,33 → vermelho.
  - `G6` `capacidade_confirmada = false` → `capacidade_nao_confirmada`; `true` → faixa calculada.
  - `G7` duas lojas na cobertura → as 14 linhas `mais_de_uma_loja`.
  - `G8` frescor: `p_agora = coberto_ate + 4 dias − 1 s` → fresco; `+ 4 dias` exatos → `dado_desatualizado` e `faixa_ultimo_calculo` = a faixa de antes. Rodar também com a sessão em `TZ=UTC` e em `America/Sao_Paulo` → mesmo resultado.
  - `G9` dia sem linha fora da cobertura não vira zero: dosagens em 10 dias, cobertura só nos 5 últimos → `d` usa 5 dias. Ilha começando às 16h55 → aquele dia não entra no denominador.
  - `G10` LT: WP sem LT no QT e com GL `lt_medio = 7` → `lt_fonte = 'GL'`, `LTc = 11`; sem os dois → `mediana_wp`; nenhum WP com LT → `lt_sem_fonte`.
  - `G11` estoque: GL existe e sem linha em `sku_estoque_atual` → `estoque_fechado_l IS NULL`, `excesso_l IS NULL`, `capital_parado IS NULL`; GL inexistente → só o QT. GL existe sem `sku_parametros` → `demanda_motor_l_dia IS NULL`.
  - `G12` capital: excesso 1,62 L × cmc 101,076754 → `163.744…` (sem ÷ 0,81).
  - `G13` sem-ponte 1,01% do volume → as 14 linhas `dosagens_sem_ponte`; 0,99% → faixa calculada. Rejeitadas idem.
  - `G14` RLS: `SET ROLE authenticated` + GUC de customer → `v_corante_giro` sem linhas; staff → 14 linhas.
  - `G15` `reloptions` de `v_corante_giro` e `v_corante_consumo_diario` contém `security_invoker=on` (ou `=true`).
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** falsificações (`>=` no lugar de `>` em `G2`; `÷ 0,81` de volta em `G12`; `COALESCE(estoque_gl, 0)` em `G11`; `greatest(0, estoque − teto)` sem o `CASE` em `G11`; `>=` no frescor em `G8`; denominador = 180 fixo em `G9`; tirar o piso da maior dosagem em `G5`) → cada uma vermelha só no seu G. **Passo 5:** verde em `C` e `pt_BR.UTF-8`; entrada no núcleo.
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
  modo: "backfill" | "incremental" | "rescan" | "cura"; janela_desde: string; janela_ate: string; consultado_em: string;
  n_preparacoes: number; n_rejeitadas: number; n_itens: number };
export type ItemPreparacao = { ordem: number; id_corante_origem: string; codigo_corante_origem: string | null;
  qtd_ml: number; peso_especifico: number | null };
export type PreparacaoSaneada = { preparacao_id: string; data_dosagem: string; itens: ItemPreparacao[] };
export type RejeitadaSaneada = { preparacao_id: string; data_dosagem: string; motivo: string };
export type LotePreparacoes = { manifesto: ManifestoExtracao; preparacoes: PreparacaoSaneada[]; rejeitadas: RejeitadaSaneada[] };
export type ErroLote = { preparacao_id: string | null; motivo: string };   // NUNCA carrega o objeto bruto
export function sanearLotePreparacoes(body: unknown): { ok: true; lote: LotePreparacoes } | { ok: false; erros: ErroLote[] };
// ids dos cabeçalhos gerados AQUI (novoId), e cada item já sai com o staging_preparacao_id explícito:
// nada depende da ordem do `returning` (Codex P1 #5).
export function linhasDeStaging(lote: LotePreparacoes, ctx: { sync_run_id: string; account: string; store_code: string; novoId: () => string }): {
  preparacoes: Record<string, unknown>[]; itens: Record<string, unknown>[]; manifesto: Record<string, unknown> };
// Handler testável, com dependências injetadas: o index.ts só monta `deps` e delega.
export type DepsPreparacoes = { createSyncRun: (...) ; inserir: (tabela: string, linhas: Record<string, unknown>[]) => Promise<void>;
  logError: (runId: string, tipo: string, id: string | null, msg: string, det: Record<string, unknown>) => Promise<void>;
  completeSyncRun: (...); concluirEEnfileirar: (...); novoId: () => string };
export async function processarPreparacoes(corpoTexto: string, agent: AgentCtx, deps: DepsPreparacoes): Promise<{ status: number; corpo: Record<string, unknown> }>;
```
(`(...)` = as assinaturas atuais de `index.ts`; o construtor as copia.)

- [ ] **Passo 1: testes Deno vermelhos** (`deno test --no-remote`):
  - `"descarta cliente e chaves fora da allowlist em todos os níveis"`: entrada com `cliente`, `preco`, `nome_cor`, `itens[0].cliente` → `JSON.stringify(lote)` não contém `cliente` nem `preco`.
  - `"preparação inválida reprova o lote inteiro"`: 3 válidas + 1 com `qtd_ml: 0` → `ok:false`, 1 erro com `preparacao_id` e `motivo: "qtd_ml_fora_da_faixa"`.
  - `"erro nunca carrega o objeto bruto"`: preparação inválida com `cliente: "Fulano"` → `JSON.stringify(erros)` não contém `Fulano`.
  - `"manifesto obrigatório e coerente"`: ausente → `manifesto_ausente`; `lote > total_lotes` → `manifesto_lote`; `janela_desde >= janela_ate` ou `consultado_em < janela_ate` → `manifesto_janela`; `n_*` ≠ corpo → `manifesto_contagem`.
  - `"preparacao_id único no lote"`: repetido entre válidas, ou entre válida e rejeitada → `preparacao_duplicada`.
  - `"dosagem dentro da janela"`: `data_dosagem = janela_ate` → `dosagem_fora_da_janela`.
  - `"itens apontam o cabeçalho pelo id, não pela posição"`: `linhasDeStaging` com `novoId` determinístico → cada item tem o `staging_preparacao_id` do SEU cabeçalho (2 preparações, itens embaralhados no teste).
  - `"ordem 1..6 sem repetição na preparação"`: ordem 7 ou repetida → erro.
  - `"qtd_ml finita, > 0 e <= 18000"`: `NaN`, `Infinity`, `-1`, `18000.5` → erro; `18000` aceito.
  - `"delta vazio é um lote válido"`: `preparacoes: []`, `rejeitadas: []` com manifesto → `ok:true`.
  - `"linhasDeStaging não tem cliente e grava raw_data saneado"`.
- [ ] **Passo 2:** `bun run test:edges` → FAIL. **Passo 3:** implementar (teto `18000` como constante exportada `QTD_ML_MAX`, espelho do CHECK). **Passo 4:** PASS. **Passo 5:** commit.

### Task 6: Handler `/preparations`

**Arquivos:**
- Modificar: `supabase/functions/tint-sync-agent/index.ts:672-759` (handler), `:78-91` (remover `TintPreparacaoPayload`), `versao.ts` (`VERSAO = "v1.3-preparacoes-plano-manifesto"`), `supabase/functions/_shared/sonda-fingerprints.ts` (gerado)
- Modificar, se a contagem mudar: as baselines de `src/__tests__/escrita-critica-gate.test.ts`, `single-shot-truncado-gate.test.ts`, `erro-object-object-gate.test.ts`
- Criar: `src/__tests__/tint-preparacoes-sem-cliente.test.ts` (vitest textual)

**Interfaces:** consome a Task 5, `concluirEEnfileirar` (`index.ts:267`) e `tint_consumo_plano_extracao` (Task 2).
- `/preparations`: `checkIdempotency` (não lê o corpo) → o corpo como TEXTO → `processarPreparacoes(texto, agent, deps)`. Dentro: `JSON.parse` em `try` com erro FECHADO (`{ok:false, error:"corpo_invalido"}`, sem a mensagem da exceção) → `validateBatchSize` → `sanearLotePreparacoes` **antes de qualquer log** → `createSyncRun(agent, "preparations")` → lote inválido: `logError` só com `{preparacao_id, motivo}`, `completeSyncRun(…, "error")`, `{ok:false, error_count, errors}`, sem staging nem fila → lote válido: 3 inserts via `escritaCritica` (cabeçalhos com id próprio, itens, manifesto) → `concluirEEnfileirar`. O `catch` genérico da rota responde `{ok:false, error:"erro_interno"}` e loga só o nome da exceção. Se o `index.ts` hoje lê `req.json()` antes de rotear, a rota passa a ler `req.text()` no próprio ramo.
- `/preparations/plano`: autentica como as outras rotas e chama `rpc("tint_consumo_plano_extracao", {p_account, p_store_code, p_agora: new Date().toISOString()})`. Erro do RPC → `{ok:false}` 500, nunca "janelas vazias".

- [ ] **Passo 1:** testes vermelhos.
  - Deno (`preparacoes_test.ts`), **executando o handler** com `deps` falsos que capturam tudo: corpo com sentinela `"cliente":"CPF 123.456.789-09 Fulano"` (válido, inválido e JSON quebrado) → a sentinela não aparece em nenhum `logError`, em nenhuma resposta, em nenhuma linha passada a `inserir`. JSON quebrado → `corpo_invalido`, 0 chamadas a `createSyncRun`.
  - vitest textual: no ramo `/preparations` de `index.ts`, nenhuma ocorrência de `cliente:`, `req.json()` nem `logError(` com `p`/`body`/`raw`; o ramo delega a `processarPreparacoes(`.
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

### Task 9: Cliente do plano e janela efetiva (independe do passo 0)

**Sem HWM para preparações** (correção 9): o conector não guarda estado da entidade. O bug do `ExtractDelta` (`pg.go:133` procura o nome FÍSICO num mapa de chaves LÓGICAS, então o `maxDA` fica zerado e o catálogo faz full scan a cada ciclo) não é tocado: corrigir ali ligaria o delta de verdade no catálogo de produção, o que é mudança fora do escopo. Vira follow-up com decisão própria.

**Arquivos:** `api.go` (`PlanoPreparacoes`), novo `preparacoes_plano.go` + `preparacoes_plano_test.go`.

**Interfaces:**
- `type JanelaPlano struct{ Modo string \`json:"modo"\`; Desde time.Time \`json:"desde"\`; Ate time.Time \`json:"ate"\` }`; `func (c *Client) PlanoPreparacoes(ctx context.Context) ([]JanelaPlano, error)` → `POST /preparations/plano` com `{}`; `ok:false` ou HTTP ≠ 200 → erro (nunca "zero janelas").
- `func janelaEfetiva(j JanelaPlano, originNow time.Time) (JanelaPlano, bool)`: `Ate = min(j.Ate, originNow)`; `false` se `Ate <= Desde`.

- [ ] **Passo 1:** testes vermelhos (`captureServer`): `TestPlano_OkFalseEhErro`; `TestPlano_500EhErro`; `TestPlano_DuasJanelas` (desserializa `modo/desde/ate`); `TestJanelaEfetiva_CortaNoRelogioDaOrigem` (origem 3 h atrás do servidor → `Ate = originNow`); `TestJanelaEfetiva_OrigemAntesDoDesde` → `false`.
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `go test ./...` PASS (exit 0). **Passo 5:** commit `feat(sayersync): cliente do plano de extração de preparações`.

### Task 10: Validação por entidade e seam do `RunCycle` (independe do passo 0)

**Arquivos:** `mapping.go` (`resolveMapping`, :428-458), `sync.go` (:591-640), testes em `mapping_test.go`/`sync_test.go`, novo `test-pg17.sh`.

**Interfaces:**
- `var entidadesIsoladas = map[string]bool{"vendas_item": true}`; `ResolvedMapping.Isoladas map[string]EstadoIsolada`, com `type EstadoIsolada struct{ OK bool; Faltando []string }`. Coluna ou tabela ausente de entidade isolada nunca entra em `diff.Missing` nem derruba `diff.OK`.
- Seams de pacote: `var conectar = Connect`, `var validar = Validate`, `var novoExtractor = func(db *sql.DB, rm *ResolvedMapping) Extractor { return &pgExtractor{db, rm} }`.
- `RunCycle`: a falha de `OriginNow` continua caindo em `time.Now()` para o catálogo (comportamento atual), mas a entidade `vendas_item` é marcada `failed` naquele ciclo e não roda (Codex P1 #4).

- [ ] **Passo 1:** testes vermelhos, passando pela resolução REAL (Codex P1 #10):
  - `TestResolveMapping_VendasItemAusenteNaoDerrubaCatalogo`: o mapa de colunas descobertas sem a tabela → `diff.OK == true`, `rm.Isoladas["vendas_item"].OK == false`. Idem com a tabela presente e os slots `qtd*` ausentes.
  - `TestRunCycle_VendasItemQuebradoCatalogoSegue`: `validar` = `resolveMapping` real sobre um mapa falso (só a consulta ao `information_schema` é contornada) → `produto` vai a `/catalogs`, e `vendas_item` fica em `failed`.
  - `TestRunCycle_SemOriginNowPreparacoesNaoRodam`: `OriginNow` com erro → nenhum POST a `/preparations*`.
  - `TestPG17_ValidateDescobreVendasItem` (só roda com `SAYERSYNC_PG17_URL`): `Validate` real contra um PG17 descartável com uma `vendas_item` mínima; o mesmo sem a tabela. `test-pg17.sh` sobe o PG pelo `db/lib/pg-harness.sh`, roda `go test -run PG17 -count=1 -v` e exige `--- PASS: TestPG17_ValidateDescobreVendasItem` na saída. Teste pulado = ausência de dado.
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `go test ./...` e `bash connector/sayersync/test-pg17.sh`, os dois com `exit 0` colado. **Passo 5:** commit.

### Task 11: Entidade `vendas_item` — 🚧 só após o passo 0

**Parâmetros que o passo 0 preenche (nada mais fica em aberto):** `P0.chave` (coluna da chave única) · `P0.corante` (`id` numérico ou código) · `P0.unidade` (`ml` ou `g`) e a fonte do peso específico se for `g` · `P0.data` (coluna física de `data_dosagem`, que é o eixo da janela) · `P0.status` (coluna/valor que separa dosagem executada; ausente = toda linha conta). O teto de `qtd` é físico e não muda (correção 6).

**Arquivos:** `mapping.go` (entrada `vendas_item` em `expectedMappings`, `:309-322`, com os slots `corante1..6`/`qtd1..6` resolvidos por `flatFormulaSlotCandidates`), `pg.go` (novo `ExtractJanela`), novo `preparacoes.go` + `preparacoes_test.go`.

**Interfaces:**
- `func (p *pgExtractor) ExtractJanela(ctx context.Context, desde, ate time.Time) ([]map[string]any, error)`: `WHERE <P0.data> >= $1 AND <P0.data> < $2` (mais o filtro `P0.status`), chaves LÓGICAS no resultado. No `Extractor` (interface) e no `fakeExtractor`.
- `func montarPreparacoes(rows []map[string]any, lk *Lookups) (validas []PreparacaoEnvio, rejeitadas []RejeitadaEnvio)`; `PreparacaoEnvio`/`RejeitadaEnvio` = o contrato do payload (sem campo `cliente` no struct). Não usa `traduzItensCorante`. `id_corante_origem` = o bruto. `codigo_corante_origem` sai de um lookup NOVO e separado, `lk.CoranteCodigo` (id → código WP, montado do catálogo de corantes). `lk.CoranteIdent` é id → id e não serve (Codex P1 #11). Se o passo 0 mostrar slot por CÓDIGO, resolver código → id por um mapa explícito (`lk.CoranteIdPorCodigo`), sem mudar a identidade usada pelos catálogos.
- `const qtdMlMax = 18000`, espelho de `QTD_ML_MAX` (edge) e do CHECK. Quantidade fora de `(0, qtdMlMax]` → `rejeitadas` com `qtd_fora_da_faixa`, nunca "válida".

- [ ] **Passo 1:** testes vermelhos: slots com corante denso (WP07, 1,95) e `P0.unidade = g` → `qtd_ml = g ÷ 1,95` com `peso_especifico = 1.95` no item; slot com corante sem qtd → `rejeitadas` com `slot_parcial`; qtd 18001 → `qtd_fora_da_faixa`; `json.Marshal` de uma preparação montada de linha COM `cliente` não contém `cliente`; id bruto `"12"` + código `"WP07"` vindos de `lk.CoranteCodigo` (o fixture monta o catálogo, não o mapa pronto); `TestParidadeQtdMlMax` lê `../../supabase/functions/tint-sync-agent/preparacoes.ts` e a migration `20261028100000` e exige `18000` nos dois. `TestPG17_ExtractJanela` (via `test-pg17.sh`): linha em `ate − 1 µs` entra e linha em `ate` fica de fora.
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `go test ./...` + `test-pg17.sh` PASS + sabotagem de valor de predicado (`ml = g × peso` no lugar de `÷`; `<=` no lugar de `<` no `ate`) → vermelho. **Passo 5:** commit.

### Task 12: `syncPreparacoes` — plano → janelas → lotes (contrato fixo; colunas do passo 0)

**Arquivos:** `sync.go` (novo `syncPreparacoes`, registro em `runEntityCycles` via `record("vendas_item", …)`), `api.go` (`AgentResponse.SyncRunID string \`json:"sync_run_id"\``), testes em `sync_test.go`.

**Interfaces:**
- `func syncPreparacoes(ctx context.Context, ex Extractor, cli *Client, rm *ResolvedMapping, lk *Lookups, originNow time.Time) error`: `PlanoPreparacoes` → para cada janela, `janelaEfetiva` → `ExtractJanela` → `montarPreparacoes` → lotes de até 1000 (válidas + rejeitadas) com `extracao_id` novo por janela, `consultado_em = originNow`, contagens por lote e `Idempotency-Key = extracao_id:lote` → POST `/preparations`, mesmo com a janela vazia (1 lote vazio). Lote sem `loteConfirmado` → para aquela janela (os lotes seguintes não vão) e segue para a próxima. Não há HWM a avançar.

- [ ] **Passo 1:** testes vermelhos com `fakeExtractor` + `captureServer`: plano com 0 janelas → 0 POST a `/preparations`; janela vazia → exatamente 1 POST com `total_lotes = 1` e `n_preparacoes = 0`; 2.500 linhas → 3 POSTs com o mesmo `extracao_id`, lotes 1..3 e `janela_*` idênticos; lote 2 com `ok:false` → o lote 3 não vai, a 2ª janela vai; `consultado_em >= janela_ate` em todo corpo; nenhum corpo capturado contém `cliente`; `iniciarFullRescan` não interfere (sem estado da entidade).
- [ ] **Passo 2:** FAIL. **Passo 3:** implementar. **Passo 4:** `go test ./...` PASS. **Passo 5:** `./release.sh 0.3.0` (entidade nova = minor); registrar o sha256 no PR. A publicação no Storage é do founder, na ordem e com a condição de "Ordem de entrega". **Passo 6:** commit, **PR D** com Auto-fix.

---

## Verificação de pronto (por camada, com evidência)

- Migrations aplicadas (envelope da sessão ou SQL Editor) → psql-ro: as 4 tabelas `tint_consumo_*` + a de manifestos, as 2 colunas + 14 linhas de seed, a ACL de `tint_promote_preparacoes` e `tint_consumo_plano_extracao`, `reloptions` das views, o md5 do tick pós-patch, a allowlist do ledger.
- Edge → `bun run pendencias:deploy` mostra `tint-sync-agent` com `v1.3-preparacoes-plano-manifesto` servido + sonda.
- Conector → heartbeat `agent_version = 0.3.0`; `tint_consumo_cobertura_em(now())` com `primeiro_dia_coberto` = o dia da primeira dosagem (ou o piso), `lacuna_desde` NULL e `ilha_ate` a menos de 4 dias; `tint_sync_runs` `preparations` todos `promovido`.
- Publish → `lovable-deploy-verify`; a aba abre com 14 linhas.
- Capacidade → o Lucas confirma o canister do "400"; `UPDATE tint_corantes SET capacidade_confirmada = true …` → psql-ro.
