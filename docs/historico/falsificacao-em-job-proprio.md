# A falsificação em job próprio — e por que ela não virou "paralela por dentro" (2026-10-02)

> **A classe:** quando um step é o caminho crítico do check required, tirar ele do job e pôr num
> job irmão dentro do `validate.needs` troca **soma** por **máximo** sem mudar uma vírgula do que
> roda. Mudar COMO ele roda esbarra nas máquinas que leem a forma dele.

## O que foi medido (01/10, log do runner)

| | |
|---|---:|
| `gates-e-falsificacao` (o maior job do `validate`) | ~21–23 min, pior 24,2 contra o teto de 25 |
| step "Falsificação — sabota o alvo" dentro dele | ~16 min (27 alvos em série) |
| `fecho-edges-pendentes` / `codex-async` | ~410 s / ~220 s — os outros 25 somam ~6 min |
| push → `validate` concluído (mediana) | 6 min em 08/09 → 26 min em 01/10 |

## O conserto

O step foi para o job `falsificacao`, irmão do `gates-e-falsificacao` e dentro do `validate.needs`
(com o denominador `esperados` 6 → 7 e guarda NOMINAL, como a de `provas-sql`). O preâmbulo é o mesmo
de lá — fetch-depth 0, bun, deno, shellcheck pinado — para os alvos rodarem no ambiente de sempre.
O caminho crítico passa a ser o **maior** dos jobs (~17 min da falsificação), não a soma (~23).

## Por que não "3 alvos em paralelo dentro do job"

Era o plano, e o runner existe (worktree por faixa, testado contra repo descartável). O que o
barrou foi o próprio repo — três leitores da FORMA do `test:falsificacao`:

- **`exclusividade`** assina argv+env de cada gate. Um env (`FALSIF_FAIXAS=3`) no step ou no job,
  ou um nome novo de script, faz o `test:falsificacao` virar "gate novo sem exclusividade"
  (REPROVA) até alguém re-medir a matriz — 853 s só esse gate na última medição.
- **R4 do `falsificar-exige-assert-gate.ts`** reprova qualquer resíduo no roteiro que ele não saiba
  expandir (ex.: `[ "$CI" = true ] ||` no corpo do laço) e exige que toda invocação direta seja um
  alvo JULGADO (idioma SABOTAGENS ou juiz) — um orquestrador não é.
- **`test-falsificar-implementado.sh`** lê a lista com `sed` exigindo que o valor COMECE em
  `for t in`.

O job próprio não toca em nenhum dos três: a invocação é byte a byte a mesma, e a exclusividade
segue "medida". Paralelizar por dentro continua possível, mas é decisão de máquina meta (ensinar o
R4 a reconhecer o orquestrador e re-medir a exclusividade), e fica para quando valer o custo.

## Como re-medir

```bash
gh run list --workflow CI --event pull_request --limit 20 --json databaseId
gh api "repos/LucasSardenbergL/afiacao/actions/runs/<id>/jobs" \
  --jq '.jobs[] | select(.name|test("falsificacao|gates-e")) | {name, started_at, completed_at}'
```
