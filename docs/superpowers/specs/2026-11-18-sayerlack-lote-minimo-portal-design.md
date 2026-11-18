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

**Fluxo decidido pelo founder (2026-11-18)**

1. O pedido entra no portal com o lote (Qtd UN) e o PO do Omie com a quantidade real.
2. **Logo em seguida**, no mesmo ciclo do envio, sai o e-mail ao CRS pedindo a alteração. A resposta costuma vir no
   mesmo dia.
3. **Sem resposta em 1 dia útil**, o sistema alerta o founder e **cobra** respondendo no mesmo thread.
4. **Se a resposta for "não é possível alterar"**, respondemos no thread **pedindo o cancelamento**, e a Sayerlack
   cancela sozinha. Não existe ação de cancelamento no portal.
5. A varredura já lê "6 - Cancelado". O encerramento do nosso lado (PO e pedido) segue pelo caminho auditado que já
   existe.

**Ledger novo** `pedido_portal_ajuste_qtde`, com RLS e 1 escritor por transição:

| coluna | |
|---|---|
| `pedido_id`, `pedido_item_id`, `sku_portal` | |
| `qtde_portal`, `qtde_omie` | o par divergente, explícito, em Qtd UN |
| `status` | `email_enviado` → `aceito` · `recusado` → `cancelamento_pedido` → `cancelado` · `lote_aceito` |
| `gmail_thread_id`, `email_message_id`, `email_enviado_em`, `cobrado_em`, `resposta_recebida_em`, `resposta_classificacao`, `resposta_trecho` | trilha |
| `decidido_por`, `decidido_em` | dono de cada transição: `sistema` ou o user |

**Proposta: o item abaixo do lote vai num pedido de portal SEPARADO.** Hoje ele entraria no mesmo pedido Sayerlack dos
outros 9 SKUs, e "cancelar o pedido" derrubaria a compra inteira. Com o item isolado, o cancelamento afeta só ele. É
a pergunta aberta nº 6.

**Envio do PO com qtde diferente**

- Hoje o `disparar-pedidos-aprovados` faz `nQtde = ceil(qtde_final)` (`produto-po.ts:70`).
- Com ajuste aberto, o PO usa `qtde_omie` do ledger, e o portal usa `qtde_portal`.
- A divergência é **intencional e registrada**. Toda tela de conciliação e recebimento deve ler o ledger antes de
  acusar diferença.
- **Onde mais aparece:** a conferência de recebimento. Se a Sayerlack faturar o lote, a NF chega com 20 e o PO diz 1.

**E-mail ao CRS — sai do Gmail pessoal do founder**

O founder decidiu que o e-mail sai do Gmail pessoal dele. É a **mesma caixa** que o Apps Script do
`gmail-webhook-receiver` monitora (§6), então a resposta volta para dentro do sistema.

**Envio**
- Pela Gmail API (`users/me/messages/send`), o mecanismo de `dispatch-notifications`.
- Verificar antes de implementar:
  - o refresh token já configurado é dessa conta e tem escopo `gmail.send`;
  - se não for, o founder gera um token novo e o grava no Supabase secrets, nunca no chat.
- Guarda o `threadId` devolvido no ledger.

**Destinatário e assunto**
- Para: crs@sayerlack.com.br.
- Assunto: `Alteração de quantidade — Pedido Sayerlack <protocolo> [AFI-<id>]`.

**Corpo (template fixo, sem LLM)**
- pedido Sayerlack, SKU e descrição;
- "lançado 20 UN pelo lote mínimo, precisamos de 1 UN";
- pedido de confirmação.

**Cobrança**
- Resposta no mesmo thread: "Bom dia, conseguem confirmar a alteração do pedido <protocolo>?".
- Sai automaticamente quando `dias_uteis_entre(email_enviado_em, now()) >= 1`. A função já existe em prod.
- Ao mesmo tempo, `fornecedor_alerta` para o founder.
- Segunda cobrança sem resposta → só alerta, para não virar spam ao fornecedor.

**Resposta do CRS**

- **Quem responde:** o crs@ **nunca** escreveu para essa caixa (0 de 8.771 e-mails no log). A resposta pode vir de uma
  pessoa, como as caixas pessoais da Sayerlack que aparecem no log. Logo, correlacionar por **thread**, não por
  remetente.
