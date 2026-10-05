-- ============================================================================================
-- 20261001100001 · sales_orders: gêmeos push/pull — contagem única na fonte  [MONEY-PATH]
-- Spec:  docs/superpowers/specs/2026-10-01-gemeos-push-pull-contagem-unica-design.md
-- Prova: db/test-gemeos-push-pull-contagem-unica.sh (PG17: migration real + RPC real do importador)
--
-- O QUE: o pedido que o app empurra ao Omie (linha do APP: hash_payload nulo) e o MESMO pedido
-- trazido pelo importador (linha IMPORTADA: hash 'omie_<account>_<omie_pedido_id>') são duas linhas.
-- Com order_date_kpi nas duas, o universo canônico conta a venda 2x (abril/2026: 22 pares,
-- R$ 12.840,46). A IMPORTADA é a autoridade (é o que o Omie fatura; a do app pode até ser de outro
-- cliente depois que o pedido é reaproveitado no Omie). A linha do app continua existindo (recibo de
-- envio: vendedor, checkout, edição pelo id dela), mas quando a importada existe ela perde o kpi e
-- aponta para a gêmea. O índice único garante no máximo 1 linha com kpi por pedido Omie, venha a
-- escrita de onde vier; os triggers mantêm a marca para qualquer escritor. E a importada SEMPRE tem
-- data (CHECK sales_orders_importada_tem_data): sem ele, uma importada sem order_date_kpi faria a
-- linha do app perder o kpi e a venda sumiria do universo sem alarme (parecer Codex, 2026-10-05).
--
-- LIMITES (spec §5.2 + parecer Codex + revisão final) — nenhum conta a venda em DOBRO (o índice
-- único segura em todos); os de concorrência falham ALTO (40P01), os outros deixam o ponteiro velho
-- ou faltando EM SILÊNCIO:
--  · os triggers da importada são só de INSERT: mudar hash/pid de uma importada existente não
--    re-deriva — as linhas do app do pid antigo ficam com o ponteiro velho (o CHECK canônico amarra
--    o hash ao pid);
--  · S9: UPDATE POSTERIOR que liste uma das 5 colunas observadas pelo trigger do app numa linha que JÁ
--    tem pid, contra o import do mesmo pedido → 40P01. Grave o kpi no INSERT ou no MESMO UPDATE que
--    grava o pid;
--  · DELETE físico de importada contra o reimport do mesmo pedido → 40P01 (a ação da FK dispara o
--    trigger do app). Quem apagar importada pega ANTES o advisory 'sales_orders.gemeo:<account>:<pid>';
--  · o protocolo pressupõe READ COMMITTED: sob REPEATABLE READ o ponteiro pode faltar, em silêncio; a
--    contagem não muda (o índice único não depende de snapshot).
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação
-- (não há BEGIN/COMMIT aqui). Idempotente: reaplicar não muda nada. A postcondição no fim aborta
-- tudo se o estado final não for o desenhado.
-- ============================================================================================

-- ALTER/CREATE TRIGGER/CREATE INDEX em sales_orders: não fila atrás de transação longa
SET LOCAL lock_timeout = '5s';

-- 1) coluna DERIVADA: o único escritor é trg_sales_orders_gemeo_app (valor escrito por fora é recalculado)
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS gemeo_importado_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sales_orders.gemeo_importado_id IS
  'Só em linha do APP (hash_payload nulo): a linha IMPORTADA do mesmo (account, omie_pedido_id). Preenchida = esta linha é recibo de envio, sem order_date_kpi, fora do universo de vendas. Derivada por trg_sales_orders_gemeo_app; não escreva.';

-- 2) índices de apoio: os triggers da importada acham as linhas do app sem varrer a tabela; e a ação
--    da FK auto-referente (ON DELETE SET NULL) acha quem aponta para a linha apagada sem seq scan
CREATE INDEX IF NOT EXISTS idx_sales_orders_app_pedido_omie
  ON public.sales_orders (account, omie_pedido_id)
  WHERE hash_payload IS NULL AND omie_pedido_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_orders_gemeo_importado_id
  ON public.sales_orders (gemeo_importado_id)
  WHERE gemeo_importado_id IS NOT NULL;

-- 3) funções dos triggers. SECURITY DEFINER: a derivação não pode depender da RLS de quem escreve.
CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_app_derivar()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_gemeo uuid;
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
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_importada_antes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Mesmo lock do trigger da linha do app (ver sales_orders_gemeo_app_derivar).
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_orders.gemeo:' || NEW.account || ':' || NEW.omie_pedido_id, 0));
  -- ANTES da inserção: o índice único é imediato e barraria a importada se a linha do app ainda
  -- tivesse kpi. Dispara também quando o INSERT ... ON CONFLICT DO NOTHING acaba não inserindo —
  -- coerente: a importada já existe, e a linha do app não pode ter kpi. Importada SEM data não
  -- chega a existir: o CHECK sales_orders_importada_tem_data recusa a linha proposta (o PG avalia o
  -- CHECK antes do ON CONFLICT) e a falha desfaz este UPDATE junto com o comando.
  UPDATE public.sales_orders a
     SET order_date_kpi = NULL
   WHERE a.account = NEW.account
     AND a.omie_pedido_id = NEW.omie_pedido_id
     AND a.hash_payload IS NULL
     AND a.order_date_kpi IS NOT NULL;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.sales_orders_gemeo_importada_depois()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- DEPOIS da inserção (a FK exige a importada existindo): toca as linhas do app do mesmo pedido
  -- para o trigger delas derivar o ponteiro.
  UPDATE public.sales_orders a
     SET gemeo_importado_id = NEW.id
   WHERE a.account = NEW.account
     AND a.omie_pedido_id = NEW.omie_pedido_id
     AND a.hash_payload IS NULL
     AND a.gemeo_importado_id IS DISTINCT FROM NEW.id;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.sales_orders_gemeo_app_derivar() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_orders_gemeo_importada_antes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_orders_gemeo_importada_depois() FROM PUBLIC, anon, authenticated;

