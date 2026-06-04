# Frente B — Mínimo de compra forçado por SKU (Reposição)

> **Status:** rascunho de design. O Codex (ChatGPT Plus) bateu o limite de uso às 17:27 BRT (reset 19:55). As decisões abaixo são o melhor desenho atual; as **questões abertas** (§9) serão validadas pelo Codex no reset (consulta de metodologia já redigida em `/tmp/codex-frenteB-metodologia.txt`), antes do merge.

**Data:** 2026-06-04
**Autor:** Claude (sessão autônoma) + Codex (pendente reset)
**Money-path:** SIM — gera pedido de compra real ao fornecedor.

---

## 1. Problema

Alguns SKUs têm uma **quantidade mínima de compra obrigatória** (imposta pelo fornecedor ou pela embalagem) acima do que o motor de reposição sugere naturalmente. O founder pediu explicitamente a "R" que **força um mínimo** na sugestão de pedido.

Hoje a RPC `gerar_pedidos_sugeridos_ciclo` calcula:

```
qtde_sugerida = estoque_maximo − estoque_efetivo
```

(onde `estoque_efetivo = estoque_fisico + estoque_pendente_entrada + em_transito`) e grava **a mesma quantidade** em `pedido_compra_item.qtde_sugerida` E `qtde_final` (que é o que dispara pro Omie via `nQtde`). **A RPC NÃO aplica nenhum piso** — nem o `lote_minimo_fornecedor` (que existe em `sku_parametros` mas só é usado pelo otimizador "comprar mais?"). Resultado: o motor pode sugerir uma quantidade abaixo do mínimo do fornecedor.

## 2. Solução (v1)

Nova coluna **`sku_parametros.minimo_forcado_manual numeric NULL`** (por SKU × fornecedor padrão — `sku_parametros` já tem 1 fornecedor por linha, sem ambiguidade). Quando setada e o item **já precisa de reposição**, a quantidade do pedido é elevada ao mínimo:

```
qtde_natural = estoque_maximo − estoque_efetivo        (inalterado)
qtde_final   = GREATEST(qtde_natural, COALESCE(minimo_forcado_manual, 0))
```

Sem valor (NULL) → `qtde_final = qtde_natural` = **comportamento atual idêntico**.

## 3. Princípios (degradação honesta, money-path)

1. **Piso, NUNCA gatilho.** O mínimo só atua em item que **já passou no gate de necessidade** (`estoque_efetivo <= ponto_pedido`, inalterado) **e** cujo `qtde_natural > 0` (o filtro de criação atual). Nunca força comprar item sobre-estocado/que não precisa. Só **eleva** a quantidade de quem já ia ser comprado.
2. **Audit X→Y visível.** A RPC grava `qtde_sugerida = qtde_natural` (referência) e `qtde_final = qtde_final` (o que compra). Quando diferem, a UI de revisão de pedido já destaca (a `ItensTable` mostra ambas as colunas e pinta `qtde_final ≠ qtde_sugerida` em amarelo). Adiciona-se um badge **"mínimo forçado"** para distinguir do ajuste humano.
3. **Valor inválido não força.** `NULL` → não força. Valor `≤0`, `NaN` ou `Infinity` → **bloqueado por CHECK** (⚠️ em Postgres `'NaN'::numeric > 0` é TRUE; o CHECK precisa de `> 0 AND < 'Infinity'::numeric`, que rejeita NaN porque NaN ordena acima de Infinity). A UI também valida antes de salvar.
4. **Preview antes de confirmar.** O cadastro do mínimo mostra o ajuste que ele provocaria; a revisão do pedido mostra natural→forçado.
5. **Sem fabricar nada.** O mínimo não inventa demanda nem custo; só impõe um piso na quantidade de um item que o motor já decidiu comprar.

## 4. Escopo — o que CORTAR da v1 (Codex)

- ❌ Alinhar `lote_minimo_fornecedor` na RPC (hoje ignorado na geração). Mudança ampla, não-pedida, blast-radius alto → **só o `minimo_forcado_manual`**. (Follow-up consciente.)
- ❌ Múltiplos fornecedores por SKU / múltiplos de embalagem / conversão de unidade.
- ❌ Importação em massa / regra por tabela de fornecedor.
- ❌ Reescrita do otimizador (só alimentar o extension point existente).
- ❌ Qualquer nova automação de escrita no Omie.

## 5. Consumidores

1. **RPC `gerar_pedidos_sugeridos_ciclo`** (money-path principal). Base de maior timestamp: `20260604140000_tipo_produto_consumidores.sql` (com a guarda fail-closed de `tipo_produto='04'` e o `statement_timeout 120s`). Mudança cirúrgica: `qtde_final = GREATEST(qtde_natural, COALESCE(sp.minimo_forcado_manual, 0))`, mantendo `qtde_sugerida = qtde_natural`; `valor_linha`/`valor_total` passam a usar a quantidade **forçada**.
2. **Otimizador "comprar mais?"** (helper puro `compras-otimizador-helpers.ts`, `qtdBase`/`qtdMinimaEfetiva` já existentes). A tela `AdminReposicaoOportunidades.tsx:41` já passa `minimo_forcado_manual: null // extension point`. Falta só a **fonte**: a view `v_otimizador_compras_insumos` (versão viva: `20260530143818`) expõe `sp.minimo_forcado_manual`, e `montarInsumo` lê dela.

