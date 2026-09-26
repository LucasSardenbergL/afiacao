# Retry de rede no CI — e o denominador que decide se ele vale

**2026-09-25** · `.github/workflows/ci.yml`, job `provas-sql`, step "PostgreSQL 17 (PGDG)" ·
lab em `scripts/lab-retry-pgdg/`

## O pedido e a pergunta que vinha antes dele

O step instala o PostgreSQL 17 do PGDG e tem três chamadas de rede sem nenhuma tentativa extra
(`curl` da chave, `apt-get update`, `apt-get install`). Sob `set -euo pipefail`, qualquer soluço
aborta o job — e `provas-sql` é check **obrigatório** (o `validate` exige `success` POSITIVO de
cada job), então o PR trava até alguém re-rodar à mão. Dois incidentes conhecidos:

- **2026-09-21**, run `35549862278`: `curl: (56) Failure when receiving data from the peer`,
  step morto em 53s, num PR cujo diff era um arquivo de teste, um `.def` e um doc — nada de SQL.
  `gh run rerun --failed` passou de primeira, sem mudar uma linha.
- **2026-09-09**, run `34383259513` + dois reruns: `Hash Sum mismatch` no repositório do Chrome
  derrubou o job três vezes seguidas. A mitigação daquela vez — remover as fontes de terceiro que
  o job não usa — está no comentário do step e continua valendo.

"Falhou duas vezes" não é taxa. **A entrega começou pelo denominador**, e o denominador quase
mudou a resposta.

## A medição

Fonte: API do Actions, `workflows/ci.yml/runs` + `runs/<id>/jobs`. Duas decisões que mudam o
número:

1. **`filter=all`**. Sem ele, a API devolve só o ÚLTIMO attempt — e a falha de 09-21 foi
   re-rodada com sucesso, então o run inteiro aparece como `success`. Medir sem `filter=all` é
   medir um mundo em que transitório não existe, porque o rerun apagou exatamente o que se quer
   contar.
2. **Cortar na mitigação, não na janela redonda.** Os 400 runs pedidos atravessam o commit
   `8eb465837` (2026-09-09 18:07), que removeu as fontes de terceiro. Misturar os dois lados
   produz uma taxa que não descreve desenho nenhum.

| janela | execuções de `provas-sql` | falhas no step do PGDG | taxa |
|---|---|---|---|
| PRÉ-mitigação (até 2026-09-09 18:07) | 176 | 5 | 2,84% (IC95 [1,22; 6,48]) |
| **PÓS-mitigação (desenho atual)** | **234** | **1** | **0,43% (IC95 [0,08; 2,38])** |

As seis falhas do step, nas 410 execuções, são **todas de rede e nenhuma do PostgreSQL**.

E um terceiro cuidado, porque ele é o que torna a taxa comparável: **a rede é mesmo exercida**. O step é embrulhado num `if [ ! -x .../initdb ]`, e se o runner já trouxesse o
PG17 o bloco seria pulado — o denominador real seria uma fração disso e a taxa, várias vezes
maior. Duração mínima do step em 205 execuções: **10s** (mediana 13s), sem nenhum bucket de ~1s;
e o log de um run traz `Setting up postgresql-17` e `(PostgreSQL) 17.11`. O `if` nunca achou
PG17 pronto.

## A decisão: vale — pela assimetria, não pela frequência

0,43% a ~14 execuções/dia é **~1 trava a cada 16 dias**. Pouco. O que decide não é a frequência,
é o custo dos dois lados:

- **Não ter retry** custa, a cada ~16 dias, um PR parado num repo que mergeia sozinho. A trava
  não é barulhenta: ninguém é avisado, o PR só não anda.
- **Ter retry** custa ~12 linhas num step e alguns segundos quando dispara. Quando não dispara,
  custa zero — a primeira tentativa é a de hoje.

Uma re-tentativa custa segundos; o rerun custa o job inteiro mais a atenção de quem percebe. Com
uma evidência pós-mitigação só (IC95 até 2,38%), a conclusão honesta é "vale, e por pouco" — não
"a rede do PGDG é ruim".

**O que reabriria a decisão:** se o retry passar a disparar com frequência visível no log, o
problema deixou de ser soluço e virou fonte ruim — aí o conserto é a fonte (mirror, cache de
pacote), não mais tentativas.

## O desenho: fail-CLOSED, e por que não `|| true`

