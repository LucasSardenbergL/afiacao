# Tintométrico — referência operacional (Afiação/Colacor, money-path)

> Balcão de tinta: cor + produto + base + embalagem → fórmula (receita de corantes) → preço. Princípios em `docs/agent/money-path.md`; casamento boletim↔SKU em `docs/agent/knowledge-base.md`. Módulo em `src/pages/Tint*.tsx`, `src/lib/tint/`, `src/hooks/useTint*`, edges `supabase/functions/tint-*`.

## Modelo de dados (a chave)

- **`tint_formulas`** = uma linha por combinação vendável `(account, cor_id, produto_id, base_id, subcolecao_id, embalagem_id)` — é a unique key `uq_tint_formulas_chave` (com `COALESCE(subcolecao_id, '000…')`). **`tint_formula_itens`** = a RECEITA (N linhas corante_id + qtd_ml). Fórmula SEM item = sem receita.
- **`sku_id`** liga a fórmula ao `omie_products` (base) via `tint_skus.omie_product_id`. É o `sku_id` que a busca do balcão filtra.
- **`subcolecao_id` está na unique key.** ⚠️ Consequência cara (achado 2026-07-17): quando um writer muda o rótulo de subcoleção da MESMA fórmula (ex.: o sync passou a mandar `SL` onde o import de março mandava `1`/SAYERLACK), a chave muda → **INSERT em vez de UPDATE** → o catálogo inteiro DUPLICA. Em 2026-07-17 havia 2 gerações ativas: `1`/SAYERLACK (465k, congelada 03→04/2026, `preco_final_sayersystem` presente) e `SL` (493k, viva desde 06/2026, `preco_final_sayersystem` NULL em 100%). Ambas com `sku_id` → o catálogo aparece DUPLICADO na busca do balcão.
- **`volume_final_ml` tem convenção DIVERGENTE entre gerações:** na SAYERLACK, `vol_final = vol_embalagem + Σ(corantes)`; na SL, `vol_final = vol_embalagem` (não soma corante). Isso importa para detectar corrupção: a invariante `vol_final − vol_embalagem ≈ Σ(qtd_ml)` só vale na SAYERLACK.

## Preço = motor honesto, fail-closed (RPC `get_tint_price`/`get_tint_prices`)

- **A venda NUNCA lê `tint_formula_itens` direto** — passa pela RPC `SECURITY DEFINER` `get_tint_price` (single) / `get_tint_prices` (batch, alternativas+busca global). A RPC soma custo_base (Omie) + custo dos corantes e devolve `precoFinal` (+ custo gateado por staff — P1 `20260708234100`).
- **Fail-closed em receita VAZIA:** `v_corantes_completos := COALESCE(bool_and(custo_disponivel), false)`. `bool_and` sobre conjunto vazio = NULL → `COALESCE(…,false)` → false → `precoFinal = NULL`. `select-price.ts` então bloqueia TODAS as fontes (inclusive o CSV `preco_final_sayersystem`) → botão "Adicionar" desabilitado. Fórmula vazia **não vende**. (batch idêntico: fórmula sem item não entra no `GROUP BY` → `LEFT JOIN` → `COALESCE(corantes_completos,false)`.)
- ⚠️ **Fail-OPEN em receita PARCIAL** (achado 2026-07-17): se a fórmula tem ALGUNS corantes mas falta um (ex.: o import gravou 3 de 4), `bool_and` roda sobre os presentes → pode dar `true` → `precoFinal` calculado com receita INCOMPLETA → **preço baixo válido, subfaturamento SILENCIOSO**. Pior que a vazia (que é fail-closed). Medido: 240 na SAYERLACK (residuo de volume − Σqtd_ml > 1ml). Detecção só funciona na SAYERLACK (convenção de `vol_final`); a SL precisa de outro oráculo.

## Import de fórmulas (edge `tint-import`) — a fronteira de escrita

