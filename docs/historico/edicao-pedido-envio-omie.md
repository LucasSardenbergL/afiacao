# Edição de pedido em /sales — o que vai ao Omie (P0 5–8) e a trava do gêmeo (2026-11-26)

> Continuação dos PRs #4187 e #4198 (P0 1–4 da tela de edição). Money-path. Edge `omie-vendas-sync` v1.50,
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
  e **cliente vivo ≠ `codigo_cliente` que o app mandou ao criar o PV** (sem âncora, ou âncora não independente
  — PV vinculado por duplicidade, `omie_response.reconciled`, cujo payload desde o #4174 é o PV consultado —
  também recusa; 0 reconciliados em prod). Categoria/conta corrente ausentes na leitura também recusam. Tudo
  200 estruturado `blocked` + `motivo`, que a tela mostra.
- **Cabeçalho preservado**: etapa, `data_previsao`, frete e classificação (`codigo_categoria`, conta corrente,
  `codVend`; vendedor ausente vai ausente, sem default) vão como LIDOS; antes iam `"10"`, hoje e um frete do zero. O AlterarPedidoVenda vai **antes**
  do delete+add: se o Omie recusar o frete reenviado, os itens ficam intactos.
- **Âncora sobrevive à edição**: o payload regravado leva `cabecalho.codigo_cliente` (antes a perdia).
- **Caminho local**: salvar só observação não toca `items/subtotal/total`; itens mudados com total ≠ subtotal
  recusa; o UPDATE só vale sem PV, não excluído, no mesmo status e na MESMA `updated_at` da abertura (trigger
  em todo UPDATE — o claim de um envio posterior muda a versão: sem dois totais confirmados). **Não** filtra
  `envio_omie_reivindicado_em`: `authenticated` não tem SELECT nessa coluna (42501 em todo salvar — Codex, prod).
- **Parcela**: só vai ao Omie se o vendedor TROCOU o seletor; sem troca a edge herda o prazo VIVO do PV
  (reenviar o do recibo regravaria um prazo que o financeiro mudou no Omie). Muda o teste de formas degradadas.
  Sem escolha E sem parcela na leitura → recusa `leitura_omie_incompleta` (senão `parcelaEfetiva` daria `999`).
- **Preço do produto adicionado**: `precoDeNascimento` (`src/lib/pricing/`), a mesma decisão do Novo Pedido;
  legado com `customer_user_id = created_by` usa tabela pura; resposta tardia de QUALQUER leitura do pedido
  anterior não publica (geração nasce antes do 1º await do `loadOrder`); falha do mapeamento avisa o vendedor;
  a busca mostra o preço que o clique aplica (`precoPrevisto`), não a tabela.
- **Cupom**: nenhuma data nem valor por parcela inventados (`textoVencimentosDoCupom`, uma função para as
  duas vias). O app não guarda as parcelas reais do PV; `S41` = 28/42/56 e o PV pode ter parcelas desiguais.

## Decisões e residuais

- Etapa 50 não editável é restrição de PRODUTO (o Omie aceita) — mesma régua do gêmeo `separacao`.
- Frete reenviado inteiro: não provado em homologação (Codex). Mitigado pela ordem cabeçalho-antes.
- Residuais aceitos: tela aberta DURANTE um envio em voo (claim feito, write-back não) não é vista pelo UPDATE local; cabeçalho
  aplicado + falha na exclusão deixa a parcela nova sobre os itens velhos (a mensagem diz); gêmeo local
  `separacao` de um PV que voltou a 10 no Omie é recusado (precisão > recall).
- Falsificação: 14 + 9 + 4 + 2 sabotagens, todas vermelhas com controle verde; uma camada redundante (corrida do
  preço) foi removida porque sabotá-la ficava verde.
