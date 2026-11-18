-- DERIVADO de supabase/migrations/20261119100000_calendario_operacao.sql para `bun run db:aplicar` (a transação é do executor): idêntico ao original exceto as linhas BEGIN; e COMMIT; removidas. Não editar à mão.
-- =====================================================================================================================
-- Calendário de operação — Etapa 1 (Task 1): esquema, RLS, log por trigger e funções de data.
-- Spec: docs/superpowers/specs/2026-11-18-calendario-operacao-design.md §6.1 · Prova: db/test-calendario-operacao.sh
--
-- ⚠️ MIGRATION MANUAL (nome custom: o Lovable NÃO aplica). Idempotente: IF NOT EXISTS / OR REPLACE / DROP+CREATE
--    de policy e trigger. Termina com postcondição embutida (DO $post$) — aborta se o estado ficou insuficiente.
--
-- O que cria:
--   · calendario_operacao_empresa    — SÓ exceções (dia ausente = regra base: seg–sex aberto, sáb/dom fechado).
--   · calendario_operacao_fornecedor — dias FECHADOS do fornecedor (presença da linha = fechado), por empresa.
--   · calendario_operacao_log        — antes/depois de toda escrita nas duas (trigger AFTER, 1 writer).
--   · pedido_compra_sugerido.data_recebimento_prevista / recebimento_ajustado_calendario (NULL = não calculado).
--   · calendario_proximo_dia_recebimento · calendario_somar_dias_uteis_fornecedor · calendario_dias_sem_nf.
--
-- Autorização:
--   · Tabelas: leitura staff (master|employee), escrita só master — policies no formato initplan do repo
--     ((SELECT has_role(auth.uid(), …))). O enum de prod é {master,employee,customer}: não existe 'admin'.
--   · Funções: SECURITY INVOKER (a RLS das tabelas vale para quem chama) + gate na FRONTEIRA: JWT com sub que não
--     é staff → 42501 (sem o gate o customer receberia a regra base, i.e. uma data inventada). Sessão sem sub
--     (service_role da edge, SQL Editor) passa. EXECUTE revogado de PUBLIC e anon; concedido a authenticated e
--     service_role.
--   · Trigger de log: SECURITY DEFINER (o master escreve a tabela sob RLS; o log não tem policy de escrita).
--
-- Money-path (ausente ≠ zero): nenhuma função inventa data — entrada NULL → NULL; sem dia aberto em 60 dias → NULL;
-- fornecedor NULL → NULL (não "sem fechamento").
-- =====================================================================================================================

-- ── 1) Tabelas ───────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.calendario_operacao_empresa (
  data          date         NOT NULL,
  empresa       text         NOT NULL CONSTRAINT calendario_operacao_empresa_empresa_chk
                               CHECK (empresa IN ('OBEN', 'COLACOR')),
  status        text         NOT NULL CONSTRAINT calendario_operacao_empresa_status_chk
                               CHECK (status IN ('aberto', 'fechado', 'meia_equipe', 'pendente_dado')),
  peso          numeric(3,2) NOT NULL CONSTRAINT calendario_operacao_empresa_peso_chk
                               CHECK (peso BETWEEN 0 AND 1),
  motivo        text,
  origem        text         NOT NULL CONSTRAINT calendario_operacao_empresa_origem_chk
                               CHECK (origem IN ('escala', 'feriado', 'emenda', 'manual', 'deteccao', 'historico')),
  decidido_por  uuid                  DEFAULT auth.uid(),
  atualizado_em timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT calendario_operacao_empresa_fechado_peso_chk CHECK (status <> 'fechado' OR peso = 0),
  PRIMARY KEY (data, empresa)
);

COMMENT ON TABLE public.calendario_operacao_empresa IS
  'Calendário de operação: SÓ exceções por (data, empresa). Dia ausente = regra base (seg–sex aberto, sáb/dom '
  'fechado). pendente_dado = dia passado sem explicação (não conta como aberto nem como fechado). Spec 2026-11-18 §6.1.';

CREATE TABLE IF NOT EXISTS public.calendario_operacao_fornecedor (
  data            date        NOT NULL,
  empresa         text        NOT NULL CONSTRAINT calendario_operacao_fornecedor_empresa_chk
                                CHECK (empresa IN ('OBEN', 'COLACOR')),
  fornecedor_nome text        NOT NULL CONSTRAINT calendario_operacao_fornecedor_nome_chk
                                CHECK (btrim(fornecedor_nome) <> ''),
  motivo          text,
  origem          text        NOT NULL CONSTRAINT calendario_operacao_fornecedor_origem_chk
                                CHECK (origem IN ('escala', 'feriado', 'emenda', 'manual', 'deteccao', 'historico')),
  decidido_por    uuid                 DEFAULT auth.uid(),
  atualizado_em   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (data, empresa, fornecedor_nome)
);

