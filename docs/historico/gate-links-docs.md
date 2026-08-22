# Gate de links de docs — `](caminho.md)` que não resolve

**PR:** gate `docs:links` (2026-08-21) · **Irmãos:** [gate-indice-docs.md](gate-indice-docs.md), [gates-textuais-cegos.md](gates-textuais-cegos.md)

## A classe

Link markdown cujo caminho relativo aponta para lugar nenhum. O markdown não valida nada: o CI fica
verde e o leitor só descobre no clique. A variante cara é o **caminho escrito a partir da raiz do
repo** dentro de um doc que não está na raiz — `](docs/historico/x.md)` num arquivo de
`docs/historico/` resolve para `docs/historico/docs/historico/x.md`. Em revisão de PR o link parece
certo: o alvo existe, o texto está certo, só o ponto de partida é outro.

**Medido (#1863):** ao editar `.claude/skills/fecho/SKILL.md` escreveu-se
`](../../docs/historico/mergeabilidade-assincrona.md)`. De `.claude/skills/fecho/`, `../../` é
`.claude/`. Os dois gates de docs ficaram verdes — `docs:indice` só confere que todo `.md` de
diretório com README tem linha no índice, `docs:citacoes` só confere citação de LINHA. Nenhum
resolve link.

**O buraco maior que isso abriu:** `.claude/skills/` são 35 arquivos, o maior corpo de instrução
operacional do projeto, e não tinham cobertura automatizada NENHUMA — `git grep -l '.claude/skills'
src/ scripts/` devolve vazio, nenhum código do repo as lê, então nada as media.

**Ao nascer o gate achou 10 links quebrados vivos na main**, todos da variante "caminho a partir da
raiz": `auditoria-ux-redesign.md` → `docs/ux-audit/*` (4), `bugs-resolvidos.md` →
`docs/superpowers/specs/*` (2), `lovable-supabase.md` → `docs/migrations-audit.md`,
`schema-security-report.md` → `superpowers/specs/*`. Todos os alvos EXISTEM, em outro caminho — a
assinatura da classe. Sobreviveram a todas as revisões humanas que passaram por esses docs.

## As decisões que valem para o PRÓXIMO gate textual

**Código é exemplo, não link — e o falso-positivo estava em INLINE code, não em cerca.** Os 5 únicos
falsos-positivos do corpus são docs que documentam o gate irmão: `gate-indice-docs.md:60` tem
`` `[a.md](b.md)` `` ilustrando a invariante "TEXTO = DESTINO". Um stripper que só entendesse ```
deixaria o gate nascer com 5 exceções permanentes — e gate que nasce com exceção nasce ignorado.

**O stripper compartilhado era a ferramenta errada, não uma reutilização esquecida.** A regra do
CLAUDE.md manda usar `removerComentarios` de `@/lib/gates/limpeza-fonte`; ele remove `//` de JS/TS e
decapitaria **todo `https://`** do corpus (267 links). O que se herda é a LIÇÃO: numeração de linha
preservada; crase casada dentro da MESMA linha (um `[\s\S]*?` engoliria dezenas de linhas a partir de
uma crase solta em prosa — o estrago de `gates-textuais-cegos.md`); cerca aberta que GRITA em vez de
descartar em silêncio.

**Fail-closed só COM VÍTIMA.** Cerca não fechada cega a medição, mas os 2 casos vivos do repo são
cerca pendurada na ÚLTIMA linha do arquivo (`2026-05-24-financeiro-a4-proxima-acao.md:841`, de 841
linhas): não escondem link nenhum. A invariante só acusa quando a cerca engoliu ao menos um link — e
a mensagem nomeia quais. Gritar sem vítima é como um gate ensina a ignorar o vermelho.

**A autoridade é o índice do GIT, não o `existsSync`.** O APFS do macOS é case-INSENSITIVE:
`](../Historico/x.md)` passa no laptop e quebra no Linux do CI e no GitHub. Um `Set` de caminhos do
`git ls-files` compara caixa de forma exata nos dois sistemas, e ainda pega o arquivo que existe no
disco de quem escreveu mas nunca foi commitado. O `existsSync` sobra só para DISCRIMINAR a mensagem
("não existe" vs. "existe no disco e não está no git") — que é o que a torna acionável.

**O achado carrega `causa`, não só prosa.** `ausente | nao-rastreado | fora-do-repo | cerca-aberta`.
Motivo concreto: o primeiro teste desta entrega quebrou porque assertava `'não está no git'` contra
uma mensagem que dizia `'NÃO está no git'`. Teste preso a texto quebra por caixa/acento sem que nada
real tenha mudado (a armadilha de caixa/acento do CLAUDE.md, aqui em JS em vez de shell).

## Falsificação (o que provou que não é teatro)

Commitado ANTES de falsificar (`restaurar()` costuma ser `git checkout --`). Três mutações, todas
exigindo vermelho, e um controle exigindo verde:

| Mutação | Exit |
|---|---|
| o link EXATO do #1863 em `.claude/skills/fecho/SKILL.md` | 1 — acusa `.claude/docs/historico/…` |
| `](docs/ux-audit/01-inventario.md)` de `docs/historico/` (a classe dos 10) | 1 — e sugere `../ux-audit/01-inventario.md` |
| `](../Historico/…)` com caixa errada (o que o APFS deixaria passar) | 1 — "existe no disco mas NÃO está no git" |
| controle: tudo restaurado | 0 |

## Achado lateral

`scripts/docs-citacoes-gate-check.ts:111` tem um comentário afirmando que "linha dentro de ``` é
pulada" — e o código nunca implementou isso (não há estado de cerca nenhum na função). Citação
escrita como exemplo dentro de um bloco de código é cobrada como citação real. Fora do escopo deste
PR; chip aberto.
