-- ============================================================
-- Validação PÓS-APPLY — ATP fase 3 (20260808012000_atp_reconciliacao_fase3.sql)
--                     + fase 3.1 (20261009120000_atp_fase3_1_elo_pid.sql), checks 26+
--                     + fase 3.2 (20261009233000_atp_fase3_2_corretiva.sql), checks 43+
--                     + fase 3.3 (20261010150000_atp_fase3_3_pv_divergente.sql), checks 48+
-- A 3.1 RECRIA o cálculo, o job de TTL e a reconciliação: os checks 7 e 10 aceitam
-- as duas formas (a propriedade da fase 3 — PV firme isento do relógio, canônica
-- lida — vale nas duas); sem isso este validador ficaria VERMELHO em prod depois
-- da 3.1 aplicada, empurrando alguém a "re-aplicar a fase 3" e desfazer a 3.1.
--
-- Lê CATÁLOGO, nunca INVOCA a função (database.md §): invocar exige EXECUTE, e sob
-- psql-ro (claude_ro) o "permission denied" seria o REVOKE funcionando se
-- apresentando como falha da migration — falso negativo que empurra para re-aplicar
-- algo são. Assim a MESMA query roda no SQL Editor (superuser) e no psql-ro.
--
-- Todo predicado de corpo mede o functiondef COM OS COMENTÁRIOS REMOVIDOS: a
-- própria migration escreve prosa citando os predicados que ela instala, e sem o
-- strip o assert casaria o comentário em vez do código (money-path §"o ALVO mente").
-- ============================================================
WITH defs AS (
  SELECT
    regexp_replace(pg_get_functiondef(to_regprocedure('private.atp_disponivel(text,bigint,uuid)')), '--[^\n]*', '', 'g') AS disp,
    regexp_replace(pg_get_functiondef(to_regprocedure('private.expirar_reservas_vencidas_job()')),   '--[^\n]*', '', 'g') AS job,
    regexp_replace(pg_get_functiondef(to_regprocedure('private.atp_reconciliar_job()')),             '--[^\n]*', '', 'g') AS rec,
    regexp_replace(pg_get_functiondef(to_regprocedure('public.atp_resolver_reserva(uuid,text,text)')), '--[^\n]*', '', 'g') AS res,
    regexp_replace(COALESCE(pg_get_functiondef(to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')), ''), '--[^\n]*', '', 'g') AS cpv,
    regexp_replace(COALESCE(pg_get_functiondef(to_regprocedure('private.atp_canonico_da_reserva(uuid)')), ''), '--[^\n]*', '', 'g') AS cdr
), checks AS (
  -- ── existência dos objetos novos (to_regprocedure devolve NULL se ausente,
  --    sem levantar erro — e resolve tipo de verdade, não compara texto)
  SELECT 1 AS n, 'coluna faturamento_observado_em' AS item,
         EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema='public' AND table_name='estoque_reservas'
                   AND column_name='faturamento_observado_em') AS ok
  UNION ALL SELECT 2, 'private.atp_pedido_canonico(uuid)',
         to_regprocedure('private.atp_pedido_canonico(uuid)') IS NOT NULL
  UNION ALL SELECT 3, 'private.atp_reconciliar_job()',
         to_regprocedure('private.atp_reconciliar_job()') IS NOT NULL
  UNION ALL SELECT 4, 'public.atp_reconciliar()',
         to_regprocedure('public.atp_reconciliar()') IS NOT NULL
  UNION ALL SELECT 5, 'public.atp_resolver_reserva(uuid,text,text)',
         to_regprocedure('public.atp_resolver_reserva(uuid,text,text)') IS NOT NULL
  UNION ALL SELECT 6, 'public.atp_reservas_pendentes(integer)',
         to_regprocedure('public.atp_reservas_pendentes(integer)') IS NOT NULL

  -- ── M1: o CÁLCULO deixou de expirar reserva de PV firme.
  --    Ancorado na ESTRUTURA (a chamada com o campo), não em nome solto.
  UNION ALL SELECT 7, 'M1 atp_disponivel isenta PV firme do relogio',
         (SELECT disp ~ 'r\.expira_em > now\(\)\s*(OR r\.omie_pedido_id IS NOT NULL\s*)?OR EXISTS' AND disp ~ 'so\.omie_pedido_id IS NOT NULL' FROM defs)
  -- e o guard de frescor de 24h NÃO foi perdido no CREATE OR REPLACE (a fase 3
  -- recriou a função inteira — negativo obrigatório, senão "aplicou" e "aplicou
  -- por cima do hardening da 1.1" ficam indistinguíveis)
  UNION ALL SELECT 8, 'M1 preservou os guards C1-C4 da fase 1.1',
         (SELECT disp ~ '24 hours' AND disp ~ '''Infinity''' AND disp ~ '''NaN'''
                 AND disp ~ '5 minutes' AND disp ~ 'divergente' FROM defs)

  -- ── M2: o JOB de TTL deixou de carimbar reserva de PV firme
  UNION ALL SELECT 9, 'M2 job de TTL pula PV firme',
         (SELECT job ~ 'AND NOT EXISTS' AND job ~ 'so\.omie_pedido_id IS NOT NULL' FROM defs)

  -- ── M3: le a CANONICA e nao age por deleted_at
  UNION ALL SELECT 10, 'M3 reconciliacao usa a linha canonica',
         (SELECT rec ~ '(atp_pedido_canonico|atp_canonico_da_reserva)' FROM defs)
  UNION ALL SELECT 11, 'M3 NAO libera por deleted_at (negativo)',
         (SELECT rec !~ 'deleted_at' FROM defs)
  UNION ALL SELECT 12, 'M3 NAO consome automaticamente (negativo)',
         (SELECT rec !~ '''consumida''' FROM defs)
  UNION ALL SELECT 13, 'atp_pedido_canonico casa por hash_payload preenchido',
         (SELECT regexp_replace(pg_get_functiondef(to_regprocedure('private.atp_pedido_canonico(uuid)')), '--[^\n]*', '', 'g')
                 ~ 'c\.hash_payload IS NOT NULL')

  -- ── válvula humana: guard de ator PRÓPRIO (não o gate de capability)
  UNION ALL SELECT 14, 'atp_resolver_reserva exige ator humano',
         (SELECT res ~ 'v_uid IS NULL' FROM defs)
  UNION ALL SELECT 15, 'atp_resolver_reserva exige motivo',
         (SELECT res ~ 'btrim\(p_motivo\) = ''''' FROM defs)

  -- ── privilégios por CATÁLOGO (42501 tem dois emissores: gate e falta de GRANT —
  --    só o catálogo responde a pergunta "tem privilégio?")
  UNION ALL SELECT 16, 'anon SEM execute em atp_reconciliar',
         NOT has_function_privilege('anon', to_regprocedure('public.atp_reconciliar()')::oid, 'EXECUTE')
  UNION ALL SELECT 17, 'anon SEM execute em atp_resolver_reserva',
         NOT has_function_privilege('anon', to_regprocedure('public.atp_resolver_reserva(uuid,text,text)')::oid, 'EXECUTE')
  UNION ALL SELECT 18, 'anon SEM execute em atp_reservas_pendentes',
         NOT has_function_privilege('anon', to_regprocedure('public.atp_reservas_pendentes(integer)')::oid, 'EXECUTE')
  UNION ALL SELECT 19, 'authenticated SEM execute no job privado',
         NOT has_function_privilege('authenticated', to_regprocedure('private.atp_reconciliar_job()')::oid, 'EXECUTE')
  UNION ALL SELECT 20, 'authenticated SEM execute em atp_pedido_canonico',
         NOT has_function_privilege('authenticated', to_regprocedure('private.atp_pedido_canonico(uuid)')::oid, 'EXECUTE')
  UNION ALL SELECT 21, 'trilha segue append-only (service_role sem UPDATE)',
         NOT has_table_privilege('service_role', 'public.atp_decisoes', 'UPDATE')
  UNION ALL SELECT 22, 'trilha segue append-only (service_role sem DELETE)',
         NOT has_table_privilege('service_role', 'public.atp_decisoes', 'DELETE')

  -- ── CHECK de domínio estendido
  UNION ALL SELECT 23, 'CHECK de decisao aceita os desfechos da fase 3',
         EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
                 WHERE c.relname='atp_decisoes' AND con.conname='atp_decisoes_decisao_check'
                   AND pg_get_constraintdef(con.oid) LIKE '%liberacao_forcada%')
  UNION ALL SELECT 24, 'CHECK de contexto aceita resolucao_manual',
         EXISTS (SELECT 1 FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
                 WHERE c.relname='atp_decisoes' AND con.conname='atp_decisoes_contexto_check'
                   AND pg_get_constraintdef(con.oid) LIKE '%resolucao_manual%')

  -- ── cron agendado no ENTRYPOINT PRIVADO (a RPC pública é inagendável: sem JWT
  --    o gate devolve 42501 — foi o C7 da fase 1.1)
  UNION ALL SELECT 25, 'cron atp-reconciliar ativo no job privado',
         EXISTS (SELECT 1 FROM cron.job
                 WHERE jobname='atp-reconciliar' AND active
                   AND command LIKE '%private.atp_reconciliar_job%')
  -- ══ FASE 3.1 — o elo reserva↔PV sobrevive ao DELETE ══════════════════════
  UNION ALL SELECT 26, '3.1 colunas omie_pedido_id + omie_account em estoque_reservas',
         (SELECT count(*) = 2 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='estoque_reservas'
            AND column_name IN ('omie_pedido_id','omie_account'))
  UNION ALL SELECT 27, '3.1 CHECK do par (ambos ou nenhum, PID > 0)',
         EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.estoque_reservas'::regclass
                   AND conname = 'estoque_reservas_pv_par_check')
  UNION ALL SELECT 28, '3.1 trigger write-once ATIVO (insert + update do par)',
         EXISTS (SELECT 1 FROM pg_trigger t
                 WHERE t.tgrelid = 'public.estoque_reservas'::regclass
                   AND t.tgname = 'trg_estoque_reservas_pv_write_once'
                   AND t.tgenabled <> 'D' AND NOT t.tgisinternal
                   AND pg_get_triggerdef(t.oid) ~ 'BEFORE INSERT OR UPDATE OF omie_pedido_id, omie_account')
  UNION ALL SELECT 29, '3.1 public.atp_confirmar_pv existe',
         to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)') IS NOT NULL
  UNION ALL SELECT 30, '3.1 private.atp_canonico_da_reserva existe',
         to_regprocedure('private.atp_canonico_da_reserva(uuid)') IS NOT NULL
  UNION ALL SELECT 31, '3.1 calculo: o PAR PROPRIO torna a reserva firme',
         (SELECT disp ~ 'OR r\.omie_pedido_id IS NOT NULL' FROM defs)
  UNION ALL SELECT 32, '3.1 job de TTL: o PAR PROPRIO tambem isenta do relogio',
         (SELECT job ~ 'AND r\.omie_pedido_id IS NULL' FROM defs)
  UNION ALL SELECT 33, '3.1 reconciliacao acha a canonica pela RESERVA e inclui a desvinculada',
         (SELECT rec ~ 'atp_canonico_da_reserva\(r\.id\)'
                 AND rec ~ 'r\.sales_order_id IS NOT NULL OR r\.omie_pedido_id IS NOT NULL' FROM defs)
  UNION ALL SELECT 34, '3.1 canonica da reserva: par proprio primeiro, hash_payload preenchido',
         (SELECT cdr ~ 'COALESCE\(r\.omie_pedido_id, push\.omie_pedido_id\)'
                 AND cdr ~ 'c\.hash_payload IS NOT NULL' FROM defs)
  UNION ALL SELECT 35, '3.1 anon SEM execute em atp_confirmar_pv',
         NOT COALESCE(has_function_privilege('anon', to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')::oid, 'EXECUTE'), true)
  UNION ALL SELECT 36, '3.1 authenticated SEM execute em atp_confirmar_pv',
         NOT COALESCE(has_function_privilege('authenticated', to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')::oid, 'EXECUTE'), true)
  -- positivo obrigatório: sem EXECUTE o edge recebe 42501 (não PGRST202, então
  -- NÃO cai no write-back legado) e o write-back falha DEPOIS de o PV existir no
  -- Omie — um REVOKE "a mais" quebraria a criação de pedido inteira
  UNION ALL SELECT 37, '3.1 service_role COM execute em atp_confirmar_pv',
         COALESCE(has_function_privilege('service_role', to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')::oid, 'EXECUTE'), false)
  UNION ALL SELECT 38, '3.1 atp_confirmar_pv tem gate proprio de service_role',
         (SELECT cpv ~ 'auth\.role\(\) IS DISTINCT FROM ''service_role''' FROM defs)
  UNION ALL SELECT 39, '3.1 atp_confirmar_pv trava checkout e SKU (mesmo namespace do reservar)',
         (SELECT cpv ~ '''atp:checkout:''' AND cpv ~ '''atp:sku:''' FROM defs)
  UNION ALL SELECT 40, '3.1 write-back exige EXATAMENTE 1 linha (P0002)',
         (SELECT cpv ~ 'v_n_so <> 1' AND cpv ~ 'P0002' FROM defs)
  -- WRITER ÚNICO: nenhuma outra função escreve o par. service_role não tem UPDATE
  -- na tabela (fase 1.1), então só função DEFINER escreve — e só esta pode.
  UNION ALL SELECT 41, '3.1 writer UNICO do par (nenhuma outra funcao o grava)',
         NOT EXISTS (
           SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('public','private')
             AND p.oid <> COALESCE(to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')::oid, 0)
             AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
                 ~ 'UPDATE\s+(public\.)?estoque_reservas[^;]*omie_(account|pedido_id)\s*=')
         AND NOT has_table_privilege('service_role', 'public.estoque_reservas', 'UPDATE')
  -- o SINAL da fila humana (decisão 2026-10-09: consumo segue humano)
  UNION ALL SELECT 42, '3.1 fila humana expoe o sinal saldo_embute_faturamento',
         COALESCE(pg_get_function_result(to_regprocedure('public.atp_reservas_pendentes(integer)'))
                  ~ 'saldo_embute_faturamento boolean', false)

  -- ══ FASE 3.2 — correções do Codex retroativo da 3.1 ═══════════════════════
  -- CENSO (HEURÍSTICO): as funções que escrevem em estoque_reservas são
  -- exatamente as 7 revisadas. Um writer novo é uma porta nova para soltar
  -- reserva firme (o #2 eram duas portas que ninguém tinha listado). Pega
  -- UPDATE [ONLY] e DELETE FROM [ONLY], com ou sem schema/aspas, em qualquer
  -- schema de usuário, e compara por OID (o nome impresso depende do
  -- search_path). NÃO vê SQL dinâmico (EXECUTE format(...)) — é rede, não prova.
  UNION ALL SELECT 43, '3.2 censo: writers de estoque_reservas = os 7 revisados',
         (SELECT COALESCE(array_agg(p.oid ORDER BY p.oid), '{}')
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast'
             AND regexp_replace(p.prosrc, '--[^\n]*', '', 'g')
                 ~* '(update|delete\s+from)\s+(only\s+)?("?public"?\s*\.\s*)?"?estoque_reservas"?\M')
         = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[
                 to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')::oid,
                 to_regprocedure('public.atp_gate_pedido(uuid,boolean,uuid,boolean,text)')::oid,
                 to_regprocedure('public.atp_resolver_reserva(uuid,text,text)')::oid,
                 to_regprocedure('public.liberar_reserva_checkout(uuid,text,text)')::oid,
                 to_regprocedure('private.atp_reconciliar_job()')::oid,
                 to_regprocedure('private.expirar_reservas_vencidas_job()')::oid,
                 to_regprocedure('public.reservar_estoque(text,uuid,jsonb,integer)')::oid]) AS x)
  UNION ALL SELECT 44, '3.2 reservar_estoque nao substitui reserva firme',
         COALESCE((SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') ~ 'reserva de PV CONFIRMADO'
                     FROM pg_proc WHERE oid = to_regprocedure('public.reservar_estoque(text,uuid,jsonb,integer)')), false)
  UNION ALL SELECT 45, '3.2 liberar_reserva_checkout preserva reserva firme',
         COALESCE((SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') ~ 'preservadas_firmes'
                     FROM pg_proc WHERE oid = to_regprocedure('public.liberar_reserva_checkout(uuid,text,text)')), false)
  UNION ALL SELECT 46, '3.2 sinal da fila exige saldo confiavel e canonica faturada',
         COALESCE((SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') ~ 'saldo_confiavel IS DISTINCT FROM true'
                      AND regexp_replace(prosrc, '--[^\n]*', '', 'g') ~ 'k\.status IS DISTINCT FROM ''faturado'''
                     FROM pg_proc WHERE oid = to_regprocedure('public.atp_reservas_pendentes(integer)')), false)
  UNION ALL SELECT 47, '3.2 CHECK do par recusa conta com PID nulo',
         EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.estoque_reservas'::regclass
                   AND conname = 'estoque_reservas_pv_par_check'
                   AND pg_get_constraintdef(oid) ~ 'omie_pedido_id IS NOT NULL')

  -- ══ FASE 3.3 — a reserva acompanha o PV reconciliado por duplicidade ══════
  UNION ALL SELECT 48, '3.3 atp_confirmar_pv le os itens do PV reconciliado e ajusta a reserva',
         (SELECT cpv ~ 'p_omie_response->>''reconciled''' AND cpv ~ 'pv_divergente'
                 AND cpv ~ 'consulta,pedido_venda_produto,det' FROM defs)
  -- a reserva criada pelo ajuste nasce SEM par e é carimbada depois (o trigger
  -- write-once recusa o par no INSERT): o INSERT vem ANTES do carimbo
  UNION ALL SELECT 49, '3.3 o ajuste roda ANTES do carimbo do par',
         (SELECT strpos(cpv, 'INSERT INTO public.estoque_reservas') > 0
                 AND strpos(cpv, 'INSERT INTO public.estoque_reservas') < strpos(cpv, 'omie_account = p_account')
            FROM defs)
)
SELECT n, CASE WHEN ok THEN 'OK  ' ELSE 'FALHOU' END AS status, item
FROM checks ORDER BY n;

-- Resumo em uma linha (o que colar de volta se algo falhar)
WITH defs AS (
  SELECT regexp_replace(pg_get_functiondef(to_regprocedure('private.atp_disponivel(text,bigint,uuid)')), '--[^\n]*', '', 'g') AS disp
)
SELECT CASE WHEN (SELECT disp ~ 'so\.omie_pedido_id IS NOT NULL' FROM defs)
            AND to_regprocedure('private.atp_reconciliar_job()') IS NOT NULL
       THEN 'FASE 3 APLICADA' ELSE 'FASE 3 NAO APLICADA (ou parcial)' END AS veredito;

-- Veredito da 3.1 (linha própria: 'FASE 3.1 APLICADA' não contém 'FASE 3 APLICADA')
SELECT CASE WHEN to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)') IS NOT NULL
             AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema='public' AND table_name='estoque_reservas' AND column_name='omie_pedido_id')
             AND regexp_replace(pg_get_functiondef(to_regprocedure('private.atp_disponivel(text,bigint,uuid)')), '--[^\n]*', '', 'g')
                 ~ 'OR r\.omie_pedido_id IS NOT NULL'
       THEN 'FASE 3.1 APLICADA' ELSE 'FASE 3.1 NAO APLICADA (ou parcial)' END AS veredito_3_1;

-- Veredito da 3.2 (linha própria)
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                         WHERE conrelid = 'public.estoque_reservas'::regclass
                           AND conname = 'estoque_reservas_pv_par_check'
                           AND pg_get_constraintdef(oid) ~ 'omie_pedido_id IS NOT NULL')
             AND COALESCE((SELECT prosrc ~ 'preservadas_firmes' FROM pg_proc
                            WHERE oid = to_regprocedure('public.liberar_reserva_checkout(uuid,text,text)')), false)
       THEN 'FASE 3.2 APLICADA' ELSE 'FASE 3.2 NAO APLICADA (ou parcial)' END AS veredito_3_2;

-- Veredito da 3.3 (linha própria)
SELECT CASE WHEN COALESCE((SELECT prosrc ~ 'pv_divergente' FROM pg_proc
                            WHERE oid = to_regprocedure('public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)')), false)
       THEN 'FASE 3.3 APLICADA' ELSE 'FASE 3.3 NAO APLICADA (ou parcial)' END AS veredito_3_3;
