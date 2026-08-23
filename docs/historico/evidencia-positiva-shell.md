# Evidência POSITIVA — e as nove armadilhas de shell que fabricam VEREDITO

> **A regra que sobrou no CLAUDE.md:** validação só conta com **evidência positiva** — rode o
> comando autoritativo, confirme que **terminou**, capture `exit 0`. Este doc guarda o *porquê*
> e o catálogo de armadilhas, que não cabia mais lá.

> **Por que o CLAUDE.md não numera as armadilhas:** ele numerava, e a contagem lá já mentiu uma
> vez (`b1a7773a0` — o parêntese anunciava "7" e listava 6). Ao chegar a 9ª (2026-08-23) o teto da
> seção estourou em 8 palavras, e a política é não pagar encolhendo outra lição — então o número
> saiu de lá: o parêntese do CLAUDE.md é **amostra**, este doc é o **inventário**. Dois números
> para o mesmo fato divergem; um número não tem com quem divergir.

**Quando:** consolidado em 2026-08-22, ao compactar o CLAUDE.md (o bullet tinha crescido para
1.346 chars / 224 palavras — a maior linha do arquivo, ~9% do orçamento inteiro).

## A doutrina

**Ausência de sinal NÃO é aprovação.** São *ausência de dado*, não veredito:

- processo **enfileirado** (o `heavy` pode estar esperando o semáforo, não rodando — §7);
- log **sem a linha de conclusão** (começou ≠ terminou);
- `grep` **sem ocorrência** — ⚠️ confira **caixa e acento** antes de concluir "não existe";
- **linter que não tem a regra** (verde porque não olhou, não porque está limpo).

O erro de classe: tratar "não vi nada errado" como "está certo". Um comando que **falhou ao
rodar** (glob não expandido, arquivo inexistente, flag inválida) devolve zero linhas — idêntico,
na tela, a uma busca que rodou e não achou nada. Só o **exit code** e o **formato da saída**
distinguem os dois.

## As nove armadilhas

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

