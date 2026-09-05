# Fase 0 · lote 1 — os 4 P1 de money-path de recebimento e reposição (M-01…M-04)

**Quando:** 2026-09-05 · **Plano:** `docs/superpowers/plans/2026-09-05-plano-melhorias-codebase/README.md` §5 (Fase 0) · **PRs:** M-01 #2201 · M-02 #2204 · M-03 #2205 · M-04 #2206

Quatro P1 abertos desde a revisão de 2026-07-04 (M-01…M-03) e o achado A3 do relatório de domínio (M-04). Todos da mesma família: **o código decidia pelo sinal errado** — transporte em vez de corpo, contagem em vez de quantidade, ausência de guard em vez de fronteira, `|| 0` em vez de `null`.

## O que cada um era, e o que virou

| | Sintoma | Fronteira nova | Prova |
|---|---|---|---|
| **M-01** | `handleFinalize` mostrava "NF-e efetivada" quando a edge respondia 200 com `success:false` — entrada de estoque/fiscal que não aconteceu no Omie | `interpretarRespostaEfetivacao` (só `success === true` + modo da allowlist + 2xx) nas 2 páginas; a edge responde 429 (throttle) / 502 (falha, parcial) | 22 vitest + 5 Deno; 5 sabotagens vermelhas na marca; Codex 0 P1 / 4 P2 aplicados |
| **M-02** | Rejeição em lote/inline por `UPDATE … .in("id", ids)` sem guard: pedido já **disparado** virava "cancelado"; `CancelarModal` dizia "cancelado" quando a RPC recusava | `rejeitarPedidos` → RPC `cancelar_pedido_sugerido` (guard no servidor + higiene do portal + `cancelado_humano`), **status relido do banco** antes de decidir, allowlist por via (lote = nunca aprovado; individual = + veto do auto-aprovado), `CancelarModal` pela mesma fronteira, resumo por status real | 14 + 4 casos; RED/GREEN em v1 e v2; Codex 3 P1 / 3 P2 (2 P1 fechados, 1 mitigado — TOCTOU na RPC é migration) |
| **M-03** | Editor de quantidade inicializava com `num_skus` (contagem) e gravava `num_skus` — o disparo lia `qtde_final` do item e comprava a quantidade original; modal descartava edição só-de-preço | Cardinalidade pelos ITENS (1 query no painel), editor grava o ITEM com checagem de status + **compare-and-set**, aprovar **fail-closed** sem itens, ceil/múltiplo da embalagem no campo; modal salva só-preço com o mesmo CAS | 12 + 3 + 5 casos (ordem testada no mesmo log); Codex 5 P1 / 3 P2, todos fechados |
| **M-04** | `unit_price \|\| 0` fabricava margem negativa (custo cheio, receita 0) no TS; a edge converte ausência em 0 na origem | TS: `valorMedido` + `> 0` (mesma régua do custo) + `semPreco`. **A edge SAIU do PR** (Codex 6 P1: `null` no jsonb quebra impressão/WhatsApp/orçamento; `sync-reprocess` e o canon `_shared/omie-pedido.ts` restauram o 0; a RPC coalesce numa coluna NOT NULL) → fatia de origem especificada para o founder | 6 vitest + vigia do sentinela; medição prod: 70.927 itens, 0 sem preço (latente) |

## Lições que valem além destes 4

- **O challenge do Codex pagou o custo três vezes:** M-03 v1 lia a cardinalidade da coluna que o próprio bug corrompia e deixava aprovar com o item ainda carregando (fail-open); M-02 v1 confiava no status do browser e o `CancelarModal` mentia sobre a recusa da RPC; M-04 v1 teria mandado `null` para leitores voltados ao cliente. Em money-path, o ritual roda ANTES de marcar ready — e o resultado pode ser recuar o escopo (M-04), não só corrigir.
- **RED honesto com implementação já escrita:** quando a v2 nasce depois do parecer, guarde a v2 fora da árvore, volte os arquivos à v1 (`git checkout -- f`, `rm` do novo), rode os testes novos (RED registrado), restaure e rode o GREEN — no mesmo slot do `heavy`. O log do RED é a prova de que o teste morde.

- **Transporte não é veredito.** `supabase.functions.invoke` resolve `error` só em ≠2xx; uma edge que responde 200 com `success:false` deixa o caller "aprovar por ausência de erro". Quando a edge tem efeito irreversível, o status HTTP tem de carregar o veredito **e** o front tem de ler o corpo — dos dois lados, senão qualquer ordem de deploy abre a janela. O corpo do ≠2xx fica em `error.context` (Response não lida): leia com `clone()`, dentro de `try`, com teto de tempo (Codex).
- **`heavy` com 1 slot e timeout de 30 min de fila é uma armadilha em sessão com 4 entregas:** 3 rodadas RED abortaram sem rodar (`exit=1` do wrapper, não do vitest — "ausência de sinal ≠ dado") porque um `edges:typecheck` MEU travou 53 min com 0 % de CPU e sem filho segurando o slot. Regra prática: (1) consolidar tudo o que precisa do slot num único script com `AFIACAO_HEAVY_TIMEOUT` longo; (2) `passo` que pode pendurar (deno check) roda sob `perl -e 'alarm N; exec @ARGV'`; (3) ao ler o log, procure a linha do runner (`Tests N passed`), nunca só o `exit=`.
- **`grep -c "marca"` com acento sob locale C não casa** (o mesmo #1483 do CLAUDE.md, agora no script de falsificação): a asserção que falhou era a certa, o contador dizia 0. Marca de falsificação em ASCII.
- **Vocabulário de status com 2 escritores** (`cancelado` do Cockpit × `cancelado_humano` da RPC): antes de unificar, `psql-ro` nas funções de prod que distinguem os dois (`prosrc LIKE '%''cancelado''%' AND NOT LIKE '%cancelado_humano%'`) — aqui só um ramo do em-trânsito, neutralizado pela própria RPC.

## Pendências que ficaram com o founder

- 💬 deploy das edges `omie-nfe-recebimento` (sonda → `v1.1-falha-sai-nao-2xx`) e `omie-vendas-sync` (→ `v1.2-preco-ausente-null`) + 🖱️ Publish.
- 🧭 RPC `cancelar_pedido_sugerido` com TOCTOU (lê status → `UPDATE … WHERE id` sem repetir o predicado; o disparador idem): fechar é migration `… WHERE id AND status NOT IN ('disparado','concluido_recebido') RETURNING` + `prove-sql-money-path` (Codex P1 do M-02, mitigado: lote só rejeita o nunca-aprovado).
- 🧭 `order_items.unit_price` NOT NULL + `coalesce(…,0)` na RPC `criar_pedidos_com_itens`: o banco ainda recebe 0 para item sem preço — migration é decisão sua (M-04 só tornou o jsonb e o transporte honestos).
- 🧭 M-06 (telas sobre objetos inexistentes) — plano §6.
