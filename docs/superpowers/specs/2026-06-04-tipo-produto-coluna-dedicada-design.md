# `tipo_produto` como coluna dedicada — restaurar a guarda de "não comprar fabricado" — Design

**Data:** 2026-06-04
**Frente:** Reposição / integridade de dados do Omie — money-path (decisão de comprar vs. fabricar).
**Status:** design (aguardando aprovação do founder antes do plano).
**Endurecido com:** Codex (consult de design — recomendou coluna dedicada + writer autoritativo + trigger anti-clobber + vigia de cobertura + fail-closed).

---

## 1. Problema

O sinal **`tipo_produto`** do Omie distingue Produto Acabado (`'04'` = fabricado internamente, **nunca comprar**) de Mercadoria para Revenda (`'00'` = comprável). Ele alimenta a guarda de compra (#527/#529) que impede o motor de reposição de sugerir a **compra** de um tingidor que a empresa **fabrica**.

**Medido em produção (2026-06-04, OBEN):** dos ~3651 produtos, **0 com `'04'`, 0 com `'00'`, 3651 com `NULL`** — o sinal sumiu por completo. O `updated_at` é de hoje (sync fresco): não é dado velho, é o sync **gravando sem o sinal**. Em 31/05 (pós-#515) havia ~1204 com `'04'`.

**Consequência:** a guarda viva (`metadata->>'tipo_produto' <> '04'`) está **morta** (NULL passa); o vigia `reposicao_sayerlack_fabricado` está **verde-mentindo** (procura `'04'`; se o sinal some, declara sucesso — cego por construção). Hoje só o flag `sku_parametros.tipo_reposicao='produto_acabado'` (backfill de 31/05, 38 SKUs) segura os fabricados conhecidos; qualquer fabricado **novo** ou que perca o flag entraria na compra **sem alarme**.

**Gatilho do achado:** founder viu 5 tingidores Sayerlack fabricados pedindo aprovação na fila de Parâmetros → Revisão (ruído já corrigido — ver §7, item 0), e questionou. Puxar o fio revelou a regressão do sinal.

## 2. Causa-raiz (confirmada no código)

`omie_products.metadata` (jsonb) é escrito por **vários** edge functions com o **mesmo** `onConflict: "omie_codigo_produto,account"` (account `oben`), mas cada um monta o objeto `metadata` diferente. O upsert do supabase-js/PostgREST **sobrescreve a coluna `metadata` inteira** (não faz merge de jsonb). Writers da linha OBEN:

| Function | path | `metadata.tipo_produto`? |
| --- | --- | --- |
| `omie-vendas-sync` (syncProducts) | [index.ts:347](../../../supabase/functions/omie-vendas-sync/index.ts) | ✅ lê `tipoItem ?? tipo_item ?? tipo ?? recomendacoes_fiscais` (mas `maxPages=12` → cobre ~1200 dos ~3651) |
| `omie-sync-metadados` | [index.ts:88](../../../supabase/functions/omie-sync-metadados/index.ts) | ❌ — **pagina o catálogo INTEIRO** (`while pagina<=totalPaginas`), mesmo endpoint `ListarProdutos` |
| `omie-analytics-sync` (sync_products/sync_all) | [index.ts:531](../../../supabase/functions/omie-analytics-sync/index.ts) | ❌ |
| `sync-reprocess` | [index.ts:421](../../../supabase/functions/sync-reprocess/index.ts) | ❌ |
| `tint-omie-sync` | [index.ts:167](../../../supabase/functions/tint-omie-sync/index.ts) | ❌ |

Os "descritivos" (sem `tipo_produto`) rodam por cron com frequência → vencem o `omie-vendas-sync` → estado estável = `tipo_produto` NULL. O `omie-sync-metadados`, em particular, cobre todos os 3651 e roda por cron → é o suspeito principal de zerar (e, por isso mesmo, o candidato ideal a dono do sinal — ver §5.2).

**Confirmado empiricamente (2026-06-04):** dos 3651 produtos OBEN, **0** têm a chave `tipo_produto` no jsonb, mas **3651** têm `inativo_omie` e `cfop`. A chave `tipo_produto` **nem existe** (não é valor null) → o último writer de 100% dos produtos foi um descritivo (grava `inativo_omie`/`cfop`, não `tipo_produto`). Isso **descarta** a hipótese alternativa "o Omie parou de mandar `tipoItem`" (que exigiria a chave presente com valor null) e prova a colisão de upsert.

## 3. Consumidores do sinal (hoje todos via `metadata->>'tipo_produto'`)

1. **Guarda na RPC `gerar_pedidos_sugeridos_ciclo`** (motor de sugestão de compra) — [20260531160000:128](../../../supabase/migrations/20260531160000_reposicao_excluir_fabricado_04.sql). Subquery account-aware. **Morta hoje.**
2. **View cold-start `v_sku_candidatos_primeira_compra`** — mesma migration, linha 217.
3. **Vigia `reposicao_sayerlack_fabricado`** (Sentinela, push por email) — [20260531130000:287](../../../supabase/migrations/20260531130000_data_health_check_sayerlack_fabricado.sql). **Cego hoje.**
4. **Check `reposicao_mapeamento_sayerlack`** (gap de de-para) — [20260531170000](../../../supabase/migrations/20260531170000_data_health_check_sayerlack_mapeamento_gap.sql).
5. **Frontend `submitOrder`** (auto-criação de Ordem de Produção em vez de compra) — [submitOrder.ts:215](../../../src/services/orderSubmission/submitOrder.ts).
6. **Backfill** `sku_parametros.tipo_reposicao='produto_acabado'` (#527/#529) — não é leitura runtime, mas depende do sinal pra marcar novos fabricados.

## 4. Objetivo & não-objetivos

**Objetivo:** restaurar e blindar o sinal `tipo_produto` como dado money-path confiável, eliminando a **classe** do bug (sobrescrita por writers concorrentes), e garantir que a guarda **falhe fechado** (nunca trate "sinal ausente" como "comprável").

**Não-objetivos (v1):**
- Reescrever os 4 syncs descritivos pra incluir `tipo_produto` ("alinhar todos") — **rejeitado pelo Codex** (frágil; depende de cada redeploy + payload + memória do próximo dev).
- Merge de jsonb via RPC — resolve a sobrescrita mas mantém o sinal num "saco genérico" e aumenta superfície operacional.
- Migrar outros sinais de `metadata` pra colunas (só `tipo_produto` agora; política geral fica registrada como princípio).
- Esconder fabricados de TODAS as telas (a fila de Revisão já foi tratada; outras telas, sob demanda).

## 5. Arquitetura da solução

### 5.1 Coluna dedicada `omie_products.tipo_produto` (Codex — decisão central)

`tipo_produto` sai do `metadata` jsonb compartilhado e vira **coluna própria** (`text`, normalizada — canônico `'04'`, `'00'`, etc.). Quem não inclui a coluna no payload do upsert **não a toca** (PostgREST só atualiza colunas presentes). Isso mata a classe do bug: os 4 syncs descritivos seguem fazendo upsert normal e **deixam a coluna intacta**.

### 5.2 Writer autoritativo único = `omie-sync-metadados`

Só **um** writer escreve `tipo_produto`, e ele **pagina o catálogo inteiro**. O `omie-sync-metadados` já faz isso (`while pagina<=totalPaginas`, mesmo `geral/produtos/ListarProdutos` de onde o vendas-sync lê o `tipoItem`) → ele passa a:
- extrair `tipoItem` (com a regra de confiança de §5.4),
- gravar **na coluna** `tipo_produto` (não no metadata),
- registrar métricas no `sync_state`/log: `total`, `paginas`, `tipo04_count`, `typed_count`, `complete`.

O `omie-vendas-sync` **para de gravar** `metadata.tipo_produto` (não cobre o catálogo todo; deixa de ser fonte). *(Decisão a confirmar no plano: o vendas-sync escreve a coluna também — redundante mas inofensivo com o trigger de §5.3 — ou só o metadados é dono. Preferência: só o metadados é dono.)*

### 5.3 Trigger anti-null-clobber (Codex — defesa em profundidade)

`BEFORE UPDATE` em `omie_products`: se `NEW.tipo_produto IS NULL` e `OLD.tipo_produto IS NOT NULL`, preserva `OLD` (`NEW.tipo_produto := OLD.tipo_produto`). Blinda contra um writer futuro que acidentalmente mande a coluna como `NULL`. (Reescrita legítima de valor — `'04'→'00'` — passa; só o apagamento é bloqueado.)

### 5.4 `tipoItem` confiável (Codex)

`prod.tipo` é usado no código como discriminador de **Kit** (`tipo === 'K'`) — não é o tipo fiscal. A extração só aceita o **valor fiscal numérico** do Omie (`tipoItem`/`tipo_item`, normalizado a 2 dígitos: `'4'→'04'`); `prod.tipo` **não** entra como fallback. Sem valor confiável → **não escreve a coluna** (deixa intacta; não grava NULL).

### 5.5 Consumidores leem a coluna (com ponte na transição)

RPC/cold-start/vigia/de-para/`submitOrder` passam a ler `COALESCE(op.tipo_produto, op.metadata->>'tipo_produto')` **só durante a transição**; alvo final é a coluna pura. Normalização canônica `'04'` elimina o espalhamento de `'04'|'4'|4`.

### 5.6 RPC fail-closed (Codex)

Se a **cobertura do sinal** estiver quebrada (ver §5.7), o `gerar_pedidos_sugeridos_ciclo` para OBEN deve **recusar** com erro explícito (`tipo_produto_unhealthy`) em vez de tratar 3651 NULLs como compráveis. (Hoje "ausente = comprável" silencioso — inaceitável no money-path.)

### 5.7 Vigia de cobertura do sinal (Codex — o que faltava)

Checks novos no Sentinela (`_data_health_compute`), independentes do `'04'` existir:
- **`omie_tipo_produto_frescor`** — full sync de classificação não completou há >30h (warning) / >48h (broken).
- **`omie_tipo_produto_cobertura_oben`** — `typed_count` (não-nulo) vs. baseline pós-restore: warning <90%, broken <80%.
- **`omie_tipo_produto_04_oben`** — `count('04')` vs. baseline (~1204): warning <95% & queda absoluta >10; broken <90% ou =0.

Promovidos ao push (`data_health_watchdog` + `fin_sync_heartbeat`). ⚠️ partir SEMPRE da migration de **maior timestamp viva** do `_data_health_compute` e recriar watchdog+heartbeat **junto** (lição de cascata do §5 do CLAUDE.md).

### 5.8 Fix do join account-blind (Codex — bug lateral)

A RPC tem `LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text` **sem** `op.account = lower(p_empresa)` (a guarda `04` é account-aware via subquery, mas `op.ativo`/`op.familia`/`op.descricao` no corpo podem ler a linha da conta errada). Corrigir o join no mesmo passe.

## 6. Degradação honesta & riscos

- **Pedidos já vazados (Codex):** consertar o sinal não limpa sugestão/pedido que já passou pela guarda morta. Auditoria obrigatória (query de contenção entregue; quarentenar `'04'` em `pendente_aprovacao`/`aprovado_aguardando_disparo`/portal/Omie).
- **`CREATE OR REPLACE` em funções quentes** (RPC, `_data_health_compute`): partir da maior timestamp viva; recriar watchdog/heartbeat junto.
- **Baseline do `04`:** o limiar do vigia depende de medir o `tipo04_count` **após** o full sync (não confiar no "~1204" histórico cegamente).
- **Rollout manual no Lovable:** 2 migrations (SQL Editor) + redeploy de edge (chat) → main e prod divergem se não deployar; confirmar por **comportamento**, não pela palavra do Lovable.
- **Princípio (Codex):** `metadata` não carrega mais sinal money-path — fica registrado no CLAUDE.md.

## 7. Entregáveis & ordem (fases — detalhe no plano)

0. ✅ **(já feito) Fix de UI** — fila de Revisão esconde `produto_acabado` ([useRevisaoParametros.ts:175](../../../src/components/reposicao/revisao/useRevisaoParametros.ts)). Vai no mesmo PR.
1. **Contenção/auditoria** — query "vazou fabricado pra pedido ativo?" (entregue); quarentenar achados.
2. **Migration 1** — coluna `tipo_produto` + normalização + trigger anti-null-clobber. (lovable-db-operator)
3. **Edge autoritativa** — `omie-sync-metadados` lê `tipoItem` (regra §5.4) e grava a coluna + métricas; `omie-vendas-sync` deixa de gravar o sinal. Deploy manual.
4. **Full sync** OBEN (+Colacor, por causa do `submitOrder`) → repopula; **medir baseline** do `04`/typed.
5. **Verificar** no SQL Editor (total ~3651, `tipo04_count` ≈ baseline, frescor recente).
6. **Migration 2** — RPC/cold-start/vigia/de-para leem a coluna (COALESCE ponte) + RPC fail-closed + fix join account-blind.
7. **Vigia de cobertura** — 3 checks novos no Sentinela, promovidos ao push.
8. **Frontend** — `submitOrder` lê a coluna; types do Supabase; (+ fix de UI já pronto). Mesmo PR.
9. **Regenerar ciclo** OBEN só após os checks verdes.

## 8. Plano de teste

- **Helper puro TDD** pra normalização de `tipoItem` (`'4'→'04'`, rejeita `'K'`/não-numérico → não escreve) — espelhado no edge (Deno não importa de `src/`).
- Teste do trigger (PG17 descartável): `UPDATE ... SET tipo_produto=NULL` preserva OLD; `'04'→'00'` passa.
- Teste do vigia de cobertura nos 3 ramos (ok/stale/broken) em cluster descartável (padrão do projeto).
- Teste da RPC fail-closed (cobertura broken → erro, não pedido).

## 9. Métrica de sucesso

- `tipo04_count(OBEN) > 0` e estável **após** rodadas dos syncs descritivos (a coluna não é mais zerada).
- Guarda viva volta a barrar `'04'` na sugestão de compra; vigia reflete a verdade (não verde-mentindo).
- Vigia de cobertura alerta em <48h se o sinal regredir de novo.

## 10. Questões abertas (revisão do founder)

- **Q1.** OK só o `omie-sync-metadados` ser o dono do sinal (e o `omie-vendas-sync` parar de gravá-lo)? Ou manter os dois escrevendo a coluna (redundante, mas o trigger protege)?
- **Q2.** Colacor entra na v1 (o `submitOrder` usa `tipo_produto` pra auto-OP) ou só OBEN agora (foco do incidente)?
- **Q3.** Cron dedicado de classificação (frescor garantido) ou confiar no cron atual do `omie-sync-metadados`? (precisa saber a cadência dele — homework no Lovable).
