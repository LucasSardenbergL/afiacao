# Revisão /sales — leva 3, PR B: order_feed no servidor (procedência, fim do período, busca, exclusão) (2026-11-27)

Achados da revisão Codex r3 + Fable (2026-11-25), leva 3, parte de **banco** (migration
`20261127214433_order_feed_origem_fim_busca_exclusao.sql`, aplicada pelo founder no SQL Editor, ANTES do
Publish). A1 (#4275) e A2 (#4284) foram só front; C (edge L2-a) vem depois.

## Pré-flight na prod (psql-ro, 2026-11-27)
- `order_feed`: corpo = 20261102160821 (md5 `dee24dde…`), `security_invoker=true`. `order_feed_total` = repo.
- `authenticated` lê `sales_orders.hash_payload` e grava `deleted_at` (ACL por coluna).
- Procedência × status: 13 de origem Omie em `separacao` ganhavam "Editar"; 11.269 `cancelado` ganhavam
  "Excluir" que a edge recusa. A coluna `origem` de `sales_orders` não serve (vazia em 32.541 de 32.569).
- Busca: ~1,3 s por consulta, `jsonb_array_elements` 32.569 vezes, e a tela consulta duas vezes.
- **`deleted_at` tem DOIS escritores**: o navegador (exclusão) e o cron `omie-pv-exclusao-reconciliar`
  (PV excluído no Omie, service_role — baixa legítima). Limpar "marca velha" sem distinguir os dois
  ressuscitaria baixas. Dos 23 ocultos hoje: 10 com prova do reconciliador, 12 no mesmo minuto
  (22/11 00:06, compatível com a limpeza manual do #4082) e 2 sem explicação (`1a3c47e6…` enviado de
  21/11 21:25, `da6c89da…` importado de 25/11 20:21) — **não tocados**: a recuperação só vale para marca
  registrada daqui em diante.

## O que mudou
- **#5** `order_feed.origem_omie` (15ª coluna, no fim): `hash_payload LIKE 'omie\_%'`, o mesmo teste da edge.
  `podeExcluirPedido`/`podeEditarPedido` recusam pela procedência; o painel lê `hash_payload` e marca igual.
- **#31** `order_feed_total(…, p_ate, p_puros_fim)`: fim exclusivo = meia-noite local de amanhã, fora as
  datas-puras de amanhã (em SP, 00:00Z de amanhã = 21h de hoje). A lista aplica o mesmo par (`.lt` + `.neq`).
  Assinatura nova ⇒ DROP + CREATE com o ACL reemitido; a chamada antiga de 7 parâmetros segue respondendo.
- **#35** `sales_orders.busca_base`: coluna GERADA (`private.busca_base_pedido`, IMMUTABLE) com número,
  itens e total; a view só junta o nome do cliente. Texto final idêntico: 0 divergências em 32.569 linhas
  na prod (read-only, antes do apply) e a PÓS repete a comparação no apply.
- **#19** `sales_orders_exclusao_marca` registra só a marca do USUÁRIO (trigger, `auth.role()='authenticated'`).
  `private.sales_orders_exclusao_recuperar()` (cron `*/10`, SQL puro) devolve à lista o pedido cuja marca
  segue igual após 30 min. Sucesso da edge apaga pedido e marca (cascade). Edge intocada.

## Prova
- `db/test-order-feed-leva3-b.sh` (PG17): 27 asserts executando view/RPCs/trigger/recuperação, negativos por
  SQLSTATE+marca, RLS sob `SET ROLE authenticated`, `reloptions` conferido. Falsificação com 13 sabotagens
  e controle verde na mesma invocação, em `LC_ALL=C` e `pt_BR.UTF-8`.
- **Lição do harness:** em `pt_BR.UTF-8` o bash 3.2 do macOS leu `"$REC·"` como nome de variável, abortou
  por `set -u` — **e saiu 0** (com `set -e`, o `$?` dentro do trap EXIT vem 0). Só o contador de asserts
  da falsificação pegou. Correção: `${REC}` + marcador `FIM=1` no fim; sem ele o trap força exit 1.
- Front: testes novos (procedência no card/painel, fim do período no `feed` e no hook, paridade do fake com
  `p_ate`) e falsificação de 7 sabotagens nos dois locales.
- Codex sem cota (até 02/12): **sem-codex**, Caminho B (revisão adversarial por subagente).

## Ordem de deploy
1. 🟣 migration no SQL Editor (reescreve `sales_orders` para a coluna gerada: lock curto da tabela).
2. Publish do front (lê `origem_omie` e passa `p_ate`). Front velho segue funcionando com o banco novo.
