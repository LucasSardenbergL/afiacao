# O ledger cobre 13% e atrasa 12 dias — "sem linha em `schema_migrations`" NÃO é "não aplicada"

**Episódio:** 2026-10-08 · fecho de sessão · PROD `fzvklzpomgnyikkfkzai` · medido via `~/.config/afiacao/psql-ro`

## O que aconteceu

Para auditar as 45 migrations do último mês, montei uma query contra
`supabase_migrations.schema_migrations` — o ledger que o passo (1) da reconciliação do §1 alimenta.
Ela acusou **43 das 45 como "não aplicadas"**.

Rodando o audit de verdade (`scripts/audit-custom-migrations.sql`) e lendo a **tabela (B)** — os
objetos que de fato existem em prod — os **125 objetos** dessas migrations estavam **TODOS
presentes, zero ausentes**. As **6** migrations sem nenhuma linha em (B) (alteram dados, coluna,
GRANT/REVOKE ou re-agendam cron, que (B) não inventaria) foram provadas **uma a uma** por query
dedicada: todas aplicadas.

**O alarme era 100% falso.** A causa não é o banco: é ler *ausência de linha no ledger* como
*ausência do objeto em prod*.

## A medição

| medida | valor |
|---|---|
| `count(*)` em `supabase_migrations.schema_migrations` | **245** |
| `.sql` em `supabase/migrations/` na `origin/main` | **767** (708 `version` numéricas únicas) |
| `max(version)` no ledger | **20260925210332** (25/09) |
| última migration na `main` | `20261008010000_cron_estoque_diario_fora_do_minuto_00.sql` (08/10) |
| atraso do ledger | **12 dias** |

O passo (1) do §1 (`INSERT` no ledger) **não é cumprido na prática** — e não por descuido de uma
sessão: o apply normal aqui é colar no SQL Editor, que não registra nada.

### O off-by-one que piora o número aparente

245/767 ≈ 32% é a cobertura **otimista**. O ledger grava um timestamp **1–2 s à frente** do que está
no nome do arquivo, então o casamento por `version` **exata** — que é como toda query de ledger
pergunta — perde ainda mais:

| casamento | migrations do repo cobertas |
|---|---|
| `version` **exata** (`WHERE version = '<timestamp do nome>'`) | **94/708 = 13,4%** |
| tolerância ±1 s | 221/708 = 31,4% |
| tolerância ±2 s | 239/708 = 34,0% |

Distribuição do delta (`version` do repo − `version` do ledger) nos 239 casados: **0 s em 94 · +1 s
em 127 · +2 s em 18**. Ou seja, em **145 dos 239** (61%) o nome do arquivo **não é** a chave do
ledger, e 127+18 = **145 migrations que ESTÃO registradas** somem de um `JOIN` por igualdade.

⇒ Pelo caminho exato, "está aplicada?" respondido pelo ledger dá **falso negativo em ~6 de cada 7
casos**; dando a tolerância de graça, em ~2 de cada 3.

## A regra

**A autoridade é a tabela (B) — existência do objeto. A tabela (A) / o ledger não responde "está
aplicada?".** Isto é o mesmo erro do `✅ registrado` que CURTO-CIRCUITA a verificação
([audit-migrations-falso-vermelho.md](audit-migrations-falso-vermelho.md)), visto pelo outro lado: lá
o registro dava verde sem conferir objeto; aqui a **ausência** de registro dá vermelho sem conferir
objeto. O registro erra nos DOIS sentidos — já medido em
[schema-migrations-fail-open.md](schema-migrations-fail-open.md), agora com o denominador.

**O que (B) não inventaria** (e aí só query dedicada prova): `UPDATE`/`INSERT` de dados ·
`ALTER TABLE ADD COLUMN` · `GRANT`/`REVOKE` · constraint (classe 100% cega — o extrator não tem o
kind) · cron por `cron.alter_job`/`unschedule` (só `cron.schedule('nome',…)` entra no inventário).
O último é caso vivo: a migration mais nova da `main` (`20261008010000`) usa `cron.alter_job` ⇒
**0 objetos** em (B), por desenho.

## O que NÃO fazer

**Não reconciliar o ledger com um `INSERT` de ~522 linhas.** É escrita em banco de produção sem
ganho: a tabela (B) já responde a pergunta que o ledger responderia, e o ledger voltaria a atrasar
na próxima migration colada à mão (que é o caminho normal). Se algum dia valer, vale como decisão
do founder — guardada por existência (`INSERT … SELECT … WHERE EXISTS … ON CONFLICT DO NOTHING`,
§2) para não criar falso-verde — não como efeito colateral de um registro de lição.

## Como re-medir

```bash
~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -At -F'|' \
  -c "SELECT count(*), max(version) FROM supabase_migrations.schema_migrations;"
git ls-tree -r --name-only origin/main -- supabase/migrations/ | grep -c '\.sql$'
```
