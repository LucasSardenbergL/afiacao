# Frente C — JOIN `omie_products` account-aware na RPC de reposição (design)

**Data:** 2026-06-06 · **Tipo:** correção preventiva money-path (degradação honesta) · **Escopo:** 1 cláusula de JOIN na RPC `gerar_pedidos_sugeridos_ciclo` + validação PG17 robusta. **Revisado adversarialmente pelo Codex (spec).**

## Problema

No CTE `skus_necessitando` da RPC `public.gerar_pedidos_sugeridos_ciclo`, o LEFT JOIN com `omie_products` é **account-blind** (`supabase/migrations/20260604190000_…:129`):

```sql
LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text
```

`omie_products` é **UNIQUE `(omie_codigo_produto, account)`** → ≤1 linha por `(código, empresa)`, mas **N linhas pelo mesmo código** (uma por empresa). `account` = convenção EMPRESA (`oben`/`colacor`; nunca `vendas`/`colacor_vendas` — essa convenção Omie-account vive só em `inventory_position`).

Logo, pro pedido OBEN (`p_empresa='OBEN'` → `lower='oben'`), o JOIN casa **qualquer** linha do mesmo código — inclusive a de `colacor`:
1. **Multi-match → duplicação silenciosa:** código em `oben` E `colacor` → 2 linhas no CTE pro mesmo SKU → 2 itens no pedido (**não há `UNIQUE(pedido_id, sku_codigo_omie)`** em `pedido_compra_item`) → `num_skus`/`valor_total`/`SUM(qtde_final×preço)` inflados → **compra dobrada**.
2. **Atributo da empresa errada:** `op.ativo`/`op.descricao`/`op.familia` (políticas da empresa, não atributos globais) podem vir da linha de `colacor`.

**Precedente no mesmo arquivo já account-aware:** a guarda `'04'` (`op04.account = lower(p_empresa)`), o LEFT JOIN `inventory_position` (`ip.account = lower(p_empresa)`), a view irmã `v_otimizador_compras_insumos` (`op.account = lower(o.empresa)`). E `20260602101856_…:18` afirma *"É o MESMO join que a RPC … usa em prod: `omie_products.account = lower(sku_parametros.empresa)`"* — **hoje falso** (só a chave `account`; aquela função usa `ativo` para outra finalidade — refresh de rótulo, não gate de compra). Este fix torna a afirmação verdadeira **na chave account**.

## Diagnóstico (dado de prod, 2026-06-06)

| Sinal | Valor |
|---|---|
| accounts em `omie_products` | `oben` 3651 · `colacor` 4254 (só esses) |
| `skus_oben_total` (reposição automática) | **292** |
| `skus_multi_match_hoje` / `pedidos_item_duplicado_hoje` | **0 / 0** |
| `sem_linha_oben_total` / `sem_nenhuma_linha` | **0 / 0** |
| `sem_oben_405_450_*` | **0 / 0** |
| `indice_unico_valido` | **true** |

**Leitura:** os 292 casam exatamente 1 linha `oben` e nenhum colide com `colacor` hoje → o fix é **comportamentalmente NEUTRO hoje**. É **blindagem preventiva** (alinha ao contrato/view/guarda/ip; protege contra colisão de código futura, que duplicaria compra silenciosamente). ⚠️ O dado pode envelhecer → **re-rodar o diagnóstico de neutralidade imediatamente antes do apply** (runbook).

## Decisão de design

1. **Account-aware PURO** — adicionar `AND op.account = lower(p_empresa)` ao JOIN. **Sem fallback cross-account** (Codex): aplicar `ativo`/`descricao`/`familia` de outra empresa ao SKU OBEN É o próprio bug.
2. **Preservar `COALESCE(op.ativo,true)=true` no WHERE** — escopo = só o `account` no JOIN. `omie_products.ativo` é `NOT NULL`, então o `COALESCE` só trata a linha nula que o LEFT JOIN produz. **Não mover `ativo` pro JOIN** (seria *menos* conservador: linha OBEN inativa, com `ativo` no WHERE casa e **exclui**; com `ativo` no JOIN não casa → fail-open → **entraria**).
3. **Fail-open é uma MUDANÇA DELIBERADA, não status quo** (correção honesta do Codex): hoje o comportamento de "código só em `colacor`" é *fail-closed pela linha errada* (usa atributos estrangeiros); o fix muda para **"ausente na conta própria → fail-open"** (op.* NULL → passa). O cenário 2005 prova isso (`0 → 1`). Hoje é inócuo (`sem_linha_oben_total=0`), mas a política é explícita. **Risco residual:** se a linha OBEN sumir por sync parcial e o SKU seguir elegível, ele pode ser comprado mesmo ausente/inativo no catálogo OBEN — a guarda de saúde da RPC (`:65`) cobre cobertura **global** da conta, não **por SKU**. Mitigação = follow-up (monitor "SKU automático sem linha na própria account").
4. **Param canônico** — caller passa `'OBEN'`/`'COLACOR'`; o fix usa `lower(p_empresa)` (igual à guarda `'04'`/`ip`/view). O pressuposto uppercase **vira assert no PG17** (cenário COLACOR + nota sobre `gerar-pedidos-diario:248`, que não canonicaliza `body.empresa`).

## Escopo

**Dentro:** a cláusula `AND op.account = lower(p_empresa)` no JOIN da linha 129; migration `CREATE OR REPLACE` da RPC (corpo **verbatim** da `20260604190000` + a cláusula); validação PG17 robusta; runbook de apply com preflight anti-drift.

