# Edição de pedido em /sales — o que vai ao Omie (P0 5–8) e a trava do gêmeo (2026-11-26)

> Continuação dos PRs #4187 e #4198 (P0 1–4 da tela de edição). Money-path. Edge `omie-vendas-sync` v1.48,
> sem migration. Módulo puro: `supabase/functions/omie-vendas-sync/edicao-omie.ts` (+ `_test.ts`).

## Medido na prod (psql-ro, 2026-11-26)

| | valor |
|---|---|
| recibos do app (`hash_payload` NULL) com PV | 25 |
| … `enviado` no app (editável hoje) com gêmeo `faturado` | **19 · R$ 11.565,88** (2 com o PV reaproveitado p/ outro cliente) |
| … cancelado × cancelado / enviado × importado | 4 / 1 |
| … com `customer_document` | 0 (o verify-before-edit era sempre pulado) |
| … com `codigo_cliente` no `omie_payload` (âncora) | 20 (os 5 sem âncora têm gêmeo faturado) |
| pedidos do app sem PV (caminho local) | 2 (rascunho/orçamento, total = subtotal) |
| importados 90 d com `total ≠ subtotal` | 0 de 1.450 — o total local é a MERCADORIA, nunca o frete |

## O que mudou

- **Trava no servidor** (antes de qualquer escrita): conta desconhecida, origem `omie_*`, status bloqueado,
  gêmeo importado fora de `importado/enviado`. Depois do ConsultarPedido e antes de mutar o ERP: etapa viva
  ∉ {10, 20}, `cancelado`/`faturado = 'S'`, `cancelado` sem `'N'` explícito, leitura sem etapa/previsão/frete,
  e **cliente vivo ≠ `codigo_cliente` que o app mandou ao criar o PV** (sem âncora também recusa). Tudo
  200 estruturado `blocked` + `motivo`, que a tela mostra.
- **Cabeçalho preservado**: etapa, `data_previsao`, frete e classificação (`codigo_categoria`, conta corrente,
  `codVend`) vão como LIDOS; antes iam `"10"`, hoje e um frete do zero. O AlterarPedidoVenda vai **antes**
  do delete+add: se o Omie recusar o frete reenviado, os itens ficam intactos.
- **Âncora sobrevive à edição**: o payload regravado leva `cabecalho.codigo_cliente` (antes a perdia).
- **Caminho local**: salvar só observação não toca `items/subtotal/total`; itens mudados com total ≠ subtotal
  recusa; o UPDATE só vale sem PV, sem envio reivindicado, não excluído e no mesmo status.
- **Preço do produto adicionado**: `precoDeNascimento` (`src/lib/pricing/`), a mesma decisão do Novo Pedido;
  legado com `customer_user_id = created_by` usa tabela pura.
- **Cupom**: nenhuma data nem valor por parcela inventados (`textoVencimentosDoCupom`, uma função para as
  duas vias). O app não guarda as parcelas reais do PV; `S41` = 28/42/56 e o PV pode ter parcelas desiguais.

## Decisões e residuais

- Etapa 50 não editável é restrição de PRODUTO (o Omie aceita) — mesma régua do gêmeo `separacao`.
- Frete reenviado inteiro: não provado em homologação (Codex). Mitigado pela ordem cabeçalho-antes.
- Fora: concorrência entre dois editores / alteração no Omie entre abrir e salvar; vencimentos reais de
  `fin_contas_receber` no cupom (RLS de financeiro + vazio-por-RLS indistinguível de não faturado).
