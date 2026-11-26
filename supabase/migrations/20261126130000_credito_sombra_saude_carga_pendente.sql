-- Crédito-IA PR 5 (follow-up): a saúde da sombra deixa de contar como "carga pendente" o PV que o
-- lote JÁ OBSERVOU e não pode avaliar (tentativa não-erro: revisao_ausente / valor_ausente /
-- valor_parcial). Medido em prod (2026-11-26): carga_pendente = 22 fixo, os 22 PVs antigos do app sem
-- revisão (anteriores ao PR 3) — nunca drenariam e o sensor parecia carga travada.
-- Continua pendente: PV da carga sem decisão e sem tentativa, OU só com tentativa 'erro' (o lote
-- re-tenta até 3×; depois disso fica aqui de propósito — é defeito real, e erros_24h esquece).
--
-- Só a VIEW muda: mesmas colunas, mesma ordem, mesmo tipo (CREATE OR REPLACE preserva o ACL);
-- security_invoker repetido (omitir RESETA a opção). Idempotente. Sem BEGIN/COMMIT (a transação é do
-- executor). Prova: db/test-credito-sombra.sh (S8 + F13/F14).

DO $pre$
BEGIN
  IF to_regclass('public.credito_sombra_saude') IS NULL OR to_regclass('public.credito_sombra_tentativa') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICAO credito-sombra-saude: a migration 20261125200000 não está aplicada';
  END IF;
END
$pre$;

CREATE OR REPLACE VIEW public.credito_sombra_saude WITH (security_invoker = on) AS
SELECT (SELECT ativado_em FROM public.credito_sombra_marco) AS ativado_em,
       (SELECT max(terminado_em) FROM public.credito_sombra_lote WHERE status = 'ok') AS ultimo_lote_ok,
       -- a linha 'rodando' só existe dentro da transação do lote: o sinal externo é o tempo sem lote ok
       round((extract(epoch FROM now() - (SELECT max(terminado_em) FROM public.credito_sombra_lote
                                           WHERE status = 'ok')) / 60)::numeric, 1) AS minutos_sem_lote,
       (SELECT count(*) FROM public.credito_sombra_tentativa WHERE resultado = 'erro'
          AND criada_em > now() - interval '24 hours') AS erros_24h,
       (SELECT count(*) FROM public.credito_sombra_lote WHERE pendentes > 0
          AND terminado_em > now() - interval '1 hour') AS lotes_com_sobra_1h,
       (SELECT count(*) FROM public.credito_sombra_carga k JOIN public.sales_orders s ON s.id = k.sales_order_id
         WHERE k.situacao = 'aberto' AND s.status NOT IN ('cancelado','rascunho','pendente','orcamento')
           AND NOT EXISTS (SELECT 1 FROM public.credito_sombra_decisao d WHERE d.sales_order_id = k.sales_order_id)
           AND NOT EXISTS (SELECT 1 FROM public.credito_sombra_tentativa t
                            WHERE t.sales_order_id = k.sales_order_id AND t.resultado <> 'erro'))
         AS carga_pendente,
       (SELECT count(*) FROM public.credito_sombra_reserva rs JOIN public.sales_orders s ON s.id = rs.sales_order_id
         WHERE rs.status = 'ativa' AND s.deleted_at IS NOT NULL) AS excluido_app_reserva_ativa;

DO $pos$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class
                  WHERE oid = 'public.credito_sombra_saude'::regclass
                    AND 'security_invoker=on' = ANY (COALESCE(reloptions, '{}'))) THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra-saude: security_invoker perdido';
  END IF;
  -- o ACL segue a allowlist da 20261125200000: fora do dono, só SELECT
  IF EXISTS (SELECT 1 FROM pg_class c,
                    aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
              WHERE c.oid = 'public.credito_sombra_saude'::regclass
                AND a.grantee <> c.relowner AND a.privilege_type <> 'SELECT') THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra-saude: privilégio de escrita fora do dono';
  END IF;
  IF has_table_privilege('anon', 'public.credito_sombra_saude', 'SELECT')
     OR NOT has_table_privilege('authenticated', 'public.credito_sombra_saude', 'SELECT') THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra-saude: ACL de leitura divergente';
  END IF;
  IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
       WHERE attrelid = 'public.credito_sombra_saude'::regclass AND attnum > 0 AND NOT attisdropped)
     <> 'ativado_em,ultimo_lote_ok,minutos_sem_lote,erros_24h,lotes_com_sobra_1h,carga_pendente,excluido_app_reserva_ativa' THEN
    RAISE EXCEPTION 'POSCONDICAO credito-sombra-saude: colunas mudaram';
  END IF;
  RAISE NOTICE 'POSCONDICAO credito-sombra-saude OK';
END
$pos$;
