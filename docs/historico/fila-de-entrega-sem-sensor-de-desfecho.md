# A fila de ENTREGA não tem sensor de desfecho — 41 branches com trabalho e sem PR

> Diagnóstico medido em **2026-09-07** (`gh`, `git`, `wt:status`), a pedido do founder ("como podemos
> resolver esses problemas de fila?"). **Evidência de contagem tem validade — re-meça antes de agir
> sobre qualquer número daqui.** Os comandos de re-medição estão no fim, e são o item mais útil deste doc.

## O pedido, e por que ele quase virou outra coisa

"Fila" neste app é ~10 coisas: `FilaDoDia`, `FilaDeCaca`, a fila do plano tático
([fila-plano-tatico.md](fila-plano-tatico.md)), a de prontidão da reposição
([fila-de-prontidao-e-sensor-de-derivada.md](fila-de-prontidao-e-sensor-de-derivada.md)),
`analytics_outbox`, `score_recalc_queue`, `afiacao_os_sync_fila`, a fila de aprovação da KB.
Antes de perguntar, as filas TÉCNICAS foram medidas e estavam **limpas**: outbox 277 linhas
100% drenadas, `score_recalc_queue` e `afiacao_os_sync_fila` vazias, `visit_score_recalc_queue`
37.919 linhas 100% processadas com 0 erro. O founder queria a fila de **entrega** — PRs e sessões.

## O que foi medido

**Máquina** (M2 8GB, no instante da medição):

| Sinal | Valor |
|---|---|
| RAM disponível | 2,0–2,2 GB de 8 |
| Swap em uso | **4,5 → 5,9 GB** (subiu durante a própria sessão) |
| Worktrees com branch | **85** (667 MB de `node_modules` cada) |
| Sessões Claude vivas | **44** · 185 pastas de projeto, **134 órfãs**, 427 transcritos |
| Processos órfãos | **7** a 60–83% de CPU por ~52 min |

**Fila de trabalho:**

| Fato | Valor |
|---|---|
| Branches com commit **e sem PR** | **41** |
| …paradas há **≥7 dias** | **25** (a mais velha há **92 dias**) |
| Pior caso | `fu4f-fase3-product-costs` **22 commits** · `sayerlack-captura-precos-fase1` **18 commits**, 51 dias |
| Worktrees cuja branch **já está mergeada** | **41** (lixo puro: RAM, disco, ruído no `wt:status`) |
| PRs abertos | 5 — um deles (#2093) parado há **227h**, `CONFLICTING` |
| Vazão | **~4 PRs/dia**; a main recebe **60–65 commits/dia** nos picos |

## O diagnóstico

**Lei de Little:** WIP 41 ÷ vazão 4/dia ⇒ lead time ≈ **10 dias** — que é exatamente o observado
(25 branches paradas ≥7 dias). **Não é problema de velocidade: é WIP sem teto e sem drenagem.**
E branch parada envelhece contra uma main de 60 commits/dia ⇒ conflito garantido.

⚠️ **Uma medição inicial estava errada e vale registrar o erro:** "CI com 36% de falha (8 em 22
runs)". Das 14 falhas nos 60 runs seguintes, **11 eram o mesmo passo** (`mutcheck`), de uma janela
de 2h que os PRs #2227/#2232 já haviam consertado. A taxa real depois do fix: **1 em 26 (~4%)**.
Medir uma janela que contém um incidente e chamar isso de taxa é fabricar tendência a partir de
um evento — a régua é a janela DEPOIS do conserto conhecido.

## O vão: nenhuma ferramenta mede "trabalho commitado sem desfecho"

Existe toolkit para quase tudo — e ele passa exatamente ao lado disto:

| Ferramenta | O que enxerga | O que NÃO enxerga |
|---|---|---|
| `wt:status` | RAM, disco, `node_modules`, órfãos de CPU | se há trabalho não entregue |
| `wt:orfas` | sessão cujo **worktree sumiu** (cruza com `gh pr list`) | worktree que **existe**, com commit e sem PR |
| `wt:reap` / `wt:clean` / `wt:prune` | processos, `node_modules`, worktree de conversa excluída | idem |
| `onde-parei.sh` | o estado de **uma** sessão | a fila inteira |

As 41 branches caem no vão entre `wt:status` e `wt:orfas`. É a MESMA classe de
[fila-plano-tatico.md](fila-plano-tatico.md) (533 planos gerados, zero desfecho) e de
[fase-sem-sinal.md](fase-sem-sinal.md) — só que aplicada ao processo de entrega do próprio repo:
**a fila gera, ninguém drena, e não há sensor sobre o DESFECHO.**

## O custo, demonstrado no mesmo dia

Destravar o **#2093** (parado 227h por um conflito de 2 linhas) custou **4 rodadas de re-merge** —
a main mergeou por cima 3× durante o conserto — e revelou **4 defeitos latentes** que só apareceram
porque cada correção destravava a seguinte:

1. Conflito de 1 token no `test:hooks`.
2. **O gate dependia da versão do shellcheck do runner** — 0.9.0 no CI × 0.11.0 local: **108 × 0**
   achados, 86 deles SC2317 (falso-positivo notório da 0.9.0). Corrigido pinando a versão, não
   baixando a severidade. Gate cujo veredito depende do runner não é gate.
3. `## Stack` do CLAUDE.md estourou o teto por 1 palavra.
4. **O caso que provava o *fail-closed* do gate ficava VERDE no Ubuntu**: simulava "shellcheck
   ausente" por DIRETÓRIO (`PATH=/usr/bin:/bin`), premissa válida no macOS (homebrew) e falsa no
   runner, onde o apt instala em `/usr/bin`. O caso aprovava a si mesmo. Corrigido para simular
   por SÍMBOLO, com asserção positiva de que o sandbox realmente não resolve o binário.

O nº 4 é a lição transferível: **teste de fail-closed escrito e validado num só SO herda a topologia
daquele SO.** Se a simulação de ausência depende de ONDE o binário mora, ela é verdadeira só na
máquina de quem a escreveu.

## Como re-medir (o item perecível deste doc)

```bash
# branches com commit e SEM PR, por idade do último commit
gh pr list --limit 100 --json headRefName --state open | jq -r '.[].headRefName' > /tmp/pr-branches.txt
git worktree list --porcelain | awk '/^branch /{print substr($2,12)}' | while read -r b; do
  git merge-base --is-ancestor "refs/heads/$b" origin/main 2>/dev/null && continue   # já mergeada
  grep -qx "$b" /tmp/pr-branches.txt && continue                                     # já tem PR
  echo "$(( ($(date +%s) - $(git log -1 --format=%ct "refs/heads/$b")) / 86400 ))|$(git rev-list --count origin/main..refs/heads/$b)|$b"
done | sort -rn

# worktrees cuja branch JÁ está mergeada (descartáveis)
git worktree list --porcelain | awk '/^branch /{print substr($2,12)}' \
  | while read -r b; do git merge-base --is-ancestor "refs/heads/$b" origin/main 2>/dev/null && echo "$b"; done | wc -l

# vazão real (merges/dia) — o denominador da Lei de Little
git log origin/main --since=14.days --format='%ad' --date=short | sort | uniq -c
```

⚠️ **Duas armadilhas de shell atingidas ao medir isto** (a classe está em
[evidencia-positiva-shell.md](evidencia-positiva-shell.md)): em **zsh**, `git show $sha:caminho`
sem chaves faz o `:s` virar MODIFICADOR (`bad substitution`) e a contagem sai **0** — zero
fabricado, não medido; use `"${sha}:caminho"`. E um `grep -c` de padrão com `$` devolveu 0 para
texto que existia — a medição boa foi refeita em Python. **Contagem que sai 0 num shell merece um
segundo eixo antes de virar conclusão.**

## Lição

**Fila sem sensor de desfecho acumula em silêncio, e o custo não aparece na fila — aparece no
conserto.** O que fica caro não é a branch parada; é que ela envelhece contra uma main veloz, e
quando alguém finalmente a empurra, paga N rodadas de re-merge e descobre os defeitos que o tempo
plantou. Medir "quantos itens entraram" é fácil e inútil; o que decide é **quantos saíram, e há
quanto tempo o mais velho espera**.
