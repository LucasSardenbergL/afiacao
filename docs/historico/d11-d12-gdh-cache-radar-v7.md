# D11 e D12 — o compute do GDH não ficou mais lento: o custo é cache frio na instância (plano v7)

**2026-11-06, só leitura.** Itens D11 e D12 do plano v7 (`docs/superpowers/plans/2026-11-05-plano-melhoria-v7/README.md`, §2 D). Tudo foi medido assim:
- via `psql-ro` (`claude_ro`, `-v ON_ERROR_STOP=1` + `FIM_OK`);
- `_data_health_compute()` como função e o `pg_stat_statements` pelo conector Lovable, em transação `read_only`;
- o `data_health_watchdog()` **nunca** foi executado: ele grava `fin_alertas` e enfileira e-mail.

Duas sessões mediram em paralelo, esta e uma duplicada que foi encerrada sem PR; o registro junta as duas. **Não há mudança de código nem de banco.**

## D11 — veredito

**A função não regrediu.** O compute puro custa ~0,2 s hoje, como no D6. O "2.106 ms" que abriu o item foi **uma única** execução de `EXPLAIN ANALYZE`, num instante em que a instância estava lenta.

**O watchdog é lento porque lê páginas fora do cache.** Na janela desde 05/11 14:13 UTC, ele leu do disco ~1.948 blocos por chamada (era 1.123 no D6). Quando o cache está quente, a mesma rodada cai para 0,5 s.

A causa está na **instância**: Lovable Cloud **Mini, 2 cores ARM compartilhados e 1 GB de RAM**, com `shared_buffers` de 256 MB contra um banco de 6,8 GB. Desde o restart de 31/10, os backends leram 16,3 M blocos e evictaram 16,3 M. Cada leitura expulsa uma página, ou seja, o cache vive saturado.

### Evidência

| medida | valor | fonte |
|---|---|---|
| corpo vivo × repo | `pg_get_functiondef` = migration `20261031191715`; watchdog md5 `b325d2af…`, heartbeat `f5defcde…` | `psql-ro` |
| corpo inline (SELECT puro) | **188 ms** de execução com timing off, mais 12,7 ms de planejamento; 71,9 k hits, **0 lidos** | `EXPLAIN (ANALYZE, BUFFERS)`, 12:17 UTC |
| `_data_health_compute()` como função | **233–240 ms**, 76,6 k hits, 0 lidos | conector, 12:19–12:20 UTC |
| o "2.106 ms" do plano | 1 chamada de `EXPLAIN (ANALYZE, BUFFERS, SUMMARY) SELECT count(*) FROM _data_health_compute()`: 2.107,6 ms, 81.865 hits, **0 lidos**. É a única fora do modelo abaixo | `pg_stat_statements` |
| `data_health_watchdog()` (cron) | 44 chamadas, média de **6.483 ms** (672 a 15.047), **1.948 lidos por chamada** | idem, desde 05/11 14:13 UTC |
| `get_data_health()` (badge do front) | 16 chamadas, média de 2.693 ms (275 a 5.030), 565 lidos por chamada | idem |
| modelo | tempo ≈ **0,24 s + ~3–4 ms × blocos lidos**. Watchdog: (6,48 − 0,24) / 1.948 ≈ 3,2 ms. Front: (2,69 − 0,24) / 565 ≈ 4,3 ms. D6: 1.123 lidos, 4,4 s | conta |
| sonda de leitura aleatória | 200 blocos de `tint_formula_itens` por TID: **1,3–1,8 ms/bloco** em todas as amostras | laço, abaixo |
| cache da instância | `client backend`: 16,25 M leituras, **16,26 M evicções**, 2,2 G hits (99,3%) desde 31/10 10:33 | `pg_stat_io` |
| instância | `shared_buffers` 256 MB, `effective_cache_size` 768 MB, `max_connections` 60, 6 workers. Lovable, em *Database size*: **Mini · 2-core ARM shared · 1 GB RAM**. Banco de 6,8 GB (*Database storage*: 7,86 de 27 GB) | `pg_settings` + print do founder, 06/11 |

### O experimento do laço (06/11, 12:30–16:50 UTC)

