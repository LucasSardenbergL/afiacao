-- ============================================================================================
-- A venda empurrada entra no universo canonico NO ENVIO: o trigger da linha do app deriva o kpi
-- ============================================================================================
-- Desde 20261001100001 os gemeos push/pull contam 1x (so order_date_kpi): a importada e a venda e a
-- linha do app vira recibo (kpi NULL + gemeo_importado_id). Mas nenhum escritor do app grava o kpi:
-- a venda empurrada so entrava no universo quando o importador trazia a gemea (~2 h), e a que nunca
-- volta ficava fora. Aqui o trigger da linha do app (trg_sales_orders_gemeo_app ->
-- sales_orders_gemeo_app_derivar) passa a DERIVAR o kpi no ENVIO:
--  * ENVIO = a linha passa a ter omie_pedido_id (UPDATE com OLD.omie_pedido_id nulo: o write-back do
--    criarPedidoVenda) ou ja nasce com ele (INSERT). O UPDATE do trigger da importada, que zera este
--    kpi antes de a importada entrar, nao e envio e nao re-deriva - se re-derivasse, o indice unico
--    barraria a importada (23505).
--  * so se o kpi vier vazio (kpi explicito e respeitado) e se nenhuma OUTRA linha do mesmo pedido ja
--    tiver kpi (a 2a linha do app cairia em 23505 no write-back, depois de o Omie aceitar).
--  * a data e o DIA DE SAO PAULO do instante, nunca o de UTC (a prod roda com TimeZone=UTC).
--  * o instante vem de public.sales_orders_instante_envio() = statement_timestamp(): a chegada do
--    UPDATE do write-back, antes de qualquer espera de lock (now() seria o inicio da transacao;
--    clock_timestamp() incluiria a espera). A funcao existe para a prova fixar o instante.
--  * nenhum lock novo, nenhum escritor novo, nenhum UPDATE posterior nas 5 colunas observadas: a
--    regra "kpi so no INSERT ou no MESMO UPDATE do write-back" vale por construcao.
-- Os 3 triggers, o indice unico e os 2 CHECKs da 20261001100001 NAO mudam. Sem backfill (0 candidatas).
--
-- Corpo de partida = o de PROD, conferido em 2026-10-05 (md5 do prosrc):
--   sales_orders_gemeo_app_derivar  cc036077756a992f97835f383686e110 = 20261001100001
--   sales_orders_instante_envio     ausente (nasce aqui)
-- Spec: docs/superpowers/specs/2026-10-05-app-grava-kpi-no-envio-design.md (5.1, 5.2)
-- Aplicacao: `bun run db:aplicar` (o EXECUTOR fornece a transacao - por isso nao ha BEGIN/COMMIT aqui).
-- Prova: db/test-sales-orders-kpi-no-envio.sh (PG17, com --falsificar).
-- ============================================================================================
SET LOCAL lock_timeout = '5s';

-- ── PRE: trava e identidade, ANTES de ler (idioma da 20261005150000) ─────────────────────────
-- O ALTER ... SET search_path com o MESMO valor atualiza a linha de pg_proc: um CREATE OR REPLACE
-- concorrente espera esta transacao e falha. Funcao ausente ABORTA. Identidade = md5 EXATO; aceita o
-- predecessor (1o apply) ou ESTA versao (re-aplicacao idempotente); qualquer outro corpo aborta. A
-- costura, se ja existir, tem de ser a desta versao.
DO $pre$
DECLARE
  v_md5  text;
  v_md5i text;
