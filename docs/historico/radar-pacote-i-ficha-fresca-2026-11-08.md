# Radar pacote I: ficha fresca depois do cadastro, falhas parciais ditas, ficha entregue pelo card (2026-11-08)

Esta entrega fecha três achados da 2ª revisão do Radar. Ela é só front: sem migration e sem edge. O que falta para ir ao ar é o **Publish** (founder).

## 1. A ficha mostrava o estado velho depois do cadastro no Omie

- **Sintoma.** O vendedor cadastrava o lead como cliente e a ficha seguia dizendo "a contatar", sem "já é cliente", até ele recarregar a página.
- **Causa.** O cadastro tira o lead da fila: com `incluirJaClientes` desligado, a fila relida já não o traz. A ficha então caía num snapshot guardado num `useRef`, e o lead aberto pelo link vivia num `useState`. A invalidação do react-query (`invalidarRadar`, que relê tudo sob `['radar']`) não alcança nenhum dos dois.
- **Correção.**
  - O lead fora da fila agora vem de uma query sob `['radar','empresa',cnpj]` (`src/queries/useRadarEmpresa.ts`). A mesma invalidação a relê.
  - A escolha de qual versão mostrar é uma regra pura (`src/lib/radar/ficha-aberta.ts`). A linha da fila vem primeiro. Depois vem a leitura do servidor, quando ela já assentou. Por último o snapshot, que só serve de ponte enquanto a leitura volta.
  - O `abrirPorCnpj` (conflitos de cadastro) lê pela mesma query.
  - Uma releitura que falha com a ficha na tela não fecha a ficha: ela avisa "Não consegui atualizar a ficha".
- **Linha da lista.** A fila já era relida pela invalidação. O teste cobre o caso em que o lead continua na fila (já-clientes incluídos): a linha e a ficha mostram o estado novo.

## 2. Falha parcial mostrada como dado completo

- **Ranking "Onde caçar"** (`RadarRankingCidades`). A contagem e a penetração são leituras independentes. Quando a penetração falhava e a contagem não, a coluna "cli." e o bloco "Mercado grande, pouca penetração" sumiam sem aviso. O card parecia completo, só que sem clientes.
  - Agora há um aviso para cada estado: falhou (diz que não é falta de cliente), sem lote completo (o hook devolve `null`) e desatualizada (a releitura falhou sobre um dado anterior). Enquanto carrega, a linha mostra "… cli.".
  - `empresas_lote ?? 0` virou "—" (ausente ≠ zero).
- **Linha da fila** (`RadarLinha`). Na mesma linha, o vínculo que falhava já dizia "vínculo?", mas os irmãos que falhavam sumiam como se o lead não fosse filial de cliente. Agora `irmaosEstado` chega à linha, e `selosFilial(i, 'falhou')` sem dado vira o selo "filial?". Com dado em mãos (releitura que falhou), o dado vale.
- **Fila com páginas na tela** (Codex, achado 13; o `~484` do brief era a numeração da main da época). O erro só aparecia sem nenhuma página carregada, e o rodapé tratava só a falha da página seguinte. Um refetch comum que falhasse (a invalidação depois de um contato ou cadastro) deixava as linhas velhas sem aviso. Agora `q.isError && !q.isFetchNextPageError` com páginas carregadas mostra "Não consegui atualizar a fila: as linhas abaixo são da leitura anterior", com "Tentar de novo".

## 3. Ficha entregue pelo card (sobra do pacote F)

- `linkFichaRadar(cnpj, 'card')` gera `/radar?cnpj=…&origem=card`. O link do e-mail continua sem `origem`, porque o `RadarAbrirEmail` grava a própria ficha antes do redirect.
- O `/radar` lê `origem` pelo mesmo `useUrlState` do `cnpj`, que é navegação: fica fora da chave da fila e dos favoritos. Quando a ficha daquele CNPJ abre, ele chama `registrarFichaEntregue({ origem: 'card', cnpj })` **uma vez** e tira o `origem` da URL, para que recarregar a página não grave de novo. Trocar de ficha também apaga o `origem`.
- Sob a lente "Ver como" a ficha abre, mas nada é gravado. Lead que não existe fecha a ficha sem gravar.
- **Não** declare `instalado_em` do `ficha_card`: a cobertura começa no 1º registro (ver `radar-funil-lead-empurrado.md`).

## Provas

- Vitest:
  - `RadarClientes.test.tsx`: 12 casos novos (ficha fresca, ficha do card e fila desatualizada).
  - `RadarRankingCidades.estados.test.tsx`: 5 casos.
  - `RadarLinha.selos.test.tsx`: 2 casos.
  - `ficha-aberta.test.ts`: 6 casos.
  - `ui-helpers.test.ts` e `prospectar-hoje.test.ts`: asserts novos.
- Falsificação com controle verde na mesma invocação: 8 sabotagens, uma camada por vez, todas vermelhas.
  - snapshot vence o servidor;
  - chave fora de `['radar']`;
  - lente grava;
  - origem não sai da URL;
  - sem registro;
  - sem aviso de releitura;
  - aviso da penetração nulo;
  - "filial?" some.
- Na 1ª rodada, "origem não sai da URL" ficou verde: nenhum teste olhava a URL. Acrescentei a asserção sobre `location.search`.

## Deploy

Só o Publish (founder). Depois dele, quando medir: o painel `/radar/funil` mostra "Fichas (card)". A 1ª linha de `ficha_card` no ledger é o sinal de que o escritor está no ar.
