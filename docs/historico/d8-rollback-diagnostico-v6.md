# D8: 17% de rollback é acumulado de uma rajada passada, não do app nem do cron (plano v6)

**2026-11-05, só leitura.** Item D8 do plano v6 (`docs/superpowers/plans/2026-11-04-plano-melhoria-v6/README.md`, §2 D). As fontes foram o `psql-ro` (`claude_ro`), o conector Lovable (`query_database`, com `SET TRANSACTION READ ONLY` na frente e o banco atestando `transaction_read_only = on` em todas as respostas) e um experimento com a anon key pública contra o PostgREST de produção. Nada foi escrito em prod.

## Veredito

1. **O 17% é um acumulado desde o restart de 31/10 10:33 UTC, e a taxa atual é baixa.** Na série de 60 s das 13:07 às 13:19 UTC (10:07–10:19 em SP, dia útil, app em uso), houve **207** rollbacks. Desses, 202 foram meus (experimento abaixo), o que deixa **~5 orgânicos em 11,5 min, contra ~3.200 commits (0,15%)**. Na noite de 04/11 o plano mediu 0,9%. A conta da madrugada também não fecha sozinha: entre a medição do plano (antes das 00:38 UTC de 05/11) e 13:07 UTC houve **+7,4 mil rollbacks**, ≫ 12 h × 86/h. Houve, portanto, rajada também nessa janela, e não só de 31/10 a 04/11.
2. **Não é o app via PostgREST.** No `pg_stat_statements` (zerado no mesmo restart, `dealloc = 0`), o `ABORT` do `authenticator` soma **1.137 desde o restart**, dos quais ~200 são do meu experimento. Mesmo corrigindo pela captura de ~75% medida abaixo, ficam **≤ ~1,5 mil erros do PostgREST em 5 dias, menos de 1% dos 235 mil**.
3. **Não é o cron.** `cron.job_run_details` registra **1 falha em 79.641 rodadas** desde o restart (`tint-watchdog-fase5-6h`, 31/10 18:00, `statement timeout`). Do lado do `pg_net`, as respostas HTTP das últimas ~6 h têm 2 com status ≥ 400.
4. **Não é timeout em massa.** O `active_time` somado de **todos** os backends desde o restart é de **~8 h** (`pg_stat_database`). 230 mil timeouts de 8 s precisariam de ~500 h. Os rollbacks em massa foram erros **rápidos**.
5. **A premissa do Codex de que "o PostgREST faz rollback de propósito na leitura" não vale nesta instância.** Medido: leitura bem-sucedida termina em **COMMIT**.
6. **Quem gerou o grosso (~233 mil) ainda não está atribuído.** O único ator com volume nessa escala é o **poller do Realtime**: o `SELECT wal->>…` (`list_changes`) do `supabase_admin` tem **330.278 chamadas bem-sucedidas** desde o restart. O Realtime só faz polling com assinante conectado, o que bate com "concentra no horário de uso". Poll que falha não entra no `pg_stat_statements`, e o conjunto de conexões do Realtime é recriado sob demanda (as atuais nasceram às 13:04:52 UTC de hoje; às 12:43 não havia nenhuma). Isso é **hipótese (H1), não prova**: nenhuma fonte legível pela sessão guarda erro com hora.

**Benigno ou erro real?** Hoje não há sinal de erro real: 0,15% em horário de uso, cron limpo e PostgREST com ~1 mil erros em 5 dias. O erro do passado continua sem SQLSTATE. Por isso **não há item proposto**: ele precisaria de evidência que esta sessão não alcança. O passo que decide é a consulta do founder abaixo.

## Experimento controlado: o que vira rollback no PostgREST

Requisições com a anon key pública, só leitura, lendo `pg_stat_database` antes e depois (com `pg_sleep(3)` para o flush das estatísticas):

| requisição | resposta | Δ `xact_rollback` |
|---|---|---|
| 40 × `GET profiles` (anon sem `SELECT` → 42501) | 401 | **+40** |
| 40 × `GET profiles?id=eq.nao-e-uuid` + 40 × `GET profiles?id=eq.<uuid zero>` com `Accept: …pgrst.object` | 400 / 401 | **+80** (sem pausa de flush entre as duas levas, por isso estão somadas) |
| 60 × `GET fin_movimentacoes?limit=1` (RLS → `[]`) | **200** | **+0** |
| 60 × `GET profiles` | 401 | **+60** |
| 20 × `GET profiles` (contra o `pg_stat_statements`) | 401 | `ABORT` +15, `set_config` anon +20 |

Conclusão: **cada resposta de erro do PostgREST é exatamente 1 rollback, e leitura bem-sucedida é commit.** O `pg_stat_statements` sub-registra o `ABORT` (15 de 20). Por isso o limite do item 2 foi corrigido por ~75%.