O corpo inline (só SELECT, nunca o watchdog) rodou duas vezes seguidas (`c1`, `c2`) a cada 10 min, junto com um calibrador de CPU pura (join de `pg_class`), a sonda de leitura e a contagem de locks em espera. A sessão duplicada rodou o mesmo corpo a cada ~2,2 min entre 12:22 e 12:31.

Com isso, as páginas que o watchdog lê **ficaram no cache**. É um experimento natural, com previsão: com o cache quente, as rodadas do job 101 encolhem; sem o laço, voltam ao patamar.

| rodada do job 101 (UTC) | duração | contexto |
|---|---|---|
| 10:00 · 10:30 · 11:00 · 11:30 · 12:00 | 15,04 · 3,19 · 10,56 · 4,28 · **10,89 s** | antes do laço |
| 12:30 · 13:00 · 13:30 · 14:00 · 14:30 | **0,49** · 5,45 · 1,72 · 1,16 · **0,48 s** | laço ativo |
| 15:00 · 15:30 · 16:00 · 16:30 | 1,25 · 4,62 · 4,52 · 3,51 s | laço ativo |
| 17:00 · 17:30 | 1,12 s (10 min depois da última amostra) · **7,02 s** (40 min depois) | controle, laço parado |

Para não confundir com a hora do dia, comparei a mesma janela (12:30–16:00 UTC, 8 rodadas) em cada dia:

| dia | p50 | mín. | máx. |
|---|---|---|---|
| 30/10 · 31/10 · 01/11 | 1,74 · 2,96 · 3,26 s | 0,74 · 0,71 · 1,67 | 2,97 · 5,53 · 6,81 |
| 02/11 · 03/11 · 04/11 | 6,06 · 5,06 · 5,12 s | 4,12 · 1,80 · 0,54 | 12,83 · 10,84 · 7,74 |
| 05/11 | 2,35 s | 0,62 | 6,98 |
| **06/11 (com o laço)** | **1,49 s** | 0,48 | 5,45 |

**Leitura:** com o laço, a mediana foi a menor dos 8 dias nessa janela. Sem ele, a rodada voltou a 7 s em 40 min. Isso **confirma o sentido** da previsão. O tamanho do efeito, porém, é incerto: 05/11 à tarde já tinha caído para 2,35 s, num dia em que outras sessões também rodavam o compute, sem controle. N = 8 por dia.

O que o laço mostrou sobre o próprio compute (**27 amostras, 12:30–16:50 UTC, todas com rc=0 e `FIM_OK`**):
- **c2** (a 2ª corrida, segundos depois): **205–244 ms em 27 de 27**, com 0 lidos.
- **c1** ficou em 208–449 ms em 21 de 27. **Nas outras 6 travou: 914, 1.010, 1.674, 2.235, 2.876 e 5.669 ms**, sempre com 0 lidos e os mesmos ~72 k hits.
  - A trava pega o plano inteiro: a razão mediana c2/c1 por nó foi 0,03 às 12:50 e 0,18 às 13:20.
  - O nó mais afetado é o seq scan de `sales_orders` (39 MB, o maior pedaço do working set), que foi de 15 para 2.402 ms.
- O calibrador de CPU, que roda logo antes, ficou em 361–441 ms em 26 de 27 amostras. **Às 16:40 ele travou sozinho: 747 ms**, enquanto c1 e c2 saíram normais.
- A sonda leu 0,65–1,78 ms por bloco. Locks em espera: 0 em todas as amostras.
- Na amostra-teste das 12:23, a trava caiu na c2 (211 → 653 ms).

A trava em c1 aparece com mais frequência (6 contra 0 em c2), o que sugere custo de "primeiro toque" depois de 10 min parado. Mas o calibrador travado e a c2 lenta das 12:23 mostram que também há pausas que não dependem de página.

### O que fica atribuído e o que fica residual

- **Atribuído (evidência positiva):**
  - O compute não mudou: o corpo é o mesmo e o custo também (~0,2 s).
  - O tempo do watchdog e do badge acompanha os blocos lidos do disco.
  - Com o cache quente, a rodada real do cron cai: mínimo de 0,48 s, mediana de 1,49 s na janela, contra 5–6 s em 02–04/11. Sem o laço, voltou a 7 s em 40 min.