COMMENT ON TABLE public.calendario_operacao_fornecedor IS
  'Dias FECHADOS do fornecedor por empresa (presença da linha = fechado). Casamento por lower(btrim(fornecedor_nome)) '
  'contra pedido_compra_sugerido.fornecedor_nome. Spec 2026-11-18 §6.1.';

CREATE INDEX IF NOT EXISTS calendario_operacao_fornecedor_busca_idx
  ON public.calendario_operacao_fornecedor (empresa, lower(btrim(fornecedor_nome)), data);

CREATE TABLE IF NOT EXISTS public.calendario_operacao_log (
  id       bigserial   PRIMARY KEY,
  tabela   text        NOT NULL,
  operacao text        NOT NULL,
  antes    jsonb,
  depois   jsonb,
  por      uuid,
  em       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.calendario_operacao_log IS
  'Antes/depois de toda escrita em calendario_operacao_empresa/_fornecedor (1 writer: trigger '
  'calendario_operacao__registrar_log). Reconstrói a versão do calendário usada num cálculo.';

ALTER TABLE public.pedido_compra_sugerido ADD COLUMN IF NOT EXISTS data_recebimento_prevista date NULL;
ALTER TABLE public.pedido_compra_sugerido ADD COLUMN IF NOT EXISTS recebimento_ajustado_calendario boolean NULL;

COMMENT ON COLUMN public.pedido_compra_sugerido.data_recebimento_prevista IS
  'Data prevista de recebimento já ajustada ao calendário de operação (NULL = não calculada).';
COMMENT ON COLUMN public.pedido_compra_sugerido.recebimento_ajustado_calendario IS
  'true = o dia fechado da EMPRESA empurrou o recebimento além da promessa do fornecedor (data_recebimento_prevista > '
  'promessa); false = calculada pelo calendário e recebida no próprio dia da promessa (o recesso do FORNECEDOR pode '
  'ter movido a promessa e ainda assim dar false); NULL = não calculada (legado ou calendário indisponível).';

-- ── 2) Log por trigger ───────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.calendario_operacao__registrar_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.calendario_operacao_log (tabela, operacao, antes, depois, por)
  VALUES (TG_TABLE_NAME, TG_OP,
          CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END,
          CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END,
          auth.uid());
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.calendario_operacao__registrar_log() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS calendario_operacao_empresa_log ON public.calendario_operacao_empresa;
CREATE TRIGGER calendario_operacao_empresa_log
  AFTER INSERT OR UPDATE OR DELETE ON public.calendario_operacao_empresa
  FOR EACH ROW EXECUTE FUNCTION public.calendario_operacao__registrar_log();

DROP TRIGGER IF EXISTS calendario_operacao_fornecedor_log ON public.calendario_operacao_fornecedor;
CREATE TRIGGER calendario_operacao_fornecedor_log
  AFTER INSERT OR UPDATE OR DELETE ON public.calendario_operacao_fornecedor
  FOR EACH ROW EXECUTE FUNCTION public.calendario_operacao__registrar_log();

-- ── 3) RLS + privilégios ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.calendario_operacao_empresa    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendario_operacao_fornecedor ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendario_operacao_log        ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.calendario_operacao_empresa    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.calendario_operacao_fornecedor FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.calendario_operacao_log        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.calendario_operacao_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendario_operacao_empresa    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.calendario_operacao_fornecedor TO authenticated;
GRANT SELECT                         ON public.calendario_operacao_log        TO authenticated;
GRANT ALL ON public.calendario_operacao_empresa, public.calendario_operacao_fornecedor, public.calendario_operacao_log
  TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.calendario_operacao_log_id_seq TO service_role;

-- empresa
DROP POLICY IF EXISTS calendario_operacao_empresa_sel ON public.calendario_operacao_empresa;
CREATE POLICY calendario_operacao_empresa_sel ON public.calendario_operacao_empresa
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::public.app_role)));
DROP POLICY IF EXISTS calendario_operacao_empresa_ins ON public.calendario_operacao_empresa;
CREATE POLICY calendario_operacao_empresa_ins ON public.calendario_operacao_empresa
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)));
DROP POLICY IF EXISTS calendario_operacao_empresa_upd ON public.calendario_operacao_empresa;
CREATE POLICY calendario_operacao_empresa_upd ON public.calendario_operacao_empresa
  FOR UPDATE TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)))
  WITH CHECK ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)));
DROP POLICY IF EXISTS calendario_operacao_empresa_del ON public.calendario_operacao_empresa;
CREATE POLICY calendario_operacao_empresa_del ON public.calendario_operacao_empresa
  FOR DELETE TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)));