### 7. O WRAPPER devolve exit≠0 por conta PRÓPRIA — igualzinho ao comando embrulhado
```
heavy: timeout (1800s) esperando vaga — abortando. (posição 1 na fila)
exit=1
```
Medido em 2026-08-22 (sessão do #1893): o `heavy` (semáforo de RAM) abortou **na fila** e devolveu
`exit=1` — o mesmo código de um teste vermelho. O vitest **nunca rodou**. É a mais traiçoeira da
lista porque não produz ausência, produz um **veredito**: entrega um número plausível para reportar
como "falhou". Vale para todo wrapper (`heavy`, `timeout`, retry, `xargs`, `sudo`, `docker run`) —
o exit dele ocupa a mesma faixa do exit do comando de dentro, e código nenhum separa sozinho
"rodou e falhou" de "nem começou".

⇒ exija **sinal do comando INTERNO**: a linha `Test Files N passed` do vitest, ou um marcador que o
lado de DENTRO escreveu.
```bash
# roda-tudo.sh — tudo isto corre DENTRO do wrapper
bun run typecheck > tc.log 2>&1; echo "TYPECHECK_EXIT=$?" >> exits.txt   # colado (§2)
bun run test      > vt.log 2>&1; echo "VITEST_EXIT=$?"    >> exits.txt
echo FIM >> exits.txt

heavy bash roda-tudo.sh    # o wrapper embrulha o script INTEIRO
```
O consumidor **não lê código nenhum antes de achar a linha `FIM`**: sem ela o veredito é "não
rodou", nunca "falhou" — e isso independe do que o `heavy` devolveu. O caso concreto tinha sido
anotado só de passagem em `docs/historico/medicao-trabalho-nao-entregue.md`; a classe é geral.

**Irmã, na mesma sessão — a conclusão impressa por `echo`:**
```bash
command grep -rn 'padrao' src --include=*.tsx   # sem aspas o zsh expande o glob: o grep NEM RODA
echo "(vazio = nenhum consumidor)"              # imprime a conclusão do mesmo jeito
```
A frase-veredito não depende do comando: sai idêntica se ele rodou limpo, se falhou ou se nem
existiu. ⇒ aspe o glob (`--include='*.tsx'`) e **derive a conclusão do resultado** em vez de
escrevê-la ao lado dele. (É o §2 por outro ângulo: lá o `echo` sobrescreve o `$?`; aqui ele fabrica
o veredito.)

### 8. O `; echo "exit=$?"` no fim mente para o HARNESS — mesmo imprimindo a verdade

Irmã do §2, e mais traiçoeira, porque o número **impresso está certo**:

```bash
bash scripts/pr-watch.sh 1888; echo "PR-WATCH exit=$?"
#            \_ devolve 5 (sem desfecho)   \_ imprime "PR-WATCH exit=5"  <- VERDADE
# ...mas o exit status do COMPOUND e o do `echo` = 0                       <- o que sobra
```

O `$?` foi capturado colado e a linha diz o certo. A mentira mora num **segundo canal**: o status
do comando composto, que é o do último elemento — o `echo`. Quem lê o *exit code* (o harness que
reporta a task, um `&&` encadeado, um step de CI) vê **0** e nunca lê a linha impressa.

Medido **duas vezes na mesma sessão** (2026-08-22, PR #1888), por quem já conhecia o §2:

| Comando | Harness reportou | Verdade, na saída |
|---|---|---|
| `heavy bun run typecheck; echo …` | `completed (exit code 0)` | `heavy: timeout (1800s) — abortando` — **nunca rodou** |
| `bash scripts/pr-watch.sh 1888; echo …` | `completed (exit code 0)` | `PR-WATCH exit=5` — consultei, **sem desfecho** |

O segundo caso é o pior possível: no contrato do `pr-watch`, **exit 0 significa MERGEADO**. A máscara
não produziu "desconhecido", produziu uma **afirmação falsa e específica** — um merge que não tinha
acontecido, pronto para ser reportado ao founder. O que salvou foi a regra do CLAUDE.md de confirmar
desfecho com `gh pr view <nº>` antes de avisar: ela existe justamente porque o canal do watcher não é
confiável sozinho.

⇒ **não termine em `echo` um comando cujo exit code alguém vai ler.** Rode pelado, ou preserve:
```bash
cmd > log 2>&1; rc=$?; echo "exit=$rc"; exit $rc     # o compound volta a valer o que mede
exec bash scripts/pr-watch.sh 1888                   # ou: nada depois dele
```
Combina com o §7: lá o wrapper **fabrica** um veredito; aqui o `echo` **apaga** o veredito — inclusive
o do wrapper. No caso do typecheck as duas agiram juntas, e o `abortando` do `heavy` só apareceu porque
alguém foi ler o log em vez do código de saída.

### 9. `${PIPESTATUS[0]}` no zsh é VAZIO — e vazio, ali, vale ZERO

A contramedida da §1 é ela própria uma armadilha fora do bash. `PIPESTATUS` é **bash**; o zsh tem
`pipestatus` — **minúsculo e 1-indexed**. O nome errado não dá erro: expande para vazio.

E vazio, no `[` do zsh, **não é "sem dado" — é `0`**, que por acaso é o exit code de SUCESSO:

```bash
false | true                                                    # o pipeline FALHOU
if [ "${PIPESTATUS[0]}" -eq 0 ]; then echo "PIPELINE OK"; fi    # imprime OK
```

Medido nos DOIS shells (2026-08-23; o Bash tool desta sessão roda em `/bin/zsh`, e o teste usou
`zsh -f`/`bash` para provar que é o shell, não a config do usuário):

| | `${PIPESTATUS[0]}` | `${pipestatus[1]}` | `[ "" -eq 0 ]` |
|---|---|---|---|
| **bash** (controle) | `1` ✓ | vazio | **erro alto**: `integer expression expected` |
| **zsh** (o nosso) | **vazio** | `1` ✓ | **verdadeiro, e calado** |

É a §6 pelo AVESSO: lá a divergência BSD×GNU fazia "outra coisa" em silêncio; aqui quem falha alto é
o **bash** — a proteção mora no shell que não estamos usando, e nada avisa na travessia. E é o
`?? 0` do money-path na camada de evidência: exit code **ausente** vira **aprovação**
(`docs/agent/money-path.md` §2, ausente ≠ zero). Sem `set -u` o silêncio é total — o `[` nem
reclama, devolve 1, e o `if` cai no ramo do "passou".

⇒ **não porte o idioma do bash.** Capture pelado, sem pipe (`cmd > log 2>&1; rc=$?` — §1), ou use
`${pipestatus[1]}` assumindo zsh-only. E **`set -u` converte esta classe inteira em aborto**
(`zsh: PIPESTATUS[0]: parameter not set`, exit 1): é a única linha que transforma o silêncio em
vermelho, e vale para todo bash-ism que só se manifesta como string vazia.

Achado no próprio trabalho, não em laboratório: nesta sessão um `git push … | tail` seguido de
`echo "EXIT_PUSH=${PIPESTATUS[0]}"` imprimiu `EXIT_PUSH=` — uma linha com **cara** de captura de
exit code e nenhum dado dentro. O push tinha funcionado, mas quem provou isso foi
`git rev-parse HEAD origin/<branch> | uniq -c` (duas refs, uma linha), não a linha do exit.

## O padrão por trás das nove

Seis produzem **verde por construção**, não por mérito; a sétima mostra que o mesmo defeito
fabrica **vermelho** com a mesma facilidade; a oitava, que o veredito certo pode existir e ainda
assim não ser o que o consumidor lê; e a nona volta ao verde por construção pelo pior
caminho — é a CONTRAMEDIDA de outra que trai ao mudar de shell, lendo ausência de dado como
sucesso: o sinal que você lê não é o sinal que você acha que está lendo. A contramedida é sempre a mesma — **exigir uma afirmação POSITIVA e com formato
conhecido** (exit code capturado colado, saída não-vazia, marcador de conclusão, formato conferido),
em vez de ler qualquer coisa na ausência dela.

É a mesma família de `WHEN OTHERS THEN 'OK'` (SQL) e `toThrow()` pelado (TS): o teste passa sem
provar nada. Ver `docs/historico/tothrow-pelado.md`.
