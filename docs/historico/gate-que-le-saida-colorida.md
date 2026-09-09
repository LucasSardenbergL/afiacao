# O gate lia a APRESENTAÇÃO, não o dado — `grep` na saída colorida do vitest reprova só no CI

**2026-09-09 (#2424 · #2433).** O step `prova por consumidor` do job `mutation-check` entrou pelo
#2424 e derrubou a `main` no mesmo dia. Ele reprovava **em todo run do runner** e ficava **verde em
toda execução local** — com e sem `LC_ALL=C`, reproduzindo a sequência `mutcheck → prova`. Sem
causa medida, o #2433 tirou o step do CI (decisão correta para o momento: gate cuja falha ninguém
explica é ruído com poder de veto). A causa, medida depois, não estava no vitest nem no ambiente:
estava **no guard**.

## O que o guard fazia

`scripts/prova-consumidores-controle.sh` roda `vitest -t "<filtro>"` e precisa saber se o filtro
**casou algum teste** — porque `-t` que não casa nada faz o vitest sair **0 por vazio**, e aprovar
por vazio é exatamente a falha que o script existe para não cometer. Ele perguntava isso assim:

```bash
casou_algum() { grep -qE 'Tests +[1-9][0-9]* passed' /tmp/prova-consumidores.$$.log; }
```

No terminal local a linha do vitest é `      Tests  2 passed | 162 skipped (164)` e o `grep` casa.
**No GitHub Actions o vitest COLORE** — o runner anuncia suporte a ANSI, e a linha que chega ao log
é (escapes visíveis):

```
ESC[2m      Tests ESC[22m ESC[1mESC[32m8653 passedESC[39mESC[22mESC[2m | ESC[22mESC[33m1 skipped
```

Entre `Tests` e o número há `ESC[22m ESC[1mESC[32m`. O `+` do regex aceita **só espaços** — então
**nunca** casa no CI. O vitest ficava verde, os testes casavam, e **quem mentia era o guard**.

## Por que ninguém achou: "mesmo SHA, vereditos opostos" era falso

O diagnóstico partiu de uma tabela de runs que parecia não-determinismo — o SHA `150856a59` com um
run **verde** às 13:41 e quatro **vermelhos** às 15:3x, sem nenhum commit entre eles. Não era.

| run | evento | `mutation-check` |
|---|---|---|
| 13:41 verde | `schedule` | **skipped** (0 steps) |
| 15:31–15:38 vermelho | `workflow_dispatch` | rodou, falhou |

O job tem `if: github.event_name != 'schedule'`. **O "verde" era o job pulado** — ausência de dado
vestida de aprovação, a armadilha que o CLAUDE.md já nomeia ("ausência de sinal NÃO é aprovação").
O gate era **determinístico**: sempre vermelho quando rodava. Procurar não-determinismo (cache
entre runs, mutante sobrevivendo no disco, resíduo do `mutcheck`) foi procurar o que não existia —
**a premissa do bug estava errada antes da primeira hipótese**. Antes de investigar "por que
intermitente", confira se o run "bom" **mediu** alguma coisa: `gh run view <id> --json jobs` diz
`skipped` em letra.

A segunda pista falsa foi o tempo: ~1,15 s por execução, lido como "falha de INICIALIZAÇÃO do
vitest, não de rodar 164 testes". Era o oposto — **1,15 s era uma rodada bem-sucedida** de um
arquivo com o cache do Vite quentíssimo (o `mutcheck` acabara de rodar ~10 min de vitest sobre ele)
e com `-t` filtrando 164 de 166 testes. Tempo curto não distingue "não rodou" de "rodou pouco".

## A classe

**Gate que decide lendo a saída HUMANA de uma ferramenta herda a formatação dela.** Cor, locale,
largura de terminal, emoji, layout do reporter — nada disso é contrato, tudo isso vota. É a mesma
família de `docs/historico/gates-textuais-cegos.md` (medir com regex local em vez do stripper
compartilhado) e de `evidencia-positiva-shell.md` (veredito fabricado por recorte de texto): o
sensor consulta a **apresentação** e chama o resultado de **dado**.

