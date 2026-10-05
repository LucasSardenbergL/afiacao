# As rodadas do `fecho-edges-pendentes --falsificar` em paralelo — e o que a re-medição de 05/10 decidiu (2026-10-05)

> **A classe:** quando o laço de falsificação já isola cada rodada por CONSTRUÇÃO (diretório próprio,
> fixtures somente-leitura), o estado que sobra compartilhado é o do ARNÊS — a cópia sabotada e o
> embrulho ao lado dela. Isolado isso, as rodadas correm em paralelo sem mudar uma linha do juiz.

## A re-medição (API do Actions, runs de 19/09 a 05/10)

Depois de [mutation-check-por-escopo.md](mutation-check-por-escopo.md),
[falsificacao-em-job-proprio.md](falsificacao-em-job-proprio.md), o cancelamento do run superado e
o `mutation-check` da main em 3 partes:

| | antes | depois |
|---|---|---|
| `mutation-check` em PR | 100% dos runs, 28 min de runner cada | ~1 em 4 PRs de produto; 5 min/run |
| run de commit superado seguindo após push novo | 34% dos runs — 3.811 min em 13 dias | 2 casos, 2 min |
| run repetido na main (mesmo SHA) | 50 de 116 (3.016 min) | 1 de 4 |
| caminho crítico do `validate` | `gates-e-falsificacao` 18,6 min | `falsificacao` 16,4 min |
| `mutation-check` da main | 41–44 min (run inteiro 41–74) | 15,9 min (run inteiro 16,5) |

Nada disso foi código mais rápido: dois cortes de trabalho redundante e duas reorganizações em
paralelo. E o ganho foi comido pelo crescimento das suítes no mesmo período: provas SQL de 3,4 para
30 min de runner por run de PR (3 partes de ~10), gates + falsificação de 11,8 para 21,3. O run de PR
custa 68 min de runner (era 70; sem os cortes, ~100). Em rajada a fila domina: em 03/10, 7 PRs no
mesmo minuto ocuparam os 20 jobs simultâneos da conta por 35 min (até 55 na fila) e levaram 31–43 min
até o `validate`.

## Por que as provas SQL NÃO ganharam escopo por diff

- **Pouco ganho seguro:** 79% dos 400 PRs mergeados de 07/09 a 03/10 tocam algo além de
  `src/`/`docs/`/`*.md`/`public/`; o recorte fail-closed pularia 11% dos runs (~3 min de runner/run).
- **Superfície larga e viva** (mapeada por leitura transitiva): `db/**`; `supabase/migrations/**`
  varrida por CONTEÚDO (`cv_cadeia`, `dhv_cadeia`); todo `supabase/functions/*/index.ts` (o gerador
  lista a pasta); `supabase/schema-snapshot.sql`, o prelude e `config.toml`; `scripts/db-aplicar.sh`,
  `sonda-versao-sql.ts`, `canaria-*.ts`, `sonda-fingerprint.ts`, `lib/transporte-nuvem.ts`; em `src/`,
  `lib/gates/limpeza-fonte.ts` e `lib/erro-mensagem.ts` (via imports `@/`, que dependem do
  `tsconfig.json`); e um `git worktree add --detach HEAD` — a árvore inteira do commit.
- Allowlist à mão apodrece no primeiro import novo; a robusta derivaria o fechamento de imports —
  máquina meta nova sem incidente. **Decisão: não fazer.**

## O conserto: as rodadas do `fecho-edges-pendentes` em paralelo

Medido na main (run 37126326759): o alvo levava **313 s dos 831 s** do step de falsificação —
~102 rodadas (51 sabotagens × 2 locales) de ~3 s, em série.

**Por que é seguro.** Desde o #2652 cada chamada de `suite` nasce no SEU `$tmp/rodada.*`, as
fixtures compartilhadas são `chmod a-w` e tudo o que um caso escreve nasce na rodada. O que ainda era
um só para os dois locales de uma sabotagem era a cópia e o EMBRULHO que `embrulha_alvo` escreve ao
lado dela — com um embrulho só, o stderr de um locale cairia no arquivo do outro. Agora cada locale
tem a sua cópia (`sabotado.<locale>.sh`) e o seu embrulho; a `camada4` recebe essa cópia para
normalizar o caminho.

