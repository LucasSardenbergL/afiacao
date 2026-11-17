# Varredura do portal Sayerlack — o "0 de 0" de outra consulta virava prova (v1.13, 2026-11-17)

> Edge `sayerlack-varrer-pedidos-portal`. Continuação dos "Pontos cegos, Onda 3" de
> [importar-pedido-portal-sayerlack.md](importar-pedido-portal-sayerlack.md). Changelog do `VERSAO` em
> [versao-sayerlack-varrer-pedidos-portal.md](versao-sayerlack-varrer-pedidos-portal.md).

Achado ao diagnosticar o alerta 642 do data health (`sayerlack_cancelado_com_po`, alarme falso por outro motivo): a
rodada das 22:30 SP da varredura grava `sucesso` com 0 linhas, de forma intermitente. É o incidente da Onda 3 de
volta, agora **com a prova da v1.5 dizendo `ok`**.

## O que o ledger mostra

`acoes_execucoes`, slug `reposicao.varrer_portal_sayerlack`, lido por psql-ro.

- **Só às 22:30.** 6 das 20 rodadas das 22:30 com portal aberto leram 0 linhas: 22/10, 02/11 (as 2 da Onda 3), 09/11,
  12/11, 13/11 e 16/11. Nas 46 rodadas de 12:30 e 17:30, nenhuma. As 4 de novembro já são v1.12 e gravaram
  `prova_leitura='ok'` com `total_anunciado=0`.
- **A lista vazia é falsa.** Em 09/11 a mesma rodada leu 0 linhas desde 03/11 e, 12 s depois, em outra sessão, linhas
  desde 06/11 (4 situações aceitas na cobertura): o subconjunto tem linhas e o superconjunto não. Em 12, 13 e 16/11
  a mesma janela tinha devolvido 8, 8 e 5 linhas às 17:30.
- **A prova pendia de uma fonte só.** `dt_total` e `info_portal` são nulos em **todas** as rodadas desde a v1.5. O
  total vinha só do `recordsFiltered` da resposta do `POST /order-viewer/form/list`, e dela o ledger guardava só as
  chaves (`success, message, data, recordsTotal, recordsFiltered`), não os valores.
- **Não é a janela em UTC.** `emissao_desde` sai em data de SP (09/11 22:30 → 03/11), a mesma das 17:30. O que é UTC
  é o `data_emissao_fim` padrão da tela do portal (lido 11/11 às 22:30 SP de 10/11), que só alarga a consulta.

## A medida que sustenta o mecanismo

Está na evidência da importadora (`sayerlack_portal_evidencia.trace`, mesmo trecho de navegação e, na época, a mesma
espera). Em 10/11 às 22:31:32 SP ela consultou o pedido 2148912 e leu 0 linhas — 90 s depois de a varredura
listá-lo, e 14 h antes de achá-lo pelo mesmo número. Nesse trace a "resposta da consulta" chegou **48 ms depois do
clique** em Filtrar. Nas outras 20 leituras da tabela, todas com 1 linha, o intervalo vai de 214 a 502 ms. Uma
resposta a 48 ms do clique não é do pedido que o clique fez: é de um pedido anterior, ainda em voo.

## Causa

O script aceitava como resposta da NOSSA consulta a primeira resposta de `/order-viewer/form/list` que chegasse
depois do clique, sem prendê-la ao pedido que o clique gerou. A página do portal consulta por conta própria (ao abrir
a tela ou ao trocar um filtro), com o que estiver no formulário na hora; para a OBEN isso devolve lista vazia. Com
uma dessas ainda em voo no instante do clique — a espera antes dele é fixa, 1,5 s —, o `recordsFiltered: 0` dela
virava o total anunciado, a tabela mostrava o resultado dela, e `provarLeitura` fechava "0 lidas = 0 anunciadas".

**O que é medido e o que é inferência:**

- Medido: as listas vazias são falsas; a prova tinha uma fonte só; a resposta de 48 ms na edge irmã.
- Inferência: que as 6 rodadas da varredura tiveram o mesmo mecanismo (o trace dela não é guardado), e por que só à
  noite (nada mede a latência da consulta da própria página). O Codex levantou a explicação concorrente: o portal
  responder vazio à nossa própria consulta nesse horário. Ela não explica os 48 ms, mas não está descartada para a
  varredura. A v1.13 fecha as duas pelo lado da prova e grava no ledger o que distingue uma da outra.

## Conserto (só a edge, sem migration)

1. **Resposta presa ao pedido** (`consulta-rastreio.ts`, interpolado no script). O script ouve as consultas da página
   desde antes de a tela abrir. Só vale a resposta do **1º pedido feito depois do nosso clique**. A de um pedido
   anterior nunca vale, chegue quando chegar.
