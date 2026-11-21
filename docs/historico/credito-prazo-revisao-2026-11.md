# Prazo em dias no SQL + revisão imutável da operação (crédito-IA, PR 3 — 2026-11-21)

Programa: `docs/superpowers/specs/2026-11-20-credito-ia-design.md` · plano `docs/superpowers/plans/2026-11-20-credito-ia.md` (seções "PR 3" e "Revisão pós-Codex").

## O que o banco mostrou (psql-ro, 2026-11-21)

- `sales_orders` **não guarda a parcela**: ela só existe no payload de `criar_pedido`/`alterar_pedido`, e `omie_payload` está nulo nos pedidos desde 2026-08. Hoje não há como saber, depois do fato, com que condição um PV foi enviado.
- `omie_condicao_pagamento_catalogo` tem **só a OBEN** (145 condições ativas, `dias_parcelas` vazio). **Colacor tem 0 linhas** e não há writer no repo.
- `OBEN/999` = **"Informar o número de parcelas"** (`num_parcelas = 999`). Não é à vista: o fallback de `listarFormasPagamento` o rotula "A Vista", e isso está errado (follow-up).
- Edição sem parcela selecionada **regravava `999` no Omie** por cima da condição real do PV.

## O que mudou

| Camada | Antes | Depois |
|---|---|---|
| SQL, prazo | prazo só no front (`parseCalendarioParcela`) | `credito_parse_calendario` (porte fiel, paridade por `db/fixtures/credito-prazo-paridade.json` no vitest e no PG17) · `credito_prazo_resolver`/`credito_prazo_dias(codigo, account)`: override → catálogo (exige `num_parcelas` presente e igual) → `NULL`. `999`, vazio, ilegível, empresa sem catálogo → **`NULL`, nunca 0** |
| SQL, override | — | `credito_prazo_override` append-only e versionado; só `credito_sou_aprovador()` (o Lucas) escreve, via `credito_definir_prazo_override`; revogação = `prazo NULL`; override de `999` vetado |
| SQL, revisão | — | `credito_operacao_revisao` append-only: devedor comprovado, parcela efetiva + origem (`informada`/`herdada_omie`/`default_999`), itens (código/quantidade/preço na ordem do envio), `valor_brl` = Σ round(q×v, 2) por linha, prazo + evidência. `credito_registrar_revisao` (service_role) reusa a última revisão de conteúdo idêntico (retry) e serializa por advisory lock. `id::text` = o `revisao` do PR 2 |
| Edge `omie-vendas-sync` v1.44 | envio com o payload; edição sem parcela → `999`; troca de parcela sempre chamava o piso | revisão **antes** do gate; envio usa a parcela efetiva e código/quantidade/preço **da revisão** (conferidos item a item); edição sem parcela **herda a do PV**; troca de parcela só pula o piso se os dois calendários vêm do catálogo e o novo domina-ou-iguala o antigo (30/60/90 → 75 dias reavalia) |

**Não bloqueia venda no PR 3** (spec §10: a trava nova só liga após a 1ª leva): revisão que falha vira `null` + log, e o pedido segue o caminho do PR 1. O piso continua fail-closed.

## Prova

- `db/test-credito-prazo-revisao.sh`: 148 asserts + 14 falsificações (cada uma vermelha pelo motivo certo, controle verde na mesma invocação), com o BANCO criado em `C` e em `pt_BR.UTF-8`. A corrida de 2 sessões prova que o registro concorrente do mesmo conteúdo gera 1 linha; com o lock trocado por compartilhado, B colide no `seq` (`23505`).
- Deno: `gate-credito_test.ts` (dominância na edição) e `revisao-credito_test.ts` (parcela efetiva, envio = revisão, falha não bloqueia).
- 2ª opinião Codex no desenho (2 P0 + 6 P1 + 1 P2) e no diff (4 P1 + 6 P2, todos acatados).

## Lição: `E'\v'` no PostgreSQL é a letra `v`

O porte do `.trim()` do JS usou `btrim(d, E' \t\n\r\f\v')`. O PG só reconhece `\b \f \n \r \t` em string `E''`; `\v` vira `v`, e o trim passou a comer a letra "v" das pontas (`vA Vista` → `[0]` no SQL, `null` no TS). O CREATE passa, a postcondição não testa esse caso, e só a fixture de paridade com borda proposital pegaria. Use `chr(11)`. Dentro de REGEX (`'[\\v]'`) o `\v` é do motor ARE e funciona — a armadilha é só no literal `E''`.

## Herdado pelo PR 5 (antes de a revisão reservar crédito)

(d) a retomada vincula o PV à revisão despachada, porque a chave `PV_<id>` é a mesma em todas as revisões; (e) despacho serializado por revisão, com resultado registrado; (f) tint/ATP antes da reserva, retomada por perna no checkout misto e contrato explícito de troca de parcela no editor (PR 6). Também: popular o catálogo da Colacor, sem o qual todo prazo Colacor é `NULL` e cai em 🟡 até haver override.

## Como reverter

Edge: voltar `omie-vendas-sync` para v1.43 (não depende das tabelas novas). Banco: `DROP` das 2 tabelas e 5 funções novas. Ainda não há dado de negócio: nada decide com a revisão até o PR 5.