- **Residual 1 — as travas com 0 lidos** (o "2,1 s" do plano e o c1 de até 5,7 s). Contam como `hit`, então não são leitura do Postgres. São compatíveis com duas coisas:
  - (a) **page fault na memória compartilhada**: a página está em `shared_buffers`, mas o SO a mandou para swap, porque são 1 GB de RAM com 256 MB de buffers mais o cache do SO;
  - (b) **CPU roubada / throttle da VM**.

  A favor de (a): a assimetria c1 × c2 (6 a 0) e a trava concentrada no nó que varre mais páginas. A favor de (b): o calibrador também travou uma vez (747 ms às 16:40) e os cores são **compartilhados** (*2-core ARM shared*). Provavelmente as duas coisas acontecem.
  
  Os cards **CPU / Memory / Disk** do Lovable (24 h, por hora) **não destacaram nenhuma hora** no print do founder de 06/11, à tarde. As travas duram segundos e não aparecem num agregado por hora, então o card não decide entre (a) e (b). **Fica residual.** Só fecha com métrica de granularidade fina (swap ou *steal*), que o Lovable não expõe.
- **Residual 2 — quem expulsa as páginas.** Desde 05/11 14:13 UTC, 1,97 M blocos foram lidos no total:
  - `tint_promocao_tick()` (job 187, a cada 15 s): **38%**, mais ~1,1 GB de temp e uma rodada longa por dia (218 a 852 s);
  - `radar_agregado_recalcular()`: 16%;
  - `aplicar_sql`: 10%;
  - `tint_staging_purge`: 9%.

  O tick longo **não** explica a mediana do watchdog: em 4 dias, só 1 rodada coincidiu com um tick > 5 s. O padrão é desgaste contínuo, não um evento.
  
  As rodadas dos :00 tendem a ser mais lentas que as dos :30 (hoje, 7–15 s contra 3–4 s). Isso sugere que os jobs horários disputam o cache, mas **não foi medido**.

### Impacto e decisão