2. **Espera a página se aquietar antes de clicar** (até 20 s, mais 0,5 s para ela desenhar): sem consulta em voo, o
   clique gera a consulta e a leitura sai na 1ª tentativa.
3. **O pedido tem de levar o nosso filtro**, decidido pelos CAMPOS que ele mandou (`classificarFiltroDoPedido`, pura),
   nunca por achar a data em qualquer lugar do texto, e nunca por um campo vizinho:
   - `false` = a emissão INICIAL (ou a entrega inicial) do pedido é outra data. Reprova com qualquer contagem.
   - `true` = os quatro campos estão nomeados e batem: emissão inicial, entrega inicial (o `2020-01-01` que o script
     põe), `cliente` e `exibir` (nome exato — `pedido_cliente` e `exibir_inativos` não contam).
   - `null` = não deu para saber (sem corpo legível, sem campo reconhecível). Só a data decide o "não": cliente e
     exibir são valores soltos, e um campo de nome parecido derrubaria rodada boa.
4. **Tabela disputada não é leitura.** A tabela só é lida sem consulta em voo e sem outra resposta, de conteúdo
   diferente (impressão do corpo inteiro), chegada depois do clique. Contagem igual não prova que as linhas são as
   da nossa resposta.
   **Na paginação**, cada "próxima" tem de ser da mesma consulta: pedido sem outro filtro e o mesmo total da 1ª página.
5. **0 linhas só com prova positiva de tudo:** `success: true` do portal, o nosso filtro no pedido (`true`, não
   `null`) e a consulta REPETIDA respondendo 0 de novo — e a repetição tem de ser leitura tão boa quanto a 1ª.
   Repetição com linha é `zero_nao_confirmado`.
6. **`provarLeitura`** (pura): `resposta_sem_vinculo` · `zero_lidos_sem_prova` · `zero_nao_confirmado`. As 3 leituras
   da rodada (lista, cobertura, reconciliação) passam pela mesma prova.
7. **Ledger, no sucesso e na falha:** `consultas_portal` (o que a página consultava em volta do clique, com a linha do
   tempo de cada consulta fotografada na saída, e `ouvinte_erro` se um ouvinte do script lançou), `filtro_no_pedido`,
   `resposta_sucesso`, `resposta_mensagem`, `zero_repetido` e `linhas_na_resposta` (medida, sem veto: quantas das
   linhas lidas têm o nº no corpo da resposta do clique).
8. **Ouvinte de evento que lança não derruba o script — e invalida a leitura** (`CONSULTA_NAO_OBSERVADA`): se o
   script deixou de observar uma consulta da página, não dá para saber o que a tabela mostra.

A causa nova chega ao vigia `sayerlack_varredura_portal` como texto (`prova:<motivo>` ou `leitura:<tipo>`), sem
mudança nele.

## Provas

- **Teste que roda o script real** (`script-navegador_test.ts`): o template que vai ao Browserless, dentro do handler
  real, contra um portal falso no nível da API do Puppeteer, em tempo virtual.
- **Reprodução antes do conserto:** com a consulta da página em voo no clique, a rodada fecha `sucesso` +
  `prova_leitura='ok'` + 0 linhas — o registro de prod. Vale para os 4 arranjos (consulta ao abrir a tela ou ao
  trocar o cliente; clique engolido ou clique que dispara outra). **Depois:** os 4 leem as 2 linhas na 1ª tentativa.
- **Falsificação.** Laço com controle verde antes e depois (120/120), em `LC_ALL=C` e em `pt_BR.UTF-8`, estado
  commitado antes de sabotar. Cada sabotagem foi conferida como aplicada e exigida vermelha **pela marca** do teste
  esperado, não só pelo exit. São 26, uma por vez, e os números são iguais nos dois locales.

  | Sabotagem | Testes vermelhos |
  |---|---|
  | fontes da `main`, sem o conserto (só o teste do script) | 23 de 26 — 9 com o registro de prod: `sucesso` + prova `ok` + 0 linhas |
  | rastreio sem o vínculo com o clique | 15 |
  | script sem esperar a página antes do clique | 5 |
  | script sem repetir o zero | 3 |
  | prova aceitando zero sem repetição | 8 |
  | repetição confirmando só pela contagem | 3 |
  | prova aceitando total sem vínculo | 3 |
  | prova aceitando pedido que levava outro filtro | 5 |
  | prova aceitando zero sem `success: true` | 3 |
  | prova aceitando zero sem saber o filtro do pedido | 2 |
  | script lendo tabela disputada por outra resposta | 5 |
  | script lendo tabela com consulta em voo | 2 |
  | classificador: emissão inicial de outra data deixa de ser "não" | 8 |
  | classificador: "é o nosso filtro" sem conferir cliente e exibir | 2 |
  | classificador: achar a data em campo sem nome vira prova | 2 |
  | classificador: emissão final vale pela inicial | 10 |
  | classificador: campo de nome parecido vale pelo exato | 1 |
  | falha do navegador sem a evidência no ledger | 6 |
  | paginação aceitando página de outro filtro | 1 |
  | paginação aceitando página com outro total | 1 |
  | ouvinte de evento sem blindagem | 2 |
  | linha do tempo congelada no clique | 1 |
  | impressão da resposta só do total, não do corpo | 4 |
  | erro de observação sem invalidar a leitura | 1 |
  | linha do tempo sem dizer de qual clique é a consulta | 1 |
  | medida contando pedaço de outro número | 1 |