-- fornecedor
DROP POLICY IF EXISTS calendario_operacao_fornecedor_sel ON public.calendario_operacao_fornecedor;
CREATE POLICY calendario_operacao_fornecedor_sel ON public.calendario_operacao_fornecedor
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::public.app_role)));
DROP POLICY IF EXISTS calendario_operacao_fornecedor_ins ON public.calendario_operacao_fornecedor;
CREATE POLICY calendario_operacao_fornecedor_ins ON public.calendario_operacao_fornecedor
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)));
DROP POLICY IF EXISTS calendario_operacao_fornecedor_upd ON public.calendario_operacao_fornecedor;
CREATE POLICY calendario_operacao_fornecedor_upd ON public.calendario_operacao_fornecedor
  FOR UPDATE TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)))
  WITH CHECK ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)));
DROP POLICY IF EXISTS calendario_operacao_fornecedor_del ON public.calendario_operacao_fornecedor;
CREATE POLICY calendario_operacao_fornecedor_del ON public.calendario_operacao_fornecedor
  FOR DELETE TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)));

-- log: só leitura staff; sem policy de escrita (o writer é o trigger SECURITY DEFINER).
DROP POLICY IF EXISTS calendario_operacao_log_sel ON public.calendario_operacao_log;
CREATE POLICY calendario_operacao_log_sel ON public.calendario_operacao_log
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::public.app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::public.app_role)));