- **Correlação:**
  - o Apps Script passa a enviar `threadId` (e `inReplyTo`) no payload; hoje o payload não tem esses campos e o
    script vive fora do repo, então o founder ou a sessão edita no Google;
  - o webhook aceita qualquer remetente `@sayerlack.com.br` **cujo thread esteja no ledger**;
  - sem thread conhecido, cai no comportamento atual (mapa `REMETENTES`).
- **Classificação:** só a parte NOVA do `bodyText`, sem o texto citado, com Anthropic direto (`MODELO_PADRAO`, tool-use
  não forçado), em `aceito` | `recusado` | `ambiguo`, guardando o trecho citado.
- **Ações por classificação:**
  - `aceito` → marca o ledger. A prova final é a NF ou o pedido importado do portal com 1 UN.
  - `recusado` → **resposta de cancelamento no thread** (Fase 2a: um clique do founder; Fase 3: automática).
  - `ambiguo` → alerta o founder com o trecho e não age.

**Depois do cancelamento**

- A necessidade de 1 UN continua, e o motor vai sugerir de novo no próximo ciclo.
- O ledger marca o SKU com "redução recusada em <data>". A tela de decisão mostra isso, para não repetir o mesmo
  pedido ao CRS em loop.
- O founder escolhe entre comprar o lote, comprar de outra fonte ou esperar.

### Fase 3 — resposta de cancelamento automática, condicionada a sinal

- **O que muda:** a resposta "pedimos o cancelamento" a um `recusado` sai **sem clique**.
- **Abre quando:** a Fase 2a medir a taxa de acerto do classificador **com denominador**: N respostas, M aceitas pelo
  founder sem correção.
- **Por que esperar:** um "não" mal lido cancela uma compra necessária.
- **Mesmo automática:**
  - só `recusado` com confiança alta e trecho citado; `ambiguo` nunca;
  - o founder é notificado na hora, com o trecho.
- **O encerramento no Omie continua pelo caminho auditado.** Mudar essa regra é decisão separada.

## 4. Fora de escopo

- Arredondar automaticamente as sugestões do motor para o lote.
- Capturar o lote proativamente para todo o catálogo, por exemplo estendendo a `sayerlack-captura-precos`. Só se a
  Fase 0 mostrar que acontece com frequência.

## 5. Perguntas abertas para o founder

1. ~~Unidade do "20"~~: **respondida**, é Qtd UN (§2).
2. ~~Caixa de e-mail~~: **respondida**, é o Gmail pessoal do founder; o Apps Script está vivo (§6).
3. ~~Como cancelar~~: **respondida**, é uma resposta no thread do CRS; a Sayerlack cancela sozinha.
4. **Se a Sayerlack faturar o lote mesmo após pedir a redução:** aceitamos o estoque extra ou devolvemos?
5. ~~Prazo~~: **respondido**, é 1 dia útil para alerta e cobrança.
6. **O item abaixo do lote vai num pedido de portal separado?** É o que recomendo: sem isso, cancelar derruba os outros
   SKUs do pedido.

## 6. Evidência — automação de e-mail viva (`psql-ro`, 2026-11-18)

- `gmail_webhook_log`: 8.771 linhas; último recebimento em 2026-11-18 12:50 UTC (hoje).
- O Apps Script repassa a caixa **inteira**; só o mapa `REMETENTES` decide o que é processado. Nos últimos 30 dias:
  1.063 `rejeitado` e 1 `sucesso`.
- Remetentes `@sayerlack.com.br` já vistos: pedidos@, filialsp@, financeiro@ e caixas pessoais. **crs@: zero.**
- **Ressalva:** ninguém olhava a edge, a ponto de ela estar marcada como "órfã provável". A Fase 2 dá dono a ela.

## 7. Deploy e verificação (por fase)

| Fase | Camadas | Quem |
|---|---|---|
| 0 | edge `enviar-pedido-portal-sayerlack` (bump `VERSAO` + fingerprint); espelho em `src/` (Publish só se a tela mudar) | sessão abre o PR; deploy da edge segue `pendencias:deploy` |
| 1 | migration (colunas em `sku_fornecedor_externo`) + tela + Publish | migration pelo ritual `lovable-db-operator`; Publish pelo founder |
| 2 | migration (ledger + RLS + cron de cobrança) + `disparar-pedidos-aprovados` + `gmail-webhook-receiver` + edge nova de envio/cobrança + Apps Script (threadId) + secret Gmail da conta do founder | idem; secret e Apps Script pelo founder |

**Money-path:** Fases 1 e 2 passam por `/codex` (Caminho B) antes da implementação, com prova SQL em PG17
executando, não só criando.
