# Radar — o expurgo horário relia o heap inteiro por causa do rowmark (plano v8, R2) — 2026-11-11

**Entrega:** `supabase/migrations/20261113110000_radar_expurgo_sem_varrer_heap.sql` (só a etapa (c) de
`public.radar_privacidade_expurgo`), prova PG17 `db/test-radar-privacidade-j.sh` fase I*.

## O sintoma

O job 284 (`41 * * * *`) era o maior leitor de disco da instância. Pelo `pg_stat_statements` (37 chamadas, de 05/11 a 11/11),
o comando de nível superior somava **157.665 blocos lidos fora do shared_buffers por chamada** (~1,2 GiB), mais 697 mil
blocos em cache, com **79,7 s por chamada**. Dá ~29 GiB/dia de leitura para uma tarefa de higiene.

## O diagnóstico (o plano errou o suspeito)

O plano v8 culpava as duas varreduras por regex (o backfill e a contagem `razoes_cruas_restantes`). O EXPLAIN de prod
desmente: as duas já usam o índice parcial `idx_radar_empresas_razao_crua` (Index Only Scan; o backfill leu 48 blocos).

O leitor era a **higiene do cru**:

```sql
DELETE FROM private.radar_razao_receita r
 WHERE NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = r.cnpj) AND NOT EXISTS (… carga …);
```

**Lição (vale para qualquer DELETE/UPDATE com junção):** num UPDATE/DELETE, toda relação **não-alvo** da junção leva
rowmark (`ROW_MARK_REFERENCE`): o executor precisa do ctid dela para o EvalPlanQual. Isso **proíbe o Index Only Scan**
nessa relação. A anti-junção virou um Merge Anti Join que percorre `radar_empresas_pkey` (os ~4,7 mil blocos de índice)
e vai ao heap buscar cada uma das 624 mil linhas (os ~155 mil blocos de heap; o heap tem 93 mil páginas e não cabe nos
256 MB de shared_buffers). EXPLAIN em prod: custo 121.843 no DELETE contra 14.418 na forma SELECT. A mesma anti-junção
escrita como SELECT (EXPLAIN ANALYZE em prod) leu 11.609 blocos em 3 s.

**Correção:** os órfãos saem de uma `WITH … AS MATERIALIZED (SELECT …)`. Ali não há rowmark, então o planner volta a usar o
Index Only Scan. O DELETE só casa o resultado pela PK do cru. É o mesmo snapshot e a mesma semântica, num único comando.
Além disso, a higiene passou a rodar **no máximo 1× a cada ~24 h**: é a 1ª rodada sem uma higiene `sucesso` nas últimas
23 h 30 min. O órfão de cru só nasce de carga abortada ou de empresa que saiu do Radar (carga mensal).

`pg_stat_statements` não mostra os comandos de dentro de uma função plpgsql (`track = top`), mas a linha do comando de
nível superior **soma** o IO deles. Para ver o plano de dentro da função, a prova usa `auto_explain` com
`log_nested_statements = on` e `client_min_messages = log`.

## O que fica (a garantia de LGPD)

O backfill (a) e a contagem `razoes_cruas_restantes` seguem **a cada hora**. Também seguem a cada hora a retenção de
notas (b), a expiração de acessos e as exclusões de titular (d). A prova I1 insere uma razão crua que furou o trigger
(`session_replication_role = replica`) e exige que a rodada seguinte a mascare.

**Resíduos honestos:**
- O cru órfão passa de ~1 h para até ~24 h de retenção.
- O backfill horário só pega o sufixo da RFB (` [0-9]{11}$`). O CPF em formato livre no nome depende dos triggers e da
  regravação única do #3795. Isso já era assim antes desta entrega.
- Na rodada sem higiene, `cru_orfao_apagado` vai como **null**: ausente ≠ zero.

## Medido (pg_statio_user_tables de radar_empresas + pg_stat_statements, por rodada)

Método: `pg_statio_user_tables` lido por psql-ro em 3 fotos — 1 min antes, 20 s antes e logo depois de a rodada entrar
no ledger. Junto, o delta de `pg_stat_statements` do comando `SELECT public.radar_privacidade_expurgo()`, que soma o IO
dos comandos de dentro da função. A janela de 1 min antes teve delta **zero** em `radar_empresas`: a rodada estava isolada.

| Rodada | Corpo | pgss: blocos lidos (fora do cache) | pgss: em cache | duração | radar_empresas heap_read | idx_read |
|---|---|---:|---:|---:|---:|---:|
| 11/11 11:41 | velho (cdb486…) | **161.820** (1,23 GiB) | 536.367 | 68,7 s | 152.356 | 4.695 |
| 11/11 12:41 | velho (cdb486…) | **161.615** (1,23 GiB) | 535.388 | 66,2 s | 152.321 | 4.697 |
| 11/11 13:41 | **novo** (3f4f…), sem higiene | **2.601** (~20 MiB) | 1.519 | **0,86 s** | 1 | 76 |

A rodada das 13:41 leu **98,4% menos** que as do corpo velho (2.601 contra ~161,7 mil blocos) e durou 0,86 s contra
~67 s. O resto dos 2.601 blocos vem das outras etapas (notas, acessos, titulares); `radar_empresas` quase não foi tocada.
No ledger: `sucesso`, `cru_orfao_apagado` = **null** (a higiene ficou fora pelo gate de 23 h 30 min) e
`razoes_cruas_restantes` = 0. A janela de 1 min antes (13:39:44 → 13:40:43) teve delta zero nas duas tabelas.

