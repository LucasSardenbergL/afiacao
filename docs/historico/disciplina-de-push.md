# CI fatia E: disciplina de push das sessões (2026-11-09)

> Programa "merge de PR mais rápido sem perder qualidade". Fatias: A conflito de arquivo
> regenerado ([ci-arquivos-gerados-sem-conflito.md](ci-arquivos-gerados-sem-conflito.md), #3768) ·
> B parar cedo quando um gate rápido reprova · C escopo incremental para push só de docs · D
> balancear as provas · **E (esta)**: só texto de regra para os agentes. **Sem máquina nova**: nenhum
> hook, gate ou sensor. A regra viva fica em `docs/agent/worktrees.md` §"Disciplina de push".

## A evidência (medição de 06/11 a 09/11, API do Actions, run a run)

- 236 runs de CI em PR. **93 foram cancelados** por push novo no mesmo branch, e eles somam **33%
  do runner-min**: cerca de 82,5 min por run cancelado. A conta tem limite de 20 jobs
  concorrentes, então run cancelado também ocupa a fila dos PRs das outras sessões.
- Causa dos 93 cancelamentos:
  - **51%** vieram de re-sync com a `main` por conflito em arquivo regenerado. A fatia A já
    resolveu isso.
  - **33** vieram de push de código. **22** deles vieram depois de um vermelho real, ou seja, a
    sessão empurrou tentativas em vez de reproduzir local.
  - **17** vieram de push só de docs no meio do CI (registro em `docs/historico/`, ajuste de texto
    do PR).
- Drafts são só 3% dos runs e não são alavanca.

Os 22 cancelamentos após vermelho e os 17 de docs são comportamento da sessão. Nenhuma máquina
do CI resolve isso sem custo; a regra de texto resolve de graça.

## A regra (resumo; texto vivo em `docs/agent/worktrees.md`)

1. **Antes de abrir o PR ou tirar de draft:** junte os commits num push só e rode local o que for
   barato e relevante: `bun run typecheck`, o teste do arquivo tocado e a prova SQL tocada.
2. **Depois de um vermelho real:** leia o log, reproduza local e corrija. Empurre quando o local
   passar, não para "ver se o CI passa".
3. **Commit só de docs com o CI do PR rodando:** não empurre. Junte ao próximo push ou deixe para
   depois do verde.
4. **Merge da `main`:** só com conflito ou dependência real (o PR precisa de algo que acabou de
   mergear). "Ficar atualizado" não é motivo: o squash do auto-merge já junta com a `main`.

## Por que sem máquina

O CLAUDE.md exige incidente citado por ID para máquina meta nova
([maquinas-meta.md](../agent/maquinas-meta.md)). CI lento não é incidente. As fatias B e C já
reduzem o custo de cada cancelamento no próprio `ci.yml`. Esta fatia muda só o comportamento que
gera os cancelamentos.

## Como medir depois

Repita a consulta da fatia A (`docs/historico/ci-arquivos-gerados-sem-conflito.md` §Como medir)
numa janela de 3 a 4 dias após o merge. Separe os cancelados por causa (sync da `main`, push de
código após vermelho, push só de docs). O sinal desta fatia é a queda das duas últimas causas,
hoje 22 e 17 em 236 runs.

**Medido em 12/11:** [ci-cancelados-por-causa.md](ci-cancelados-por-causa.md). Pushes de conserto
após vermelho caíram de 22 para 2 e pushes só de docs de 17 para 2 (102 runs, ~40 h). Atenção: 15
dos 24 `cancelled` da janela eram o `fail-fast` se cancelando, não push.