O comentário do step já registrava a restrição: o autor anterior **não** suprimiu erro de
propósito, porque isso mascararia falha real do PGDG ou do repo base. Um retry ingênuo reintroduz
exatamente esse defeito por dentro:

```bash
for i in 1 2 3; do cmd && break; sleep 5; done   # <- as três falham, o laço TERMINA, o script SEGUE com 0
```

É o `ausente ≠ zero` no tempo ([espera-sem-desistencia.md](espera-sem-desistencia.md)): o caminho
não-reconhecido cai no lado otimista. O helper `tentar` inverte isso:

- devolve o exit da **última** tentativa (56 do curl, 100 do apt) — não um `1` genérico;
- é chamado **nu**, então sob `set -e` o retorno não-zero mata o step;
- o `set -e` fica suspenso num ponto só, o `"$@" || rc=$?`, onde a falha é dado e não veredito;
- o erro da ferramenta continua no log (o `-sS` do curl e o stderr do apt não são silenciados).

O teto e a espera são **literais**, sem `${VAR:-3}`: botão de ambiente em gate é o caminho para
um `env:` de workflow mudar a verdade do step sem aparecer no diff dele.

## A falsificação

`scripts/lab-retry-pgdg/` roda no `test:hooks` (lab) e no `test:falsificacao` (sabotagens). O lab
extrai o **texto real do step** do `ci.yml` a cada invocação — cópia da lógica envelheceria calada
— e só desvia, mecanicamente e com conferência positiva, os três prefixos absolutos para uma raiz
em `$TMPDIR`. Rede: zero; `curl`/`apt-get`/`lsb_release`/`sudo`/`sleep` são dublês no PATH.

Nove cenários, 29 asserções, separando as duas metades que falham por motivos opostos: **retenta**
(transitório → verde, com a re-tentativa no log) e **desiste** (permanente → vermelho, com o exit
real e o rótulo da camada). Cada camada é sabotada sozinha, e a permanente de cada uma exige que
a seguinte **não** tenha sido chamada — a prova de que o fail-closed para a linha, em vez de
seguir com um Postgres não conferido.

Cinco sabotagens, cada uma removendo uma propriedade, em dois locales, com **controle verde antes
do primeiro `sed` na mesma invocação**: `return $rc`→`return 0`, teto 3→1, `|| true` na chamada,
uma camada sem `tentar`, e `"$@" || rc=$?`→`"$@"; rc=$?`. Cada uma exige vermelho **nos casos
certos** e exige que o C0 (controle interno do lab) siga verde — sabotagem que derruba o C0
quebrou o lab, não a guarda.

## Três armadilhas que apareceram fazendo isto

1. **`xargs` recusou o comando e a coleta devolveu zero.** A segunda janela voltou com 0 linhas e
   um marcador de fim dizendo `linhas=0`. Não era "não há `provas-sql` nesses runs": era
   `xargs: command line cannot be assembled, too long` — a interpolação `-I{}` num `bash -c`
   comprido estourou o limite. O marcador de fim provou que o laço **terminou**; só o `stderr`
   provou que ele não **mediu**. Marcador de conclusão e evidência de trabalho são coisas
   diferentes.
2. **`grep -c` num arquivo de 0 bytes.** A primeira busca por "instalou mesmo?" deu `0` — e o log
   tinha 0 bytes, porque o `gh api` recusou escrever sequências de escape. Zero ocorrências num
   arquivo vazio não é resposta; foi o `wc -c` impresso ao lado que denunciou.
3. **Acento.** A primeira versão do lab procurava `exit da ultima: 56` e a mensagem diz
   `última`. O lab ficou vermelho e estava certo — a asserção é que era cega. O formato exato
   agora está fixado numa asserção só, com acento.

A quarta apareceu por fora: o `--falsificar` recusou a sabotagem S3 porque o padrão casou **0
vezes** (eu errei a indentação do YAML por dois espaços). Sem a trava de "casou exatamente 1x", a
sabotagem teria virado no-op, o lab teria continuado verde, e isso seria lido como "a guarda não
existe".

## Cobertura

`bun run lint:shell` **não** varre `.github/workflows/` — os globs são `scripts/`, `.claude/hooks/`,
`db/` e `.claude/skills/*/`. O bloco `run:` deste step foi conferido à mão
(`shellcheck --shell=bash` sobre o `run` extraído do YAML, zero achados) e os três scripts do lab
entram no gate pelo glob `scripts/lab-*/*.sh`, em zero achados.
