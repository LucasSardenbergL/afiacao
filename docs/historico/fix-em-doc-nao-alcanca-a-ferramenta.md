# O fix entrou no DOC e não na FERRAMENTA — e a ferramenta é quem emite o veredito (2026-09-05)

> **A classe:** uma receita em prosa e o script que a implementa são **dois** artefatos. Corrigir a
> receita deixa a lição registrada e o comportamento **intacto** — e quando o script é o que produz
> o veredito lido por outra sessão, o fix documentado não impede nada. Aqui o intervalo entre o doc
> certo e a ferramenta errada custou um chip inteiro de verificação sobre edges **já no ar**.

## O desfecho, primeiro

> **Fechado em 2026-09-04:** o predicado mudou. `scripts/pendencias-deploy.ts` passou a aceitar as
> DUAS vias (sonda ativa **ou** eco passivo), com prova que EXECUTA o SQL num PG17 local e
> falsifica (`db/test-pendencias-deploy-eco-passivo.sh`). Na mesma janela de 6h a cobertura foi de
> 2 para 3 edges e a `analytics-outbox-drain` virou `✅ confere`. Medições e o que a via nova
> admite de novo: `sonda-eco-passivo-sem-colagem.md` §10.


Chip pedia verificar se duas edges mergeadas entre 2026-08-29T01:00Z e 05:00Z chegaram a ser
deployadas. **As duas estavam no ar, verbatim.** Nenhum deploy foi pedido ao founder.

