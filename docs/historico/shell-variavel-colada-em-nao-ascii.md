# `$NOME…` no bash do macOS: o 1º byte do caractere colado vira parte do nome — e o script morre, ou apaga calado

**Medido:** 2026-09-10 (canária, #2472) e 2026-09-14 · **Erradicado + gate:** 2026-09-14 · **Classe:** expansão `$NOME` sem chaves com caractere não-ASCII colado ao nome, em shell que roda no bash do macOS.

## A classe

O bash desta máquina é o `/bin/bash` **3.2.57** — é ele que o `#!/usr/bin/env bash` acha (não há bash do Homebrew). Ele decide onde o NOME da variável termina perguntando ao `isalnum()` do locale, e sob UTF-8 a libc do macOS responde "letra" para o 1º byte de quase todo caractere multibyte. `"$marca…"` — o `…` é U+2026, bytes `E2 80 A6` — vira `${marca\xE2}`.

Medido com `/bin/bash -c`, `marca=X` e `echo "fim: '$marca…'"`:

| forma | `LC_ALL=C` | `LC_ALL=pt_BR.UTF-8` |
|---|---|---|
| `$marca…` com `set -u` | `fim: 'X…'` | `marca�: unbound variable` — **o script morre** |
| `$marca…` sem `set -u` | `fim: 'X…'` | `fim: '` + `\x80\xA6` + `'` — **o valor e o 1º byte somem, calados** |
| `${marca}…` | `fim: 'X…'` | `fim: 'X…'` |

Que byte morde: dos 18 bytes-líderes testados (`C2 C3 C4 C5 C8 CA CE D0 D7 D8 DF E0 E2 E3 E9 EF F0 F4`, cada um com continuação válida), **17 quebram**. Só o `D7` escapa — lido como Latin-1 ele é `×`, que não é letra. Na prática: qualquer caractere não-ASCII colado ao nome. A decisão é tomada na EXECUÇÃO da linha, não no parse — vale o locale daquele momento. No Linux (glibc) a forma não morde (relato do #2472; não havia Linux à mão para re-medir), e por isso o CI nunca a veria executando.

## Por que as ocorrências eram latentes — e por que isso não bastava

As 3 provas afetadas exportam `LC_ALL=C LANG=C` no topo: a linha roda em `C` e não morde. Mas a regra da casa manda **falsificar nos DOIS locales** (`docs/agent/money-path.md`, #1483), e o 2º locale roda a suíte de novo sob `pt_BR.UTF-8`, por cima do `export`. Foi o que aconteceu na canária: o `'$marca…'` derrubava a suíte no 2º locale, e **toda** sabotagem "ficava vermelha" por crash, sem julgar nada (`falsificacao-da-canaria-no-caminho-obrigatorio.md`). A disciplina que existe para pegar asserção frouxa é justamente a que acorda esta classe — e o vermelho que ela produz se lê como sucesso da falsificação.

Agravante: em `test-caca-custo-producao.sh:126` a forma estava no ramo de **sucesso** da falsificação F1. Sob UTF-8, quem morre é o caminho saudável.

## Varredura — repo inteiro, main `d046839e5`

Universo: `git ls-files` de `.sh .bash .ts .tsx .js .mjs .cjs .sql .md .yml .yaml .json .toml .txt`, mais os sem extensão de `db/ scripts/ .claude/hooks/ .husky/`. `git ls-files`, e não `rg` cru, que pularia `.claude/` (19ª armadilha de `evidencia-positiva-shell.md`). Assinatura em modo byte, fora de linha de comentário:

```bash
perl -ne 'if (!/^\s*#/ && /\$([A-Za-z_][A-Za-z0-9_]*)([\x80-\xff])/) { printf "%s:%d: \$%s + 0x%02X\n", $ARGV, $., $1, ord($2) } close ARGV if eof'
```

| sítio | colado | ramo | veredito |
|---|---|---|---|
| `db/test-audit-claude-ro-hardening.sh:225` | `»` (`C2 BB`) | falha ("sem a marca «…»") | **afetado** → `${marca}` |
| `db/test-caca-custo-producao.sh:126` | `≠` (`E2 89 A0`) | **sucesso** da F1 — núcleo do CI | **afetado** → `${FBUGVAL}` |
| `db/test-vendas_sync_cursor.sh:336` | `≠` | falha da F5 | **afetado** → `${NPS}` |
| `db/test-canaria-veredito.sh:206` | `…` | falha | já corrigido no #2472 |
| `docs/historico/README.md:210` · `falsificacao-da-canaria-no-caminho-obrigatorio.md:41` | `…` | — | falso positivo: doc citando o caso |
| `docs/superpowers/specs/2026-05-25-financeiro-funding-divida-design.md:70` | `ç` | — | falso positivo: prosa (`custo_R$_antecipação`) |

Limpos: os outros 429 `.sh` rastreados (`db` 304 · `scripts` 87 · `.claude` 36 · `connector` 2) e todo `.ts/.tsx/.js/.sql/.yml/.json/.toml/.txt` do repo.

**Prova por sítio** — a linha exata, antes e depois, executada sob `set -u` com stubs de `ok`/`bad`:

| sítio | antes · `C` | antes · UTF-8 | depois · `C` | depois · UTF-8 |
|---|---|---|---|---|
| `audit:225` | rc 0 | **rc 1, não chega ao fim** | rc 0 | rc 0 |
| `caca:126` | rc 0 | **rc 1, não chega ao fim** | rc 0 | rc 0 |
| `vendas:336` | rc 0 | **rc 1, não chega ao fim** | rc 0 | rc 0 |

Em `C`, antes e depois imprimem o mesmo texto: o conserto não muda nada onde a forma não mordia. Nos 3 arquivos o diff é só de chaves (`git diff --word-diff`), `bash -n` rc 0, detector com 0 casos e prova de leitura, shellcheck rc 0.

⚠️ A primeira rodada dessa conferência mentiu: no zsh do Bash tool, `F="a b c"; perl … $F` passa UMA palavra só (o zsh não divide expansão sem aspas), o perl não abriu arquivo nenhum e o detector imprimiu `0`. O `0` só virou dado quando cada arquivo passou a imprimir também uma marca de leitura (`perl=LIDO`).

## O gate

`scripts/shell-variavel-colada-gate.ts` — textual; roda no CI pelo vitest (`scripts/shell-variavel-colada-gate.test.ts`, 31 casos, job `testes`). CLI: `bun scripts/shell-variavel-colada-gate.ts` → exit 0 limpo · 1 violação · 2 não conseguiu medir.

- **Assinatura larga, de propósito.** `$` + nome + `\P{ASCII}` sobre a fonte limpa. O conserto (`${NOME}`) é inócuo em todo contexto em que o bash expande, então não vale adivinhar quais bytes a libc de cada máquina chama de letra. `$$NOME…` (PID + texto) fica de fora; posicional e especial (`$1…`, `$@…`) não têm nome.
- **A única isenção é comentário, e quem decide é `removerComentariosShell`**, o stripper compartilhado (`gates-textuais-cegos.md`): `#` dentro de aspas é dado. Aspas simples, `$'…'` e heredoc citado **contam** — o bash de agora não expande, mas o texto costuma alimentar um bash depois (`trap '…' EXIT`, `bash -c '…'`, `cat > fake.sh <<'EOF'`).
- **Universo: `db/`, `scripts/`, `.claude/` inteiro e `connector/`** — 432 `.sh`. Não só `.claude/hooks/` (19): `.claude/skills/` tem 17 e `connector/sayersync/` tem 2 (release e falsificação do conector Go, ambos com `set -u`). `.sh`/`.bash`, e sem extensão com shebang de `sh`/`bash`. `.claude/worktrees/` sai por CAMINHO (no checkout principal guarda cópias inteiras do repo), não por nome. E o universo é conferido **por fora do walker**: todo `.sh`/`.bash` do `git ls-files` tem de ter sido lido — raiz nova com shell fica vermelha, não invisível.
- **Alarmes do stripper:** os quatro de `diagnosticarShell` (fração, bloco contíguo, sub-limpeza, heredoc aberto até o EOF), com os pisos **importados** de `psql-ro-error-stop-gate.ts` — mesma calibração, mesmo corpo.
- **Pisos, medidos:** por raiz (`db` 250/307 · `scripts` 70/87 · `.claude/hooks` 15/19 · `.claude/skills` 12/17 · `connector` 1/2), expansões `$NOME` 25.000/31.252, e **forma certa vista** (`${NOME}…`) 14/18. Este último é o eixo que nenhum alarme de stripper cobre: se a leitura perder o não-ASCII (encoding errado, flag `u` removida), as violações zeram junto, e só ele diz que o zero não foi mérito.

## Falsificação

Tudo com o código **commitado antes** (`7b99acd9e`), restauração por CÓPIA provada por `sha256` + `git diff --quiet` (nunca `git checkout`) e marca ASCII sem `-i`.

**Linha de base, na mesma invocação:** CLI `exit 0` com a marca nos dois locales — `charmap` sondado, `US-ASCII` e `UTF-8`, não só `LC_ALL` setado — e vitest `31 passed (31)`.

**Reintrodução em arquivo REAL, uma por raiz:**

| caso | arquivo | `C` | `pt_BR.UTF-8` |
|---|---|---|---|
| desfazer o conserto (`${FBUGVAL}≠250` → `$FBUGVAL≠250`) | `db/test-caca-custo-producao.sh` | exit 1, aponta `:126` | exit 1, aponta `:126` |
| `echo "sabotagem $x…"` anexado | `.claude/hooks/bash-contexto-nudge.sh` | exit 1, `:131` | exit 1, `:131` |
| idem | `.claude/skills/doc2md/doc2md.sh` | exit 1, `:73` | exit 1, `:73` |
| idem | `connector/sayersync/falsifica-sentinela.sh` | exit 1, `:118` | exit 1, `:118` |
| `$x…` dentro de heredoc CITADO | `scripts/check-claude-md-budget.sh` | exit 1, `:228` | exit 1, `:228` |
| controle: `$x…` só em comentário de linha | `db/test-caca-custo-producao.sh` | exit 0 | exit 0 |
| controle: `$x…` em comentário de fim de linha | idem | exit 0 | exit 0 |
| controle: `${x:-}…`, com chaves | idem | exit 0 | exit 0 |

No CI quem julga é o vitest: sob o 1º caso ele deu `2 failed | 29 passed (31)` — exatamente os dois casos do corpo real ("nenhuma expansão…" e "o fiscal MEDIU…"), e nenhum outro. 8 casos, 0 falhas, 15 s com o controle; `git status` vazio no fim.

**Camada a camada — `scripts/mutcheck.d/shell-variavel-colada.mut`:** 20 mutações, **20 pegas**, 0 sobreviventes, 0 inválidas, controle+ ✓ (43 s; a baseline compila e passa). Cobrem o detector cego, o stripper ignorado, a regex LOCAL no lugar do stripper compartilhado, o `$$`, o shebang, a raiz `connector/`, `.claude/worktrees` por caminho e por nome, os quatro alarmes e a régua do script curto, cada piso e os códigos de saída. O `--seco` deu 20/20 padrões cirúrgicos. Uma lacuna apareceu ANTES da rodada, ao desenhar as mutações: nenhum caso punha as expansões abaixo do piso, então desligar esse piso passaria verde. O caso entrou no teste, e a mutação correspondente passou a ser pega.

## Assinatura para varredura futura

```bash
bun scripts/shell-variavel-colada-gate.ts   # o gate; exit 0 esperado (432 .sh em 2026-09-14)
```

Para o repo inteiro, inclusive o que o gate não lê: a assinatura em modo byte da seção "Varredura", sobre `git ls-files`. Medido ao fechar este registro: **41 hits, 0 em `.sh`** — 18 em `.md` que CITAM a forma (este arquivo incluso) e 23 no próprio gate e no teste dele, que a carregam como dado. Hit em `.sh` é a classe voltando; hit em qualquer outro lugar, confira se é citação.

(Eu tinha escrito "todo hit fora de `.sh` é doc" antes de medir. Os 23 do gate e do teste desmentiram a frase — mesma família da conferência que mentiu lá em cima.)

## O que fica de fora, e por quê

- **Shell embutido em outra linguagem** — string de `.ts` passada a `spawnSync('bash', …)`, `run:` de `.github/workflows/*.yml`, `scripts` do `package.json`. Fora do universo do gate; a varredura acima deu 0 ocorrências neles. Workflow roda em Linux, onde a forma não morde.
- **zsh — o shell do terminal do founder e do Bash tool — tem regra MAIS ESTREITA.** Medido no zsh 5.9 sob `LC_ALL=pt_BR.UTF-8`: `$marca…` passa (`[X…]`, porque `…` não é letra), mas `$marcaé` lê `marcaé` como nome (vazio; com `setopt nounset`, `marcaé: parameter not set`). No zsh só LETRA acentuada gruda. Comando entregue ao founder com `$var` colado a letra acentuada tem o mesmo problema, e chaves resolvem igual.
