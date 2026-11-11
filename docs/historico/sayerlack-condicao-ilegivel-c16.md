# C16 — pedido do portal Sayerlack recusado por "condição ilegível" (2026-11-11)

Plano v8, lote 0, item C16. Edge `sayerlack-importar-pedido-portal` (v1.12-condicao-retrato). Runbook:
`docs/runbooks/sayerlack-pedido-portal-nao-entrou.md` § "Condição de pagamento ilegível".

## Fato

Os pedidos **2148220** e **2148223** ficaram fora do Omie a partir de 2026-11-09 20:31 UTC. Toda tentativa
(automática e pelo botão) recusou com `etapa=leitura`, `motivo=condicao_ilegivel`. Em 11/11, nenhum PO à mão com esses
números no contrato (`purchase_orders_tracking`) e nenhuma linha em `pedido_compra_sugerido`.

## O que a evidência imutável (#3747) mostrou — psql-ro, 2026-11-11

- `sayerlack_portal_evidencia`: **13 de 13** leituras desde que a tabela existe (2148220 ×7, 2148223 ×5, 2148912 ×1)
  com `condicao` NULL e `condicoes_opcoes = []`. Não foi coisa dos dois pedidos: **o leitor de condição nunca leu nada
  em prod**.
- Trace (evidência #12): `itens_direto` ok em 9,8 s; passo `condicao` null em 25 s. O `waitForFunction` de 15 s estourou
  e, depois dele, `lerCondicoesOpcoesDom` achou zero opções: na rota do viewer
  (`/order-creation-form-edit/<nº>/route/order-viewer`) o `#condicoes_pagamento` **não existia ou estava vazio**.
- Contraste: o **envio** (`enviar-pedido-portal-sayerlack`, tela `/order-creation/form/add` depois de escolher o
  cliente no select2) leu o mesmo seletor com 80+ opções e "70 - 7 DIAS" selecionado em 4 de 4 envios desde 09/11.
- Desde que a condição passou a ser exigida (#3674/#3691, 06-07/11), **nenhuma importação passou**. As 6 anteriores
  gravaram `000` (o à-vista fabricado que motivou a mudança).
- A fixture `scripts/__fixtures__/sayerlack-portal/detalhe-pedido.html` (#3742) foi **escrita à mão**, presumindo que
  o viewer tem o mesmo select da criação. Ela nunca foi capturada da tela real. O teste "contra HTML real" provava o
  seletor contra a hipótese, não contra o portal.

**O que não deu para provar:** o que a tela de detalhe TEM no lugar do select. A evidência não guardava o DOM, e a
sessão não consegue abrir o portal (exige login, e o agente não autentica com senha). Este é o limite honesto do
diagnóstico.

## O que mudou (PR deste item)

1. **Retrato da tela na evidência.** Quando a condição não vem, o script grava no `trace` os passos `detalhe_aberto`
   (status do GET e caminho final, sem query, o que mostra redirect para login ou home) e `condicao_diag`
   (`diagnosticarCondicaoDom`, em `condicao-dom.ts`: todos os `<select>` com nº de opções, os campos e as linhas de texto
   que falam de condição ou pagamento, com a linha seguinte, nº de iframes e quanto foi cortado). Com teto e sem PII:
   campo oculto ou senha só como metadado; texto selecionado só dos selects de condição; CPF/CNPJ, 8+ dígitos e
   sequências de token mascarados. A função mora na importadora, fora do
   `_shared`, para não mudar a fonte (e o fingerprint) da varredura.
2. **Recusa com causa.** O `motivo=condicao_ilegivel` continua o mesmo (contrato). A resposta ganha `causa_condicao`
   (`sem_retrato` · `fora_do_detalhe` · `campo_ausente` · `campo_sem_opcoes` · `sem_selecao` · `fora_do_prazo`) e uma
   mensagem que diz se repetir provavelmente adianta. A causa é o que ESTA leitura observou, não causa confirmada.
   Quando repetir não adianta, a mensagem diz como seguir: lançar à mão no Omie com o nº no contrato, depois de
   conferir que não há PO nem importação em andamento, e não importar de novo até o PO aparecer no espelho. O IP006
   lê `purchase_orders_tracking`, que tem a defasagem do sync. Nenhuma causa vira condição: tudo continua recusando.
3. **Testes.** Envelope REAL da evidência #12 (2148223) no teste do handler: recusa sem RPC de gravação e sem disparo.
   Classificador por causa; texto serializado do retrato rodando sem o escopo do módulo; retrato no jsdom (com e sem
   select, teto de 30 selects). Falsificação: 9 sabotagens, uma por vez, todas vermelhas, com controle verde antes e
   depois, em `LC_ALL=C` e `pt_BR.UTF-8`.

## 2ª opinião (Codex, challenge, 2026-11-11)

Sem P0. O Codex confirmou o fail-closed (o retrato nunca alimenta a condição) e o template do Browserless (o
`${fn.toString()}` não reinterpreta escapes). Os 2 P1 foram corrigidos no mesmo PR: o "não duplica" era uma garantia
falsa, porque o IP006 lê um espelho com defasagem, e o retrato podia gravar campo oculto e CPF de select alheio. Os P2
também: a causa passou a ser descrita como observação e o retrato ganhou o par rótulo→valor, os cortes, os iframes e o
status do detalhe no caminho de fallback. Fica de fora o status das requisições XHR da tela (sem corpo nem URL): só se
o retrato não bastar.

## Próximo passo (o conserto do seletor) — superado, ver Desfecho

Depois do deploy da edge, a próxima leitura de 2148220/2148223 (botão ou varredura) grava o retrato. Com ele, o seletor
certo para o viewer sai de dado, não de hipótese:

```sql
SELECT id, gravado_em,
       jsonb_path_query_first(trace, '$[*] ? (@.step == "detalhe_aberto")') detalhe,
       jsonb_path_query_first(trace, '$[*] ? (@.step == "condicao_diag")') retrato
FROM public.sayerlack_portal_evidencia WHERE protocolo IN ('2148220','2148223') ORDER BY id DESC LIMIT 2;
```

## Desfecho (2026-11-11): o seletor estava certo; o caminho até a tela, não

- **O retrato (v1.12, evidência de 14:02Z, 2148223 manual) mostrou a causa.** O `page.goto` direto para
  `/order-creation-form-edit/2148223/route/order-viewer` respondeu **404**. O caminho final foi
  `/login/order-creation-form-edit/…` e a página ficou com o título "Not Found", sem nenhum select. O leitor de condição
  nunca chegou à tela de detalhe.
- **A rota existe.** No Chrome logado do founder, a mesma URL mostra "Condição de Pagamento 70 - 7 DIAS" num campo
  travado. Na Consulta Pedidos, o nº do pedido é um `<a href>` para essa URL. A coluna Ações só tem e-mail e impressão.
- **O conserto foi o #3820 (v1.13-detalhe-por-clique).** A edge passou a abrir o detalhe clicando nesse link, o mesmo
  padrão que já se usava para abrir a Consulta pelo menu ("goto direto pode cair em /login/…"). O `goto` ficou só como
  fallback.
- **A prova foi feita em prod.** A varredura das 15:31Z leu os dois pedidos com `detalhe_aberto` via clique e status
  200, e com `condicao = "70 - 7 DIAS"` e 80 opções. Os dois entraram no Omie: 2148220 → PO 1340 e 2148223 → PO 1341.
  `sayerlack_varredura_falha.resolvido_em` foi preenchido às 15:31Z nos dois. A sonda pós-deploy (tentativa #1086,
  request 16132) deu DEPLOY CONFIRMADO para a v1.13, com fonte `bf57a210…`.

## Lição

**Neste portal, `goto` direto é suspeito; chegar pelo clique é o normal.** Rota que abre no Chrome do usuário pode
dar 404 por `goto` na sessão do robô. Quando a tela é alcançada por link, o robô navega pelo link: casa o `href` pelo
fim, com o nº entre barras, e usa só links de leitura. Mesmo assim, grave status e caminho do destino no trace, porque
foi isso que transformou "condição ilegível" em "404".

**Fixture escrita à mão não é "HTML real".** Um teste de seletor contra uma fixture inventada prova a hipótese, não o
portal. Ele passa verde para sempre enquanto a produção recusa 100%. Toda fixture de tela de terceiro precisa dizer de
onde veio (capturada em qual data, de qual URL). Fixture "recortada" a partir de outra tela (aqui, a criação no lugar do
viewer) é hipótese e precisa ser marcada como tal.

**Evidência que não guarda o porquê da recusa não diagnostica.** A #3747 gravou o envelope (condição null, opções
`[]`), mas não o que a tela tinha. Treze recusas iguais disseram "tente de novo", e tentar de novo nunca resolveria.
Recusa fail-closed precisa carregar o retrato do que faltou e dizer se repetir adianta.
