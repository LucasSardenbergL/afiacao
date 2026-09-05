# `psql-ro` lido de `-f`/stdin sai 0 com ERROR — a FORMA de invocação decide o veredito

Medido 2026-09-05. O wrapper `~/.config/afiacao/psql-ro` não passa `-v ON_ERROR_STOP=1`, e o psql
só devolve exit ≠ 0 por conta própria na forma `-c`. As três formas, contra o wrapper de prod:

| invocação | rc com SQL quebrado |
|---|---|
| `psql-ro -c "<sql>"` | **1** — protegido |
| `psql-ro -f arq` · `psql-ro < arq` · heredoc | **0** ⚠️ o ERROR sai só no corpo |
| `psql-ro -v ON_ERROR_STOP=1 < arq` | **3** — protegido |

**`PGOPTIONS` não serve** para consertar isto: o pooler o ignora (o próprio cabeçalho do wrapper
avisa). `ON_ERROR_STOP` é variável do psql, client-side — tem de ir como `-v` na chamada.

## O alcance real: 1 de 14

A varredura por "menciona `psql-ro`" é inútil (200+ arquivos, quase todos comentário). O filtro que
vale é **quem executa** o wrapper — 14 consumidores. Treze usam `-c` e reprovam, provado um a um
sob um wrapper sabotado: `edges-pendentes.sh` rc=2 (fail-closed, "MECÂNICA NÃO CONFIÁVEL"),
`verify-edge-eco`/`-escrita` rc=3, os 5 `db/audit-*.ts` + `scripts/pendencias-deploy.ts` rc=2
(`execFileSync` lança), `scripts/probe-censura.sh` rc=70. `db/refresh-snapshot.sh` usa `-c` com
`|| true`, mas o erro vira lista vazia que estoura a paridade bidirecional — classificado por
leitura, **não executado** (o run completo faz `pg_dump` de prod).

O décimo quarto era `db/audit-anon-dml-bypass.sh` — um **linter de segurança de bypass de RLS** —
com `-tA -f "$SQL_FILE"` e `|| exit 2`. Com a query sabotada ele imprimia

    ✅ LIMPO: nenhuma view atualizável permite DML de anon/authenticated bypassando RLS.

e saía **0**. O ERROR ia para o corpo, nenhuma linha casava `HIT|`, e zero-hits virava veredito:
falha ABERTA, família "ausente ≠ zero" (`docs/agent/money-path.md`), na guarda que existe
justamente para vigiar escrita bypassando RLS.

## O dente era cego porque provava a QUERY, não o SCRIPT

`db/test-audit-anon-dml-bypass.sh` já tinha detecção + falsificação da query — mas rodava-a por
`P()`, que **já traz `-v ON_ERROR_STOP=1`**. Um harness que reimplementa a chamada em vez de
executar o alvo herda as proteções do harness e não vê as que faltam no alvo. O bloco novo (C)
executa o `.sh` de verdade sob um wrapper que imita o psql-ro de prod (sem `ON_ERROR_STOP`,
ecoando os `SET` do `psqlrc-ro`).

## A rede de falsificação nasceu cega — e isso é a metade mais útil da lição

Correção em duas camadas: `-v ON_ERROR_STOP=1` **e** um marcador `FIM|` no fim da query, exigido
pelo `.sh` (pega a query trocada/truncada que roda "bem", e é imune a locale — ao contrário de um
`grep '^ERROR'`, já que em pt_BR o psql traduz parte da mensagem).

Primeira rede: C1 caminho feliz, C2 SQL que falha, C3 sem marcador. **Sabotar o `ON_ERROR_STOP`
deixou tudo VERDE.** Porque o marcador está no fim da query: se o SQL morre antes, o marcador
também não sai, e a camada (2) recusa sozinha — subsumindo a (1) em todos os casos testados.

Daí a regra: **em defesa em profundidade, cada camada precisa de um caso onde ela é a ÚNICA que
pode reprovar.** É C4 — marcador ANTES do statement que falha: o guard textual passa, e só o exit
code separa "rodou inteira" de "morreu no meio". Com C4, S1→❌C4 e S2→❌C3, nos dois locales.

**Corolário para qualquer commit de defesa em profundidade:** contar casos verdes não prova nada;
sabote **uma camada de cada vez** e exija que ao menos um caso fique vermelho *por causa dela*. Uma
camada cuja sabotagem não produz vermelho ou é redundante, ou o teste não a alcança — e as duas
respostas mudam o commit.

---

## O sentinela (2026-09-05, segunda metade): 13 de 14 estavam protegidos POR ACIDENTE DA FORMA

O #2167 consertou o único consumidor doente. Não consertou a classe: os outros 13 passam porque
usam `-c`, não porque alguma regra os obrigue — e nada impedia o próximo script de usar `-f`.