- ~~Fora (Codex r4)~~ **Fechado na edge v1.53 + migration 20261126190127:** edição local salva ANTES do
  claim de uma conversão aberta em outra aba com os itens velhos → PV com o total antigo. O claim passou a
  ser CONFERIDO (`sales_order_reivindicar_envio_conferido`, `./claim-conferido.ts`): a edge lê o
  `updated_at` da linha ANTES do gate ATP e o claim só carimba se (a) a linha não mudou desde então e (b) a
  projeção [código, qtd, valor, cor da tinta] dos itens da LINHA — como multiconjunto — for igual à dos
  itens que vão ao Omie. A pré-checagem recusa a foto velha antes de reservar estoque. A recusa LANÇA com
  `[pedido_alterado]` (caller antigo lê `blocked` desconhecido como sucesso); a tela de orçamentos
  reconhece a marca e recarrega a lista. Não depende do front (nenhum bundle manda versão).
  Denominador: 27/27 pedidos do app com PV têm a linha igual ao `det` enviado. Nenhum escritor legítimo
  toca a linha entre a leitura e o claim (medido em prod: só `atp_confirmar_pv`, depois do IncluirPedido).
  Prova PG17 `db/test-claim-envio-conferido.sh` (40 asserts; 2 sessões reais nas duas ordens; o caso
  2→3→2 entre a reserva e o claim; `LC_ALL=C` e `pt_BR.UTF-8`) com uma sabotagem por camada.
  - Codex do claim (r1, BLOQUEANTE sim → corrigido): versão no claim (ATP × claim), multiconjunto (retry do
    pedido programado relê sem `ORDER BY`), cor da tinta, recusa por `throw`.
  - Codex do claim (r2, BLOQUEANTE sim → 3 corrigidos + 1 residual): o pedido programado
    (`pedido-programado-enviar` v1.1) não marca `[OMIE-INCERTO]` numa recusa `[pedido_alterado]` (travaria o
    "Cancelar") e preserva a incerteza HERDADA do `erro_motivo` anterior; a mensagem diz "esta tentativa NÃO
    enviou nada" (outra tela pode ter enviado); a ordenação TS é por unidade de código (o `localeCompare`
    empatava composições Unicode). O BLOQUEANTE (reserva ATP obsoleta adotada no retry do checkout) é
    PRÉ-EXISTENTE — `reservar_estoque` retorna sem liberar a reserva anterior e `atp_confirmar_pv` vincula
    todas as ativas; qualquer retry com carrinho trocado após falha pós-ATP o alcança. A v1.53 o ESTREITA (a
    pré-checagem recusa antes do ATP; sobra a janela de segundos entre ela e o ATP) e não o piora (antes, o PV
    saía com B e vinculava a reserva de A direto). Liberar a reserva na recusa foi DESCARTADO: com duas telas
    enviando o mesmo pedido, a perdedora liberaria a reserva da vencedora antes do `atp_confirmar_pv`.
  - Codex do claim (r3, BLOQUEANTE sim → 2 corrigidos + 1 residual): o programado lia a incerteza
    herdada na LISTAGEM (velha: outro runner pode ter terminado em `erro` com `[OMIE-INCERTO]` entre ela e o
    claim) e as saídas antecipadas pós-claim (header/itens/config/validação) a apagavam no release → agora
    lê `erro_motivo` NO claim e toda saída pós-claim passa por `falha()`, que a preserva; `null` × `""` na
    cor empatavam na ordenação TS → recusa à toa. Residual: a reserva ATP obsoleta (r2) ganha também a
    janela ATP → claim (lê A, reserva A, outra tela salva B, o claim recusa; um retry de B por backorder
    antes do TTL vincula a reserva de A) — mesma classe pré-existente, mesmo motivo para não liberar.
  - Residuais aceitos: (i) `ensureSalesOrderRow` (checkout/retry) regrava a linha sem versão — apaga a
    edição de outra aba, pré-existente; (ii) editor aberto DEPOIS do claim salva com o `updated_at` novo
    enquanto o PID é nulo; (iii) recusa depois do gate ATP deixa a reserva até o TTL (30 min), como todo
    throw pós-ATP; (iv) dado sujo (`"10,50"`) lança 22P02 genérico; (v) salvar NÃO commitado × envio com
    os itens novos recusa sem esperar o lock (sem caminho real).
  - **No ar (2026-11-27, PR #4250):** migration 20261126190127 aplicada pela sessão e validada por fora
    (`t | t | f`; anon `f`, service_role `t`); `pedido-programado-enviar` v1.1 (onda 1, sonda CONFERE) e
    depois `omie-vendas-sync` v1.54 — a v1.53 com a leva 1 do #4258 por cima (onda 2, relé CONFERE). Sensor
    de edição: onda 2 `SEM_EDICAO`; onda 1 acusou o commit do bot que regravou `types.ts` (as 2 funções
    novas) e o `.env` com a chave `sb_publishable` que o bundle publicado JÁ servia — falso positivo.
  - Fora, pré-existente e de outro caminho: a reconciliação por duplicata (`PV_<id>`) compara só SKU e
    quantidade, então confirma um PV com preço antigo (Codex, achado 5).
- Fora: concorrência entre dois editores / alteração no Omie entre abrir e salvar; vencimentos reais de
  `fin_contas_receber` no cupom (RLS de financeiro + vazio-por-RLS indistinguível de não faturado).