## 6. Componentes (arquivos)

### SQL (migration nova `2026XXXX_reposicao_minimo_forcado.sql`, manual via SQL Editor)
- `ALTER TABLE public.sku_parametros ADD COLUMN IF NOT EXISTS minimo_forcado_manual numeric;`
- CHECK idempotente: `minimo_forcado_manual IS NULL OR (minimo_forcado_manual > 0 AND minimo_forcado_manual < 'Infinity'::numeric)`.
- `CREATE OR REPLACE FUNCTION gerar_pedidos_sugeridos_ciclo` — **verbatim da `20260604140000`** + o `GREATEST` + `qtde_natural`/`qtde_final` separadas + valor com a forçada.
- `CREATE OR REPLACE VIEW v_otimizador_compras_insumos` — **verbatim da `20260530143818`** + `sp.minimo_forcado_manual` no SELECT.
- Validação inline (`SELECT 'OK', count(rpc), count(view), column_exists`).

### Helper puro TS (oráculo TDD, espelha a lógica da RPC)
- `src/lib/reposicao/compras-otimizador-helpers.ts`: nova função pura `aplicarMinimoForcado(qtdeNatural, minimoForcado)` = `Math.max(qtdeNatural, minimoForcado ?? 0)` (espelho exato do `GREATEST(natural, COALESCE(min,0))` da RPC), com testes. `qtdBase`/`qtdMinimaEfetiva` já cobrem o otimizador.

### UI
- `src/lib/reposicao/sku-param.ts`: `+ minimo_forcado_manual: number | null` no `SkuParam`.
- `src/components/reposicao/SkuDetailSheet.tsx`: input "Mínimo de compra forçado" na seção de parâmetros (editável, validação >0/finito), exibição, e preview do ajuste.
- `src/components/reposicao/oportunidades/types.ts`: `+ minimo_forcado_manual` no tipo `Oportunidade`.
- `src/pages/AdminReposicaoOportunidades.tsx:41`: trocar `null` por `o.minimo_forcado_manual`.
- `src/components/reposicao/pedidos/ItensTable.tsx` (+ `useDetalhesModal`/`types`): badge "mínimo forçado" quando `qtde_final > qtde_sugerida` e o motivo é o mínimo (não ajuste humano).

## 7. Validação

- **vitest** no helper (`aplicarMinimoForcado` + `qtdBase` existentes).
- **PG17 harness** (`db/verify-snapshot-replay.sh`): aplica a migration sobre o schema-snapshot, semeia `sku_parametros` com `minimo_forcado_manual`, roda a RPC e assere: (a) `qtde_final = max(natural, minimo)`; (b) `qtde_sugerida = natural`; (c) item **sem** necessidade (estoque_efetivo > ponto_pedido) NÃO é ativado mesmo com mínimo setado; (d) item com `qtde_natural ≤ 0` NÃO é ativado; (e) `valor_linha = qtde_final × preço`; (f) NULL → comportamento atual; (g) CHECK rejeita 0/NaN/Infinity.
- **typecheck strict** (`bun run typecheck`), **lint**, **build**.

## 8. Entrega (founder)

- **Migration manual** via SQL Editor (money-path) — blocos rotulados (coluna+CHECK / RPC / view) + query de validação. Re-gerar `ciclo` é Checkpoint consciente do founder (não na migration).
- **Sem edge deploy** (RPC e view rodam no banco).
- **Publish do frontend** (UI do cadastro + audit).
- CLAUDE.md §10 + roadmap.

## 9. Questões abertas (validar com Codex no reset 19:55)

1. Escopo: só `minimo_forcado_manual` (defendido) vs alinhar `lote_minimo_fornecedor` na RPC. Risco de divergência RPC×otimizador?
2. Audit: reusar `qtde_sugerida`(natural) vs `qtde_final`(forçada) basta, ou flag explícita `minimo_forcado_aplicado` em `pedido_compra_item`?
3. CHECK robusto contra NaN/Infinity — confirmar a semântica de ordenação de NaN no Postgres.
4. Garantir que o GREATEST nunca ativa item que não precisa (interação com o gate `estoque_efetivo <= ponto_pedido` e o filtro `qtde_natural > 0`).
5. Teto de segurança contra mínimo absurdo (ex. 100000) — preview/audit cobre, ou flag "mínimo > N× a sugestão natural"?
6. Confirmar que o forçado entra em `em_transito` no ciclo seguinte (via `qtde_final`) e não cria loop de re-sugestão.
7. Furos não-vistos (double-count, item '04', interação com fail-closed, valor_total, idempotência, suposição de `qtde_sugerida == qtde_final` em outros consumidores).
8. Escopo mínimo final.
