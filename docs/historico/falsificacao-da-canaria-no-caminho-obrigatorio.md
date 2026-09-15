# A falsificação da canária no caminho obrigatório — e as sabotagens que só pareciam capturar

**2026-09-10.** `db/test-canaria-veredito.sh` prova, EXECUTANDO num PG17, a ordem dos ramos do CASE
que separa **BUNDLE VELHO SERVINDO** (⇒ redeployar) de **CANÁRIA VERMELHA** (⇒ investigar
regressão). O modo normal dela roda no núcleo do CI desde 2026-09-08. O `--falsificar` — as
sabotagens que provam que a suíte SABE ficar vermelha — não rodava em lugar nenhum: o núcleo só
conhecia o modo normal, e o `test:falsificacao` só itera `scripts/test-*.sh`. O pedido era decidir
como levá-lo ao CI, com o custo medido.

## A decisão de produto dissolveu na medição

A premissa era "caro: cada rodada sobe e derruba um PG17". Medido, **não sobe**: o PG sobe uma vez
por invocação e as ~38 execuções da suíte reusam o mesmo servidor. Na M2 (swap em 5,1 GB):
`--falsificar` = **32,4s**, contra 3,5s do modo normal.

O número que decide é o do runner (`gh run view --json jobs`, 12 runs verdes): `provas-sql` tem
mediana **53s** e o caminho crítico do CI é o `gates-e-falsificacao`, mediana **433s**. Ou seja, o
job onde o PG17 já está instalado termina ~6 min antes do CI terminar. As três opções avaliadas:

| opção | custo no wall-clock | cobertura | bloqueia o merge |
|---|---|---|---|
| 1. no `provas-sql`, inteira | **zero** (fora do caminho crítico) | 100% | sim |
| 2. job separado / cron | zero | 100% | **não** — vermelho pós-merge (#1947→#1948) |
| 3. subconjunto obrigatório | zero | parcial | parcial |

Com custo zero, 2 e 3 não compram nada. `scripts/mutcheck.d/` também não serve: muta FONTE TS e roda
vitest num job não-required e sem PG17; a canária sabota o SQL GERADO e o gerador, e roda PG17.
Eixos diferentes.

## Mas ligar como estava formalizaria dentes falsos

O parecer Codex (gpt-6-astra/max) aceitou a opção 1 e bloqueou o desenho: *"hoje o harness aceita
vermelhos que não provam a propriedade anunciada; acrescentar recibo apenas tornaria essa afirmação
mais formal."* O laço de sabotagem exigia só "a suíte ficou vermelha". Medido, sabotagem por
sabotagem, com a saída da suíte visível (antes ia para `/dev/null`):

| achado | medida | origem |
|---|---|---|
| (e) NULL-blind troca `ca.corpo` por **`l.corpo`** — alias que não existe | 2 ok / 22 fail, **22 "nenhuma linha"**: SQL que não compila | f7796b3ff (2026-09-08) renomeou o alias `l`→`ca`; o padrão foi atualizado, a substituição não |
| (f) janela apaga **4 linhas** (`,+3d`) de um guard de **2** | 2 ok / 22 fail, 22 "nenhuma linha": `THEN` órfão | o ramo seguinte ganhou um `AND` em 2 linhas; a contagem envelheceu |
| no 2º locale, **toda** sabotagem "ficava vermelha" por CRASH | `'$marca…'`: em UTF-8 no macOS o bash lê o 1º byte do `…` como parte do nome → `unbound variable` | a suíte, não as sabotagens |
| (h) a injeção do SQL do worktree contornava a linha que gera o SQL do modo normal | uma regressão como a do #2405 seguiria vermelha aqui e verde no CI | parecer Codex |
| (h4) prometia "2xx ANONIMO vira testemunha" | quem quebra é o 2xx de OUTRA fatia; o anônimo segue barrado por `canary:true` | as duas camadas cobrem o anônimo em redundância — nenhuma sabotagem provava o dente dele |
| gerador sabotado que nem emite SQL contava `ok`; restauração por `git checkout --` sem conferência | leitura de código | parecer Codex |

Os dois primeiros e o terceiro não foram achados do parecer sozinho — o parecer achou a (e); o
levantamento completo achou a (f); a primeira execução do juiz novo achou o crash. Nenhum veredito de
produção saiu errado: a suíte continuava discriminando (a (e) corrigida dá 17 ok / 7 fail pelo
motivo certo). O que estava quebrado era a **prova de que ela discrimina**.

## O que entrou

**Na canária** — cada sabotagem declara a **marca** do vermelho certo, lida da saída real: um trecho
ASCII da asserção que ela existe para derrubar e o veredito errado que veio (`veio '…`). O juiz exige
a marca nos 2 locales. SQL que não executa vira `[SQL-INVALIDO]` (o `veredito` usa `ON_ERROR_STOP` e
não engole o stderr), crash de shell vira "a suíte MORREU", e os dois reprovam a sabotagem como
**vazia**. Um **controle negativo do juiz** roda antes do primeiro `sed` que conta: a (e) antiga e a
(a2) julgada pela marca da (a1) TÊM de ser recusadas — sem isso, um juiz que sempre dissesse sim
aprovaria tudo. As sabotagens de gerador passam também pela **entrada normal** do worktree (o
comando que o CI roda). Ids e expressões únicos, restauração por cópia conferida por conteúdo, e a
(h5) nova: testemunha por STATUS no lugar da identidade — a regressão que o #2445 fechou. **18
sabotagens, 18 vermelhas pelo motivo certo.**

**No runner** — 3º campo do `db/nucleo-ci.txt`: `falsificar=<n>` roda o modo e exige **exatamente
um** recibo `SABOTAGENS: <v> vermelhas / <f> falhas` com f = 0 e v ≥ n; `falsificar=fora-do-ci` é
exceção declarada, com o motivo na mesma linha, impressa em toda execução. O recibo é exclusivo do
modo, porque um `--falsificar` ignorado roda o modo normal e sai 0. A identidade do recibo final é o
par (arquivo, modo). Toda prova do núcleo que menciona `--falsificar` TEM de declarar o 3º campo — o
detector é texto cru e é **alarme**, não prova (flag montada por concatenação escapa de qualquer
leitura textual); a declaração no manifesto é o cadastro.

**No CI** — o `db/falsifica-nucleo-ci.sh` (o dente do runner, que também só rodava à mão) virou step
do `provas-sql`, com os casos do caminho novo, **controle positivo pelo runner** (falsificação
honesta → verde com `falsificacoes=1/1`) e piso de casos. A regex `GUARDA` do
`falsificacao-cobertura.test.ts` passou a aceitar a guarda invertida (`!=`), a forma da canária.

E o dente foi ele mesmo sabotado, uma camada por vez, numa cópia isolada do runner: aceitar dois
recibos, cegar o detector, aceitar falhas > 0, ignorar o mínimo, perder a identidade do recibo, não
passar a flag, aceitar declaração sem modo, aceitar exceção sem motivo — **8 sabotagens, 8 vezes o
harness vermelho no caso que vigia aquela camada**, com o controle verde na mesma invocação e, caso a
caso, idêntico ao do CI (33 linhas). Mas 8/8 cobre as 8 mutações, não o runner inteiro: a 2ª rodada
do Codex achou uma 9ª camada que nenhuma delas tocava (abaixo).

## A 2ª rodada do Codex — o silêncio contava como captura

**2026-09-14** (gpt-6-astra/max, 574s, no código; a rodada tinha esbarrado na cota em 2026-09-10). O
parecer segurou o DRAFT com 2 P0, 1 P1 e 1 P2, e os quatro se confirmaram na leitura:

| achado | mecanismo | correção |
|---|---|---|
| sabotagem creditada sem ter rodado | `injeta`, `julga_log` e `entrada_normal` ecoavam **vazio** para "capturada"; sob `set -u` sem `-e`, a função que morre dentro de `$(...)` ecoa vazio e o laço segue. No gerador, `$(injeta)$(entrada_normal)` concatenados escondiam a morte da 2ª | palavras positivas (`CAPTURADA`, `CERTO`), as duas capturas do gerador conferidas em separado e 2 controles negativos de morte silenciosa — sem PG, custo ~0 |
| harness truncado sai 0 | o piso `OK_MINIMO` morava no rodapé do arquivo que ele vigia: cortado na linha 73, o harness roda 3 controles e sai 0 | o step do `provas-sql` confere **um** recibo `FALSIFICACAO: OK≥34 XX=0`, com o piso no `ci.yml` — o chamador, como o runner faz com as provas |
| (g2) creditada sem a contagem | `DISPAROU  vez(es)`, com a contagem ausente, casava a marca | exit e inteiro conferidos; falha de medição vira `[SQL-INVALIDO]`, que o juiz recusa |
| guarda `n_linhas != 1` do runner sem caso | "dois recibos" e "malformado" reprovam também pela contagem de válidos | caso "um válido + um malformado"; piso 34 |

Calibração: nenhum dos quatro produziu veredito errado observado — o da morte silenciosa pede uma
função que morra no meio, e o do truncamento, uma edição que corte o arquivo. Na minha régua seriam
P1; a correção é a mesma, e barata. O parecer também achou envelhecido o comentário que justifica o
`fetch-depth: 0` do job (o guard de `origin/main` não roda no caminho da fixture): corrigido o
comentário, não o checkout.

**Prova por execução** (M2, `539e9c188`): a canária corrigida segue 18/0, com os 2 controles de morte
silenciosa verdes. Numa cópia não commitada, a injeção da (a1) e a entrada normal da (h1) passaram a
MORRER e a contagem da (g2) a falhar — as três viraram FALHA pelo motivo de cada uma
(`SABOTAGENS: 15 vermelhas / 3 falhas`). O harness corrigido dá `OK=34 XX=0`, e o runner sem a guarda
`n_linhas` o deixa vermelho só no caso novo. O step do CI, extraído do `ci.yml`, fica verde com o
recibo no piso e vermelho nos 5 desvios (abaixo do piso, dois recibos, exit 1, `XX≠0`, sem recibo) e
no harness real truncado na linha 73. A primeira meta-sabotagem da (g2) era ela mesma inválida
(`case padrão)` dentro de `$(...)`, que o bash 3.2 do macOS não parseia) — quem pegou foi o controle
verde da própria canária, que abortou antes do primeiro `sed`.

## A 3ª rodada do Codex — a marca que também saía no verde

**2026-09-14** (gpt-6-astra/max, 518s, 139.803 tokens, sobre a main `d046839e5`). O conserto da 2ª
rodada ficou de pé: os quatro achados estão **fechados**. O P1 novo estava no harness que o #2472
levou ao CI: o juiz do `aplica_e_exige` procurava a marca no log **inteiro**, e a marca do bug real 3
era o **título** da asserção — `customer NÃO lê v_sku_sigma_demanda`, que o `eq` imprime no ✅ e no ❌.

Reproduzido por execução, numa cópia do HEAD com os logs preservados: com a asserção da l.180
comparando o resultado consigo mesmo, o customer volta a ler (`✅ … (=1)`), o único vermelho vem da
asserção de metadados (`esperado [5], veio [4]`) — e o harness creditou a captura (`OK=9 XX=0` no
trecho dos bugs reais). A medição achou a classe, não só o caso do parecer:

| bug real | marca | no controle verde | no sabotado |
|---|---|---|---|
| 1 | `[CLAIM-GUARD-FORA-DO-UPDATE]` | 0 | 1 |
| 2 | `[GUARD-CEGO]` | **2** (asserções F5/F7 da própria prova) | 1 |
| 3 | `customer NÃO lê v_sku_sigma_demanda` | **1** | 1 |

A correção tem duas camadas. As marcas dos casos 2 e 3 passaram a ser as da FALHA, lidas da saída
real (`POST FALHOU [GUARD-CEGO]` e `… — esperado [0], veio [1]`: 0 no verde, 1 no sabotado). E o juiz
confere isso sozinho: o `julga_captura` recusa a marca que aparece no **controle verde da mesma
prova, na mesma invocação**, com um controle negativo sem Postgres (a marca só numa linha verde, o
vermelho vindo de outra asserção). O filtro óbvio — "a marca tem de estar numa linha de falha" —
nasceria furado: as provas 1 e 2 imprimem numa linha VERDE `mensagem do servidor: ERROR:  division by zero`.

**Prova por execução** (`73afe0e65`, uma invocação sobre o commit fixado, controle primeiro; o
julgamento das saídas nos dois locales, C e pt_BR.UTF-8 — 11/11 em cada):

- **controle:** o step do `ci.yml` extraído do commit roda o harness inteiro — `FALSIFICACAO: OK=35
  XX=0`, `HARNESS_NUCLEO_OK casos=35 (piso 35)`, exit 0;
- **sem a camada 2** (o juiz deixa de conferir o controle verde): o controle negativo vira `XX`, com o
  juiz dizendo `CERTO`; o mesmo corte sem a sabotagem fica `OK=1 XX=0`;
- **sem a camada 1** (as marcas antigas nos casos 2 e 3): os dois viram `XX` por "aparece no CONTROLE
  VERDE", e o caso 1 segue `OK` — a camada 2 não recusa tudo;
- **o cenário do parecer**, sobre o harness corrigido: o caso 3 vira `XX` "SEM a marca", com o controle
  inicial ainda verde.

No CI do mesmo commit, o `provas-sql` fechou com `HARNESS_NUCLEO_OK casos=35 (piso 35)`.

## A 4ª rodada do Codex — o juiz provado ramo a ramo

**2026-09-14** (gpt-6-astra/max, tentativa 1, 162.209 tokens, sobre `73afe0e65`; os 10.084s de
relógio incluem ~2h38 de máquina dormindo). Veredito: **merge como está**, sem P0/P1/P2 — e dois
limites registrados, os dois confirmados na leitura:

1. **Controle verde vazio.** Contra um controle de 0 bytes, o `grep` do `julga_captura` sai 1 — "a
   marca não sai no verde" — sem ter medido nada; com controle vazio, até a marca vazia passava. O
   parecer não achou caminho atual até esse insumo (o controle inicial exige exit 0, e as provas
   imprimem) e não o classificou como P2.
2. **O controle negativo cobria um ramo só.** Trocar a checagem final do sabotado por `printf CERTO`
   passava por ele (a camada 2 recusa antes) e pelos 3 bugs reais: as marcas deles já são exclusivas
   e o vermelho sempre vem, então eles não distinguem juiz bom de quebrado.

Os dois fecharam no mesmo PR — custo ~0, e o harness vive no caminho obrigatório. O `julga_captura`
recusa controle vazio ou ausente, e o controle do juiz virou 5 casos sintéticos sem Postgres: um por
ramo, mais o positivo, que pega o juiz que recusa tudo. Onde a recusa não é pela marca ausente, a
marca **está** no sabotado, para que só o ramo testado a barre. A marca vazia não ganhou ramo: num
controle não-vazio ela casa qualquer linha (camada 2) e, num vazio, cai na recusa nova — um ramo
dedicado ficaria verde sob sabotagem. Piso 35 → 39.

**Prova por execução** (`8039e457c`, uma invocação, sem Postgres; julgamento nos dois locales, 12/12
em cada). O corte só-juiz sem mutação fecha `OK=5 XX=0`, e cada mutante de UMA camada derruba
exatamente o caso do seu ramo:

| mutante | recibo | o `XX` |
|---|---|---|
| sem a conferência do controle verde | `OK=4 XX=1` | a marca que também sai no verde — veio `CERTO` |
| checagem final → `printf CERTO` (o do parecer) | `OK=4 XX=1` | o vermelho SEM a marca — veio `CERTO` |
| sem a recusa do exit 0 | `OK=4 XX=1` | exit 0 com a marca no log — veio `CERTO` |
| sem a recusa do controle vazio (= o juiz de `73afe0e65`) | `OK=4 XX=1` | o controle verde VAZIO — veio `CERTO` |
| juiz que recusa tudo | `OK=4 XX=1` | o positivo — veio "SEM a marca" |

O mutante do parecer, aplicado ao `73afe0e65`, **sobrevivia**: `OK=1 XX=0`.

A ponta a ponta com Postgres ficou com o CI do mesmo commit, no runner ubuntu: os 5 casos do juiz
`OK`, `FALSIFICACAO: OK=39 XX=0`, `HARNESS_NUCLEO_OK casos=39 (piso 39)`. Na M2 ela não rodou — a
única vaga do `heavy` estava presa havia 40 min, com a máquina em swap —, e o delta não toca o trecho
com Postgres.

## O custo, medido

O número honesto é o do runner (1º run do #2472): o `provas-sql` foi de mediana 53s para **132s** — o
step do núcleo de ~29s para **69s** (os +40s são a falsificação da canária) e o harness do executor,
step novo, **39s**. O caminho crítico segue sendo o `gates-e-falsificacao` (~433s): o `provas-sql`
continua terminando ~5 min antes, e o custo no wall-clock do PR é **zero**, como a medição previa.

Na M2 a mesma falsificação levou **86s a 445s** (era 32s antes das 6 entradas normais do worktree,
cada uma com `initdb`, e dos controles do juiz) — no run de 445s a canária NORMAL levou 22s, contra
1–2s no runner. Outra vez: a máquina local compara A com B; quem dimensiona o CI é o CI.

## Fora desta entrega (declarado, não esquecido)

- ~~`db/test-db-aplicar.sh --falsificar` (9 sabotagens): `falsificar=fora-do-ci`~~ — **entregue em
  2026-09-14** (#2488): 11 sabotagens, cada uma em 3 combinações servidor×cliente, no `provas-sql`,
  com o pt_BR provisionado e conferido pelo job. O remédio previsto aqui ("provisionar o locale e
  provar ERRO×ERROR numa falha real") sozinho não bastaria: a palavra ERRO×ERROR vem do `lc_messages`
  do SERVIDOR, e a rodada pt_BR antiga só trocava o cliente — as duas saíam idênticas, e tirar `ERRO`
  da regex do executor passava verde nas duas. Ver
  [falsificacao-db-aplicar-idioma-do-servidor.md](falsificacao-db-aplicar-idioma-do-servidor.md).
- A classe do crash: `$var` colado em byte não-ASCII aparece em mais 3 provas
  (`test-caca-custo-producao.sh`, que está no núcleo; `test-audit-claude-ro-hardening.sh`;
  `test-vendas_sync_cursor.sh`). Lá é latente — elas forçam `LC_ALL=C` —, mas nada impede a próxima.
- As outras 3 provas de `db/` com modo `--falsificar` (`test-deploy-atestacoes.sh`,
  `test-deploy-sonda-cron.sh`, `test-pendencias-deploy-eco-passivo.sh`) estão fora do núcleo inteiro,
  que é allowlist deliberada.
- O `fetch-depth: 0` do `provas-sql` ficou sem motivo medido: o guard de `origin/main` que o
  justificava não roda no caminho da fixture. Tirar é outra entrega, medindo o job sem o histórico.
- O ramo do `julga_captura` para controle que existe, não está vazio e não se lê (o `grep` sai 2)
  segue sem caso sintético: fabricá-lo depende de permissão e de usuário — root lê tudo —, e o caso
  seria vermelho por ambiente. Hoje nada chega lá: o controle nasce do próprio harness.

## As regras

1. **Falsificação que aceita qualquer vermelho conta crashes, não capturas.** Sem a marca, SQL que
   não compila e `unbound variable` passam por "a suíte notou". A marca é LIDA da saída real — a da
   (h4) foi deduzida, e a primeira execução mostrou que ela prometia o caso errado.
2. **Falsificação que não roda apodrece em 2 dias.** De 2026-09-08 a 2026-09-10, 2 de 17 sabotagens
   viraram vazias e o 2º locale inteiro era crash, sem nada ficar vermelho — o laço dizia `ok` para
   todas. "Só roda à mão" não é custo baixo: é o prazo de validade da prova.
3. **Sabotagem que conta linhas envelhece com o layout.** Neutralize a CONDIÇÃO (`WHEN false`) em vez
   de apagar N linhas: o `,+3d` quebrou quando o ramo vizinho mudou de forma.
4. **Antes de declarar "caro demais para o CI", meça onde está o caminho crítico.** O custo que
   importa é o do job mais lento, e o `provas-sql` tinha 6 min de folga.
5. **Silêncio não é veredito.** Protocolo em que a saída VAZIA quer dizer sucesso transforma morte em
   aprovação: a função que morre dentro de `$(...)` também ecoa vazio. O veredito é uma palavra
   positiva, conferida por quem decide — e a trava que mora no arquivo que ela vigia some junto com
   ele (o piso do harness, que um truncamento levava embora).
6. **Marca que também sai no verde não é marca.** O título de uma asserção aparece no ✅ e no ❌;
   procurado no log inteiro, casa qualquer vermelho. "Exclusiva da falha" é MEDIDA contra o controle
   verde da mesma invocação — nunca a intenção de quem escolheu a string.
7. **Juiz de falsificação se prova ramo a ramo.** Casos reais com marca exclusiva não separam juiz bom
   de quebrado — o vermelho sempre vem, a marca sempre está lá —, e um controle negativo só cobre o
   ramo que exercita: trocar a checagem final por `printf CERTO` passou pelos dois. Um caso sintético
   por ramo, que só ELE barra, mais o positivo. E controle verde vazio é ausência de dado, nunca "a
   marca não sai no verde".

**Ver também:** [falsificacao-fora-do-ci.md](falsificacao-fora-do-ci.md) (a mesma classe em
`scripts/`), [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (o controle
verde — aqui ganhou o irmão negativo), [prova-que-imitava-o-oraculo.md](prova-que-imitava-o-oraculo.md)
(a mesma prova, #2449), [falsificacao-db-aplicar-idioma-do-servidor.md](falsificacao-db-aplicar-idioma-do-servidor.md)
(a prova irmã do db-aplicar: o 2º locale que era o 1º, e a regra 6 virando gêmeo verde, #2488).
