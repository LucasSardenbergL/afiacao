-- Prime Colacor — PR-1: fundação de dados (planos, assinaturas, uso de benefício, extrato)
-- Spec: docs/superpowers/specs/2026-07-09-prime-colacor-design.md §7
-- Plano (com fold do challenge Codex): docs/superpowers/plans/2026-07-11-prime-colacor-pr1-fundacao.md
--
-- Honestidade money-path ENFORÇADA no banco:
--  · monetizável exige valor_tabela > 0 E referencia (lastro Omie);
--  · afiação amarra valor_tabela = round(quantidade × preco_unitario_snapshot, 2)
--    (contrafactual auditável da época — nunca número solto);
--  · registro monetário é APPEND-ONLY: UPDATE só para estorno (trigger), DELETE sem policy;
--  · uso só em assinatura ATIVA e competência dentro da vigência (suspensa congela);
--  · ciclos do mesmo cliente não sobrepõem competência (extrato nunca duplica mês);
--  · a view fala "mensalidade_contratada" — NUNCA "pagou" (não há fato de pagamento na v1).
-- Transação única: o SQL Editor do Lovable roda como script — erro no meio não pode
-- deixar estado parcial.

BEGIN;

-- ── 0. Preflight: dependências que PROD precisa ter (falha CLARA, não erro ruim no meio) ──
DO $$
BEGIN
  IF to_regtype('public.app_role') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT prime_fundacao: tipo public.app_role não existe neste banco';
  END IF;
  IF to_regprocedure('public.has_role(uuid, public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT prime_fundacao: função public.has_role(uuid, app_role) não existe';
  END IF;
  IF to_regprocedure('public.update_updated_at_column()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT prime_fundacao: função public.update_updated_at_column() não existe';
  END IF;
END $$;

-- ── 1. Catálogo de planos ──
CREATE TABLE public.prime_planos (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  nome text NOT NULL,
  preco_mensal numeric NOT NULL CHECK (preco_mensal > 0),
  franquia_dentes integer NOT NULL CHECK (franquia_dentes >= 0),
  -- Descritivo/copy dos benefícios (lista de strings). Staff é o único writer;
  -- NÃO é sinal money-path (o sinal vive em prime_beneficio_uso, coluna dedicada).
  beneficios jsonb NOT NULL DEFAULT '[]'::jsonb,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── 2. Assinaturas — 1 viva por cliente; preço e franquia CONGELADOS na adesão ──
-- (grandfathering do spec §5: mudar o catálogo NUNCA muda o contratado de quem já
--  assinou; mudança de condição = nova assinatura em novo ciclo)
CREATE TABLE public.prime_assinaturas (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  plano_id uuid NOT NULL REFERENCES public.prime_planos(id),
  preco_contratado numeric NOT NULL CHECK (preco_contratado > 0),
  franquia_dentes_contratada integer NOT NULL CHECK (franquia_dentes_contratada >= 0),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa','suspensa','cancelada')),
  data_inicio date NOT NULL DEFAULT current_date,
  data_fim date CHECK (data_fim IS NULL OR data_fim >= data_inicio),
  -- Suspensão congela o extrato: a view para de gerar competências após este mês.
  -- Reativar = limpar suspensa_em (staff via admin, PR-2).
  suspensa_em date CHECK (suspensa_em IS NULL OR suspensa_em >= data_inicio),
  observacao text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Estado amarrado às datas (review da Task 1): sem isto, 'cancelada' com data_fim
  -- NULL viraria 'infinity' na anti-sobreposição e bloquearia o cliente PARA SEMPRE;
  -- e suspensa_em solto (status ainda 'ativa') não congelaria nada.
  CONSTRAINT prime_assinatura_status_datas CHECK (
    CASE status
      WHEN 'ativa'     THEN data_fim IS NULL AND suspensa_em IS NULL
      WHEN 'suspensa'  THEN data_fim IS NULL AND suspensa_em IS NOT NULL
      WHEN 'cancelada' THEN data_fim IS NOT NULL
    END
  )
);
CREATE UNIQUE INDEX uq_prime_assinatura_viva
  ON public.prime_assinaturas (customer_user_id) WHERE status <> 'cancelada';

-- Ciclos do MESMO cliente nunca sobrepõem competência (senão o extrato mensal
-- duplicaria o mês). Nova assinatura só em mês estritamente posterior ao mês de
-- encerramento de QUALQUER assinatura anterior do cliente.
CREATE FUNCTION public.prime_assinatura_sem_sobreposicao() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.prime_assinaturas a
    WHERE a.customer_user_id = NEW.customer_user_id
      AND a.id <> NEW.id
      AND date_trunc('month', COALESCE(a.data_fim::timestamp, 'infinity'::timestamp))
          >= date_trunc('month', NEW.data_inicio::timestamp)
  ) THEN
    RAISE EXCEPTION 'cliente já tem assinatura cobrindo o mês de início (competência não pode duplicar no extrato)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
-- INSERT E UPDATE (review da Task 1): sem o UPDATE, staff editaria data_inicio/cliente
-- e furaria a garantia por fora do caminho de criação.
CREATE TRIGGER trg_prime_assinatura_sem_sobreposicao
  BEFORE INSERT OR UPDATE OF customer_user_id, data_inicio, data_fim, status
  ON public.prime_assinaturas
  FOR EACH ROW EXECUTE FUNCTION public.prime_assinatura_sem_sobreposicao();

-- ── 3. Uso de benefício — APPEND-ONLY; contrafactual auditável por linha ──
-- Registro = CONCESSÃO dentro do programa (excedente de franquia é faturado normal no
-- Omie e não entra aqui — mas se registrado, a view EXPÕE o excedente, nunca esconde).
-- bonus_dentes é CRÉDITO de franquia (valor_tabela NULL) — monetiza só quando consumido
-- como afiacao_dentes. Correção de erro = ESTORNO (estornado_em/por), nunca edição.
CREATE TABLE public.prime_beneficio_uso (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  assinatura_id uuid NOT NULL REFERENCES public.prime_assinaturas(id),
  tipo text NOT NULL CHECK (tipo IN
    ('afiacao_dentes','bonus_dentes','desconto_abrasivo','atendimento_tecnico',
     'prioridade_entrega','prioridade_separacao','coleta_rota')),
  quantidade numeric NOT NULL CHECK (quantidade > 0),
  valor_tabela numeric,
  -- R$/dente vigente NA CONCESSÃO (só afiacao_dentes) — o contrafactual é auditável:
  -- valor_tabela = round(quantidade × preco_unitario_snapshot, 2), enforçado abaixo.
  preco_unitario_snapshot numeric,
  competencia date NOT NULL CHECK (competencia = (date_trunc('month', competencia))::date),
  referencia text,   -- nº do pedido/NF Omie que lastreia (OBRIGATÓRIO em monetizável)
  descricao text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  estornado_em timestamptz,
  estornado_por uuid,
  -- Honestidade money-path NO BANCO (ausente ≠ zero):
  CONSTRAINT prime_uso_valor_por_tipo CHECK (
    CASE WHEN tipo IN ('afiacao_dentes','desconto_abrasivo')
         THEN valor_tabela IS NOT NULL AND valor_tabela > 0 AND referencia IS NOT NULL
         ELSE valor_tabela IS NULL END
  ),
  CONSTRAINT prime_uso_afiacao_consistente CHECK (
    tipo <> 'afiacao_dentes' OR (
      preco_unitario_snapshot IS NOT NULL AND preco_unitario_snapshot > 0
      AND valor_tabela = round(quantidade * preco_unitario_snapshot, 2)
    )
  ),
  CONSTRAINT prime_uso_snapshot_so_afiacao CHECK (
    tipo = 'afiacao_dentes' OR preco_unitario_snapshot IS NULL
  ),
  -- dentes são inteiros; evento operacional é unitário
  CONSTRAINT prime_uso_quantidade_por_tipo CHECK (
    CASE WHEN tipo IN ('afiacao_dentes','bonus_dentes') THEN quantidade = floor(quantidade)
         ELSE quantidade = 1 END
  ),
  -- bônus cross-sell: teto de 50 dentes por concessão (spec §5)
  CONSTRAINT prime_uso_bonus_teto CHECK (tipo <> 'bonus_dentes' OR quantidade <= 50),
  CONSTRAINT prime_uso_estorno_par CHECK ((estornado_em IS NULL) = (estornado_por IS NULL))
);
CREATE INDEX idx_prime_uso_assinatura_mes
  ON public.prime_beneficio_uso (assinatura_id, competencia);
-- bônus: no máximo 1 concessão VIVA por assinatura×mês (estornado libera re-conceder)
CREATE UNIQUE INDEX uq_prime_bonus_mes
  ON public.prime_beneficio_uso (assinatura_id, competencia)
  WHERE tipo = 'bonus_dentes' AND estornado_em IS NULL;

-- Vigência: uso só em assinatura ATIVA, competência entre o mês de início e o mês
-- corrente SP ("suspensa congela franquia" do spec §7 vira regra de banco).
CREATE FUNCTION public.prime_uso_vigencia() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE a record;
BEGIN
  SELECT status, data_inicio, data_fim INTO a
    FROM public.prime_assinaturas WHERE id = NEW.assinatura_id;
  IF a.status IS NULL THEN
    RAISE EXCEPTION 'assinatura inexistente' USING ERRCODE = 'P0001';
  END IF;
  IF a.status <> 'ativa' THEN
    RAISE EXCEPTION 'assinatura % — uso bloqueado (suspensa/cancelada congela franquia)', a.status
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW.competencia < date_trunc('month', a.data_inicio::timestamp)::date
     OR NEW.competencia > date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date
  THEN
    RAISE EXCEPTION 'competência fora da vigência da assinatura' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prime_uso_vigencia
  BEFORE INSERT ON public.prime_beneficio_uso
  FOR EACH ROW EXECUTE FUNCTION public.prime_uso_vigencia();

-- Append-only: UPDATE existe SÓ para estornar (nenhum outro campo pode mudar);
-- registro estornado é imutável; estornado_por = quem estorna (auth.uid()).
CREATE FUNCTION public.prime_uso_so_estorno() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.assinatura_id IS DISTINCT FROM OLD.assinatura_id
     OR NEW.tipo IS DISTINCT FROM OLD.tipo
     OR NEW.quantidade IS DISTINCT FROM OLD.quantidade
     OR NEW.valor_tabela IS DISTINCT FROM OLD.valor_tabela
     OR NEW.preco_unitario_snapshot IS DISTINCT FROM OLD.preco_unitario_snapshot
     OR NEW.competencia IS DISTINCT FROM OLD.competencia
     OR NEW.referencia IS DISTINCT FROM OLD.referencia
     OR NEW.descricao IS DISTINCT FROM OLD.descricao
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'registro monetário é append-only — correção é ESTORNO, nunca edição'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.estornado_em IS NOT NULL THEN
    RAISE EXCEPTION 'registro já estornado é imutável' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.estornado_em IS NULL OR NEW.estornado_por IS NULL
     OR NEW.estornado_por IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'estorno exige estornado_em e estornado_por = usuário autenticado'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_prime_uso_so_estorno
  BEFORE UPDATE ON public.prime_beneficio_uso
  FOR EACH ROW EXECUTE FUNCTION public.prime_uso_so_estorno();

-- ── updated_at (lição S250: tabela mutável SEM trigger enfraquece diagnóstico) ──
CREATE TRIGGER trg_prime_planos_updated_at BEFORE UPDATE ON public.prime_planos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_prime_assinaturas_updated_at BEFORE UPDATE ON public.prime_assinaturas
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── RLS ──
ALTER TABLE public.prime_planos        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prime_assinaturas   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prime_beneficio_uso ENABLE ROW LEVEL SECURITY;

CREATE POLICY prime_planos_staff_all ON public.prime_planos FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
-- Catálogo: qualquer LOGADO lê plano ATIVO (preço do plano é público pro cliente; anon fora)
CREATE POLICY prime_planos_auth_read ON public.prime_planos FOR SELECT
  USING (auth.uid() IS NOT NULL AND ativo);

CREATE POLICY prime_assinaturas_staff_all ON public.prime_assinaturas FOR ALL
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY prime_assinaturas_cliente_read ON public.prime_assinaturas FOR SELECT
  USING (customer_user_id = auth.uid());

-- Uso: SEM policy de DELETE (RLS nega por default → append-only de verdade).
-- INSERT exige created_by = auth.uid() (staff não forja autor).
CREATE POLICY prime_uso_staff_select ON public.prime_beneficio_uso FOR SELECT
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY prime_uso_staff_insert ON public.prime_beneficio_uso FOR INSERT
  WITH CHECK ((public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
              AND created_by = auth.uid());
CREATE POLICY prime_uso_staff_update ON public.prime_beneficio_uso FOR UPDATE
  USING (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role));
CREATE POLICY prime_uso_cliente_read ON public.prime_beneficio_uso FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.prime_assinaturas a
                 WHERE a.id = assinatura_id AND a.customer_user_id = auth.uid()));

