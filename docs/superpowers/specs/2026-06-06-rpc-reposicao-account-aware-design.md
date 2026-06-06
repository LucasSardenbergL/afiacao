# Frente C — JOIN `omie_products` account-aware na RPC de reposição (design)

**Data:** 2026-06-06 · **Tipo:** correção preventiva money-path (degradação honesta) · **Escopo:** 1 cláusula de JOIN na RPC `gerar_pedidos_sugeridos_ciclo` + helper puro TDD + validação PG17.

## Problema

Dentro do CTE `skus_necessitando` da RPC `public.gerar_pedidos_sugeridos_ciclo`, o LEFT JOIN com `omie_products` é **account-blind** (`supabase/migrations/20260604190000_…:129`):

```sql
LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text
```

`omie_products` é **UNIQUE `(omie_codigo_produto, account)`** → há ≤1 linha por `(código, empresa)`, mas **pode haver N linhas pelo mesmo código** (uma por empresa). Convenção de `account` confirmada = EMPRESA (`oben`/`colacor`; nunca `vendas`/`colacor_vendas` — essa convenção Omie-account vive só em `inventory_position`).

Logo o JOIN account-blind, pro pedido OBEN (`p_empresa='OBEN'` → `lower='oben'`), casa **qualquer** linha com o mesmo código — inclusive a de `colacor`. Consequências:
1. **Multi-match → duplicação silenciosa:** se o código existe em `oben` E `colacor`, o CTE produz 2 linhas pro mesmo SKU → 2 itens no pedido (não há `UNIQUE(pedido_id, sku_codigo_omie)` em `pedido_compra_item`) → `num_skus`/`valor_total`/`SUM(qtde_final×preço)` inflados → **compra dobrada** (dinheiro real).
2. **Atributo da empresa errada:** `op.ativo`/`op.descricao`/`op.familia` (políticas da empresa, não atributos globais) podem vir da linha de `colacor` e mudar incorretamente a inclusão/exclusão do SKU OBEN.