Aplicada em 11/11 entre 12:46 e 12:49 UTC pelo founder (`bun run db:aplicar`, tentativa/recibo #1073): às 12:46:04 o
md5 ainda era o velho. A 2ª testemunha, por psql-ro às 12:49, confirmou: md5(prosrc) `3f4fd1f23db1c8a2612c649a18db22a2`,
SECURITY DEFINER, `search_path=public, pg_temp` e nenhum JWT executa.

**A rodada com higiene ainda não foi medida.** A 13:41 de 11/11 roda sem ela: a das 12:41, com o corpo velho, gravou
`cru_orfao_apagado`, e o gate é de 23 h 30 min. A 1ª rodada com o corpo novo **e** a higiene é a de **12/11 às 12:41**.
Duração e resultado saem do ledger depois do fato (psql-ro):

```sql
select iniciado_em, extract(epoch from finalizado_em - iniciado_em)::numeric(8,2) as s, status,
       detalhes->>'cru_orfao_apagado' as cru_orfao_apagado
  from public.acoes_execucoes
 where acao = 'radar.privacidade_expurgo' and iniciado_em >= '2026-11-12 12:00Z'
 order by iniciado_em limit 3;
```

O IO só sai com foto **antes** (12:40:40) e **depois** de a rodada entrar no ledger: o delta de
`select heap_blks_read, idx_blks_read from pg_statio_user_tables where relname = 'radar_empresas'` (psql-ro) e o de
`select calls, shared_blks_read, shared_blks_hit from extensions.pg_stat_statements where query = 'SELECT public.radar_privacidade_expurgo()'`
(conector Lovable, read-only). Esperado: a ordem dos 11,6 mil blocos da forma SELECT, não os ~155 mil do heap.

## R1 (plano v8): a queda do agregado e o desenho incremental — CORTADO, com a medida

**A queda não foi em 10/11 06:35.** Pelo `cron.job_run_details` do job 264, foram 7 dias de recálculo:

| Rodadas | Duração |
|---|---:|
| 04 a 09/11, 06:35 | 204,1 / 212,8 / 206,1 / 207,5 / 210,3 / 211,0 s |
| 09/11 22:35 em diante | 147,4 / 146,5 / 143,7 s |

A rodada das 22:35 de 09/11 é a 1ª recalculada depois de aplicada a migration do #3769 (`visitar_calculado_em` null força o
recálculo). A coincidência com o #3769 é de calendário, não de causa:

- **O código não ficou mais barato.** O corpo do agregado é o mesmo da 20261104153351 à 20261111120000 (só ganhou a guarda
  de publicação, que lê `radar_ingest_state`). A 20261111160000 só **acrescenta** trabalho: a CTE `vis` (a regra da fila
  em ~67 mil candidatos) e uma 14ª chave no GROUP BY. Nenhum índice, nem `work_mem`, mudou.
- **Não é concorrência.** Nenhum job do cron (todos, não só os do Radar) com mais de 5 s se sobrepõe à janela 06:35–06:39
  em nenhum dos 7 dias de `cron.job_run_details`.
- **Não é perda de dado.** O agregado soma 573.021 empresas, exatamente Σ`novos` dos 4 lotes (526.176 + 27.466 + 10.792 +
  8.587). O `n_live_tup`/`reltuples` de 624.079 é estimativa inflada da estatística; não use como contagem.
- **Mecanismo físico: NÃO provado.** O cron só guarda a duração. No mesmo intervalo, a publicação do lote 2026-10
  (09/11 15:01) esvaziou o staging `radar_empresas_carga` (~1 M de inserções acumuladas). É candidata, não causa medida.

**Custo medido do recálculo** (`pg_stat_statements` do comando do cron desde o reset de 05/11 14:13). São 143 chamadas,
exatamente as 143 rodadas do cron (`cron.job_run_details`); 7 recalcularam e somam 1.272,5 s dos 1.285,0 s totais.

| | Total (7 recálculos) | Por recálculo |
|---|---:|---:|
| Blocos lidos fora do cache | 1.698.566 | **~242,7 mil (~1,85 GiB)** |
| Blocos em cache | 13.345.997 | ~1,9 M |
| Blocos sujados | 69.839 | ~10 mil |

A frequência é **1×/dia** (06:35), o que dá ~1,85 GiB/dia, ~6% do que o expurgo lia antes do R2 (~29 GiB/dia).

**O desenho incremental pelo corte "estabelecida" não é igual ao cheio.** O agregado também agrupa `prospeccao_status`,
`ja_cliente`, telefone/contato, `inedito` e `visitar`, e essas dimensões mudam todo dia: situação 06:05, recruzamento
06:15, score 06:30, contabilidade 06:50 e o trabalho dos vendedores. Recalcular só quem cruzou `hoje − 5 anos` deixaria
o resto velho. Um incremental correto precisaria do valor **anterior** de cada linha alterada, para subtrair a
contribuição velha do grupo; isso significa um log de delta mantido por trigger em `radar_empresas`, que é exatamente a
escrita quente cujo custo de índice o R2 evitou. Ganho máximo: ~1,85 GiB e ~2,5 min por dia. **Não paga: cortado.**
Reabrir só se o recálculo passar a rodar várias vezes ao dia, ou se a duração encostar no `statement_timeout` de 15 min.