-- 4) triggers
CREATE OR REPLACE TRIGGER trg_sales_orders_gemeo_app
  BEFORE INSERT OR UPDATE OF omie_pedido_id, account, hash_payload, order_date_kpi, gemeo_importado_id
  ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.hash_payload IS NULL)
  EXECUTE FUNCTION public.sales_orders_gemeo_app_derivar();

CREATE OR REPLACE TRIGGER trg_sales_orders_gemeo_importada_antes
  BEFORE INSERT ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.hash_payload LIKE 'omie\_%' AND NEW.omie_pedido_id IS NOT NULL)
  EXECUTE FUNCTION public.sales_orders_gemeo_importada_antes();

CREATE OR REPLACE TRIGGER trg_sales_orders_gemeo_importada_depois
  AFTER INSERT ON public.sales_orders
  FOR EACH ROW
  WHEN (NEW.hash_payload LIKE 'omie\_%' AND NEW.omie_pedido_id IS NOT NULL)
  EXECUTE FUNCTION public.sales_orders_gemeo_importada_depois();

-- 5) backlog: as linhas do app que JÁ têm a importada (25 em 2026-09-30; 22 com kpi). O trigger 1
--    deriva o mesmo resultado; o SET explícito documenta a intenção.
UPDATE public.sales_orders a
   SET gemeo_importado_id = i.id,
       order_date_kpi     = NULL
  FROM public.sales_orders i
 WHERE a.hash_payload IS NULL
   AND a.omie_pedido_id IS NOT NULL
   AND i.account = a.account
   AND i.hash_payload LIKE 'omie\_%'
   AND i.hash_payload = 'omie_' || a.account || '_' || a.omie_pedido_id
   AND (a.gemeo_importado_id IS DISTINCT FROM i.id OR a.order_date_kpi IS NOT NULL);

-- O CONSTRAINT TRIGGER de coerência (trg_pedido_venda_coerencia_cab) é DEFERRED: o UPDATE acima deixa
-- eventos pendentes, e CREATE INDEX/ALTER TABLE na mesma transação recusam tabela com evento pendente
-- (55006 — pego pela prova). Dispara-os agora: as linhas do app não têm order_items, a checagem é vazia.
SET CONSTRAINTS ALL IMMEDIATE;

-- 6) a trava: no máximo 1 linha com kpi por pedido Omie (depois do backfill, senão o backlog a barra)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_kpi_por_pedido_omie
  ON public.sales_orders (account, omie_pedido_id)
  WHERE omie_pedido_id IS NOT NULL AND order_date_kpi IS NOT NULL;

-- 7) a marca é auto-consistente: ponteiro só em linha do app, e nunca junto com kpi. E a importada,
--    que é a autoridade, sempre tem data: vale no INSERT (inclusive o reimport, que o CHECK barra antes
--    do ON CONFLICT) e no UPDATE. Prod em 2026-10-05: 31.687 de 31.687 importadas com kpi.
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sales_orders'::regclass
                    AND conname = 'sales_orders_gemeo_e_recibo') THEN
    ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_gemeo_e_recibo
      CHECK (gemeo_importado_id IS NULL
             OR (hash_payload IS NULL AND order_date_kpi IS NULL AND gemeo_importado_id <> id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.sales_orders'::regclass
                    AND conname = 'sales_orders_importada_tem_data') THEN
    ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_importada_tem_data
      CHECK (hash_payload IS NULL OR hash_payload NOT LIKE 'omie\_%' OR order_date_kpi IS NOT NULL);
  END IF;
END
$chk$;

-- 8) postcondição: aborta a transação inteira se o estado final não for o desenhado
DO $post$
DECLARE
  v_dup        bigint;
  v_sem_ptr    bigint;
  v_ptr_errado bigint;
  v_ptr_kpi    bigint;
  v_obj        int;
  v_acl        int;
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
  -- ACL medido, não declarado (o padrão de 20260907220000): nenhuma role pública executa as SECDEF
  SELECT count(*) INTO v_acl
    FROM (VALUES ('public.sales_orders_gemeo_app_derivar()'), ('public.sales_orders_gemeo_importada_antes()'),
                 ('public.sales_orders_gemeo_importada_depois()')) AS f(sig),
         (VALUES ('public'), ('anon'), ('authenticated')) AS r(papel)
   WHERE has_function_privilege(r.papel, f.sig, 'EXECUTE');
  IF v_dup <> 0 OR v_sem_ptr <> 0 OR v_ptr_errado <> 0 OR v_ptr_kpi <> 0 OR v_obj <> 8 OR v_acl <> 0 THEN
    RAISE EXCEPTION 'POS FALHOU gemeos: dup_kpi=% sem_ponteiro=% ponteiro_errado=% ponteiro_com_kpi=% objetos=%/8 acl_aberto=%',
      v_dup, v_sem_ptr, v_ptr_errado, v_ptr_kpi, v_obj, v_acl;
  END IF;
END
$post$;