- **O que os testes não provam:** o portal real e o Puppeteer do Browserless. O portal falso segue o que o ledger
  mostra (sem texto de info, sem total da instância, tabela desenhada na ordem de chegada). A prova da orquestração
  real é a próxima rodada em prod.

## Parecer do Codex e o que foi feito com ele

Três consultas pelo `scripts/codex-async.sh`, `gpt-6-astra`, reasoning `max`. O parecer é hipótese: cada achado foi
conferido contra o código e, quando cabia, reproduzido no portal falso antes de mexer.

| Rodada | Sobre | Achados |
|---|---|---|
| 1 — 437 s · 122.978 tokens | a 1ª versão do conserto, com `RÉGUA:` no prompt (desenho e código juntos) | 4 P0 · 4 P2 |
| 2 — 456 s · 117.057 tokens | o diff endurecido | 3 P0 · 2 P2 |
| 3 — 605 s · 132.574 tokens | o diff depois da rodada 2. Gatilho: P0 da rodada 2 cujo conserto mudou a fronteira da prova | 3 P0 · 3 P2 |

**Rodada 1.**

- P0 "o 1º pedido depois do clique não identifica o filtro" → aceito. O filtro do pedido passou a ser lido; `false` reprova.
- P0 "tabela de outra consulta com a mesma contagem passa" → aceito. Tabela disputada não é leitura.
- P0 "erro na repetição confirma o zero" → aceito. A repetição é validada por inteiro; `success` cru, só `true` vale.
- P0 "leitura estendida reprovada deixa a rodada verde" → não tratado: é o desenho documentado da v1.3 (limite abaixo).
- P2 redirect no POST e teto de 150 s sem interromper operação pendurada → preexistentes, não tratados.
- P2 "a página falsa exclui as intercalações que abrem os P0" → aceito. Cenários novos e asserção com dente.
- P2 "a causa está afirmada com mais certeza do que a evidência permite" → aceito. O registro separa medido de
  inferido, e a linha do tempo de cada consulta vai ao ledger.

**Rodada 2** (o Codex reproduziu os caminhos variando a página falsa).

- P0 "a paginação aceita página de outra consulta" → aceito. Cada página confere filtro e total.
- P0 "a data achada em qualquer campo fabrica `filtro = true`" → aceito. Classificação pelos campos; achar a data
  não prova.
- P0 "rede encerrada não prova que a tabela já foi redesenhada" → **não fechado**. Limite abaixo, com a medida
  `linhas_na_resposta`.
- P2 "`%2f` minúsculo vira outro filtro" → aceito (valores decodificados).
- P2 "a linha do tempo vai ao ledger congelada antes da resposta que derruba a leitura" → aceito (fotografia na saída).

**Rodada 3** (reproduzida pelo Codex no portal falso; confirmou fechados a paginação, a data no campo errado e o `%2f`).

- P0 "campo vizinho ainda fabrica `filtro = true`" — a nossa data no FIM do intervalo de outra consulta,
  `pedido_cliente` valendo por `cliente`, `exibir_inativos` por `exibir` → aceito. O classificador reconhece a
  emissão e a entrega INICIAIS e os campos `cliente` e `exibir` pelo nome exato.
- P0 "resposta sem campo `data` ganha a mesma impressão de outra de igual total" → aceito. A impressão é do corpo
  inteiro; sem corpo legível não há impressão, e isso conta como divergente.
- P0 "ouvinte que falha antes de registrar um pedido tira a consulta do rastreio, e a leitura segue verde" → aceito.
  Erro de observação invalida a leitura inteira (`CONSULTA_NAO_OBSERVADA`).
- P2 "o nosso pedido em formato menos óbvio vira outro filtro" → aceito. O caminho do campo é preservado; lê a coluna
  do DataTables e os pares `{ name, value }`; sem a emissão inicial nomeada, só diz "não" se a nossa data não está
  em lugar nenhum do pedido.
- P2 "a linha do tempo mistura a referência de cliques diferentes" → aceito. Uma referência só (o 1º clique) e o
  clique de cada consulta.
