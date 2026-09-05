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
