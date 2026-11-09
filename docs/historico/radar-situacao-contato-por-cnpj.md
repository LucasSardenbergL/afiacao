# Radar: o cron da RFB casa contato ↔ status por CNPJ (2026-10-31)

> Follow-up de [radar-contato-integridade.md](radar-contato-integridade.md) (Codex P1 herdado). Migration
> `20261031190000_radar_situacao_contato_por_cnpj.sql`. Prova: `db/test-radar-situacao-contato-por-cnpj.sh` (núcleo do CI).

## Problema

No trecho (b) de `public.radar_aplicar_situacao` (cron `radar-aplicar-situacao-diario`, 06:05 UTC), o contato
`descartado` nascia do **retrato** (`tmp_rfb_irreg`, com o status lido antes) e o `UPDATE` do estado relia o status
**vivo**, sem trava. A conferência era só `v_leads_upd <> v_leads`. Traço: depois do retrato, o vendedor leva X a
`virou_cliente` e reabre Y (`descartado` → `a_contatar`). O contato sai para X, que não muda, e o estado muda Y, que fica
sem contato: 1 = 1, a contagem passa. Com o vendedor no meio do `UPDATE`, o `status_anterior` saía velho.

## O que mudou (só o trecho (b))

Um statement:

```sql
WITH alvo AS MATERIALIZED (SELECT … FROM radar_empresas re JOIN tmp_rfb_irreg i …
                            WHERE <candidato pelo retrato> AND NOT COALESCE(re.ja_cliente, false)
                              AND re.prospeccao_status NOT IN ('descartado','virou_cliente')
                            FOR UPDATE OF re),
     estado  AS (UPDATE radar_empresas … FROM alvo … RETURNING cnpj, status_anterior, descricao),
     contato AS (INSERT INTO radar_contatos … SELECT … FROM estado RETURNING cnpj, status_anterior)
SELECT …, EXISTS (estado EXCEPT ALL contato ∪ contato EXCEPT ALL estado) INTO …;
```

- O retrato só aponta os **candidatos**. Status e `ja_cliente` valem na **linha travada** (EvalPlanQual re-avalia o
  `WHERE` contra a versão que outra transação acabou de gravar).
- O estado muda só nas linhas travadas, e o contato nasce do que o `UPDATE` devolveu: contato ⇔ mudança **por
  construção**, com o `status_anterior` da linha travada.
- A postcondição compara os dois conjuntos **por CNPJ** (`EXCEPT ALL` nos dois sentidos), não pelos totais. Com o corpo
  correto ela não dispara (a construção já garante); o vermelho dela é o cenário P da prova (abaixo).
- `MATERIALIZED` é explícito, não necessário: no PG17 uma CTE com `FOR UPDATE` já não é inlinada (Codex). Fica para
  declarar a intenção.
- (a), (c), os avisos e a regra de negócio não mudam. O G4 da prova confere que o corpo novo, sem o trecho (b), é byte
  a byte o predecessor de prod sem o trecho (b).
- A guarda `private.radar_empresas_status_guard` segue zerando a autoria (o cron não declara dono), e o cron sem JWT não
  esbarra no RD005/RD007 (exclui `virou_cliente` antes).

## Prova

`db/test-radar-situacao-contato-por-cnpj.sh` (núcleo do CI, porta 5496): o corpo vivo de prod (md5 dos 3 corpos
conferido contra prod no harness) + a migration. 28 asserts, verdes em `LC_ALL=C` e `pt_BR.UTF-8`.

- **B** (sem corrida): as regras do descarte não mudaram (cliente por `ja_cliente` e pelas fontes, `virou_cliente`,
  `descartado`, situação 02, lote mais velho que a foto); reaplicar o lote = 0.
- **R1**: o vendedor escreve ENTRE o retrato e o descarte. Um gancho só do harness em `radar_rfb_descricao` (advisory
  lock compartilhado, dentro do statement do retrato) para o cron; o vendedor só age depois de VER o cron parado em
  `pg_stat_activity` (assert `viu=t`). X vira cliente, Y é reaberto, W vira `ja_cliente`: o contato sai para Y (com o
  `status_anterior` dele) e não para X nem W.
