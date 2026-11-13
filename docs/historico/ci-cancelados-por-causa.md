# CI: runs de PR cancelados, por causa (2026-11-12) — sem corte grátis

> Programa "push→merge mais rápido". Pergunta: 15% dos job-min de 11–12/11 foram de runs de PR
> `cancelled`. Quem causou o push que cancelou cada um, e qual é o corte da causa dominante?
> Antecessor: [disciplina-de-push.md](disciplina-de-push.md) (fatia E, regra sem máquina de 09/11).

## Resposta curta

**"Cancelled" não quer dizer "atropelado por push".** Desde a fatia B (#3783), o job `fail-fast`
cancela o PRÓPRIO run quando um job não-SQL reprova. Esse run sai com `conclusion=cancelled`,
igual ao run atropelado. Na janela, **15 dos 24 cancelados (65% dos job-min) foram o fail-fast
funcionando**, sobre um run que já estava vermelho. Só **9** foram cancelados por push de verdade,
espalhados por 5 causas de 1 a 3 casos cada. Nenhuma domina, e todas já têm regra em
`docs/agent/worktrees.md` §Disciplina de push. Não há corte grátis que valha uma mudança agora.

## Janela e método

- `ci.yml`, `event=pull_request`, de 10/11 12:01Z a 12/11 03:41Z: **102 runs de PR, 24 `cancelled`,
  2.603 job-min** (Σ `completed_at − started_at` dos jobs de cada run).
- **Quem cancelou:** se o último job do run terminou ANTES do run seguinte do mesmo branch ser
  criado, ninguém atropelou e foi autocancelamento. Se terminou DEPOIS, foi o push (o
  `concurrency: cancel-in-progress` derruba tudo no instante do push novo).
- **Causa do push:** `compare/<head-cancelado>...<head-seguinte>`: commits, arquivos, se há merge
  commit, se o branch divergiu.
- **Autor:** todos os commits são `LucasSardenbergL`, porque as sessões e o Auto-fix empurram como
  o founder. Nenhum commit "Changes" do bot do Lovable e nenhum `update-branch` do GitHub (a
  mensagem seria "Merge branch 'main' **into** X"). Os 3 merges são `git pull` local
  ("Merge branch 'main' **of** https://…").

## Tabela de causas

| Causa | Runs | Job-min | % dos cancelados | Corte |
|---|---:|---:|---:|---|
| **A. Autocancel do `fail-fast`** (run já vermelho) | 15 | 1.690 | 65% | já é o corte (ver abaixo) |
| B1. Merge da `main` no branch com CI em voo | 3 | 326 | 13% | regra 4 (já existe) |
| B2. Push de conserto sobre vermelho, antes do corte | 2 | 266 | 10% | regra 2 (já existe) |
| B3. Push só de docs com CI em voo | 2 | 162 | 6% | regra 3 (já existe) |
| B4. Push de código sem vermelho (commits não agrupados) | 1 | 91 | 3% | regra 1 (já existe) |
| B5. Reescrita do branch (WIP/divergiu) | 1 | 39 | 1% | — |
| **Total** | **24** | **2.603** | | |

Detalhe dos 9 de push (B):

| Branch | Job-min | Push após | O que veio |
|---|---:|---:|---|
| `provas-5x3` | 152 | 14,4 min | provas-sql (5) já vermelho + conserto + `git pull` da main (B1) |
| `v9-e21-sonda-materializacao` | 133 | 17,7 min | `git pull` da main, sem vermelho (B1) |
| `v9-diagnostico-banco` | 41 | 12,9 min | o MESMO `git pull` da main, no mesmo minuto (18:21Z) (B1) |
| `v9-e20-pgdg-so` | 154 | 16,8 min | experimento + revert no próprio PR (E20), vermelho em provas-sql (B2) |
| `v9-e20-pgdg-so` | 113 | 5,4 min | conserto de 1 arquivo sobre `testes` vermelho, antes do fail-fast (B2) |
| `ci-fatiar-jobs-6min` | 128 | 5,2 min | só `docs/historico/*.md` (B3) |
| `radar-j-cpf-formatado` | 34 | 2,6 min | só `docs/historico/*.md` (B3) |
| `clientes-mei-cpf-mascarado` | 91 | 10,4 min | 4 commits (feat + wip + 2 docs) em pushes separados (B4) |
| `v8-lote4-7-docs` | 39 | 8,7 min | "Work in progress" + branch divergido (B5) |

## Por que a causa A não tem corte grátis

Nos 15 autocancelamentos, entre o 1º job vermelho e o corte passaram de **0,9 a 6,6 min**. Nessa
janela queimaram **636 job-min**: 369 nas partes do `provas-sql` e 267 nos jobs não-SQL. Os outros
~1.050 job-min são do trecho ANTES da 1ª falha. Eles são o preço do desenho paralelo: as provas
começam junto com os gates para não alongar o caminho do PR verde.

As alternativas custam latência ou qualidade:

- **Cortar no 1º vermelho em vez de esperar os 5 não-SQL:** economizaria uma parte dos 636 job-min.
  Mas o autor veria só a 1ª falha, e cada push extra de "agora a 2ª falha" custa um run inteiro
  (~100+ job-min). O desenho de esperar todos (comentário do job `fail-fast` no `ci.yml`) é
  deliberado. Sem medida de quantas vezes um run tem ≥ 2 jobs não-SQL vermelhos, o saldo é incerto.
- **`provas-sql` com `needs:` dos gates baratos:** soma ~7 min ao caminho crítico de TODO PR verde
  (71 de 102 nesta janela) para poupar job-min dos vermelhos. Isso piora o push→merge, que é a
  métrica do programa.
- Qualquer das duas mexe no `ci.yml`, que a sessão `ci-main-cede-a-vez` está editando. Fica
  registrado aqui como candidata para quando houver a medida acima, não como corte agora.

### Medida e experimento (12/11, mesma sessão): o corte no 1º vermelho também não é grátis

- **A medida pedida acima:** em 13 dos 14 autocancelamentos com vermelho fora das provas SQL,
  houve **um job vermelho só**. Só 1 (`v9-e20-pgdg-so`: `testes` e depois `mutation-check`)
  mostrou uma 2ª falha durante a espera. O motivo "o autor ver TODAS as falhas não-SQL" quase
  nunca se paga: a espera custou ~636 job-min para revelar 1 falha extra.
- **O corte óbvio, que tem um defeito:** cada job faria `gh run cancel` num passo `if: failure()`.
  O experimento descartável `exp-cancel-no-vermelho` (run 43288551883, branch sem PR, apagado
  depois) usou 4 jobs: A falha e cancela; A2 falha, cancela e espera 15 s; B é lento; C falha
  sozinho em paralelo. **Os 4 terminaram `cancelled`**, inclusive o A, que falhou primeiro, e o
  C, que nem chegou a reportar a própria falha. O job que reprovou deixa de aparecer como
  `failure`: o `validate` e o Auto-fix passariam a ver "testes: cancelled" e teriam de abrir o
  log para achar a causa. Isso gera mais ciclo de push, que custa um run inteiro (~100+ job-min)
  e é exatamente o que este programa quer cortar.
- **Alternativa de vigia em paralelo** (um job consultando a API até o 1º `failure` e então
  cancelando): o job que reprovou terminaria antes, como `failure`. Mas a vigia ocupa um runner
  em TODO run de PR, inclusive nos verdes. São ~7 job-min × ~100 runs, mais ou menos o mesmo que
  ela economiza, e um slot a menos no teto de 40. E é máquina nova sem incidente.
- **Decisão:** o `fail-fast` fica como está. Se um dia a espera passar a ser medida em latência
  de PR (fila), e não em job-min, a vigia volta à mesa com esse número.

## Por que a causa B não tem corte grátis novo

A regra de 09/11 está funcionando. Na medição de 06–09/11 (236 runs, ~4 dias), houve **22** pushes
de conserto após vermelho e **17** pushes só de docs. Nesta janela (102 runs, ~40 h), houve **2** e
**2**. A queda é maior que a do volume de runs, e é o sinal que o "Como medir depois" de
[disciplina-de-push.md](disciplina-de-push.md) pedia. O resto são casos isolados que já
violam regras escritas, sem padrão novo para encostar. Um guard (hook que barra push com CI em
voo) seria máquina meta nova sem incidente citado ([maquinas-meta.md](../agent/maquinas-meta.md)).
CI lento não é incidente.

Um padrão vale nota: **B1 duplo às 18:21Z**. Duas sessões fizeram `git pull` da MESMA `main` no
mesmo minuto, com CI em voo e sem vermelho. É a regra 4 ("ficar em dia não é motivo") sendo
ignorada em paralelo. O custo foi 174 job-min. Não há corte além da regra.

## Lição de medição (vale para o próximo programa)

**`conclusion=cancelled` mistura duas coisas opostas**: o desperdício (push atropelou um run
saudável) e a economia (o fail-fast cortou um run já perdido). Medir "job-min de runs cancelados"
como desperdício superestima o problema em ~3× nesta janela e manda otimizar o lugar errado. O
critério correto é `fim_do_run < criação_do_run_seguinte` ⇒ autocancelamento. Scripts da análise
(reprodutíveis com `gh api`): `runs.json` → `jobs` por run → `compare` entre heads.