-- ── 4) Funções de data ───────────────────────────────────────────────────────────────────────────────────────────
-- 1º dia ≥ p_data aberto para a empresa: linha 'aberto'/'meia_equipe', ou dia útil (seg–sex) sem linha.
-- 'fechado' e 'pendente_dado' não são abertos. Busca em [p_data, p_data+59]; nada aberto → NULL.
CREATE OR REPLACE FUNCTION public.calendario_proximo_dia_recebimento(p_empresa text, p_data date)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_d   date;
BEGIN
  IF v_uid IS NOT NULL AND NOT (public.has_role(v_uid, 'master'::public.app_role)
                                OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[CALENDARIO-SEM-PERMISSAO] calendario de operacao e restrito a staff';
  END IF;
  IF p_empresa IS NULL OR p_data IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT g.d::date INTO v_d
    FROM generate_series(p_data::timestamp, (p_data + 59)::timestamp, interval '1 day') AS g(d)
    LEFT JOIN public.calendario_operacao_empresa c
      ON c.data = g.d::date AND c.empresa = p_empresa
   WHERE CASE WHEN c.data IS NULL THEN extract(isodow FROM g.d) < 6
              ELSE c.status IN ('aberto', 'meia_equipe') END
   ORDER BY g.d
   LIMIT 1;

  RETURN v_d;   -- NULL quando não há dia aberto em 60 dias: nunca data inventada
END;
$$;

-- Mesma semântica de somarDiasUteis (supabase/functions/disparar-pedidos-aprovados/previsao.ts): p_n ≤ 0 devolve
-- p_de; senão avança dia a dia contando seg–sex. Fornecedor fechado = sáb/dom ∪ calendario_feriados tipo='nacional'
-- ∪ linhas do fornecedor na empresa (feriado municipal/estadual NÃO fecha fornecedor de outra praça).
-- calendario_feriados é lido sob a RLS de quem chama (INVOKER): policy staff_calendario_feriados_select = master|
-- employee (medido em prod, 2026-11-18) — o mesmo recorte do gate abaixo; a prova checa isso como employee.
CREATE OR REPLACE FUNCTION public.calendario_somar_dias_uteis_fornecedor(p_empresa text, p_fornecedor text, p_de date, p_n int)
RETURNS date
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_d      date := p_de;
  v_somado int  := 0;
  v_passos int  := 0;
BEGIN
  IF v_uid IS NOT NULL AND NOT (public.has_role(v_uid, 'master'::public.app_role)
                                OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[CALENDARIO-SEM-PERMISSAO] calendario de operacao e restrito a staff';
  END IF;
  IF p_empresa IS NULL OR p_fornecedor IS NULL OR p_de IS NULL OR p_n IS NULL THEN
    RETURN NULL;
  END IF;

  WHILE v_somado < p_n LOOP
    v_d := v_d + 1;
    v_passos := v_passos + 1;
    IF v_passos > p_n + 366 THEN
      RETURN NULL;   -- fornecedor fechado por mais de um ano: não inventa data
    END IF;
    IF extract(isodow FROM v_d) < 6
       AND NOT EXISTS (SELECT 1 FROM public.calendario_feriados fe
                        WHERE fe.data = v_d AND fe.tipo = 'nacional')
       AND NOT EXISTS (SELECT 1 FROM public.calendario_operacao_fornecedor f
                        WHERE f.data = v_d AND f.empresa = p_empresa
                          AND lower(btrim(f.fornecedor_nome)) = lower(btrim(p_fornecedor))) THEN
      v_somado := v_somado + 1;
    END IF;
  END LOOP;

  RETURN v_d;
END;
$$;

-- Dias úteis (seg–sex) sem linha de calendário e sem NF emitida, até hoje(SP)−3 (NF tardia ainda chega).
-- Só OBEN: a COLACOR não tem NF em v_venda_items_history_efetivo (medido em prod, 2026-11-18) → vazio.
CREATE OR REPLACE FUNCTION public.calendario_dias_sem_nf(p_empresa text, p_de date, p_ate date)
RETURNS SETOF date
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_corte date := (now() AT TIME ZONE 'America/Sao_Paulo')::date - 3;
BEGIN
  IF v_uid IS NOT NULL AND NOT (public.has_role(v_uid, 'master'::public.app_role)
                                OR public.has_role(v_uid, 'employee'::public.app_role)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = '[CALENDARIO-SEM-PERMISSAO] calendario de operacao e restrito a staff';
  END IF;
  IF p_empresa IS DISTINCT FROM 'OBEN' OR p_de IS NULL OR p_ate IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT g.d::date
      FROM generate_series(p_de::timestamp, p_ate::timestamp, interval '1 day') AS g(d)
     WHERE extract(isodow FROM g.d) < 6
       AND g.d::date <= v_corte
       AND NOT EXISTS (SELECT 1 FROM public.calendario_operacao_empresa c
                        WHERE c.data = g.d::date AND c.empresa = p_empresa)
       AND NOT EXISTS (SELECT 1 FROM public.v_venda_items_history_efetivo v
                        WHERE v.empresa = p_empresa AND v.data_emissao = g.d::date)
     ORDER BY 1;
END;
$$;

-- ACL: REVOKE nas DUAS pontas (PUBLIC e anon) — o default privileges do Supabase concede EXECUTE a anon.
REVOKE ALL ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendario_somar_dias_uteis_fornecedor(text, text, date, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendario_dias_sem_nf(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calendario_proximo_dia_recebimento(text, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calendario_somar_dias_uteis_fornecedor(text, text, date, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calendario_dias_sem_nf(text, date, date) TO authenticated, service_role;

-- ── 5) Postcondição embutida ─────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_t   text;
  v_fn  regprocedure;
  v_sig text;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['calendario_operacao_empresa', 'calendario_operacao_fornecedor', 'calendario_operacao_log'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      RAISE EXCEPTION '[CALENDARIO-POST] tabela ausente: %', v_t;
    END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || v_t)) THEN
      RAISE EXCEPTION '[CALENDARIO-POST] RLS desligada: %', v_t;
    END IF;
    IF has_table_privilege('anon', 'public.' || v_t, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION '[CALENDARIO-POST] anon com privilegio na tabela %', v_t;
    END IF;
  END LOOP;

  IF to_regclass('public.calendario_feriados') IS NULL THEN
    RAISE EXCEPTION '[CALENDARIO-POST] calendario_feriados ausente (lida por calendario_somar_dias_uteis_fornecedor)';
  END IF;

  IF (SELECT count(*) FROM pg_trigger
       WHERE tgname IN ('calendario_operacao_empresa_log', 'calendario_operacao_fornecedor_log')
         AND NOT tgisinternal) <> 2 THEN
    RAISE EXCEPTION '[CALENDARIO-POST] triggers de log ausentes';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'pedido_compra_sugerido'
         AND column_name IN ('data_recebimento_prevista', 'recebimento_ajustado_calendario')) <> 2 THEN
    RAISE EXCEPTION '[CALENDARIO-POST] colunas novas ausentes em pedido_compra_sugerido';
  END IF;

  FOREACH v_sig IN ARRAY ARRAY['public.calendario_proximo_dia_recebimento(text,date)',
                               'public.calendario_somar_dias_uteis_fornecedor(text,text,date,integer)',
                               'public.calendario_dias_sem_nf(text,date,date)'] LOOP
    v_fn := to_regprocedure(v_sig);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION '[CALENDARIO-POST] funcao ausente: %', v_sig;
    END IF;
    -- PUBLIC antes de anon: anon herda de PUBLIC, então PUBLIC aberto acusaria "anon" e esconderia a causa.
    IF has_function_privilege('public', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-POST] PUBLIC executa %', v_sig;
    END IF;
    IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-POST] anon executa %', v_sig;
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-POST] authenticated sem EXECUTE em %', v_sig;
    END IF;
    -- A edge (service_role) sem EXECUTE cairia no legado PARA SEMPRE, em silêncio (só um console.warn).
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION '[CALENDARIO-POST] EXECUTE ausente para service_role em %', v_sig;
    END IF;
  END LOOP;
END
$post$;

