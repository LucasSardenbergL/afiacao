# Lote mínimo do portal Sayerlack — design [money-path]

> Status: **proposta, aguardando aprovação do founder** · 2026-11-18 · nenhuma linha de código ainda.
> Gatilho: pedido 4485 (OBEN). O item VERNIZ PARA PISO YO20.1464.00BB precisa de 1 unidade. O portal recusou com
> "Quantidade informada menor que o lote mínimo de venda (20)".

## 1. Problema

O portal Sayerlack tem **lote mínimo de venda por item** e recusa a linha abaixo dele. Hoje o sistema não enxerga isso
em nenhum ponto:

- **Motor:** não conhece o lote. `sku_parametros.lote_minimo_fornecedor` existe, mas vale `1` nos 612 SKUs e a RPC
  `gerar_pedidos_sugeridos_ciclo` não o lê (medido em prod via `psql-ro`, 2026-11-18).
- **Envio** (`enviar-pedido-portal-sayerlack`):
  - ao salvar o item, só espera o POST `save-tab-preco-session` (`index.ts:972-1018`);
  - não lê corpo da resposta nem alerta do DOM;
  - a recusa por lote mínimo **passa em silêncio** ou vira `PORTAL_RESPONSE_FAILURE` genérico (`:1344-1358`);
  - classificada como `erro_retentavel`, seria retentada 3× igual.
- **Histórico:** zero ocorrências de "lote m" em `pedido_compra_sugerido.portal_erro` e em `pedidos_portal_tentativas`.
  O founder bateu nesse erro digitando à mão; o sistema nunca o registrou.

O que o founder quer quando o lote é maior que a necessidade:

1. Lançar no portal o mínimo e, no PO do Omie, a quantidade real.
2. Pedir ao CRS (crs@sayerlack.com.br), citando o nº do pedido Sayerlack, que reduza para a quantidade real.
3. Se o CRS responder que não pode, cancelar o pedido.

## 2. Unidade do lote — **Qtd UN** (confirmado pelo founder, 2026-11-18)

O número da mensagem "lote mínimo de venda (N)" está em **Qtd UN**, a unidade de embalagem do portal. **Não** é Qtd Fat
(litros).

No caso do gatilho:

- `00BB` é balde de 5 L, com Cap Emb = 5;
- lote = **20 baldes = 100 L** (Qtd Fat 100) para uma necessidade de **1 balde**;
- ao preço da grade, R$ 579,05 por balde, a diferença é de ~19 baldes, cerca de R$ 11 mil.

É por isso que "pedir redução ao CRS" importa: comprar o lote seria quase 20× a necessidade.

**Conversão para o Omie:** `lote_omie = lote_un_portal ÷ fator_conversao` (`sku_fornecedor_externo`; o fator é a
unidade do portal por unidade do Omie). Sem fator aprovado, não converte: estado `NULL`, nunca um palpite.

O portal digita a quantidade em Qtd UN. A Fase 0 também passa a afirmar isso **por cabeçalho**, não por posição.

## 3. Desenho por fases

Regra de corte: cada fase só começa com sinal da anterior (CLAUDE.md, "Fase N+1 exige SINAL").

### Fase 0 — enxergar a recusa (vale sozinha: fecha um buraco silencioso)

**1. Ler a resposta do salvar-item.** Logo após `saveResult` (`index.ts:984-1006`):

- ler o corpo do POST;
- ler o alerta visível (`.alert-danger`, `.swal2-*`, toast);
- registrar `page.on('dialog')`.

Parser puro, testado em vitest e Deno: `/lote m[ií]nimo de venda \((\d+(?:[.,]\d+)?)\)/i` → `{ lote: number }`.

**2. Novo `erroTipo` `LOTE_MINIMO_PORTAL`.** Entra na lista de erro lógico pré-submit, como `erro_nao_retentavel`:
retentar não muda o lote.

- Espelho obrigatório em `src/lib/reposicao/sayerlack-classificacao.ts`.
- Grava em `portal_resposta` um item com:
  - `sku_portal` e `lote` capturado;
  - a linha da grade **lida por cabeçalho**: UN, Cap Emb, Qtd Fat, Qtd UN;
  - a qtde tentada.