- **Fluxo INBOUND-only:** a máquina SayerSystem externa manda dados PRO app (via `tint-sync-agent` ou CSV break-glass no `tint-import`). O app NÃO manda receita a nenhuma máquina; NÃO há tela/impressão de receita pro operador. `tint_vendas`/`tint_vendas_itens` são tabelas MORTAS (0 escritores). A venda vira `sales_orders.items` (jsonb) → Omie.
- ⚠️ **O parser conta FÓRMULA, não RECEITA** (achado 2026-07-17, `processFormulas`): `imported++` sobe por fórmula, independente dos itens; itens só são inseridos `if (coranteIds.length>0)`; `errors++` só em exceção/cor_id-vazio. → uma linha sem corante legível vira fórmula gravada, contada como "importada", **0 erros**. Foi assim que `FL.6344 PU FUNDO.CSV` reportou 29.548/29.548/0-erros gravando 0 receita em 28.592 fórmulas (célula SAYERLACK×FL.6344, 100% vazia). O import SÓ reporta erro de header/upsert (ex.: duplicate key), **nunca** erro de insert de receita (que vai a `console.error`).
- **O preflight cliente (`preflight-formulas.ts`) reprova "(linha sem corante)" e qtd inválida — MAS é fronteira CLIENTE.** O writer server-side (`processFormulas`) NÃO é fail-closed por-linha: grava receita PARCIAL (pula o corante ruim) em vez de rejeitar a linha, e o delete+insert de itens não é transacional. "O buraco foi fechado" vale só para a UI de import, **não** para a fronteira de escrita. Remediação: plano `docs/superpowers/plans/2026-07-17-tint-receita-perdida-remediacao.md` (Fase 1).
- Bug latente (`tint-import/index.ts:304`): `.is("subcolecao_id", subcolecaoId ? undefined : null)` — para subcoleção não-nula passa `undefined` ao `.is()`; deveria ser `.eq`. Mitigado pelo `upsert onConflict:'chave'`, mas o UPDATE pode ir ao registro errado; erro da consulta ignorado.

## Busca do balcão (`useTintColorSelect.ts`)

- Query (`:97`): `SELECT id, cor_id, nome_cor, preco_final_sayersystem WHERE sku_id=? AND desativada_em IS NULL AND (cor_id/nome_cor ILIKE termo) LIMIT 20`. **NÃO** filtra "tem receita", **NÃO** seleciona subcoleção, `LIMIT 20` **SEM `ORDER BY`** (ordem não-determinística). → as 2 gerações da mesma cor voltam como linhas visualmente idênticas; a vendedora não distingue qual é a viva (SL) da congelada (SAYERLACK).
- `lastPracticedPrice` (`:220`): pega qualquer item coincidente nos 50 pedidos mais recentes, SEM filtro de status/cancelamento/idade, e **vence** cálculo/CSV mesmo sendo menor. Para fórmula vazia é bloqueado; para gêmea válida, perpetua preço velho. Não é "acordo explícito" — é inferência frágil.
- `TintPricing.tsx` (simulador admin, `:246-256`): motor de preço PARALELO sem guard (`precoFinal = precoBase + custoCorantes`; receita vazia → custoCorantes 0 → número fabricado só com base). Aplica imposto/margem só à base — semanticamente desconectado do preço que o balcão cobra. Aba admin, não vende, mas desinforma quem precifica.

## Regra de ouro

Fórmula ativa com preço mas **0 corantes NÃO é catálogo legítimo** (base pura) — é receita perdida. Prova barata: `volume_final_ml − vol_embalagem` da fórmula vazia bate com a soma dos corantes da gêmea com receita. Cores como PRETA/AMARELO/PANTONE com 0 corante são fisicamente impossíveis. Precisão > recall: **não apagar/desativar em massa sem o founder** — 465k linhas de catálogo, irreversível na prática; a remediação é o programa em `docs/superpowers/plans/2026-07-17-tint-receita-perdida-remediacao.md`.
