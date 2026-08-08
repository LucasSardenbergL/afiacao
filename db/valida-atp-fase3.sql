-- ============================================================
-- Validação PÓS-APPLY — ATP fase 3 (20260808012000_atp_reconciliacao_fase3.sql)
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
    regexp_replace(pg_get_functiondef(to_regprocedure('public.atp_resolver_reserva(uuid,text,text)')), '--[^\n]*', '', 'g') AS res
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
         (SELECT disp ~ 'r\.expira_em > now\(\)\s*OR EXISTS' AND disp ~ 'so\.omie_pedido_id IS NOT NULL' FROM defs)
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
         (SELECT rec ~ 'atp_pedido_canonico' FROM defs)
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