| edge | via | evidência |
| --- | --- | --- |
| `analytics-outbox-drain` (#2094) | eco passivo do cron | 4 ticks consecutivos, o mais recente 2026-08-31 15:10:55Z: `versao=v1.1-guard-dentro-do-registro`, `fonte=b03bbf880f09…fded` |
| `generate-bundle-argument` (#2101) | sonda ativa, id 69279 | 2026-09-05 01:34:16Z, status 200: `{"ok":true,"probe":true,"versao":"v1.1-cota-ia","edge":"generate-bundle-argument","fonte":"4368540ba930…6703"}` |

Nos dois casos o `fonte` bateu **byte a byte** com `supabase/functions/_shared/sonda-fingerprints.ts`,
e `bun run sonda:fingerprint` saiu exit 0 (`✓ 40 edge(s) — mapa bate com a fonte`). Como o `fonte`
hasheia o fecho transitivo dos imports, isso prova a fatia inteira — não só `index.ts` + `versao.ts`.

## O que originou o chip: um filtro estreito num script

`bun run pendencias:deploy` classificou `analytics-outbox-drain` como
**`⚪ sem sonda na janela (ausência de dado, NÃO é ok)`** e devolveu cobertura 7/40 (18%, abaixo do
piso de 50%). A edge estava respondendo o tempo todo: cron **jobid 181**, `*/5 * * * *`, e o `jsonRes`
dela anexa `versao`/`edge`/`fonte` a **toda** resposta. Medido no mesmo instante, na janela de 6h do
`pg_net.ttl`:

```
analytics-outbox-drain | v1.1-guard-dentro-do-registro | fonte=b03bbf880f09 | probe=ausente | ticks=72
```

**72 respostas completas e verificáveis**, lidas como ausência de dado. A causa está em
`scripts/pendencias-deploy.ts`, que exige o marcador da sonda ATIVA:

```sql
AND content LIKE '%"probe"%'
...
WHERE r.c ? 'edge' AND r.c ? 'versao' AND (r.c ->> 'probe') = 'true'
```

O eco passivo **não contém** `"probe"`. Varrer pelo marcador da sonda descarta exatamente a via que
não depende de ninguém disparar nada.

## Por que o #2103 não impediu isto

Isto **já tinha sido diagnosticado**. O #2103 (`5d50adae2`) mediu a diferença — filtro `"probe"`
devolvia 4 edges, a varredura por IDENTIDADE devolvia 8 — e escreveu a previsão exata do desfecho:

> "com a query estreita a sessão concluiria *sem evidência* e pediria ao founder o deploy de edges
> money-path **já no ar**"

Nomeou inclusive `analytics-outbox-drain` entre as quatro que o filtro perdia. E aconteceu assim,
seis dias depois. O motivo é o único fato que faltava no registro: **o #2103 foi docs-only** —
1 arquivo, 59 inserções, tudo em `docs/historico/verificar-sonda-versao.md`. Corrigiu a §13.3, que é
a query que um humano cola no terminal; `scripts/pendencias-deploy.ts` nunca herdou o fix, e é ele que
roda sozinho e emite o veredito que vira chip.

**A regra:** ao corrigir uma receita que também existe como script, o fix não está completo enquanto o
script não for medido contra o mesmo caso. `git grep` do sintoma (aqui, `'probe'` como filtro) acha os
dois lugares; corrigir um e fechar o PR deixa o outro emitindo o veredito antigo — com a agravante de
que o doc corrigido faz o problema **parecer** resolvido na próxima consulta.

## O chip também é um artefato com premissas — e elas envelhecem

Duas afirmações do chip não sobreviveram à medição. Nenhuma era má-fé: são o mesmo envelhecimento que
`fatia-de-deploy-envelhece.md` descreve, aplicado ao **pedido** em vez de à fatia.

**1. "As edges vieram dos PRs #2094 e #2098."** O #2098 (`319a3de56`) não tocou
`supabase/functions/`: são 4 arquivos — uma migration, um harness `db/` e dois docs. A correção da
purga da outbox foi **DB-side**. Só o #2094 mudou a edge.

**2. As listas de arquivos estavam incompletas** — 3 arquivos onde a fatia real tem 8 e 9. É o modo de
falha do #2020 que o próprio chip citava, chegando pela porta que
`closure-de-hash-nao-e-lista-de-deploy.md` já registrou: a fatia é o **closure de imports**, não o
diff. Derivada por `fecharGrafo()`:

| edge | no chip | real | o que faltava |
| --- | --- | --- | --- |
| `analytics-outbox-drain` | 3 | 8 | `_shared/auth.ts`, `_shared/erro-mensagem.ts`, `_shared/registro-execucao.ts`, `_shared/sonda-versao.ts`, `payload.ts` |
| `generate-bundle-argument` | 3 | 9 | `_shared/anthropic.ts`, `_shared/auth.ts`, `_shared/ia-cota.ts`, `_shared/sonda-versao.ts`, `argumento-helpers.ts`, `argumento-tools.ts` |

O `_shared/ia-cota.ts` é o caso exemplar: o #2101 passou a importá-lo e o arquivo estava **inalterado
desde 2026-07-31**, logo é invisível a `--name-status` nos dois lados (`A` e `M`).

## O que funcionou, e vale repetir

**A ordem "sondar ANTES de pedir o deploy" cancelou o pedido pela segunda vez registrada.** A exceção
vale quando o bundle que se TEME estar no ar **já tinha sonda** — aí o probe não dispara fluxo real.
Provado no pai, nunca de memória:

```bash
git show 0b5662801^:supabase/functions/generate-bundle-argument/versao.ts | grep VERSAO
# export const VERSAO = "v1.0-prompt-sem-margem"   -> marcador ≠ main ⇒ sondar é seguro
```

Para `analytics-outbox-drain` o pai **não tinha** `versao.ts` (era pré-sonda), então a sonda ativa
teria disparado o dreno real — e não foi preciso: o eco passivo do cron respondeu de graça. A escada
barata → cara continua sendo eco passivo → escrita de aplicação → sonda ativa, e vale percorrê-la
inteira antes de gastar um round-trip com o founder.

A via da **escrita de aplicação** foi tentada para `generate-bundle-argument` e devolveu
`exit 2 INDETERMINADO` com `CONTROLE_CRUZADO_OK` (3 de 4 vizinhas em zero): ninguém tinha usado a
feature desde o merge. Comportamento correto — a via é unidirecional, e ausência ali **não** é
"deploy pendente".