`scripts/psql-ro-error-stop-gate.ts` + `scripts/lib/psql-ro-error-stop.ts` são a regra. Puramente
textual (o CI não tem a credencial), varrem `db/`, `scripts/` e `.claude/`, e recusam qualquer
invocação do wrapper que leia SQL de `-f`, de `<`, de heredoc/herestring ou de `input:` sem
`-v ON_ERROR_STOP=1`. Rodam no CI por `bun run test` (vitest) e por `bun run test:falsificacao`.

### Três decisões que mudam o que o gate consegue ver

**1. O alvo é a VARIÁVEL, descoberta, não a string `psql-ro`.** Há 200+ menções a `psql-ro` no
repo e quase todas são prosa. O que executa é uma variável — e ela não tem nome fixo (`$PSQL`,
`$PSQL_RO`, `$PSQLRO`, `$AFIACAO_PSQL`, `$WRAP`, `$CONSULTA_PROD`…). Lista fixa de nomes fecharia a
porta de hoje. Então o vínculo é **descoberto no arquivo**: RHS que carrega a marca do wrapper,
alias por ponto-fixo (`W2="$W"`), e os nomes-semente do ambiente — que uma atribuição local
**refuta** (`PSQL="$PGBIN/psql"` não é o wrapper, e é assim que os ~40 harnesses de PG17 local não
viram ruído). Medido: **14 arquivos**, o mesmo censo que o histórico acima contou à mão.

**2. Faltava a camada SHELL do stripper compartilhado.** `limpeza-fonte.ts` entende JS. Um `.sh`
tem `#`, `'…'` sem escape nenhum, aspas que atravessam newline de propósito e heredoc, que suspende
toda a gramática. `src/lib/gates/limpeza-shell.ts` é a camada que faltava — e é UMA máquina que
produz a limpeza **e** a máscara de contexto, porque duas máquinas obrigadas a concordar divergem.

**3. O sensor que faltava era o de SUB-limpeza.** Os alarmes existentes (`medirPreservacao`,
`maiorBlocoDescartado`) vigiam o stripper que come demais. Esta máquina teve dois furos, e **nenhum
dos dois foi visto por eles**, porque os dois faziam o stripper limpar de MENOS:

| furo | efeito medido |
|---|---|
| `<<<` (herestring) lido como `<<` | delimitador vira `$REQ_IDS`, nunca fecha, e **o resto do arquivo inteiro** vira "corpo de heredoc" — 45 comentários sobreviveram em `edges-pendentes.sh` |
| `$(…)` dentro de `"…"` não voltando a contexto de comando | o 1º `"` pareia com o `"` de `"$input"` e tudo desanda — 30 comentários em `heavy-guard.sh` |

`comentariosSobreviventes()` é o alarme desse lado: comentário `#` que sobreviveu, **fora** de
heredoc (onde `#` é dado) e **fora** de literal de outra linguagem (o awk embutido em `'…'` de
`pipestatus-zsh-guard.sh` tem 37 comentários que devem mesmo sobreviver). Baseline medida nos 373
`.sh` do repo: **0**. Sem ele, um gate que mede fonte suja passa a medir também os 200 lugares onde
este repo DOCUMENTA o padrão proibido.

**Corolário:** todo alarme de stripper tem DOIS lados. Ter só o de sobre-limpeza é ter meia sonda —
e os furos reais desta máquina caíram, os dois, no lado que não existia.

### A rede: 20 fixtures × 2 locales × 14 camadas sabotadas

As fixtures são arquivos de verdade (`scripts/fixtures/psql-ro-error-stop/*.fixture` — extensão que
o próprio gate ignora, para ele não se auto-acusar), com a expectativa no nome, e os MESMOS bytes
alimentam o vitest e o harness de shell. Cada uma existe porque **isola uma camada**: sem
`limpo-b-forma-c` um gate que recusasse tudo passaria em todos os negativos; sem
`limpo-d-pgbin` a discriminação contra o psql local seria sorte; sem `viola-f-errorstop-desligado`
um gate que só procura o NOME da flag ficaria verde com `ON_ERROR_STOP=off`.

`scripts/test-psql-ro-error-stop.sh --falsificar` sabota **uma camada por vez** e exige vermelho por
causa dela. A sabotagem que quase escapou foi a do `<<<`: quebrá-la deixa a fixture correspondente
VERMELHA de qualquer jeito (o comentário-isca vira código e vira uma violação a mais) — o veredito
por fixture não muda. Quem a pega é o corpo REAL do repo saindo `rc=2` pelo sensor de sub-limpeza.
Daí o critério do harness ser "ficou vermelho em ALGUM lugar", e não "a fixture X inverteu": um
critério estreito demais faz a camada parecer redundante quando o que falta é onde olhar.

### Retro-validação

O gate rodado contra a versão PRÉ-#2167 de `db/audit-anon-dml-bypass.sh` (`git show <sha>^`) sai 1 e
aponta a linha 34. O fiscal pega o bug que o originou — que é o mínimo que se pede de um.
