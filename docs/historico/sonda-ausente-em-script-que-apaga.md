# Sonda ausente: degradar é certo no sensor, errado no script que APAGA (2026-08-21)

Varredura dos irmãos do `scripts/wt-status.sh` atrás dos dois padrões que o
[#1838](https://github.com/LucasSardenbergL/afiacao/pull/1838) consertou nele.
O achado que interessa não é a repetição — é que **o mesmo remédio muda de sinal
conforme o script LÊ ou DESTRÓI**.

## Os dois padrões do #1838, relembrados

1. **SIGPIPE.** `produtor | head -N` sob `set -e`+`pipefail`: o `head` fecha o
   pipe, o produtor toma EPIPE, o pipeline vira 141 e o `set -e` mata o script.
   Conserto: `awk 'NR<=N'`, que lê até o EOF.
2. **Sonda ausente.** Ferramenta só-macOS (`vm_stat`, `sysctl`, `lsof`, `md5`)
   devolve 127 quando não existe; sob `set -e` isso mata o SCRIPT INTEIRO, não a
   seção. Conserto no sensor: `|| flag=0`, validar o que voltou, e a seção
   declarar "sem medida" enquanto as outras seguem.

## O que a varredura mediu (contra `origin/main` 8f1301dba)

| script | `du` | `\| head` | `set -e` | veredito |
|---|---|---|---|---|
| `wt-clean.sh` | 1 | 0 | sim | **defeito ativo** (du + lsof) |
| `wt-prune.sh` | 1 | 1 | sim | **defeito ativo** (du + lsof + md5) |
| `wt-reap.sh` | 0 | 1 | **não** (`set -uo pipefail`, sem `-e`) | sem defeito |
| `wt-map.sh` | 0 | 1 | sim | sem defeito |
| `wt-orfas.sh` | 0 | 0 | não | sem defeito |

Cada linha foi reproduzida com stubs e o exit code capturado colado
(`cmd > log 2>&1; e=$?`), nunca por leitura do código.

## A regra nova: a assimetria

O `wt:status` **só lê**. Uma leitura que falta degrada a seção, o resto do
relatório segue, e "sem medida" é a resposta honesta. `wt:clean` e `wt:prune`
**apagam** — e ali a mesma ausência não degrada, ela DESTRÓI:

- Com `lsof` devolvendo 127, o `active_file` fica vazio, `is_active` passa a
  responder "não" para todo mundo, e a worktree de sessão **viva** vai de
  `skip (sessão/processo ativo)` para `would … -250 MB`. Sem uma palavra sobre
  a sonda ter faltado.
- Com `md5` ausente, os dois lados da comparação viram string vazia,
  `[ "" = "" ]` dá VERDADEIRO, e o `.env` com segredo único — o exato caso que
  a allowlist existe para bloquear — é classificado como descartável.

⇒ **Sonda de SEGURANÇA que não responde é fail-CLOSED em script destrutivo.**
Sem `lsof`, o `--yes` aborta e o dry-run declara que não é confiável; sem sonda
de hash, o `.env` bloqueia. "Não sei" ≠ "igual". Um guard que emudece não
protege nada — é o `Number(null)===0` da segurança.

## Checar `command -v` NÃO basta — exija evidência POSITIVA

A primeira versão do conserto passou verde com um `lsof` que **existe e sai
127**: `command -v` o encontrava, e o `active_file` ficava vazio exatamente como
na ausência. Ferramenta presente-porém-quebrada (PATH capado, shim, permissão)
tem o mesmo desfecho que a ausente.

Conserto: perguntar à sonda algo cuja resposta é conhecida — o `lsof` sempre
sabe o cwd do **próprio processo**. Resposta vazia = sonda inútil.

```bash
sonda_lsof_ok() {
  command -v lsof >/dev/null 2>&1 || return 1
  local r
  r="$(lsof -nP -a -p "$$" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | awk 'NR<=1')"
  [ -n "$r" ]
}
```

## `set -e` é suspenso por CONTEXTO DE CHAMADA — e isso esconde bombas

Por que o `| head -3` do `ignored_blockers` (`wt-prune.sh`) nunca matou ninguém,
enquanto o `du` da mesma função-irmã matava? Medido, não deduzido:

```
função chamada em `if ! f`   → status 141 lido, script SOBREVIVE
função chamada SOLTA (`f;`)  → EXIT=141, script MORRE
```

`classify()` só é chamada dentro de `if !`; `handle()` é chamada solta. O
`| head -3` está protegido por **acidente de chamada**, não por desenho — e o
próximo refactor que mover a chamada reintroduz a morte sem tocar no pipeline.
Mesma mecânica salva o `wt-map.sh`: `subj="$(subject_for …)"` sobrevive a um
`ls -t <glob que não casa> | head -1` que, solto, sai 1 e mata.

⇒ Trocar `| head -N` por `awk 'NR<=N'` mesmo quando está LATENTE. E, ao julgar
um `| head` num script com `set -e`, olhe **onde a função é chamada** antes de
concluir "tem defeito" ou "não tem".

⚠️ **Essa troca é a única deste PR sem teste que a distinga, e isso foi medido,
não presumido:** na falsificação, devolver o `| head -3` numa cópia deixa o
`test-wt-prune.sh` **verde**. É a consequência lógica do próprio achado — se o
`set -e` está suspenso, a diferença é inobservável. Um teste que ficasse verde
nos dois lados e fosse *apresentado* como trava do `awk` seria ausência de dado
com cara de aprovação; por isso o caso 11 declara, no próprio comentário, que
trava o COMPORTAMENTO com muitos ignorados e não a troca. Gate textual foi
considerado e **rejeitado**: o `wt-map.sh` tem um `| head -1` legítimo, então um
grep repo-wide nasceria com falso positivo.

## O que NÃO foi mexido, e por quê

`wt-reap.sh` foi poupado depois de medido, não por inspeção: com 50.000 linhas
atrás do `| head -1` sai `EXIT=0` com o veredito correto (ele tem `pipefail`
mas **não** tem `-e`, e é o `-e` que mata), e sem `lsof` degrada
fail-**closed** — `collect_dev_procs` não coleta nada, logo não mata ninguém.
Fica registrado o único senão, que não vale o risco de mexer: a mensagem
`✅ Nada a fazer — todo vitest/esbuild é de sessão viva` **afirma um veredito
que não foi medido**. É defeito de relato num caminho que não age.

Mudança sem defeito é risco sem retorno — especialmente em script que apaga.

## Falsificação: o harness cometeu o defeito que veio consertar

Rodando as 9 sabotagens em lote, quase todas reportaram *"pendurou — o teto
sumiu"*, inclusive as que não tocam o teto. Causa: o stub `du` do modo lento
deixa `sleep 30` órfãos, que contaminam a prova seguinte. Era **o mesmo erro de
atribuição de motivo** que o #1838 consertou (creditar o relógio como erro do
`du`) — agora no instrumento de medida.

⇒ Isolar cada prova (matar os órfãos entre elas) e, quando o teto do harness
estoura numa sabotagem que não é a do teto, o resultado é **INCONCLUSIVO**,
não vermelho. Vermelho creditado à causa errada é verde disfarçado.

## Artefatos

- `scripts/lib/wt-medida.sh` — `du_mb` (teto + motivo no exit code),
  `medida_humana`, `hash_arquivo`, `sonda_lsof_ok`.
- `scripts/test-wt-prune.sh` (25 asserções) · `scripts/test-wt-clean.sh` (21),
  registrados no laço `test:hooks` do `package.json`. As asserções do `--yes`
  são **físicas** (o `node_modules` ainda está lá?), não textuais: um "skip"
  impresso não prova que nada foi apagado.
- Pendência consciente: o `du_mb` do `wt-status.sh` segue duplicado — o dele tem
  orçamento GLOBAL além do teto por item.
