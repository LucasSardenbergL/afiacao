-- 20260722110000_quarentena_omie_clientes_espelho.sql
-- P0-B-bis Fatia 5B — QUARENTENA do espelho `omie_clientes` (o DROP vem depois, em PR próprio).
--
-- ⚠️ ESTA MIGRATION NAO DROPA NADA. A 1a versao dropava; o `/codex challenge` xhigh recusou
--    ("nao aplicar o DROP atual") e a recomendacao dele — RENOMEAR e observar um ciclo — foi aceita.
--    O motivo e honesto: eu havia provado ausencia de dependente INTERNO (pg_depend, corpos SQL,
--    grep no repo) e tratado isso como ausencia de consumidor. Nao e a mesma coisa. Ninguem desses
--    metodos enxerga um chamador PostgREST de FORA do repo — Zapier, n8n, planilha, BI, app cacheado
--    ou job mensal dormente. E `anon`/`authenticated` TEM SELECT nesta tabela via default privilege
--    do Supabase (medido: `information_schema.role_table_grants` vem VAZIO, mas `has_table_privilege`
--    devolve `true`), entao `GET /rest/v1/omie_clientes` responde a qualquer JWT sob a RLS staff-only.
--
-- POR QUE RENAME E ESTRITAMENTE MELHOR QUE DROP+ARQUIVO:
--   • quebra os mesmos consumidores que o DROP quebraria (mesmo poder de deteccao), mas a
--     RECUPERACAO e um `ALTER TABLE ... RENAME` de volta — segundos, sem restore;
--   • preserva os 6909 registros COM a estrutura, os indices e as constraints, em vez de uma copia
--     CTAS que perde tudo isso;
--   • elimina a janela de escrita concorrente do `CREATE TABLE AS` (o rename e instantaneo sob lock);
--   • dispensa o `IF NOT EXISTS` do arquivo — que era um BUG REAL apontado pelo Codex: com um
--     arquivo preexistente (re-run parcial) ele PULARIA a copia em silencio e dropava assim mesmo.
--
-- O QUE ISTO PRESERVA e que uma copia perderia: `omie_codigo_cliente_integracao` — 41 linhas, mas
-- so 32 valores DISTINTOS, e 9 delas SEM conta identificavel via proof (medido por psql-ro em 19/07).
-- Ou seja: a proveniencia de conta de 9 registros nao e reconstruivel de lugar nenhum. Enquanto a
-- tabela existe em quarentena, ela mesma e a fonte.
--
-- ============================================================================
-- EVIDENCIA ja reunida (o que a quarentena vem COMPLETAR, nao substituir)
-- ============================================================================
--  • preflight `db/preflight-dependencia-tabela.sql`: ZERO acionaveis (a classe `rotina` sumiu
--    depois da Fatia 5A); so restam objetos DA PROPRIA tabela;
--  • zero leitores vivos: `from('omie_clientes')` nao existe em `src/` nem em `supabase/functions/`;
--  • prova de comportamento discriminante: no run de 19/07 05:00 a proof avancou
--    (`omie_customer_account_map(oben)` -> 05:02:41) e o espelho ficou PARADO em 18/07 05:02:40;
--    o scoring levou `farmer_client_scores` de 6256 -> 6632 e zerou a fila do seed (392 -> 0);
--  • Realtime: fora de `supabase_realtime`, `realtime.subscription` = 0, `pg_stat_activity` = 0.
--  • O QUE FALTA, e so o tempo dá: consumidor externo DORMENTE (job semanal/mensal). E exatamente
--    o que a janela de quarentena mede.
--
-- ============================================================================
BEGIN;

-- 1) LOCK explicito ANTES de tudo. `NOWAIT` faz falhar na hora se houver transacao concorrente
--    escrevendo/lendo, em vez de esperar em silencio atras de um lock (o writer esta morto ha 1d,
--    entao isto deve ser instantaneo — se travar, e sinal de que ALGO ainda a usa: nao force).
LOCK TABLE public.omie_clientes IN ACCESS EXCLUSIVE MODE NOWAIT;

-- 2) A quarentena. RENAME preserva dado, indices, constraints, policies, RLS e triggers.
ALTER TABLE public.omie_clientes RENAME TO _quarantine_omie_clientes_20260722;

