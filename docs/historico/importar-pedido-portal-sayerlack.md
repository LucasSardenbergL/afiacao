# Importar pedido digitado direto no portal Sayerlack → PO no Omie (2026-10-14)

**Pedido do founder:** às vezes ele digita o pedido direto no portal Sayerlack. Quer informar só o número no app e o
sistema buscar o pedido no portal e criar o pedido de compra no Omie "como já faz". Decisões dele: **direto, sem
tela de conferência** (o caminho até o Omie é o mesmo do disparo automático); **bloquear e mostrar** quando algo não
bate; importar **qualquer situação** do portal.

## Como ficou

- Tela **Gerir pedidos** → botão **Importar do portal** → nº do pedido → resultado (itens, PO Omie ou motivo).
- Edge `sayerlack-importar-pedido-portal` (Browserless, **só leitura no portal**): Consulta Pedidos (`/order-viewer`,
  pelo menu) → cliente `SAYERLACK_PORTAL_CLIENTE_CODIGO` → nº início = fim → Filtrar → lê a linha; itens por
  `GET /order-creation/busca-itens-pedido/<nº>` (JSON posicional). Se vier vazio, carrega a página de detalhe
  (`/order-creation-form-edit/<nº>/route/order-viewer` — é tela de EDIÇÃO: só GET, nenhum clique) e lê de novo.
  Diálogo nativo é sempre recusado.
- `leitura.ts` PROVA a semântica posicional (inferida de 1 amostra) a cada pedido: qtd fat = cap × qtd UN;
  Preço Venda = Preço UN × qtd UN × (1 − desc); Σ Preço Venda = Vlr Mercadoria da consulta; coluna "Pedido" casada
  EXATA (o prefixo pegaria "Pedido Cliente"); cliente tem de ser a OBEN.
- RPC `sayerlack_importar_pedido_portal` (migration `20261014120000`): de-para INVERSO (`sku_fornecedor_externo`
  OBEN ativo, exatamente 1 por sku_portal; qtde Omie = qtde portal ÷ fator, inteira), pedido em
  `aprovado_aguardando_disparo` + `sucesso_portal` + protocolo + `importado_portal_em/_por`, e — na MESMA transação —
  `sayerlack_aplicar_custo_portal` com o **Vlr Total** do portal como prova externa (IPI por NCM). Recusa =
  SQLSTATE IP001–IP005/CP00x e nada gravado. Idempotente por protocolo (advisory lock + UNIQUE parcial novo).
- PO pelo `disparar-pedidos-aprovados` de sempre (protocolo ⇒ already_sent). **v1.9:** pedido com protocolo não é
  mais dividido em lotes de 20 (o filho sem protocolo reabriria envio ao portal = pedido duplicado no fornecedor).

## Números do spike (pedido real 2140603)

`[10,"DFA.4080LT","","L",18,288,16,19.8637,357.5466,357.5466,5,"14,9488",4865.5584,"DILUENTE PU 4080A LT",…]` —
consulta: Vlr Mercadoria 4.865,56 · Vlr Total 5.181,82 = 4.865,56 + IPI 6,5% (316,26). Preço no PO: 323,86375/LT.

## Sensor

O ledger é a própria coluna: `SELECT count(*) FROM pedido_compra_sugerido WHERE importado_portal_em IS NOT NULL`
(denominador: pedidos Sayerlack com protocolo no mesmo período). PostHog `reposicao.importar_portal` (tom).

## Provas

`db/test-sayerlack-importar-pedido-portal.sh` (46 asserts, 2 locales, 7 falsificações, no núcleo do CI) ·
`leitura_test.ts` (12, Deno) · `importar-portal.test.ts` (vitest).