-- ── 4. Extrato mensal (security_invoker → herda a RLS das tabelas) ──
-- 1 linha por assinatura × mês desde data_inicio até LEAST(mês corrente SP, mês de
-- data_fim, mês de suspensa_em) — suspensão CONGELA o extrato. Estornados ficam FORA.
-- mensalidade_contratada é o contrato — NUNCA "pago" (não há fato de pagamento na v1).
-- monetizado_total NULL quando não há registro monetizável (≠ 0 fabricado); contagens
-- 0 são fato transacional. dentes_excedentes expõe estouro de franquia (nunca esconde).
CREATE VIEW public.v_prime_extrato_mensal
WITH (security_invoker = true) AS
WITH meses AS (
  SELECT a.id AS assinatura_id, a.customer_user_id, a.status,
         a.preco_contratado, a.franquia_dentes_contratada,
         generate_series(
           date_trunc('month', a.data_inicio::timestamp),
           LEAST(
             date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')),
             date_trunc('month', COALESCE(a.data_fim::timestamp,     'infinity'::timestamp)),
             date_trunc('month', COALESCE(a.suspensa_em::timestamp,  'infinity'::timestamp))
           ),
           interval '1 month'
         )::date AS competencia
  FROM public.prime_assinaturas a
), uso AS (
  SELECT assinatura_id, competencia,
         sum(valor_tabela) FILTER (WHERE tipo IN ('afiacao_dentes','desconto_abrasivo')) AS monetizado_total,
         sum(quantidade)   FILTER (WHERE tipo = 'afiacao_dentes')  AS dentes_usados,
         sum(quantidade)   FILTER (WHERE tipo = 'bonus_dentes')    AS dentes_bonus,
         -- bônus é CRÉDITO de franquia, não uso — fora da contagem operacional
         count(*)          FILTER (WHERE tipo NOT IN ('afiacao_dentes','desconto_abrasivo','bonus_dentes')) AS usos_operacionais,
         count(*) AS n_registros
  FROM public.prime_beneficio_uso
  WHERE estornado_em IS NULL
  GROUP BY assinatura_id, competencia
)
SELECT m.assinatura_id, m.customer_user_id, m.status, m.competencia,
       m.preco_contratado AS mensalidade_contratada,
       u.monetizado_total,
       u.dentes_usados,
       u.dentes_bonus,
       m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0) AS franquia_total,
       GREATEST(0::numeric,
         m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0)
         - COALESCE(u.dentes_usados, 0)) AS dentes_restantes,
       GREATEST(0::numeric,
         COALESCE(u.dentes_usados, 0)
         - (m.franquia_dentes_contratada + COALESCE(u.dentes_bonus, 0))) AS dentes_excedentes,
       COALESCE(u.usos_operacionais, 0) AS usos_operacionais,
       COALESCE(u.n_registros, 0) AS n_registros
FROM meses m
LEFT JOIN uso u USING (assinatura_id, competencia);

COMMIT;