## Contas do `pg_stat_statements` (desde 31/10 10:33, `dealloc = 0`)

| statement | papel | chamadas |
|---|---|---|
| `SELECT wal->>…` (poller do Realtime, `list_changes`) | `supabase_admin` | **330.278** |
| `select set_config(… 'role' …)` (1 por requisição PostgREST) | `service_role` / `authenticated` / `anon` | 162.512 / 48.337 / 1.548 |
| `update/insert cron.job_run_details` | `supabase_admin` | 80.001 por tipo |
| `SELECT public.tint_preparacoes_tick()` / `tint_promocao_tick()` | `postgres` | 29.418 / 29.301 |
| `BEGIN … READ ONLY` / `READ WRITE` | `authenticator` | 23.572 / 21.590 |
| `COMMIT` | `service_role` / `authenticated` / `anon` | 26.377 / 6.574 / 294 |
| `ABORT` (erro do PostgREST, já sem o papel do request) | `authenticator` | **1.137** |
| `ROLLBACK` explícito, todos os papéis | — | ~90 (59 do `claude_rw`) |

Total de transações desde o restart: **1,43 M**. Requisições PostgREST: ~212 mil. O resto é autocommit de cron, `pg_net`, Realtime e Auth (10.580 `begin`/`commit` do `supabase_auth_admin`, quase todos dos 10.406 usuários placeholder da importação de 01/11 23:15).

## Fontes checadas e descartadas

- **Importação de clientes** (`clientes-import-diario` às 07:45 UTC, ~26,7 mil "pulados" por rodada): o pulo é decidido **em memória** (`omie-cliente/index.ts`, dedup por `omie_customer_account_map_fresco`), sem tentativa que falhe. São 17 inserções por dia.
- **Agente do tintométrico** (`tint_sync_runs`): 380–690 rodadas por dia, todas `complete`. `tint_sync_errors` tem 1–18 por dia (receita corrompida, rejeitada pela promoção).
- **`n_dead_tup` "em excesso"** (por exemplo, `fin_movimentacoes`): parece insert abortado, mas não serve como evidência. O autoanalyze reestima o `n_dead_tup`, e o contador de 31/10 parte de zero.
- **Sessões**: ~1,3 mil por hora agora, contra 1.040 por hora na média. A taxa de conexão é estável, só o rollback é que vem em rajada. `sessions_abandoned` = 1.587, `sessions_fatal` = 0.

## O que só o founder vê: a consulta pronta

**Onde:** Logs Explorer do Supabase (fonte `postgres_logs`; em Lovable Cloud, Cloud → Logs, se exposto). A janela de retenção do plano decide se 31/10–05/11 ainda está lá. É só leitura e não precisa de segredo. Ela responde H1 diretamente: se o grosso vier de `supabase_admin` com `application_name` `realtime_*`, a hipótese se confirma. Qualquer outro papel aponta o culpado.

```sql
select
  timestamp_trunc(t.timestamp, hour) as hora_utc,
  p.user_name,
  p.application_name,
  p.sql_state_code,
  p.error_severity,
  count(*) as n,
  min(substr(t.event_message, 1, 100)) as exemplo
from postgres_logs as t
  cross join unnest(t.metadata) as m
  cross join unnest(m.parsed) as p
where p.error_severity in ('ERROR', 'FATAL')
group by hora_utc, p.user_name, p.application_name, p.sql_state_code, p.error_severity
order by n desc
limit 100
```

O `exemplo` pode trazer valor de linha (por exemplo, `duplicate key … (email)=…`). Cole no chat só as colunas de contagem, papel e SQLSTATE.

**Como ler:** compare a soma de `n` por dia com o Δ diário de `xact_rollback`, que é ~45 mil por dia na média desde o restart. Se bater, a consulta atribuiu. Se a retenção já tiver apagado a rajada, o D8 fecha como **benigno hoje e sem causa histórica**. A taxa atual (0,15–0,9%) não justifica sensor novo: não há incidente citável, e máquina meta exige um.

## Lições

- **Contador acumulado desde o restart não é taxa.** O `xact_rollback` / `xact_commit` cumulativo diluiu uma rajada de dias num "17%" que parecia estado. Antes de chamar de problema, meça o **Δ em janela** (aqui, 60 s), como o Codex pediu.
- **Uma premissa sobre o comportamento do PostgREST se testa com a anon key em 1 minuto.** Leitura com sucesso e leitura com erro, contra o Δ do `pg_stat_database`, refutam ou confirmam sem precisar de log.
- **O `ABORT` pós-erro aparece no `pg_stat_statements` sob o papel `authenticator`, não sob o papel do request.** O erro desfaz o `SET LOCAL ROLE` antes do `ABORT`. E a contagem sub-registra: 15 de 20 medidos.
