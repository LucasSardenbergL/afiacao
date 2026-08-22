# Evidência POSITIVA — e as seis armadilhas de shell que fabricam verde

> **A regra que sobrou no CLAUDE.md:** validação só conta com **evidência positiva** — rode o
> comando autoritativo, confirme que **terminou**, capture `exit 0`. Este doc guarda o *porquê*
> e o catálogo de armadilhas, que não cabia mais lá.

**Quando:** consolidado em 2026-08-22, ao compactar o CLAUDE.md (o bullet tinha crescido para
1.346 chars / 224 palavras — a maior linha do arquivo, ~9% do orçamento inteiro).

## A doutrina

**Ausência de sinal NÃO é aprovação.** São *ausência de dado*, não veredito:

- processo **enfileirado** (o `heavy` pode estar esperando o semáforo, não rodando);
- log **sem a linha de conclusão** (começou ≠ terminou);
- `grep` **sem ocorrência** — ⚠️ confira **caixa e acento** antes de concluir "não existe";
- **linter que não tem a regra** (verde porque não olhou, não porque está limpo).

O erro de classe: tratar "não vi nada errado" como "está certo". Um comando que **falhou ao
rodar** (glob não expandido, arquivo inexistente, flag inválida) devolve zero linhas — idêntico,
na tela, a uma busca que rodou e não achou nada. Só o **exit code** e o **formato da saída**
distinguem os dois.

## As seis armadilhas

### 1. `cmd | tail` ENGOLE o exit code
O pipeline devolve o status do **último** componente. `bun run test | tail -5` é sempre verde.
⇒ `cmd > log 2>&1; e=$?` e só então inspecione o log.

### 2. `$?` mede o ÚLTIMO comando — um `echo`/`cat` no meio já sobrescreve
```bash
minha_suite > log 2>&1
echo "terminou"      # <-- $? agora é do echo (0), SEMPRE
if [ $? -eq 0 ]; then ...   # mede o echo, não a suíte
```
⇒ capture **colado** ao comando medido. Corolário: **saída VAZIA de um job "verde" = não rodou**.

### 3. No zsh, `echo "$json" | jq` CORROMPE o JSON
O `echo` do zsh interpreta escapes (`\n`, `\t`) dentro da string. ⇒ **sempre**
`printf '%s' "$x" | jq`. (Vivo em `scripts/test-read-contexto-nudge.sh` e
`scripts/test-stop-contexto-caro.sh`.)

### 4. O `grep` daqui é shim para `ugrep` — dobra acento em TODO locale
`grep` é uma **função de shell** (snapshot do zsh), não o binário. O `ugrep` faz *accent folding*
em qualquer locale, então `grep "sessao"` casa "sessão" — ótimo para achar, **péssimo para provar
ausência** ou para reproduzir o comportamento do CI. ⇒ use **`command grep`** ao reproduzir ou ao
afirmar "não existe". Tratamento mais fundo: `docs/agent/money-path.md`.

### 5. Log em `/tmp` não atravessa PAUSA
`/private/tmp` — **e o scratchpad da sessão mora lá dentro** — morre no reboot. Log ausente depois
de uma pausa longa **não distingue** "não rodou" de "foi limpo". ⇒ desfecho de PR se apura com
`gh pr view <nº>`, **nunca** pelo log do watcher. Mais em `docs/agent/worktrees.md`
(§`git stash` / fila do `heavy`).

### 6. Flag homônima entre BSD e GNU não FALHA — faz OUTRA coisa
`stat -f` é **formato** no macOS e **`--file-system`** no Linux. O GNU ainda cospe ~5 linhas no
**stdout ANTES** de sair `!= 0`, então o idioma `a || b` **concatena lixo** em vez de cair no
fallback. ⇒ valide o **FORMATO esperado** da saída, não o exit do 1º ramo, e teste os **DOIS**
contratos por stub. Caso medido e o idioma correto: `docs/agent/worktrees.md`
(§Portabilidade BSD × GNU).

## O padrão por trás das seis

Todas produzem **verde por construção**, não por mérito: o sinal que você lê não é o sinal que
você acha que está lendo. A contramedida é sempre a mesma — **exigir uma afirmação POSITIVA e
com formato conhecido** (exit code capturado colado, saída não-vazia, formato conferido), em vez
de aceitar a ausência de vermelho.

É a mesma família de `WHEN OTHERS THEN 'OK'` (SQL) e `toThrow()` pelado (TS): o teste passa sem
provar nada. Ver `docs/historico/tothrow-pelado.md`.
