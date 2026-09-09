# O contrato de mutação é POR ARQUIVO — e o MODO novo entrou sem ele (`sonda:sql --canaria`, 2026-09-08)

**Classe:** `scripts/mutcheck.d/<arquivo>.mut` é o contrato executável de UM arquivo. Quando um PR
acrescenta um **MODO** a esse arquivo — com suíte própria, testes próprios e decisão própria —, o
contrato segue verde medindo só o modo VELHO. O sumário continua impresso (`56 mutações · 54
pegas`) e a leitura natural dele ("este arquivo é bem coberto") passa a valer para uma fatia que
encolheu. Não há vermelho a desconfiar: o gate mede o que tem, e o que ele não tem não aparece em
lugar nenhum.

## O que era

- O **#2380** acrescentou o modo canária ao `scripts/sonda-versao-sql.ts` (`bun run sonda:sql
  --canaria`), com ~35 testes próprios em `scripts/sonda-versao-sql.test.ts`.
- O **#2392** consertou o `.mut`, que ficara stale — e o consertou inteiro **dentro do bloco da
  sonda**: 56 mutações, 54 pegas, 2 sobreviventes declaradas, 0 inválidas, 0 problemas. Verde, e
  cego para o modo novo.
- O bloco da canária decide sobre money-path pelo mesmo mecanismo da sonda, um degrau acima: o
  veredito manda **DEPLOY** (bundle sem canária no ar) ou **INVESTIGAR REGRESSÃO** (canária
  vermelha). Trocar um pelo outro custa deploy de edge de money-path à toa — ou dá por confirmado
  o que não subiu.

## O que se mediu (2026-09-08)

33 mutações desenhadas sobre o bloco da canária, contra a suíte de então: **13 SOBREVIVERAM**
(39%). Nenhuma pedia cenário exótico — todas são a invariante que o próprio código documenta:

- **5 ramos do veredito** neutralizáveis por `WHEN false` (`CANARIA DE OUTRA FATIA`, `CANARIA
  VERMELHA`, o 200 sem eco, o id ausente no mapa): a asserção procurava o **TEXTO** (`THEN
  'CANARIA VERMELHA`), e o texto continua no arquivo quando o ramo nunca dispara;
- a **negação NULL-blind** (`<>` no lugar de `IS DISTINCT FROM`) no ramo do 200 sem eco — o ramo
  que diz "o bundle ignorou a flag e RODOU O FLUXO REAL", justamente o caro;
- os dois **`LEFT JOIN` da leitura** viravam `JOIN` sem ninguém reclamar: a canária cuja trava
  ficou fechada (request_id NULL) **some** do relatório em vez de sair INDETERMINADA;
- a **janela do guard temporal** virava `30 days` (o guard do #2079 desligado);
- as **três peças do controle de credencial** — o `NOT EXISTS` da própria leva, o
  `recusas_recentes = 0` e o `CROSS JOIN` que leva `cred` até a projeção;
- o **pré-filtro do registro** trocado de `canary:true` para `contrato`: é a cegueira que o #2374
  fechou no gate, reaberta aqui — a 8ª canária serve o marcador em `versao` e **não tem a palavra
  `contrato`** em lugar nenhum do `index.ts`, então escaparia da varredura de forasteiras;
- e a **partição da trava** (`const baratas = leva`), que põe `carteira-rebuild` e
  `generate-tactical-plan` também no bloco **SEM** trava: o passo 1, colado pelo founder,
  dispararia o rebuild REAL da carteira.

Os 6 testes que as matam nasceram desse run. O `.mut` foi de 56 para **90** mutações (88 pegas,
as 2 sobreviventes declaradas de sempre, 0 inválidas, 0 problemas) e o contrato passou a custar
158s locais no lugar de ~100s.

**O custo no CI, MEDIDO e não projetado** (run do #2399, 2026-09-08): o job `mutation-check`
fechou em **10m03s** contra o teto de **15min** — 67% dele. A medição anterior, de 2026-09-07
sobre 28 runs, dava 346-533s; as 34 mutações novas custaram ~70s de job. Sobra **~1/3 do teto**,
e ele é o mesmo para os 24 contratos somados: quem for engordar o próximo `.mut` parte deste
número, não da folga de antes. Estourar o `timeout-minutes` aqui não seria reprovação de
cobertura — seria ausência de dado vestida de vermelho
([timeout-de-job-e-ausencia-de-dado.md](timeout-de-job-e-ausencia-de-dado.md)).

## A régua

**PR que acrescenta MODO a um arquivo com `.mut` acrescenta mutação junto.** A suíte do modo novo
não herda o dente da suíte do modo velho, e o sumário do contrato não distingue as duas. O sinal
de que falta contrato não é o vermelho — é o `.mut` falar só o **vocabulário** do modo antigo:
aqui, as 56 linhas ancoravam em `l`/`e`/`i`/`x`/`c` (os aliases SQL da sonda) e nenhuma em
`ca`/`esp`/`mp`/`resp`/`cred` (os da canária).

⚠️ **Mecânica, quando os dois modos moram no mesmo arquivo e falam parecido:** o guard de
substituição única do `mutcheck.sh` vira o gargalo — um padrão que sirva aos dois muta 2 linhas e
sai **INVÁLIDO**, que é ausência de medição, não medição. Ancore pelos aliases. E há linhas
**GÊMEAS** que não são endereçáveis uma a uma (as duas do 401 são idênticas entre si; o
`timeout_milliseconds` da sonda e o da canária também): declarar o limite é honesto, dá-las por
medidas não é.

⚠️ **Aspas na substituição:** mutar uma string SQL delimitada por `'` para outra que também
carregue `'` quebra o TS, e o mutante morre no compilador — o `mutcheck.sh` classifica como
INVÁLIDO de propósito (seria falso-PEGA). No `.mut`, `\\'` chega ao perl intacto e emite `\'`,
escape válido dentro da string. Foi assim que a mutação "o campo do marcador vira `'contrato'`
fixo" saiu de INVÁLIDA para PEGA.