- **R2**: o vendedor segura a linha DURANTE o descarte (transação aberta até ver o cron esperando a trava): o
  `status_anterior` é o da versão travada; quem virou cliente fica intocado.
- **P** (Codex P2): um trigger só do harness grava o contato de P1 em P2 — 1 estado e 1 contato, CNPJs diferentes. A
  postcondição aborta com `25000` e a chamada volta atrás inteira.
- **G**: ACL lida ANTES de reaplicar; reaplicar é no-op; fora do trecho (b) o corpo é o predecessor byte a byte.

`--falsificar` (controle verde na mesma invocação, nos dois locales): 10/10 sabotagens vermelhas no assert declarado —
contato do retrato (com e sem a postcondição), postcondição por totais (`post_por_total` → P1), status do retrato, sem
trava, `ja_cliente` do retrato, sem status vivo, cliente das fontes descartado, mudança fora do (b), anon com EXECUTE.
As provas vigentes seguem verdes: `test-radar-situacao-cadastral.sh` 22/0 (ela fixa `LC_ALL=C` por desenho) e
`test-radar-situacao-por-cron.sh` 31/0 nos dois locales.

Achado do harness: `pg_stat_activity` é um retrato que vale até o fim da transação. O espião do vendedor do R2 (em
`BEGIN`) via sempre a foto velha; o laço precisa de `pg_stat_clear_snapshot()` a cada volta.

Codex (money-path, `scripts/codex-async.sh`): nenhum P0/P1. P2 na prova (a postcondição sem vermelho próprio) →
cenário P + `post_por_total`. Notas sem ação: deadlock entre o (a) e o recruzamento já existia no predecessor (o
`FOR UPDATE` conflita também com `KEY SHARE`, sem ciclo novo demonstrado); `pg_blocking_pids()` daria um espião mais
preciso que `wait_event_type = 'Lock'`.

## Limites declarados

- O lado "documento nas fontes" do cliente (`radar_docs_clientes()`: `profiles` e `omie_clientes_nao_vinculados`) segue
  vindo do retrato: não há linha a travar. Um cadastro que entra nas fontes no meio da chamada não protege o lead
  daquele lote (protege no próximo, e o `ja_cliente` da linha já protege o caminho do cadastro pelo Radar).
- Avisos (`fornecedor_alerta`/`alertado_em`) não têm o defeito: lêem só `radar_situacao_cadastral`, cujo único escritor de
  `alertado_em` é esta função.

- Deadlock com o recruzamento (`radar_recruzar_ja_cliente`, 06:15) continua possível como no predecessor: o (a) trava
  linhas antes do (b). Eliminar exigiria ordem comum entre os escritores em massa desde antes do (a); hoje um ciclo
  derruba a chamada com `40P01` (rollback inteiro, sem estado pela metade).

## Deploy

Só banco (sem edge, sem front). Aplicada em 2026-10-31 ~21:20 UTC pelo envelope `bun run db:aplicar` (ensaio antes,
PÓS validada nos dois), recibo **#804** `aplicada`, sha256 `614e87b6…`, commit `2cf18e029`. Pré-voo psql-ro: md5 de
prod `f00aae84…`/`73e049de…` (= o predecessor revisado), 0 travas, fora da janela 06:05–06:45 UTC. 2ª testemunha
psql-ro: md5(prosrc) `3b99d4dd…`, secdef, `search_path=public, pg_temp`, 1 sobrecarga, ACL idêntica à de antes
(`service_role` e `sandbox_exec_*` executam; PUBLIC, anon e authenticated não).

`authz:carimbo:gravar` regravado depois do apply. O `deriva:corpo:prod` acusa `radar_aplicar_situacao` como `SEM_PAR`
até o merge (ele lê as migrations da `origin/main`); o próximo carimbo depois do merge fecha o achado.