- **Impacto hoje: nenhum para o usuário.** Foram 0 falhas em 8 dias. O badge do front custa em média 2,7 s a cada 120 s, só para master/gestor.
- **O critério de reabertura do D6 foi tocado:** 15,04 s às 10:00 UTC de 06/11. Ele diz para reabrir como **incidente de instância, não de função**. Não há PR de código a fazer: otimizar o compute ataca 0,2 s de 6,5 s.
- **Nenhum sensor ou gate novo.** Não há incidente com dano fora do repo.
- **Ação do founder.** O projeto roda em **Lovable Cloud**, não há painel Supabase. A [doc de performance do banco do Lovable](https://docs.lovable.dev/features/database-performance.md) põe tudo numa tela só:
  1. ✅ **Feito em 06/11** (print do founder). Tamanho: **Mini · 2-core ARM shared · 1 GB RAM**. Nenhuma hora destacada em CPU, Memory ou Disk nas 24 h. Pelo critério do Lovable, não há pressão sustentada por hora. O caminho, para repetir: no editor do Lovable, **More → Database → Manage → Settings**.
     - A linha **Database size** mostra o tamanho atual da instância (Tiny, Mini, Small, Medium…).
     - Os cards **CPU**, **Memory** e **Disk** mostram **só as últimas 24 h**, em segmentos por hora, com destaque nas horas sob pressão. O Disk mostra IO, não ocupação.
     - O Lovable não expõe swap nem "disk IO budget".
     - Se houver o aviso de **alta carga** ("high load") no chat, na caixa Publish ou na view Database, ele já é o sinal de que o banco bateu num limite nas últimas 48 h.
  2. Decisão do founder, com a leitura desta sessão: **aceitar por ora**. Nenhuma hora sob pressão, 0 falhas e nenhum impacto no usuário. Subir de Mini para o próximo tamanho dobra o cache, mas o banco (6,8 GB) continua muito maior que ele, então o ganho é parcial. Reabrir se o Lovable mostrar o aviso de alta carga, se as horas começarem a ficar destacadas ou se algum job falhar. As opções eram:
     - **subir um tamanho** na mesma linha (**Database size → Manage → Manage instance**). A estimativa de custo mensal aparece sob cada tamanho. O resize reinicia a instância por alguns minutos. Custa créditos por hora, mas ataca a causa. A doc do Lovable pede corrigir consulta lenta antes, e aqui o compute já é barato: quem pesa é o volume de leitura da instância inteira;
     - **cortar quem mais lê**: um item de produto separado, que começaria por `tint_promocao_tick` a cada 15 s;
     - **aceitar**: é um vigia de fundo, sem falha.
  3. Opcional: ligar `track_io_timing` para medir a latência de leitura direto no `pg_stat_statements`. É mudança de configuração, decisão dele.
- Qualquer conserto futuro no trio recria juntos `_data_health_compute`, `data_health_watchdog` e `fin_sync_heartbeat`, partindo da migration de maior timestamp (`docs/agent/sync.md`).

## D12 — `radar_empresas` depois do #3638/#3639: **medido em 2026-11-07** (veredito no fim da seção)

O #3639 foi mergeado em 2026-11-05T15:46:21Z e o #3638 em 2026-11-05T15:47:52Z. A janela útil precisa de pelo menos 1 dia inteiro depois deles, com o `pg_stat_statements` acumulando desde o reset de 05/11 14:13 UTC. **Sem veredito até lá.** A conta parcial abaixo é só referência.

**Snapshot de 06/11 12:24 UTC** (contadores desde o restart de 31/10 10:33 UTC). `radar_empresas` em `pg_statio_user_tables`/`pg_stat_user_tables`:

| métrica | valor |
|---|---|
| `heap_blks_read` | 13.269.467 |
| `heap_blks_hit` | 5.298.578 |
| `idx_blks_read` | 214.264 |
| `idx_blks_hit` | 908.636 |
| `seq_scan` | 169 |
| `seq_tup_read` | 67.507.233 |
| `idx_scan` | 183.159 |
| tamanho | heap 731 MB, índices 509 MB |
| índice com mais `idx_blks_read` | `idx_radar_empresas_fila` (116.620) |

No `pg_stat_statements` (desde 05/11 14:13 UTC):
- `radar_agregado_recalcular`: 22 chamadas, 319.951 lidos;
- `radar_recruzar_ja_cliente_tick`: 6.148 lidos;
- `radar_score_recalcular`: 673 lidos.

A base do plano era 12,3 M em 5,2 d (~2,37 M/dia). Entre ~05/11 15:20 e 06/11 12:24 entraram +0,97 M em ~21 h. A queda é provável, mas a janela é curta e ainda mistura horas de antes do merge.

**Receita de 07/11 em diante** (sem restart no meio: confira que `pg_postmaster_start_time()` continua `2026-10-31 10:33`):
1. Via `psql-ro`, para o delta por hora contra o snapshot acima:
   ```sql
   select now(), pg_postmaster_start_time();
   select heap_blks_read, heap_blks_hit, idx_blks_read, idx_blks_hit
     from pg_statio_user_tables where relid = 'public.radar_empresas'::regclass;
   select seq_scan, seq_tup_read, idx_scan
     from pg_stat_user_tables where relid = 'public.radar_empresas'::regclass;
   select indexrelname, idx_blks_read, idx_blks_hit
     from pg_statio_user_indexes where relid = 'public.radar_empresas'::regclass
    order by idx_blks_read desc;
   select 'FIM_OK';
   ```
2. Pelo conector, o que sobrou de leitor de `radar_*` no `pg_stat_statements`: `select calls, shared_blks_read, mean_exec_time, left(query,120) from pg_stat_statements where query ilike '%radar%' order by shared_blks_read desc limit 15;`
3. Veredito:
   - Se a taxa diária de `heap_blks_read` ficar bem abaixo de 2,37 M/dia **e** `radar_agregado_recalcular` deixar de ser o leitor dominante, o #3638 cumpriu.
   - Senão, o item volta com o leitor que restou.
   - `heap_blks_read` conta leitura do Postgres, não byte físico, porque o cache do SO absorve parte.

### D12 medido (2026-11-07 12:32 UTC) — o #3638 cumpriu a parte dele; o leitor que restou é o agregado diário

Sem restart no meio: `pg_postmaster_start_time()` = `2026-10-31 10:33:02Z`. Os contadores da tabela vieram do `psql-ro` (rc 0, `FIM_OK`). O `pg_stat_statements` veio do conector, com `SET TRANSACTION READ ONLY` e o banco atestando `transaction_read_only = on`, porque o `claude_ro` não tem `USAGE` no schema `extensions`. Reset do `pg_stat_statements` às 05/11 14:13:13Z.

**Delta de `radar_empresas` contra o snapshot de 06/11 12:24Z (~24,1 h):**

| métrica | 06/11 12:24 | 07/11 12:32 | Δ |
|---|---:|---:|---:|
| `heap_blks_read` | 13.269.467 | 14.849.133 | **+1.579.666 (~1,57 M/dia)** |
| `heap_blks_hit` | 5.298.578 | 6.906.237 | +1.607.659 |
| `idx_blks_read` | 214.264 | 274.020 | +59.756 |
| `seq_scan` | 169 | 178 | +9 |
| `seq_tup_read` | 67.507.233 | 70.961.674 | +3.454.441 (~9 varreduras inteiras) |
| `idx_scan` | 183.159 | 263.684 | +80.525 |

A taxa caiu de **2,37 M para 1,57 M/dia (−34%)**. Pelo comentário da migration do #3638, a economia esperada era de ~3,8 GB/dia, ~0,49 M blocos (1,5 GB do recruzar e 2,3 GB do score), o que levaria a ~1,9 M/dia. Medido, ficou abaixo disso, mesmo com a entrada no ar dos pacotes A–D do Radar em 06/11, que trazem leitura nova de usuário.

**Por job (`cron.job_run_details`):**

| job | antes do #3638 (01–05/11) | 06–07/11 |
|---|---|---|
| 213 `radar-recruzar-ja-cliente-diario` (06:15) | 12–18 s | **5,5 / 5,3 s** |
| 225 `radar-score-recalcular-diario` (06:30) | ~21 s (67 s em 01/11) | **0,9 / 1,0 s** (gate da impressão digital: não recalcula) |
| 264 `radar-agregado-recalcular` (`35 * * * *`) | média 8,6–9,0 s, máx. 204–213 s | média 8,7 s, máx. 206–208 s |

O job 264 roda **de hora em hora**, não "1×/dia" como diz o comentário da migration do #3638. Mas só uma rodada por dia é pesada (~205 s). As outras 23 somam pouco: a média de 8,7 s em 24 rodadas cabe numa pesada mais ~0,4 s nas demais. O agendamento horário não é o custo.

**`pg_stat_statements` por `shared_blks_read` (desde 05/11 14:13Z):**

| statement | calls | blocos lidos | média |
|---|---:|---:|---:|
| `tint_promocao_tick()` | 11.056 | 1.322.523 | 98 ms |
| `radar_agregado_recalcular()` | 46 | **637.221** (era 319.951 com 22 calls) | 9,1 s |
| `tint_staging_purge()` | 2 | 346.483 | 14,7 s |
| `aplicar_sql(…)` | 48 | 301.012 | 2,1 s |
| `data_health_watchdog()` | 93 | 203.515 | 5,7 s |

Entre os leitores de `radar_*`, o agregado continua **dominante**: +317 k blocos em 24 h, ~2,5 GB, quase tudo na rodada pesada. O 2º leitor de radar (uma RPC do PostgREST com `p_cnpj`) leu 29,6 k blocos em 39 chamadas.

**Veredito pelo critério da receita:**
- A taxa caiu bem: ✅.
- O agregado continua sendo o leitor dominante: ❌.

O item volta com o leitor que restou, e esse leitor é exatamente a **"próxima fatia"** que o #3638 declarou fora do escopo. O agregado depende do relógio: o corte de "estabelecida" é hoje − 5 anos, então muda todo dia e não cabe no gate de "nada mudou". **Candidato do v8: RADAR-AGREGADO-IO**, reduzir a releitura diária do `radar_agregado_recalcular` (~2,5 GB/dia). Na mesma instância Mini, o `tint_promocao_tick` (TINT-PROMO-IO, já candidato) segue sendo o maior leitor absoluto, com 2× o agregado. Nenhuma escrita foi feita nesta medição.
