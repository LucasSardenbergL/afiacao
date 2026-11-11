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
   (`diagnosticarCondicaoDom`, em `condicao-dom.ts`: todos os `<select>` com nº de opções e texto selecionado, os campos
   e as linhas de texto que falam de condição ou pagamento, tudo com teto). A função mora na importadora, fora do
   `_shared`, para não mudar a fonte (e o fingerprint) da varredura.
2. **Recusa com causa.** O `motivo=condicao_ilegivel` continua o mesmo (contrato). A resposta ganha `causa_condicao`
   (`sem_retrato` · `fora_do_detalhe` · `campo_ausente` · `campo_sem_opcoes` · `sem_selecao` · `fora_do_prazo`) e uma
   mensagem que diz se repetir resolve. Nas causas estruturais, a mensagem diz como seguir: lançar à mão no Omie com o
   nº no contrato, o que a RPC depois recusa com IP006, sem duplicar. Nenhuma causa vira condição: tudo continua
   recusando.
3. **Testes.** Envelope REAL da evidência #12 (2148223) no teste do handler: recusa sem RPC de gravação e sem disparo.
   Classificador por causa; texto serializado do retrato rodando sem o escopo do módulo; retrato no jsdom (com e sem
   select, teto de 30 selects). Falsificação: 9 sabotagens, uma por vez, todas vermelhas, com controle verde antes e
   depois, em `LC_ALL=C` e `pt_BR.UTF-8`.

## Próximo passo (o conserto do seletor)

Depois do deploy da edge, a próxima leitura de 2148220/2148223 (botão ou varredura) grava o retrato. Com ele, o seletor
certo para o viewer sai de dado, não de hipótese:

```sql
SELECT id, gravado_em,
       jsonb_path_query_first(trace, '$[*] ? (@.step == "detalhe_aberto")') detalhe,
       jsonb_path_query_first(trace, '$[*] ? (@.step == "condicao_diag")') retrato
FROM public.sayerlack_portal_evidencia WHERE protocolo IN ('2148220','2148223') ORDER BY id DESC LIMIT 2;
```

## Lição

**Fixture escrita à mão não é "HTML real".** Um teste de seletor contra uma fixture inventada prova a hipótese, não o
portal. Ele passa verde para sempre enquanto a produção recusa 100%. Toda fixture de tela de terceiro precisa dizer de
onde veio (capturada em qual data, de qual URL). Fixture "recortada" a partir de outra tela (aqui, a criação no lugar do
viewer) é hipótese e precisa ser marcada como tal.

**Evidência que não guarda o porquê da recusa não diagnostica.** A #3747 gravou o envelope (condição null, opções
`[]`), mas não o que a tela tinha. Treze recusas iguais disseram "tente de novo", e tentar de novo nunca resolveria.
Recusa fail-closed precisa carregar o retrato do que faltou e dizer se repetir adianta.
