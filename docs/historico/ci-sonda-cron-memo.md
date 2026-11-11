# sonda-cron-prova: memo das leituras do git (2026-11-11)

> **A classe:** depois do #3817 o caminho não-SQL virou um EMPATE de 4 jobs (~245–286 s):
> `sonda-cron-prova`, `falsificacao (1)`, `falsificacao (3)`, `hooks-e-evals`. Cortar um só não
> move o piso. Decisão (Fable + Codex, independentes, mesmo briefing de fatos): atacar os 4,
> começando pela sonda — a única mudança que REDUZ runner-minuto em vez de somar runner.

## Dados da decisão
- 07–11/11: 138 PRs com CI verde; **52 (38%)** só rodaram o caminho não-SQL.
- Run limpo pós-#3817 (43028741076): sonda 248 s · falsificacao (1) 250 · hooks-e-evals 264 · falsificacao (3) 245.
- O #3819 (E18) mediu o perfil do `--gate`: ~79% enumeração (`git log --follow` e `git show sha:path`
  relidos a cada volta do ponto fixo e de novo no hash da identidade).

## O que mudou
`scripts/sonda-cron-prova.ts`: memo em processo de `git show <sha>:<path>` (chave raiz+sha+path —
o sha de commit fixa a árvore) e de `git log --follow <HEAD> -- <f>` (chave raiz+HEAD+arquivo; o HEAD
é resolvido uma vez por enumeração). Nunca por edge, volta ou posição. Execução no Deno intacta
(sem pool/paralelismo — o #3819 registrou o risco de disputa de CPU no teto de timers).

## Provas
- **Equivalência em todas as edges da allowlist** (versão da main × memo, mesmo HEAD): 17 edges,
  747 closures, JSON de identidades idêntico (`cmp` = 0). Local (M2 disputada): enumeração 711 s → 410 s.
- `scripts/sonda-cron-prova.test.ts`: repo temporário; commit novo DEPOIS da 1ª enumeração (memo quente)
  vira closure novo, e memo quente == memo frio. Sabotagem da chave (sem o HEAD) → vermelho; controle verde
  na mesma invocação.

## Próximos (mesma decisão, medir entre eles)
`fecho-edges-pendentes` em k/2 (fatia nova) → separar `hooks-e-evals` → `codex-async` em 3 partes só se
ainda for o piso. Teto +2 runners; parar quando o piso estiver ~20 s acima do maior shard de `testes`.