COMMENT ON TABLE public._quarantine_omie_clientes_20260722 IS
  'QUARENTENA do espelho omie_clientes (P0-B-bis Fatia 5B, 2026-07-22). Renomeada, nao dropada, '
  'para detectar consumidor externo dormente (PostgREST/Zapier/n8n/BI) que nenhum grep enxerga. '
  'REVERSAO: ALTER TABLE public._quarantine_omie_clientes_20260722 RENAME TO omie_clientes; '
  '+ re-conceder os grants. DROP definitivo so apos um ciclo completo sem erro — ver o PR de fecho. '
  'Guarda o unico dado nao-reconstruivel: omie_codigo_cliente_integracao (41 linhas / 32 distintos, '
  '9 delas sem conta identificavel na proof).';

-- 3) Fecha o acesso via PostgREST. E ISTO que transforma a quarentena em detector: um consumidor
--    externo passa a receber 42501/PGRST, e o erro aparece no Logs Explorer com URL e horario.
--    `REVOKE FROM PUBLIC` sozinho NAO tira anon/authenticated (grant proprio por default privilege
--    do Supabase — database.md §5) => revogar os tres por nome.
REVOKE ALL ON public._quarantine_omie_clientes_20260722 FROM PUBLIC, anon, authenticated;

-- 4) VALIDACAO DENTRO DA TRANSACAO, antes do COMMIT (correcao do Codex: as validacoes da 1a versao
--    rodavam DEPOIS do commit, entao detectavam a quebra mas nao a revertiam). `LANGUAGE sql` e
--    late-bound: so o EXECUTE prova. Se qualquer uma quebrar aqui, a excecao aborta a transacao e a
--    tabela volta ao nome original sozinha — sem intervencao humana.
DO $$
DECLARE
  n_checks int;
  n_alvos  int;
BEGIN
  SELECT count(*) INTO n_checks FROM public._data_health_compute();
  IF n_checks <> 24 THEN
    RAISE EXCEPTION 'Sentinela quebrou sem o espelho: esperados 24 checks, vieram %', n_checks;
  END IF;

  -- o valor nao importa (pode ser 0); o requisito e EXECUTAR sem 42P01
  SELECT count(*) INTO n_alvos FROM public.seed_targets_faltantes();
  RAISE NOTICE 'OK: _data_health_compute=% checks · seed_targets_faltantes=% alvos', n_checks, n_alvos;

  IF to_regclass('public.omie_clientes') IS NOT NULL THEN
    RAISE EXCEPTION 'rename nao surtiu efeito: public.omie_clientes ainda existe';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- Validacao pos-apply (cole no SQL Editor apos o Run).
-- Espere: espelho_sumiu=t · quarentena_linhas=6909 · integracao=41 · anon_le=f · authenticated_le=f
--         checks=24
-- ============================================================================
SELECT
  to_regclass('public.omie_clientes') IS NULL                                              AS espelho_sumiu,
  (SELECT count(*) FROM public._quarantine_omie_clientes_20260722)                         AS quarentena_linhas,
  (SELECT count(*) FROM public._quarantine_omie_clientes_20260722
     WHERE omie_codigo_cliente_integracao IS NOT NULL)                                     AS integracao,
  has_table_privilege('anon','public._quarantine_omie_clientes_20260722','SELECT')          AS anon_le,
  has_table_privilege('authenticated','public._quarantine_omie_clientes_20260722','SELECT') AS authenticated_le,
  (SELECT count(*) FROM public._data_health_compute())                                      AS checks;

-- ============================================================================
-- ⏱️ DURANTE A JANELA (rode no Logs Explorer do Supabase, nao aqui): alguem bateu na tabela?
--   select cast(timestamp as datetime) ts, method, url, status_code
--   from edge_logs
--   cross join unnest(metadata) as metadata
--   cross join unnest(request)  as request
--   cross join unnest(response) as response
--   where regexp_contains(url, '/rest/v1/omie_clientes(?:\?|$)')
--   order by ts desc limit 1000;
-- ⚠️ A retencao do Logs Explorer depende do plano (Free 1d · Pro 7d · Team 28d · Enterprise 90d):
--    "zero hits" so cobre o periodo retido — nao prova ausencia de job MENSAL.
--
-- ROLLBACK (se algo quebrar, a qualquer momento):
--   ALTER TABLE public._quarantine_omie_clientes_20260722 RENAME TO omie_clientes;
--   GRANT SELECT, INSERT, UPDATE, DELETE ON public.omie_clientes TO anon, authenticated;
-- ============================================================================