**No mesmo arquivo já são account-aware** (precedente): a subquery de guarda `'04'` (`op04.account = lower(p_empresa)`), o LEFT JOIN `inventory_position` (`ip.account = lower(p_empresa)`) e a view irmã `v_otimizador_compras_insumos` (`op.account = lower(o.empresa)`). E o **contrato está documentado** em `20260602101856_…:18` (*"É o MESMO join que a RPC `gerar_pedidos_sugeridos_ciclo` usa em prod: `omie_products.account = lower(sku_parametros.empresa)`"*) — uma afirmação **hoje falsa** que este fix torna verdadeira. Só o JOIN principal ficou para trás (a "dívida que não chegou ao corpo final", registrada no follow-up do programa tipo_produto #575/#579).

## Diagnóstico (dado de prod, 2026-06-06)

| Sinal | Valor |
|---|---|
| accounts em `omie_products` | `oben` 3651 · `colacor` 4254 (só esses) |
| `skus_oben_total` (reposição automática) | **292** |
| `skus_multi_match_hoje` | **0** |
| `pedidos_item_duplicado_hoje` | **0** |
| `sem_linha_oben_total` / `sem_nenhuma_linha` | **0 / 0** |
| `sem_oben_405_450_*` | **0 / 0** |
| `indice_unico_valido` | **true** |

**Leitura:** os 292 SKUs OBEN têm exatamente 1 linha `account='oben'` e **nenhum** colide código com `colacor` hoje. Portanto o fix é **comportamentalmente NEUTRO hoje** (casa a mesma linha com ou sem o `account`). É **blindagem preventiva**: alinha a RPC ao contrato + à view/guarda/ip, e protege o money-path contra o dia em que um código OBEN passe a existir também em `colacor` (a duplicação seria silenciosa).

## Decisão de design

1. **Account-aware PURO** — adicionar `AND op.account = lower(p_empresa)` ao JOIN. **Sem fallback cross-account** (Codex): aplicar `ativo`/`descricao`/`familia` de outra empresa ao SKU OBEN É o próprio bug.
2. **Preservar `COALESCE(op.ativo,true)=true` no WHERE** — escopo = só o `account` no JOIN. NÃO mover `ativo` pro JOIN (mudaria a semântica de "linha oben inativa → excluída"). Cobertura = **fail-open por SKU ausente** (op.* NULL → passa), idêntico ao comportamento atual de "SKU sem nenhuma linha" e consistente com a guarda `'04'` (já account-aware). Justificado pelo dado: `sem_linha_oben_total=0` → a decisão fail-open/fail-closed é, hoje, sem efeito prático; fail-open é o status quo, então preservá-lo é a mudança mínima.
3. **Param canônico** — o caller (cron/RPC) passa `'OBEN'`/`'COLACOR'`; o fix usa `lower(p_empresa)` (igual à guarda `'04'`/`ip`). Não introduzir normalização nova (fora de escopo); registrar o pressuposto.

## Escopo

**Dentro:** a cláusula `AND op.account = lower(p_empresa)` no JOIN da linha 129; helper puro TS (oráculo da seleção account-aware + filtros de produto); migration `CREATE OR REPLACE` da RPC (corpo **verbatim** da `20260604190000` + a cláusula); validação PG17 (matriz de 8 cenários + invariantes).

**Fora (não-objetivos):**
- Mover `ativo` pro JOIN ou trocar fail-open por fail-closed (`op.id IS NOT NULL`) — mudança de comportamento independente; o dado não a exige.
- `UNIQUE(pedido_id, sku_codigo_omie)` em `pedido_compra_item` — defesa adicional; fora de escopo (registrar como follow-up).
- `v_sayerlack_mapeamento_gap:72` (também account-blind, mascarado por `DISTINCT`) — **follow-up separado** (objeto diferente; sem impacto na compra).
- `grupo_codigo` NULL vs `''` — medir no PG17, mas só corrigir se a matriz revelar duplicação por header (não esperado).

## Arquitetura

**Helper puro `src/lib/reposicao/produto-account-scope.ts` (TDD vitest):**
- `resolverProdutoAplicavel(skuCodigo, empresa, produtos[])` → a linha `omie_products` da **própria empresa** (`lower(account)===lower(empresa)`) ou `null` (account-aware; multi-match resolve pra 1; cross-account-only → `null`).
- `skuPassaFiltroProduto(produto|null, familiasNaoCompradas)` → aplica `COALESCE(ativo,true)` + filtros `405ML/450ML` (`COALESCE(descricao,'')`) + `familia ∈ familias_nao_compradas` (NULL não casa). Documenta o **fail-open** quando `produto=null`.

Esses helpers são o **oráculo** da semântica que a RPC implementa; o PG17 prova que o SQL bate.

**Migration `supabase/migrations/2026XXXXXXXXXX_reposicao_rpc_account_aware.sql`** — `CREATE OR REPLACE FUNCTION gerar_pedidos_sugeridos_ciclo` com corpo **verbatim** da `20260604190000` + a única mudança na linha do JOIN. Idempotente. Cabeçalho avisa: aplicar por ÚLTIMO entre as `2026*` que tocam a RPC (é o estado mais recente). Apply manual via SQL Editor.

## Validação PG17 (`db/test-rpc-account-aware.sh`)

Base `db/verify-snapshot-replay.sh` (schema-snapshot + foundation `tipo_produto`). Semeia 8 SKUs, cada um precisando 10 unid a R$10 (estoque ≤ ponto_pedido), e roda a RPC **antes** (account-blind) e **depois** (account-aware) — matriz do Codex:

| SKU | Cenário | Antes | Depois |
|---|---|---:|---:|
| 2001 | `oben` e `colacor` ambos válidos | 2 itens | **1** |
| 2002 | `oben` inativo, `colacor` ativo | 1 | **0** |
| 2003 | `oben` 405ML, `colacor` normal | 1 | **0** |
| 2004 | família `oben` bloqueada, `colacor` permitida | 1 | **0** |
| 2005 | sem `oben`; estrangeira inativa/405/bloqueada | 0 | **1 (fail-open)** |
| 2006 | sem nenhuma linha `omie_products` | 1 | **1** |
| 2007 | `oben` `'04'`, estrangeira `'00'` | 0 | **0** |
| 2008 | `oben` `'00'`, estrangeira `'04'` | 2 | **1** |

**Asserts de invariância (depois):**
- nenhum `(pedido_id, sku_codigo_omie)` com `count(*) <> 1` (zero duplicação);
- por pedido: `num_skus = count(DISTINCT sku_codigo_omie)` E `valor_total = COALESCE(sum(valor_linha),0)` (multi-match não infla header).

**Neutralidade-hoje:** um cenário extra com 3 SKUs sem colisão (espelho dos 292 reais) provando que antes == depois (mesma contagem/valor) → confirma que o fix não muda nada no estado atual de prod.

O `2005` é o assert que **trava a decisão de cobertura** (fail-open=1); se a política mudar silenciosamente, o harness fica vermelho.

## Entrega

Helper+testes → migration → PG17 (verde) → typecheck/test/build/lint (`heavy`) → Codex adversarial no código → PR (auto-merge `--squash --auto`) → CLAUDE.md §10 + entregar o SQL inline ao founder (apply manual + sem deploy de edge, sem Publish — é só RPC). **Neutro hoje**, então não regenera ciclo; o efeito é preventivo.