Pior: falha **em silêncio e só no ambiente que importa**. A saída colorida existe no CI e não no
laptop, então o desenvolvedor vê verde, o runner vê vermelho, e a mensagem de erro fala do *alvo*
("o filtro não casou"), nunca do *instrumento*.

## O conserto

Tirar a apresentação da decisão. O guard passa a ler o **reporter JSON** do próprio vitest:

```bash
"${TEST_CMD[@]}" "$TESTE" -t "$1" \
  --reporter=default --reporter=json --outputFile.json="$VEREDITO" > "$LOG" 2>&1
# ...
casou_algum() {
  local j="${1:-$VEREDITO}"
  [ -s "$j" ] || return 1          # sem veredito NÃO há aprovação (fail-CLOSED)
  PROVA_VEREDITO="$j" bun -e '...process.exit(Number(o.numPassedTests)>=1?0:1)'
}
```

`numPassedTests` é dado: imune a cor, a locale e ao layout do reporter humano. O `default` continua
no log **para o humano ler na falha** — só perdeu o direito de votar. Medido com `FORCE_COLOR=1`:
filtro que casa → `numPassedTests: 1`; filtro que não casa → `0`; e **o vitest sai 0 nos dois** —
prova de que o exit code sozinho nunca discriminaria, e o guard é indispensável.

Três causas de reprovação, antes fundidas em um ramo, agora são três mensagens: suíte vermelha ·
**runner saiu 0 sem emitir veredito** (fail-closed novo) · filtro não casou.

## O que trava a recaída

`scripts/prova-consumidores-controle.sh --selftest` — ~0,1 s, **sem vitest**, roda no CI antes da
prova. A asserção é a que teria pego o bug original: **com o mesmo veredito de máquina, um log
limpo e um log cheio de ANSI têm de dar o mesmo resultado.** Se alguém voltar a ler o log para
decidir, os dois divergem e o selftest fica vermelho. Os dois casos negativos (contagem zero,
veredito ausente) são o controle de discriminação.

Falsificado com controle verde na mesma invocação (`FALSIFICACAO_FIM ok`): cópia intacta verde ·
guard voltando a ler o log → vermelho · guard que sempre aprova → vermelho · fail-closed removido →
vermelho.

## Regra

**Gate não lê a saída formatada para humano quando existe saída de máquina.** Se a ferramenta tem
`--reporter=json`, `--format=json`, `--json`, `-tA` ou arquivo de saída, o veredito sai de lá — é a
convenção que o repo já pratica (`scripts/falsificar-individuais.sh`, `scripts/boletim-modulos.ts`,
`scripts/shellcheck-gate.sh --format=gcc`, `gh --json`, psql `-tA`). Quando não houver, o repo tem
duas saídas: o strip `semAnsi` de `scripts/edges-typecheck-gate.ts` (único do repo, em TS) e
`NO_COLOR=1` na invocação (`scripts/falsificar-prompt-cache.sh`). E qualquer gate que leia texto de
ferramenta deve ser falsificado **com a saída colorida** — senão a falsificação roda no único
ambiente onde o bug não aparece (a lição de `LC_ALL` do #1483, com cor no lugar do locale).

**Armadilha ao "desligar a cor": `FORCE_COLOR=0` LIGA.** O vitest (tinyrainbow) e o knip
(picocolors) testam a variável **por presença** — `"FORCE_COLOR" in env` / `!!env.FORCE_COLOR`, e
`"0"` é truthy —, então `FORCE_COLOR=0` faz o oposto do que parece. Quem desliga é `NO_COLOR`
(qualquer valor) ou `--no-color`. E não é uniforme: o **eslint** (chalk 4) **não lê `NO_COLOR`** —
ali quem desliga é `FORCE_COLOR=0`. `tsc` fixa-se com `--pretty false`, `git` com `--no-color`,
`gh` com `--json`. Já existe um `FORCE_COLOR: '0'` bem-intencionado e inócuo no repo
(`scripts/exclusividade-medir.ts`, que decide só pelo exit code) — não copiar como receita.

**E, antes de caçar não-determinismo, prove que o run "bom" mediu.** `gh run view <id> --json jobs`
diz `skipped` em letra. Verde de job pulado e verde de job aprovado são a mesma cor na listagem e
coisas opostas.