- Corrige um efeito colateral: a qtde hoje é digitada por **posição** (`td:nth-of-type(7)`), e o scrape lê `qtd_un`
  por cabeçalho. A Fase 0 passa a afirmar, por cabeçalho, em que coluna digitou.

**3. Alerta.** `fornecedor_alerta` com tipo `lote_minimo_portal`, citando o pedido, o SKU e o lote.

**4. Testes.**
- Parser com a frase real.
- Variações de acento, vírgula e caixa, nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`).
- Classificação falsificada: remover o tipo da lista e exigir vermelho.

**Sinal para abrir a Fase 1:** ≥1 recusa real capturada com `lote` (Qtd UN) e `sku_portal` legíveis, de N envios no período.

### Fase 1 — o lote vira dado e a decisão vira tela

**Onde mora o lote:** colunas novas em `sku_fornecedor_externo`, porque é ali que vive a unidade do portal:

- `lote_minimo_portal numeric NULL`, sempre em **Qtd UN** do portal (§2);
- `lote_minimo_capturado_em timestamptz`;
- `lote_minimo_origem text` (`recusa_portal` | `manual`).

Por que não reaproveitar as colunas existentes:

- `minimo_forcado_manual` é piso **manual** do founder, sem origem nem data.
- `lote_minimo_fornecedor` é morto: default 1, ninguém lê.

**1 escritor:** o envio (pela recusa) ou a tela (manual). Ausente = `NULL`, nunca `1` fabricado.

**Na tela do pedido** (`/admin/reposicao/pedidos`), o item com qtde final abaixo do lote mostra "mínimo do portal: 20 UN (100 L) · +R$ X sobre a necessidade"
e três ações, sempre por **decisão humana**:

| Ação | Portal | PO Omie | Efeito |
|---|---|---|---|
| **Comprar o lote** | lote | lote | `qtde_final := lote` (estoque extra; mostra o R$ a mais) |
| **Pedir redução ao CRS** | lote | qtde real | abre o fluxo da Fase 2 |
| **Tirar o item** | — | — | remove a linha do pedido |

O motor passa a **avisar** (não a arredondar) quando a sugestão fica abaixo do lote conhecido. Arredondar
automaticamente é decisão de capital de giro e fica fora deste escopo: o histórico de superdimensionamento do motor
está em `reposicao.md` §Mínimo forçado.

### Fase 2 — portal ≠ Omie + e-mail ao CRS + leitura da resposta

**Ledger novo** `pedido_portal_ajuste_qtde`, com RLS e 1 escritor por transição:

| coluna | |
|---|---|
| `pedido_id`, `pedido_item_id`, `sku_portal` | |
| `qtde_portal`, `qtde_omie`, `unidade` | o par divergente, explícito |
| `status` | `rascunho` → `email_enviado` → `aceito` · `recusado` · `sem_resposta` · `cancelado` · `lote_aceito` |
| `email_message_id`, `email_enviado_em`, `resposta_recebida_em`, `resposta_classificacao`, `resposta_trecho` | trilha |
| `decidido_por`, `decidido_em` | toda transição terminal tem dono humano (Fases 1–2) |

**Envio do PO com qtde diferente**

- Hoje o `disparar-pedidos-aprovados` faz `nQtde = ceil(qtde_final)` (`produto-po.ts:70`).
- Com ajuste aberto, o PO usa `qtde_omie` do ledger, e o portal usa `qtde_portal`.
- A divergência é **intencional e registrada**. Toda tela de conciliação e recebimento deve ler o ledger antes de
  acusar diferença.
- **Onde mais aparece:** a conferência de recebimento. Se a Sayerlack faturar o lote, a NF chega com 20 e o PO diz 1.

**E-mail ao CRS**

- **Canal:** Gmail API, o mecanismo de `dispatch-notifications`, a partir de uma caixa real da OBEN monitorada pelo
  Apps Script.
- **Não usar Resend:** o remetente atual é o sandbox `onboarding@resend.dev`. É inadequado para fornecedor, e a resposta
  não voltaria para caixa nenhuma.
- **Assunto com token de correlação:** `Alteração de quantidade — Pedido Sayerlack <protocolo> [AFI-<id>]`.
- **Corpo:** pedido, SKU, descrição, quantidade lançada → quantidade desejada, com pedido de confirmação.
- **Fase 2a:** o sistema monta o rascunho e o founder clica "Enviar". Mandar mensagem em nome da empresa é ação externa.
- **Fase 2b:** envio automático, só depois de N rascunhos enviados sem edição.

**Resposta do CRS**

1. Adicionar `crs@sayerlack.com.br` ao mapa `REMETENTES` do `gmail-webhook-receiver`. Hoje a edge rejeita remetente
   fora do mapa, e a doc a marca como "órfã provável": **confirmar antes** que o Apps Script está vivo e qual caixa
   monitora.
2. Correlacionar pelo token `[AFI-<id>]` ou pelo protocolo no assunto. Sem correlação, vai para a fila manual, nunca
   para um palpite.
3. Classificar o `bodyText` com Anthropic direto (`MODELO_PADRAO`, tool-use não forçado) em `aceito` | `recusado` |
   `ambiguo`, guardando o trecho citado.
4. **Fase 2 não cancela sozinha.**
   - `recusado` vai para a fila "decidir", com as opções "cancelar o pedido" e "aceitar o lote".
   - `aceito` só marca o ledger. A prova final é a NF ou o pedido importado do portal com a qtde reduzida.
5. **Sem resposta** em X dias úteis (a definir; o lead time do grupo é a referência) → alerta.

**Cancelar, quando decidido**

- O cancelamento na Sayerlack é por e-mail ao CRS ou pelo portal. Hoje **nenhuma edge escreve cancelamento no portal**.
- O PO do Omie é cancelado ou encerrado pelo caminho auditado que já existe.
- A varredura já lê "6 - Cancelado" e o `sayerlack-encerrar-cancelado-portal` já encerra, restrito a master. Reusar,
  não duplicar.

### Fase 3 — cancelamento automático (o que o founder pediu), condicionado a sinal

- **Só abre** depois de a Fase 2 medir a taxa de acerto do classificador **com denominador**: N respostas,
  M classificadas certo, revisadas pelo founder.
- **Conflito com decisão anterior:** o encerramento por cancelamento foi decidido como **auditado, não automático**
  (`sayerlack-encerrar-cancelado-portal`). A Fase 3 precisa de nova decisão explícita do founder sobre essa regra.
- **Mesmo na Fase 3:**
  - só `recusado` com confiança alta e trecho citado;
  - nunca `ambiguo`;
  - notificação com "desfazer" durante uma janela antes do efeito no Omie.

## 4. Fora de escopo

- Arredondar automaticamente as sugestões do motor para o lote.
- Capturar o lote proativamente para todo o catálogo, por exemplo estendendo a `sayerlack-captura-precos`. Só se a
  Fase 0 mostrar que acontece com frequência.

## 5. Perguntas abertas para o founder

1. ~~Unidade do "20"~~: **respondida**, é Qtd UN (§2).
2. **Caixa de e-mail:** de qual caixa sai o e-mail ao CRS e onde a resposta chega? O Apps Script do
   `gmail-webhook-receiver` ainda está vivo?
3. **Cancelar na Sayerlack:** é por e-mail ao CRS ou existe ação no portal?
4. **Se a Sayerlack faturar o lote mesmo após pedir a redução:** aceitamos o estoque extra ou devolvemos?
5. **Prazo de "sem resposta":** quantos dias úteis?

## 6. Deploy e verificação (por fase)

| Fase | Camadas | Quem |
|---|---|---|
| 0 | edge `enviar-pedido-portal-sayerlack` (bump `VERSAO` + fingerprint); espelho em `src/` (Publish só se a tela mudar) | sessão abre o PR; deploy da edge segue `pendencias:deploy` |
| 1 | migration (colunas em `sku_fornecedor_externo`) + tela + Publish | migration pelo ritual `lovable-db-operator`; Publish pelo founder |
| 2 | migration (ledger + RLS) + `disparar-pedidos-aprovados` + `gmail-webhook-receiver` + edge nova de rascunho/envio + secrets Gmail | idem; secrets no Supabase pelo founder |

**Money-path:** Fases 1 e 2 passam por `/codex` (Caminho B) antes da implementação, com prova SQL em PG17
executando, não só criando.