BEGIN
  ALTER FUNCTION public.sales_orders_gemeo_app_derivar() SET search_path = public;

  SELECT md5(p.prosrc) INTO v_md5
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.sales_orders_gemeo_app_derivar()');
  IF v_md5 IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.sales_orders_gemeo_app_derivar() ausente depois da trava.';
  END IF;
  IF v_md5 <> 'cc036077756a992f97835f383686e110' AND v_md5 <> '7b7a749a30c7167b0e4b3808447e81cc' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.sales_orders_gemeo_app_derivar() tem corpo md5 % - nem o predecessor '
                    '(cc036077756a992f97835f383686e110) nem esta versao (7b7a749a30c7167b0e4b3808447e81cc). Outro aplicador '
                    'recriou a funcao depois do pre-voo; este apply o REVERTERIA. Remonte a migration sobre o '
                    'pg_get_functiondef vivo.', v_md5;
  END IF;

  SELECT md5(p.prosrc) INTO v_md5i
    FROM pg_proc p
   WHERE p.oid = to_regprocedure('public.sales_orders_instante_envio()');
  IF v_md5i IS NOT NULL AND v_md5i <> '6ed605927fb4412b264619cbcbe34ceb' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.sales_orders_instante_envio() ja existe com corpo md5 % (esta versao: '
                    '6ed605927fb4412b264619cbcbe34ceb). Remonte a migration sobre o pg_get_functiondef vivo.', v_md5i;
  END IF;
END
$pre$;

-- ── a costura do relogio ─────────────────────────────────────────────────────────────────────
-- INVOKER e sem EXECUTE publico: o unico chamador e o trigger SECURITY DEFINER, que roda como o dono.
CREATE OR REPLACE FUNCTION public.sales_orders_instante_envio()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT pg_catalog.statement_timestamp()
$function$;

-- ── o trigger da linha do app: igual a 20261001100001 + o ramo do ENVIO ────────────────────────
CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_app_derivar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gemeo uuid;
  v_envio boolean;
BEGIN
  -- Linha do app ainda não empurrada: não há gêmea possível.
  IF NEW.omie_pedido_id IS NULL THEN
    NEW.gemeo_importado_id := NULL;
    RETURN NEW;
  END IF;
  -- Serializa com o trigger da importada do MESMO pedido (write-back x importador). Quem chega
  -- depois vê o commit do outro: o SELECT abaixo roda com snapshot novo, depois do lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_orders.gemeo:' || NEW.account || ':' || NEW.omie_pedido_id, 0));
  SELECT i.id INTO v_gemeo
    FROM public.sales_orders i
   WHERE i.account = NEW.account
     AND i.hash_payload LIKE 'omie\_%'
     AND i.hash_payload = 'omie_' || NEW.account || '_' || NEW.omie_pedido_id;
  NEW.gemeo_importado_id := v_gemeo;
  IF v_gemeo IS NOT NULL THEN
    NEW.order_date_kpi := NULL;
  ELSIF NEW.order_date_kpi IS NULL THEN
    -- ENVIO = a linha que não tinha pedido Omie e passa a ter (write-back), ou que já nasce com ele.
    -- O UPDATE do trigger da importada (que zera este kpi) não é envio: não re-deriva.
    IF TG_OP = 'INSERT' THEN
      v_envio := true;
    ELSE
      v_envio := OLD.omie_pedido_id IS NULL;
    END IF;
    -- Outra linha do MESMO pedido já com kpi: não deriva (o índice único barraria este write-back).
    -- A própria linha também casa aqui quando o UPDATE não é envio (a versão velha dela tem o kpi):
    -- trava de reserva contra re-derivar no import, se a condição de envio um dia falhar.
    IF v_envio AND NOT EXISTS (SELECT 1 FROM public.sales_orders o
                                WHERE o.account = NEW.account
                                  AND o.omie_pedido_id = NEW.omie_pedido_id
                                  AND o.order_date_kpi IS NOT NULL) THEN
      -- O dia de São Paulo do envio, nunca o de UTC (a prod roda com TimeZone=UTC).
      NEW.order_date_kpi := (public.sales_orders_instante_envio() AT TIME ZONE 'America/Sao_Paulo')::date;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.sales_orders_instante_envio()    FROM PUBLIC, anon, authenticated;
-- redundante sob CREATE OR REPLACE (preserva o ACL da 20261001100001); fica como contrato
REVOKE ALL ON FUNCTION public.sales_orders_gemeo_app_derivar() FROM PUBLIC, anon, authenticated;

-- ── POS: invariantes dos gemeos + objetos + ACL medido + identidade dos corpos ─────────────────
DO $post$
DECLARE
  v_dup        bigint;
  v_sem_ptr    bigint;
  v_ptr_errado bigint;
  v_ptr_kpi    bigint;
  v_obj        int;
  v_acl        int;
  v_md5_der    text;
  v_md5_ins    text;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT 1 FROM public.sales_orders
     WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL
     GROUP BY account, omie_pedido_id HAVING count(*) > 1) d;
  SELECT count(*) INTO v_sem_ptr
    FROM public.sales_orders a
    JOIN public.sales_orders i
      ON i.account = a.account AND i.hash_payload LIKE 'omie\_%'
     AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
   WHERE a.hash_payload IS NULL AND a.omie_pedido_id IS NOT NULL
     AND a.gemeo_importado_id IS DISTINCT FROM i.id;
  SELECT count(*) INTO v_ptr_errado
    FROM public.sales_orders a
   WHERE a.gemeo_importado_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders i
                      WHERE i.id = a.gemeo_importado_id AND i.account = a.account
                        AND i.omie_pedido_id = a.omie_pedido_id AND i.hash_payload LIKE 'omie\_%');
  SELECT count(*) INTO v_ptr_kpi
    FROM public.sales_orders WHERE gemeo_importado_id IS NOT NULL AND order_date_kpi IS NOT NULL;
  SELECT (SELECT count(*) FROM pg_trigger
           WHERE tgrelid = 'public.sales_orders'::regclass AND NOT tgisinternal AND tgenabled <> 'D'
             AND tgname IN ('trg_sales_orders_gemeo_app', 'trg_sales_orders_gemeo_importada_antes',
                            'trg_sales_orders_gemeo_importada_depois'))
       + (SELECT count(*) FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname IN ('uniq_sales_orders_kpi_por_pedido_omie', 'idx_sales_orders_app_pedido_omie',
                               'idx_sales_orders_gemeo_importado_id'))
       + (SELECT count(*) FROM pg_constraint
           WHERE conrelid = 'public.sales_orders'::regclass
             AND conname IN ('sales_orders_gemeo_e_recibo', 'sales_orders_importada_tem_data'))
    INTO v_obj;
  -- ACL medido, nao declarado: nenhuma role publica executa as 3 SECDEF dos gemeos nem a costura
  SELECT count(*) INTO v_acl
    FROM (VALUES ('public.sales_orders_gemeo_app_derivar()'), ('public.sales_orders_gemeo_importada_antes()'),
                 ('public.sales_orders_gemeo_importada_depois()'), ('public.sales_orders_instante_envio()')) AS f(sig),
         (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
   WHERE has_function_privilege(r.papel, f.sig, 'EXECUTE');
  IF v_dup <> 0 OR v_sem_ptr <> 0 OR v_ptr_errado <> 0 OR v_ptr_kpi <> 0 OR v_obj <> 8 OR v_acl <> 0 THEN
    RAISE EXCEPTION 'POS FALHOU kpi-no-envio: dup_kpi=% sem_ponteiro=% ponteiro_errado=% ponteiro_com_kpi=% objetos=%/8 acl_aberto=%',
      v_dup, v_sem_ptr, v_ptr_errado, v_ptr_kpi, v_obj, v_acl;
  END IF;

  SELECT md5(prosrc) INTO v_md5_der FROM pg_proc WHERE oid = 'public.sales_orders_gemeo_app_derivar()'::regprocedure;
  SELECT md5(prosrc) INTO v_md5_ins FROM pg_proc WHERE oid = 'public.sales_orders_instante_envio()'::regprocedure;
  IF v_md5_der IS DISTINCT FROM '7b7a749a30c7167b0e4b3808447e81cc' OR v_md5_ins IS DISTINCT FROM '6ed605927fb4412b264619cbcbe34ceb' THEN
    RAISE EXCEPTION 'POS FALHOU kpi-no-envio md5: derivar=% instante=% (esperado 7b7a749a30c7167b0e4b3808447e81cc / 6ed605927fb4412b264619cbcbe34ceb)',
      v_md5_der, v_md5_ins;
  END IF;
END
$post$;