- P2 "`linhas_na_resposta` conta outros campos como nº do pedido" → aceito. Só a coluna Pedido, número inteiro.

**Sem 4ª rodada.** Os consertos da rodada 3 são de precisão (não mudam a fronteira da prova, que é o gatilho do
ritual), e cada um tem teste próprio e sabotagem própria na falsificação.

**Calibração (minha, separada do parecer).** Os P0 sobre lista ALHEIA COM LINHAS exigem uma consulta da página que
devolva linha para a OBEN. Em 62 rodadas e nos 6 incidentes ela sempre veio vazia. Eram caminhos de código reais e
baratos de fechar, mas não são o incidente. O incidente — lista falsamente VAZIA — está coberto por camadas
independentes: vínculo com o pedido do clique, espera pela página, `success: true`, filtro no pedido e repetição.
Os pareceres crus estão na pasta de notas da sessão (fora do repo).

## Limites conhecidos (deixados de propósito)

- **Com linhas lidas, `success` e `filtro_no_pedido: null` não reprovam sozinhos.** Os valores que o portal manda
  nunca foram observados em prod; exigir o que nunca se viu derrubaria rodadas boas. O que sobra: se o portal não
  expõe o filtro no pedido (`null` em toda rodada) e a única consulta que responde ao clique for uma avulsa com
  linhas, a lista dela passa. Em 62 rodadas a consulta avulsa nunca trouxe linha para a OBEN. A consulta abaixo diz,
  na 1ª rodada, se o filtro é legível; sendo, `null` pode virar reprovação com linhas também.
- **Tabela antiga lida antes de a nossa resposta ser desenhada** (Codex, rodada 2). Exige três coisas juntas: uma
  consulta anterior que deixou linhas na tabela, a nossa resposta com a MESMA contagem, e o desenho dela atrasar mais
  de 0,5 s sem indicador de "processando". A amarração certa é pelo conteúdo — as linhas lidas estarem no corpo da
  resposta —, e depende de o portal mandar o nº do pedido no JSON, o que nunca foi observado. Por isso entrou como
  medida (`linhas_na_resposta`): se a 1ª rodada mostrar `linhas_na_resposta = lidas`, vira veto.
- **Redirect no POST da consulta** termina vermelho mesmo com a resposta final boa (o pedido final é outro). Não há
  redirect observado.
- **Leitura estendida da reconciliação que reprova a prova só relata** (`leitura_falhou` no resumo), como desde a
  v1.3. A da cobertura deixa a rodada vermelha sem `causa_pre_protocolo`. Preexistente, fora deste PR.
- **Importadora** (`sayerlack-importar-pedido-portal`): tem a mesma espera. Desde a v1.15 exige o nº do pedido no
  `postData`, com `!corpo ||` como escape; o caso de 10/11 é anterior. Sem evidência nova desde 13/11.

## Como conferir em prod

O denominador é a rodada da v1.13 com portal aberto.

```sql
SELECT to_char(iniciado_em AT TIME ZONE 'America/Sao_Paulo', 'MM-DD HH24:MI') AS sp, status,
       detalhes->>'prova_leitura' AS prova, detalhes->>'lidos' AS lidos,
       detalhes->>'filtro_no_pedido' AS filtro_no_pedido, detalhes->>'resposta_sucesso' AS sucesso,
       detalhes->'consultas_portal'->>'antes' AS consultas_da_pagina,
       detalhes->'consultas_portal'->>'em_voo_antes' AS em_voo_no_clique,
       detalhes->'consultas_portal'->>'espera_ms' AS espera_ms,
       detalhes->'consultas_portal'->>'tentativa' AS tentativa,
       detalhes->>'zero_repetido' AS zero_repetido, detalhes->>'causa_pre_protocolo' AS causa
FROM public.acoes_execucoes
WHERE acao = 'reposicao.varrer_portal_sayerlack' AND detalhes->>'versao' LIKE 'v1.13%'
ORDER BY iniciado_em;
```

- `filtro_no_pedido = true` numa rodada normal: o portal expõe o filtro no pedido, e a amarração é forte.
- `linhas_na_resposta = lidos` (acrescente `detalhes->>'linhas_na_resposta'` ao SELECT): o portal manda o nº do pedido
  na resposta, e a medida pode virar veto (fecha o limite da tabela antiga).
- `consultas_da_pagina >= 1`: a tela consulta sozinha. `em_voo_no_clique >= 1` numa rodada das 22:30 com `lidos > 0`
  é uma rodada que a v1.12 teria gravado vazia.
- 0 linhas às 22:30 com a repetição confirmando, num dia em que 17:30 leu linhas: aí é o portal respondendo 0 à nossa
  consulta. `detalhes->'consultas_portal'->'linha_do_tempo'` mostra cada consulta, o que levava e o que respondeu.
