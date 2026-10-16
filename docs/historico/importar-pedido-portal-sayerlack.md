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
  Diálogo nativo é sempre recusado. Filtro **Exibir = Pedido** (proposta não é pedido efetivado); situação
  qualquer (decisão do founder), mas tem de vir legível.
- `leitura.ts` PROVA a semântica posicional (inferida de 1 amostra) a cada pedido: qtd fat = cap × qtd UN;
  Preço Venda = Preço UN × qtd UN × (1 − desc); Σ Preço Venda = Vlr Mercadoria da consulta; coluna "Pedido" casada
  EXATA (o prefixo pegaria "Pedido Cliente"); cliente tem de ser a OBEN.
- RPC `sayerlack_importar_pedido_portal` (migration `20261014120000`): de-para INVERSO (`sku_fornecedor_externo`
  OBEN ativo, exatamente 1 por sku_portal; qtde Omie = qtde portal ÷ fator, inteira), pedido em
  `aprovado_aguardando_disparo` + `sucesso_portal` + protocolo + `importado_portal_em/_por`, e — na MESMA transação —
  `sayerlack_aplicar_custo_portal` com o **Vlr Total** do portal como prova externa (IPI por NCM). Recusa =
  SQLSTATE IP001–IP006/CP00x e nada gravado. **IP006**: já existe PO OBEN no espelho `purchase_orders_tracking`
  com este nº em `numero_contrato_fornecedor` (210 POs Sayerlack foram lançados direto no Omie assim) — sem isso,
  importar criaria um 2º PO com outra chave `AFI-<id>`. Limite: a defasagem do sync do espelho. Idempotente por protocolo (advisory lock + UNIQUE parcial novo).
- PO pelo `disparar-pedidos-aprovados` de sempre (protocolo ⇒ already_sent). **v1.9:** pedido com protocolo não é
  mais dividido em lotes de 20 (o filho sem protocolo reabriria envio ao portal = pedido duplicado no fornecedor).

## Números do spike (pedido real 2140603)

`[10,"DFA.4080LT","","L",18,288,16,19.8637,357.5466,357.5466,5,"14,9488",4865.5584,"DILUENTE PU 4080A LT",…]` —
consulta: Vlr Mercadoria 4.865,56 · Vlr Total 5.181,82 = 4.865,56 + IPI 6,5% (316,26). Preço no PO: 323,86375/LT.

## 2ª opinião (Codex, high, 2026-10-14)

2 P1, 0 P0 — ambos corrigidos: proposta/situação ausente viravam PO (filtro Exibir=Pedido + situação
obrigatória); PO lançado direto no Omie com o mesmo contrato ganhava um 2º PO (IP006). Authz/rollback da RPC e
o desvio do split: sem achado.

## Sensor

O ledger é a própria coluna: `SELECT count(*) FROM pedido_compra_sugerido WHERE importado_portal_em IS NOT NULL`
(denominador: pedidos Sayerlack com protocolo no mesmo período). PostHog `reposicao.importar_portal` (tom).

## Provas

`db/test-sayerlack-importar-pedido-portal.sh` (49 asserts, 2 locales, 8 falsificações, no núcleo do CI) ·
`leitura_test.ts` (12, Deno) · `importar-portal.test.ts` (vitest).

## Deploy — banco (2026-10-14)

Migration `20261014120000` aplicada pela sessão via `db:aplicar` após o merge do #3075: ensaio (rollback) ok →
apply = tentativa **#449** com recibo (sha256 `658bf9f2…`). 2ª testemunha por `psql-ro`: função, índice UNIQUE
válido, colunas e ACL (anon/authenticated sem EXECUTE, service_role com) ✅; `md5(prosrc)` = md5 do corpo do arquivo
(`e7294d18…`). Carimbo de authz re-medido: os 6 audits de prod exit 0 (o achado `FUNCAO_AUSENTE_EM_PROD` sumiu).
Pendente: edges (`disparar-pedidos-aprovados` v1.9 ANTES de `sayerlack-importar-pedido-portal`) e Publish.

## Deploy e 1º uso real (2026-10-15/16)

- **Edges em ondas**: `disparar-pedidos-aprovados` v1.9 → `sayerlack-importar-pedido-portal`. A ferramenta não emitia
  onda de edge NOVA com ordem (pelo nome retinha; pelo ledger ignorava `NUNCA_ATESTADA`) → #3085. O bloco do Lovable
  só vale colado NA HORA: o `sonda-fingerprints.ts` muda a cada PR que toca edge (2 recusas por hash) e a prova da
  predecessora vence em 6 h (re-sonda via `db:aplicar`; o SQL da sonda sai byte-igual → linha de comentário própria,
  senão "já aplicado").
- **1º uso (2141068) — leitura**: "0 linha(s) lida(s)" com o pedido existindo. A edge clicava em Filtrar antes de o
  portal ligar jQuery/DataTables → v1.1 (#3101) espera `table.dataTable` e a RESPOSTA do `POST /order-viewer/form/list`.
- **1º uso — gravação**: "UPDATE requires a WHERE clause". O Supabase carrega o **pg-safeupdate** nas sessões da API;
  a RPC tinha 2 UPDATE sem WHERE em tabela temporária, e o PG17 local NÃO carrega a extensão → a prova não pega.
  Migration `20261016013000` (#3102) + postcondição/assert que reprova UPDATE sem WHERE (regex com `\m`: sem fronteira,
  o comentário "safeupdate" dava falso positivo). Tudo-ou-nada segurou: nada gravado.
- **Resultado**: pedido #3644 → **PO 1291** no Omie; 10 × DFA.4080LT, R$ 304,097 + IPI 6,5% = R$ 323,863/un,
  total R$ 3.238,63 = Vlr Total do portal (provado).
