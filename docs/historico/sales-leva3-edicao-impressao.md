# Revisão /sales — leva 3, PR A2: edição e /sales/print (2026-11-27)

Achados da revisão Codex r3 + Fable (2026-11-25), leva 3. Esta entrega é a parte **só de front da EDIÇÃO e do
/sales/print** (sem migration, sem edge). A1 (#4275) foi a lista; B (migration) e C (edge) seguem em PRs próprios.

## Re-verificação na main (`d7ae71718`, depois do #4277)
Os seis achados ainda existiam. O #4277 (onda D 4b-3) mexeu no print só na leitura de contato (`orders` sem `*`,
endereço da OS pela `contato_cliente_operacional`) — nada dos achados abaixo.

## O que mudou
- **#28** `useSalesOrderEdit.ts`: formas e catálogo carregam por `Promise.allSettled`, cada um com o seu estado.
  Antes, num `Promise.all`, a falha do catálogo pulava as formas e deixava `catalogProducts = []` — a busca dizia
  "Nenhum produto encontrado". Agora `estadoCatalogo` (`carregando | ok | falhou`) chega ao `AddProductSearch`,
  que mostra a falha com "Tentar de novo" (recarrega só o catálogo, com o token da carga).
- **#40** edição: `PGRST116` na busca pela PK = "Pedido não encontrado"; qualquer outra falha antes de montar o
  pedido = "Não consegui abrir o pedido", com o motivo (`mensagemDaFalhaDoPedido`, mesma régua da lista) e
  "Tentar de novo". Antes as duas diziam "não encontrado". O `.single()` ficou (busca por PK: `PGRST116` só pode
  ser 0 linhas).
- **L2-b** envio: `contasConfirmadasDoEnvio(errors)` parte o predicado do `allConfirmed` por conta (partição exata;
  `allConfirmed = todasConfirmadas(...)`). O cupom só imprime a via da conta confirmada — no envio parcial a via
  da conta pendente saía com "(pendente ERP)" no lugar do número do PV.
- **L2-c** print: o mapa código→descrição da parcela é chaveado por `conta:codigo`. O mesmo código existe nas
  duas empresas; a lista da Colacor sobrescrevia a da Oben. E com a Colacor degradada, o código cru dela ganhava
  a descrição da Oben (prazo fabricado).
- **L2-d** print: as leituras ligam o erro e o mostram — vendas e OS do dia (aviso de falha; nunca "Nenhum
  pedido encontrado"), nomes, contato, códigos Omie e endereços Omie (aviso com "Tentar de novo"; a consulta de
  endereço que falha é CONTADA). Nome ou contato que não leram travam a impressão (a via sairia com "Cliente" e
  sem endereço). `profiles` e a view fresca passaram a lançar no erro (antes `{ data }` sem `error` = `[]`).
  Baseline do gate `erro-colapsado-em-vazio`: 4→0, por conserto (o 6→4 da leva 2 tinha sido mudança de forma).
- **#36** print: `profiles` e `omie_customer_account_map_fresco` em lotes de 100 (`coletarEmLotesConcorrente`).

## Provas
- Um teste por achado: `contasConfirmadas.test.ts`, `buildPrintData.test.ts` (L2-b + controle),
  `submitOrder.test.ts` (fiação da confirmação), `AddProductSearch.test.tsx` e
  `useSalesOrderEdit.catalogAccount.test.tsx` (#28, #40), `SalesPrintDashboard.leituras.test.tsx` (L2-c, L2-d, #36).
- Falsificação: 14 sabotagens, uma camada por vez, controle verde na mesma invocação, `LC_ALL=C` e `pt_BR.UTF-8`.

## Resíduos / fica para depois
- A queryFn das FORMAS no print degrada conta a conta e não lança: o `isError` só cobre exceção inesperada.
- "PV Oben (já enviado)" (reenvio de envelope confirmado) segue imprimindo o rótulo no lugar do número — é
  pré-existente, e o número não está no envelope.
- B (migration: `origem_omie` na `order_feed`, fim exclusivo no total, exclusão pelo servidor, busca calculada
  uma vez) e C (edge: L2-a, quantidade 0/ausente) — PRs próprios. L2-e e #21 são decisão do founder.
