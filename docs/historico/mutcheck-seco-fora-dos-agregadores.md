# O gate que bloqueia o PR e não tem nome de comando — `mutcheck --seco` fora de todo agregador local

**Classe:** um gate do CI cuja única forma de invocação é `bash scripts/<algo>.sh` dentro do
`ci.yml`. Ele **bloqueia o merge** como qualquer outro, mas não existe como script no
`package.json` — então nenhum agregador local (`test`, `test:hooks`, `typecheck`, `lint:shell`) o
chama, e **nenhuma varredura por "o que eu rodo antes de abrir o PR?" o encontra**. A verificação
local sai verde inteira e a reprovação só aparece depois de o PR estar aberto.

É a mesma forma já registrada em [ci-testes-edge-deno.md](ci-testes-edge-deno.md) ("edge tem 5
gates no CI e nenhum cobre o outro"), aplicada a **alvos com contrato de mutação**.

## O que era (#2446, 2026-09-09)

O PR acrescentava `--no-color` a dois gates que liam a saída colorida do git — a classe de
[gate-que-le-saida-colorida.md](gate-que-le-saida-colorida.md). Quatro gates locais, verdes:
`bun run lint:shell`, `bun run typecheck`, `bun run test`, `bun run test:hooks`. O CI reprovou.

Os steps vermelhos do run (`gh run view`, job → step):

```
JOB: mutation-check
  STEP FALHO: mutcheck — contratos de cobertura money-path (.mut)
JOB: gates-e-falsificacao
  STEP FALHO: Contratos de mutação ainda cirúrgicos (mutcheck --seco, introduzidos por ESTE diff)
JOB: validate
  STEP FALHO: Todos os jobs passaram? (exige 'success' POSITIVO de cada um)
```

E o job completo, no mesmo run, nomeia o culpado (e é 1 em 25):

```
mutcheck-all: ✗ 1/25 contrato(s) com problema:
  - scripts/mutcheck.d/pr-duplicata-guard.mut (exit 1)
(divergência = teste perdeu poder; INVÁLIDO = .mut stale após refactor — atualize o .mut)
```

Quem **barrou** foi o `--seco`: `gates-e-falsificacao` está em `validate.needs` (os 5 jobs
esperados), e `mutation-check` está **fora por desenho** — informativo. Os dois caem juntos pela
mesma causa, mas só um decide o merge. Ler só o job completo (o de nome óbvio) leva à conclusão
errada de que a reprovação não bloqueia.

## A mecânica medida

`scripts/mutcheck.d/pr-duplicata-guard.mut` ancorava uma mutação no **texto literal** do fonte:

```
- PEGA | diff de conteudo perde a merge-base | s{git diff "\$mb" \$alvo -- "\$f"}{...}
+ PEGA | diff de conteudo perde a merge-base | s{git diff --no-color "\$mb" \$alvo -- "\$f"}{...}
```

Ao acrescentar `--no-color` ao hook, o padrão deixou de casar **qualquer** linha. E **padrão que
não casa não mede nada**: o gate classifica como contrato ambíguo e reprova — mesma severidade de
casar demais (padrão que pega mais de uma linha, o caso que envenenou a main no #2380). O contrato
não some nem grita; ele fica apontando para um texto que não existe mais, medindo zero.

A correção é reancorar o padrão no texto atual. **Reancorar é a hora do risco**: o `--seco` volta
ao verde assim que o padrão casa de novo — e casar não é pegar. Só o mutcheck **completo** prova
que a mutação continua sendo capturada pela suíte. No #2446: **18 mutações, 18 pegas, 0
sobreviventes**.

> **Os dois modos não se substituem.** `--seco` (perl+diff; ~25s medidos aqui para os 25
> contratos) prova que os padrões são
> **cirúrgicos** — casam exatamente uma linha. O mutcheck **completo** (minutos, roda a suíte)
> prova que a mutação ainda **morre**. Verde no seco com o completo não-rodado significa "o
> contrato aponta para algum lugar", não "o contrato tem dente". O cabeçalho do
> `mutcheck-seco-gate.sh` diz isso; vale repetir aqui porque é exatamente o passo que se pula
> depois de consertar a âncora e ver verde.

## Por que nenhum agregador local pega

Medido: o **único** invocador de `scripts/mutcheck-seco-gate.sh` no repo é o `ci.yml`. Não há
entrada no `package.json`, e a causa é estrutural — o próprio `bun run exclusividade` já a nomeia,
na lista de bloqueantes que ele não consegue contar:

```
5 step(s) bloqueante(s) FORA da conta por nao invocarem script (sem nome de comando, o motor
nao sabe roda-los):
  - gates-e-falsificacao: Contratos de mutação ainda cirúrgicos (mutcheck --seco, ...)
    $ bash scripts/mutcheck-seco-gate.sh origin/${{ github.base...
```

Ou seja: a invisibilidade não é descuido de quem esqueceu de rodar — é uma **propriedade do step**,
já medida e relatada por outro gate. Um agente que monta a lista de verificação local a partir do
`package.json` (o caminho natural) **nunca** vê este gate.

## O que trava a recaída

**Regra:** tocou um arquivo que é `@src:` de algum `scripts/mutcheck.d/*.mut` → rode, antes de
abrir o PR:

```bash
bash scripts/mutcheck-seco-gate.sh origin/main
```

Custa ~25s no caminho feliz (não paga a comparação com a base enquanto o HEAD está limpo). Que
arquivos são esses — 25 contratos, hoje:

```bash
sed -n 's/^# @src: //p' scripts/mutcheck.d/*.mut     # a lista autoritativa, sempre atual
```

A superfície não é exótica: **7 hooks** de `.claude/hooks/` (os guards de PR/migration/heavy), 4
scripts de `scripts/` (`onde-parei.sh`, as três sondas), **10 helpers de `src/lib/`** — sete deles
em `src/lib/financeiro/`, money-path — e 4 arquivos de `supabase/functions/`. Editar qualquer um
deles é rotina; é por isso que a recaída é barata.

E, quando o seco acusar: **reancore e rode o completo**. O comando de cada alvo está no cabeçalho
do próprio `.mut` (alvo shell precisa de `MUTCHECK_TEST_CMD`/`MUTCHECK_COMPILE_CMD`, senão o
mutcheck roda vitest num hook e o baseline nasce vermelho).

## Aresta conhecida (não fechada aqui)

A contramedida estrutural seria dar **nome de comando** ao gate — um script no `package.json`
invocado pelo `ci.yml` —, o que o tiraria da lista de opacos do `exclusividade` e o tornaria
alcançável por qualquer varredura. Não foi feito nesta entrega: mexer no par `package.json` +
`ci.yml` reacende `exclusividade`, `gates:frescura` e a matriz `defeito × gate`, e isso é entrega
própria, com medição própria — não rodapé de um registro de lição. Fica anotado como candidato,
com o dado que o justifica: **são 5 steps bloqueantes opacos**, não um.

> Nota lateral, já a favor do gate: o `--seco` acaba de exibir um defeito que **só ele** pegou —
> exatamente a moeda que [custo-de-gate-medido-beneficio-nao.md](custo-de-gate-medido-beneficio-nao.md)
> passou a cobrar de todo gate. Ele não aparece na matriz porque a matriz indexa gates por nome de
> script, e este não tem — a mesma causa raiz da aresta acima.

## Por que esta lição NÃO virou bullet no CLAUDE.md (medido, não presumido)

A entrada natural seria uma linha em "⚠️ Armadilhas recorrentes" — é regra de **antes de agir**,
que é o que aquela seção carrega. Não coube, e o motivo é numérico:

| medida | hoje | com a linha (85 palavras) | quem resolve |
| --- | --- | --- | --- |
| seção Armadilhas | 1226 / 1226 | **1311 / 1226** | `--gerar-baseline` (legítimo, fica no diff) |
| arquivo inteiro | 2597 / **2600** | **2682 / 2600** | ninguém: `MAX_WORDS` é constante do script |

O `--gerar-baseline` re-fixa o teto **de seção**; o teto do **arquivo** (`MAX_WORDS=2600` em
`scripts/check-claude-md-budget.sh`) é hard-coded e existe declaradamente para "barrar o diário".
Com 3 palavras de folga global, qualquer bullet útil estoura — e as duas saídas restantes são
decisão do founder, não rodapé de um registro: **subir o `MAX_WORDS`** (mudar a política do gate)
ou **abrir espaço movendo armadilha para `docs/agent/`** (faxina dedicada, na linha da triagem de
[triagem-armadilhas-por-mecanismo.md](triagem-armadilhas-por-mecanismo.md)).

Fica aqui para a próxima sessão não repetir a tentativa às cegas: o CLAUDE.md está **saturado**, e
descobrir isso custa uma medição que já está feita acima.
