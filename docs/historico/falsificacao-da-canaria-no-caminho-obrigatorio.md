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

## O custo, medido

Na M2 o `--falsificar` foi de 32s para **86–212s** (a mesma máquina varia ~2,5× entre execuções; a
diferença real vem das 6 entradas normais do worktree, cada uma com `initdb`, e dos controles do
juiz). O número honesto é o do runner: ⏳ *preencher com o 1º run do PR*.

## Fora desta entrega (declarado, não esquecido)

- `db/test-db-aplicar.sh --falsificar` (9 sabotagens): `falsificar=fora-do-ci`. O 2º locale TEM de
  ser pt_BR — o `db-aplicar.sh` separa falha-limpa de desconhecido casando ERRO×ERROR do psql — e o
  runner ubuntu não tem pt_BR. Em (C, C.UTF-8) seria a falsificação-em-um-ambiente do #1483.
  Remédio: provisionar o locale e provar ERRO×ERROR numa falha real.
- A classe do crash: `$var` colado em byte não-ASCII aparece em mais 3 provas
  (`test-caca-custo-producao.sh`, que está no núcleo; `test-audit-claude-ro-hardening.sh`;
  `test-vendas_sync_cursor.sh`). Lá é latente — elas forçam `LC_ALL=C` —, mas nada impede a próxima.
- As outras 3 provas de `db/` com modo `--falsificar` (`test-deploy-atestacoes.sh`,
  `test-deploy-sonda-cron.sh`, `test-pendencias-deploy-eco-passivo.sh`) estão fora do núcleo inteiro,
  que é allowlist deliberada.

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

**Ver também:** [falsificacao-fora-do-ci.md](falsificacao-fora-do-ci.md) (a mesma classe em
`scripts/`), [falsificacao-sem-linha-de-base.md](falsificacao-sem-linha-de-base.md) (o controle
verde — aqui ganhou o irmão negativo), [prova-que-imitava-o-oraculo.md](prova-que-imitava-o-oraculo.md)
(a mesma prova, #2449).