**Sem helper TS** (decisão Codex): a RPC não vira função TS; um helper de scoping seria cerimônia que pode ficar verde com o SQL errado e diverge facilmente (uppercase, primeira-ocorrência, não modela guarda '04'/metadata/saúde). **O PG17 é o oráculo real.**

**Não-objetivos (follow-ups registrados, fora desta frente):**
- `UNIQUE(pedido_id, sku_codigo_omie)` em `pedido_compra_item` — promover ao **próximo hardening** (transforma compra duplicada em falha transacional); antes auditar histórico + caminhos de split/movimentação.
- `v_sayerlack_mapeamento_gap:72` — também account-blind (mascarado por `DISTINCT`); declara ser "fiel ao motor" → **após este fix essa fidelidade fica falsa** → follow-up obrigatório (não-blocker) para realinhar o check do Sentinela.
- `grupo_codigo` NULL vs `''` — `sku_grupo_producao.grupo_codigo` é `NOT NULL` (o NULL vem da ausência de linha); se NULL e `''` coexistirem pro mesmo fornecedor, o `GROUP BY` (header) os separa mas o JOIN do item `COALESCE(...,'')` (`:193-195`) os reúne → duplicação **entre pedidos**. **Diagnóstico + fix separados** (prioridade alta; não misturar no aceite deste fix).
- Advisory lock por `(empresa, data_ciclo)` — a RPC não serializa chamadas concorrentes nem tem unique lógico no header → 2 execuções simultâneas duplicam o ciclo inteiro.
- Monitor "SKU automático sem linha na própria account" — compensação operacional do fail-open escolhido.

## Validação PG17 (`db/test-rpc-account-aware.sh`)

Base `db/verify-snapshot-replay.sh` (schema-snapshot + foundation `tipo_produto`). Semeia cenários (cada SKU precisando 10 unid a R$10; estoque ≤ ponto_pedido) e **roda a RPC pós-migration** (protege o `WHERE qtde_sugerida>0` do 2º insert contra apagamento no replacement). Matriz (Codex):

| SKU | Cenário | Empresa | Antes | Depois |
|---|---|---|---:|---:|
| 2001 | `oben` e `colacor` ambos válidos | OBEN | 2 | **1** |
| 2002 | `oben` inativo, `colacor` ativo | OBEN | 1 | **0** |
| 2003 | `oben` 405ML, `colacor` normal | OBEN | 1 | **0** |
| 2004 | família `oben` bloqueada, `colacor` permitida | OBEN | 1 | **0** |
| 2005a | sem `oben`; estrangeira **inativa** | OBEN | 0 | **1 (fail-open)** |
| 2005b | sem `oben`; estrangeira **405ML** | OBEN | 0 | **1 (fail-open)** |
| 2005c | sem `oben`; **família estrangeira bloqueada** | OBEN | 0 | **1 (fail-open)** |
| 2006 | sem nenhuma linha `omie_products` | OBEN | 1 | **1** |
| 2007 | `oben` `'04'`, estrangeira `'00'` | OBEN | 0 | **0** |
| 2008 | `oben` `'00'`, estrangeira `'04'` | OBEN | 2 | **1** |
| 3001 | `colacor` e `oben` ambos válidos | **COLACOR** | 2 | **1** |

> 2005 separado em a/b/c (3 sinais combinados esconderiam regressões individuais). **3001 (COLACOR)** mata uma implementação hardcoded `op.account='oben'` — exige `lower(p_empresa)`.

**Asserts (depois), à prova de impl-preguiçosa:**
- **Multiset exato** por `(sku, qtde_final, valor_linha)` esperado, não só contagem.
- **Unicidade do SKU no CICLO inteiro** (não só por `pedido_id`): nenhum `sku_codigo_omie` em 2 itens do mesmo `(empresa, data_ciclo)`.
- Por pedido: `num_skus = count(*) = count(DISTINCT sku_codigo_omie)`; nenhum header sem item.
- `valor_total = COALESCE(sum(valor_linha),0)` por header.
- **Valores de retorno da RPC** (`pedidos_gerados`/`skus_incluidos`/`valor_total_ciclo`) conferidos contra as linhas persistidas.
- **Neutralidade-hoje:** semente espelhando os 292 (sem colisão) + comparação de **rowset canônico completo** (`sku, qtde_final, valor_linha` ordenados; excluindo IDs/timestamps) **antes == depois**.
- **Diff mecânico:** assert (no harness) de que o corpo da migration nova difere da `20260604190000` em **exatamente** a cláusula `AND op.account = lower(p_empresa)` (1 linha), nada mais.

## Runbook de apply (anti-drift repo×prod — apply manual)

1. Founder roda `SELECT pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure);` no SQL Editor.
2. Comparo com o corpo-base (`20260604190000`). **Mismatch → abortar e rebasear a migration sobre o corpo de produção** (a frente C é cumulativa: corpo de prod + 1 cláusula).
3. Re-rodar o diagnóstico de neutralidade (os 2 blocos) — confirmar que segue 0/0/0 (o dado de 6/jun pode envelhecer).
4. Aplicar **em transação**, **fora da janela do cron `15 9 * * *`** (kickoff diário).
5. Guardar a definição anterior (rollback) + verificar a definição pós-apply.
6. **Sem deploy de edge, sem Publish** (é só RPC). Não regenera ciclo (neutro hoje).

## Entrega

Migration → PG17 (verde) → typecheck/test/build/lint (`heavy`, sobre o resto) → Codex adversarial no código → PR (auto-merge `--squash --auto`) → CLAUDE.md §10 + entregar SQL inline ao founder **com o runbook de preflight**.