**O desenho, e por que não mais largo.** Os 2 locales de cada sabotagem correm JUNTOS (em fundo, pid
guardado); o juiz, o mesmo de antes e na mesma ordem, mede o exit com `wait "$pid"; rc=$?` — colado no
veredito, do processo que rodou a suíte. Pid ausente ou não numérico é FALHA ("rodada SEM pid"). A 1ª
versão rodava TODAS as ~102 rodadas numa fila de 4 e passava o exit por arquivo `.rc` — e dois gates
recusaram, com razão: o R2 do `falsificar-exige-assert` acusa um 2º `for … in $SABOTAGENS` que não leva
a declaração ao `grep` (a forma do laço que julga por exit), e o R4 exige a medição colada no veredito,
que o arquivo intermediário rompia (um `echo 1 > .rc` em outro ponto passaria sem o gate ver).
Ganho de ~2x neste alvo, não ~4x: o preço de continuar auditável.

**O parecer do Codex (gpt-6-astra, max, 460 s) achou dois furos na 2ª versão — os dois reais:**
1. **O R4 ficou mais fraco que antes.** Com a medição em DOIS blocos de âncora (disparo e juízo), um
   `continue 2` logo depois de guardar o pid pulava o juiz com `falhou=0`, e a falsificação anunciava
   "todas detectadas" (num recorte do laço: controle 1, variante 0). No bloco único de antes a mesma
   inserção o rompia. Agora o R4 prende UM bloco contíguo, do `aplica` ao 1º veredito.
2. **O `cp` sem status.** A cópia por locale é reaproveitada entre sabotagens: um `cp` que falhasse
   deixando a da sabotagem ANTERIOR rodaria a mutação errada, e `sql_descarta_sem_fonte` e
   `segunda_classe_sem_probe` (vizinhas, as duas exigem E12b) aprovariam a 2ª sem ela ter rodado.
   Agora a cópia é re-criada (`rm -f`) e conferida (`cmp`); rodada não disparada (cópia ou embrulho)
   ou sem pid é FALHA no próprio juízo, na ordem de sempre — e o slot do pid é zerado a cada disparo.

O que o parecer confirmou: sem estado compartilhado entre os locales (o alvo e o auxiliar usam
temporário próprio; o git dos fixtures usa `--no-optional-locks`), e `wait "$pid"` fiel no bash 3.2 e
5.x (um `wait` repetido devolve o status guardado; o PID descartado por `wait` sem argumento dá 127).

**Falsificado** (controle na mesma invocação). No TEXTO, contra o R4 (controle 0 achados): o
`continue 2` do parecer, o pid sobrescrito entre disparo e juízo, a cópia sem conferência e a rodada
não disparada pulada sem FALHA — as 4 reprovam.

**Por que não o `codex-async` (o 2º mais lento, 212 s).** A suíte dele procura `sleep 977` vazado
na MÁQUINA inteira (`pids_sleep`): duas rodadas simultâneas veriam o processo uma da outra.

**Por que não o runner em faixas** (uma worktree por faixa de alvos, guardado na branch local
`ci/falsificacao-paralela`). Ele exige mudar a invocação do `test:falsificacao`. Medido hoje: um `env:`
novo no step NÃO reprova o `exclusividade` (o gate é dispensado por NOME — o comentário do `ci.yml`
que diz "REPROVA" erra nisso), mas deixa 4 gates com exclusividade INCONCLUSIVA (`docs:indice`,
`docs:links`, `gate:ambiente`, `gates:frescura`), porque as linhas da matriz deixam de bater com a
invocação do CI — até alguém re-medir, ~14 min por execução do `test:falsificacao`. O paralelo dentro
do alvo não toca a invocação.
