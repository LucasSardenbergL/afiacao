-- PCP Fase 1B — M2: modelo de dados do corte múltiplo (rota alternativa + coproduto + rateio).
-- ÚLTIMO componente da Fundação (Fase 1). NÃO inclui motor (Fase 3) nem backflush/outbox (Fase 2).
-- Decisões founder 2026-07-05: perda por ABSORÇÃO · sobra PARAMÉTRICA (SKU na F3) · rotas DERIVADAS.
-- Painel tri-modelo (BLOCK) corrigido: geometria Σ=base · CHECK perda · normalização · valida origem+destino
--   · imutabilidade base/alvo · guard de custo · REVOKE helpers · teto k · esquema na chave.
-- Aplicar no SQL Editor do Lovable. NUNCA em supabase/migrations/. Re-colar é esperado (idempotável).
BEGIN;

-- 1) Rota alternativa por (linha, largura-base do rolo, largura-alvo principal, esquema). A base 150
--    admite decomposições distintas do MESMO alvo (150->3x50 vs 150->2x50+50sobra) => 'esquema' na chave.
CREATE TABLE IF NOT EXISTS public.pcp_bom_rotas (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  linha_modelo    text NOT NULL,
  largura_base_mm int  NOT NULL CHECK (largura_base_mm > 0),   -- largura do rolo que entra
  largura_alvo_mm int  NOT NULL CHECK (largura_alvo_mm > 0),   -- largura PRINCIPAL produzida
  esquema         text NOT NULL DEFAULT 'padrao',              -- discrimina decomposições da mesma base+alvo
  ativa           boolean NOT NULL DEFAULT true,
  nota            text,
  CHECK (largura_alvo_mm < largura_base_mm),                   -- corte múltiplo: alvo cabe na base
  CONSTRAINT pcp_bom_rotas_uk UNIQUE (linha_modelo, largura_base_mm, largura_alvo_mm, esquema)
);

-- [H] Reconciliação defensiva: se um rascunho anterior criou a tabela SEM 'esquema' (chave de 3 colunas),
--     migra a chave sem perder dados. Idempotável (no-op quando a tabela já nasce com 'esquema').
DO $mig$
DECLARE c text;
BEGIN
  ALTER TABLE public.pcp_bom_rotas ADD COLUMN IF NOT EXISTS esquema text NOT NULL DEFAULT 'padrao';
  FOR c IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'public.pcp_bom_rotas'::regclass AND con.contype = 'u'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(con.conkey) k
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k
        WHERE a.attname = 'esquema')                           -- UNIQUE legada que não inclui 'esquema'
  LOOP EXECUTE format('ALTER TABLE public.pcp_bom_rotas DROP CONSTRAINT %I', c); END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid='public.pcp_bom_rotas'::regclass AND conname='pcp_bom_rotas_uk') THEN
    ALTER TABLE public.pcp_bom_rotas ADD CONSTRAINT pcp_bom_rotas_uk
      UNIQUE (linha_modelo, largura_base_mm, largura_alvo_mm, esquema);
  END IF;
END $mig$;

-- 2) Saídas físicas (principal + coproduto + sobra + perda). Invariantes de AGREGAÇÃO por rota
--    (Σárea=base, Σfração boas=1, >=1 principal na alvo) via CONSTRAINT TRIGGER DEFERRED (bloco 4).
--    CHECK [B]: perda NUNCA rateia (fração 0) — defesa-em-profundidade contra distorção de custo.
CREATE TABLE IF NOT EXISTS public.pcp_bom_rota_saidas (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rota_id          bigint NOT NULL REFERENCES public.pcp_bom_rotas(id) ON DELETE CASCADE,
  largura_saida_mm int  NOT NULL CHECK (largura_saida_mm > 0),
  quantidade       int  NOT NULL CHECK (quantidade > 0),       -- quantas cintas dessa largura saem
  papel            text NOT NULL CHECK (papel IN ('principal','coproduto','sobra','perda')),
  fracao_rateio    numeric NOT NULL CHECK (fracao_rateio >= 0 AND fracao_rateio <= 1),
  CHECK (papel <> 'perda' OR fracao_rateio = 0),               -- [B] perda absorve: nunca carrega custo
  UNIQUE (rota_id, largura_saida_mm, papel)
);
CREATE INDEX IF NOT EXISTS idx_pcp_rota_saidas_rota ON public.pcp_bom_rota_saidas (rota_id);

-- 3) Rateio DEFAULT por área (largura×qtd). Perda absorve 0 — custo redistribuído nas boas (papel<>'perda'):
--    ABSORÇÃO (decisão do founder). Cada boa = area_boa / Σarea_boa => Σfração(boas)=1 por construção.
--    INVOKER (default) — a RLS staff-only da tabela barra o não-staff mesmo aqui.
CREATE OR REPLACE FUNCTION public.fn_pcp_rota_fracao_default(p_rota_id bigint)
RETURNS TABLE(saida_id bigint, fracao numeric) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH base AS (
    SELECT id, (largura_saida_mm * quantidade)::numeric AS area, papel
      FROM pcp_bom_rota_saidas WHERE rota_id = p_rota_id
  ), uteis AS (SELECT sum(area) AS tot FROM base WHERE papel <> 'perda')
  SELECT b.id, CASE WHEN b.papel = 'perda' THEN 0
                    ELSE round(b.area / NULLIF(u.tot, 0), 6) END
    FROM base b CROSS JOIN uteis u;
$$;

-- 4) Invariantes cross-row (valida no COMMIT — o cadastro insere rota+saídas na mesma tx antes de checar).
--    [A] Num UPDATE que move uma saída entre rotas, valida ORIGEM (OLD) e DESTINO (NEW).
--    [D] Σ(largura×qtd) de TODAS as saídas (inclusive perda) == largura_base: material não some.
--    [B] Σfração só sobre papel<>'perda' == 1: custo conservado nas boas.
CREATE OR REPLACE FUNCTION public.fn_pcp_validar_rota() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v_rotas bigint[] := ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[NEW.rota_id, OLD.rota_id]) x WHERE x IS NOT NULL);
  v_rota bigint;
  v_base int; v_alvo int; v_area bigint; v_frac numeric; v_princ int;
BEGIN
  FOREACH v_rota IN ARRAY v_rotas LOOP
    SELECT largura_base_mm, largura_alvo_mm INTO v_base, v_alvo FROM pcp_bom_rotas WHERE id = v_rota;
    IF v_base IS NULL THEN CONTINUE; END IF;                   -- rota apagada (cascade)
    SELECT COALESCE(sum(largura_saida_mm::bigint * quantidade), 0),   -- ::bigint: anti-overflow (Codex)
           COALESCE(sum(fracao_rateio) FILTER (WHERE papel <> 'perda'), 0),
           COALESCE(count(*) FILTER (WHERE papel = 'principal' AND largura_saida_mm = v_alvo), 0)
      INTO v_area, v_frac, v_princ
      FROM pcp_bom_rota_saidas WHERE rota_id = v_rota;
    IF v_princ < 1 THEN
      RAISE EXCEPTION 'rota %: exige >=1 saida principal na largura-alvo %mm', v_rota, v_alvo USING ERRCODE='check_violation';
    END IF;
    IF v_area <> v_base THEN
      RAISE EXCEPTION 'rota %: Σsaidas (%mm) <> base (%mm) — refilo deve virar sobra/perda explicita', v_rota, v_area, v_base USING ERRCODE='check_violation';
    END IF;
    IF round(v_frac, 4) <> 1.0000 THEN
      RAISE EXCEPTION 'rota %: soma fracao das boas=% (<>1, custo nao conservado)', v_rota, v_frac USING ERRCODE='check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS pcp_rota_saidas_valida ON public.pcp_bom_rota_saidas;
CREATE CONSTRAINT TRIGGER pcp_rota_saidas_valida
  AFTER INSERT OR UPDATE OR DELETE ON public.pcp_bom_rota_saidas
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.fn_pcp_validar_rota();

-- 5) [G] base/alvo são imutáveis: para reconfigurar a geometria, recadastre (recria saídas). O UPDATE do
--    cadastro (ON CONFLICT DO UPDATE SET nota/ativa) não toca base/alvo => não dispara este guard.
CREATE OR REPLACE FUNCTION public.fn_pcp_rota_imutavel() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.largura_base_mm <> OLD.largura_base_mm OR NEW.largura_alvo_mm <> OLD.largura_alvo_mm THEN
    RAISE EXCEPTION 'rota %: largura_base/alvo sao imutaveis (recadastre a rota)', OLD.id USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pcp_rotas_imutavel ON public.pcp_bom_rotas;
CREATE TRIGGER pcp_rotas_imutavel BEFORE UPDATE ON public.pcp_bom_rotas
  FOR EACH ROW EXECUTE FUNCTION public.fn_pcp_rota_imutavel();

-- 6) Rateio: distribui o custo do rolo pelas saídas boas. INVOKER => roda com as permissões do chamador,
--    a RLS staff-only barra o não-staff (custo não vaza). [I] guard de custo. [C] normaliza f/Σf (não depende
--    de Σfração ser exatamente 1). Resíduo do arredondamento vai na MAIOR boa => Σcusto == p_custo_base exato.
CREATE OR REPLACE FUNCTION public.fn_pcp_ratear_corte(p_rota_id bigint, p_custo_base numeric)
RETURNS TABLE(largura_saida_mm int, papel text, quantidade int, custo_total numeric, custo_unitario numeric)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF p_custo_base IS NULL OR p_custo_base < 0 THEN
    RAISE EXCEPTION 'fn_pcp_ratear_corte: custo base invalido (%)', p_custo_base USING ERRCODE='check_violation';
  END IF;
  RETURN QUERY
  WITH boas AS (
    SELECT s.largura_saida_mm AS w, s.papel AS pp, s.quantidade AS q, s.fracao_rateio AS f,
           -- resíduo do arredondamento vai na MAIOR boa; desempate ESTÁVEL (papel, id) => determinístico (Codex)
           row_number() OVER (ORDER BY s.largura_saida_mm::bigint * s.quantidade DESC, s.largura_saida_mm DESC,
                                       (s.papel='principal') DESC, s.id) AS rn
      FROM pcp_bom_rota_saidas s WHERE s.rota_id = p_rota_id AND s.papel <> 'perda'
  ),
  tot AS (SELECT sum(f) AS sf FROM boas),
  rateado AS (
    SELECT b.w, b.pp, b.q, b.rn,
           round(p_custo_base * b.f / NULLIF((SELECT sf FROM tot), 0), 4) AS ct
      FROM boas b
  ),
  resid AS (SELECT round(p_custo_base - COALESCE(sum(ct), 0), 4) AS resto FROM rateado)
  SELECT rt.w, rt.pp, rt.q,
         (rt.ct + CASE WHEN rt.rn = 1 THEN (SELECT resto FROM resid) ELSE 0 END),
         round((rt.ct + CASE WHEN rt.rn = 1 THEN (SELECT resto FROM resid) ELSE 0 END) / rt.q, 4)
    FROM rateado rt ORDER BY rt.w DESC;
END $$;

-- 7) Cadastro transacional de rota + saídas. [E] frações: ou TODAS explícitas, ou NENHUMA (default por área)
--    — proíbe o meio-termo que deixava coproduto com custo 0. Gate por auth.uid(). 6 args (com esquema).
CREATE OR REPLACE FUNCTION public.fn_pcp_cadastrar_rota(
  p_linha text, p_largura_base int, p_largura_alvo int, p_saidas jsonb,
  p_nota text DEFAULT NULL, p_esquema text DEFAULT 'padrao')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_rota bigint; s jsonb; v_frac numeric; v_n int; v_expl int;
BEGIN
  IF v_uid IS NULL OR NOT (has_role(v_uid,'master'::app_role) OR has_role(v_uid,'employee'::app_role)) THEN
    RAISE EXCEPTION 'fn_pcp_cadastrar_rota: apenas staff';
  END IF;
  IF p_saidas IS NULL OR jsonb_typeof(p_saidas) <> 'array' THEN     -- entrada de domínio, não erro genérico (Codex)
    RAISE EXCEPTION 'fn_pcp_cadastrar_rota: p_saidas deve ser um array jsonb';
  END IF;
  v_n    := jsonb_array_length(p_saidas);
  v_expl := (SELECT count(*) FROM jsonb_array_elements(p_saidas) e
               WHERE NULLIF(e->>'fracao_rateio','') IS NOT NULL);            -- perda:0 conta como explícita
  IF v_expl > 0 AND v_expl < v_n THEN
    RAISE EXCEPTION 'fn_pcp_cadastrar_rota: fracao_rateio deve vir em TODAS as saidas ou em nenhuma (nao misturar)';
  END IF;
  INSERT INTO pcp_bom_rotas (linha_modelo, largura_base_mm, largura_alvo_mm, esquema, nota)
    VALUES (p_linha, p_largura_base, p_largura_alvo, p_esquema, p_nota)
    ON CONFLICT (linha_modelo, largura_base_mm, largura_alvo_mm, esquema)
      DO UPDATE SET nota=EXCLUDED.nota, ativa=true
    RETURNING id INTO v_rota;
  DELETE FROM pcp_bom_rota_saidas WHERE rota_id = v_rota;
  FOR s IN SELECT * FROM jsonb_array_elements(p_saidas) LOOP
    v_frac := NULLIF(s->>'fracao_rateio','')::numeric;
    INSERT INTO pcp_bom_rota_saidas (rota_id, largura_saida_mm, quantidade, papel, fracao_rateio)
      VALUES (v_rota, (s->>'largura_saida_mm')::int, (s->>'quantidade')::int, s->>'papel', COALESCE(v_frac,0));
  END LOOP;
  IF v_expl = 0 THEN                                            -- nenhuma explícita => default por área (perda=0)
    UPDATE pcp_bom_rota_saidas t SET fracao_rateio = d.fracao
      FROM fn_pcp_rota_fracao_default(v_rota) d WHERE d.saida_id = t.id;
  END IF;
  RETURN v_rota;                                                -- trigger DEFERRED valida no COMMIT
END $$;

-- 8) Seed: para cada (linha, L alvo) e (mesma linha, L' base) com L'=k·L (2<=k<=8), cria a rota simples
--    (1 saída principal L, quantidade k, fração 1). Fonte = larguras REAIS parseadas em pcp_itens (1A).
--    Σ(L×k)=L'=base => passa a geometria. [J] teto k<=8 evita rotas absurdas. Rotas mistas = manual/F3.
CREATE OR REPLACE FUNCTION public.fn_pcp_derivar_rotas_simples()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_rota bigint; n int := 0;
BEGIN
  FOR r IN
    SELECT a.linha_modelo, a.largura_mm AS l_alvo, b.largura_mm AS l_base, (b.largura_mm/a.largura_mm) AS k
      FROM (SELECT DISTINCT linha_modelo, largura_mm FROM pcp_itens WHERE tipo_item='cinta' AND largura_mm>0) a
      JOIN (SELECT DISTINCT linha_modelo, largura_mm FROM pcp_itens WHERE tipo_item='cinta' AND largura_mm>0) b
        ON a.linha_modelo=b.linha_modelo
       AND b.largura_mm > a.largura_mm
       AND b.largura_mm % a.largura_mm = 0
       AND b.largura_mm / a.largura_mm BETWEEN 2 AND 8
  LOOP
    INSERT INTO pcp_bom_rotas (linha_modelo, largura_base_mm, largura_alvo_mm, esquema, nota)
      VALUES (r.linha_modelo, r.l_base, r.l_alvo, 'padrao', 'derivada F1B-M2')
      ON CONFLICT (linha_modelo, largura_base_mm, largura_alvo_mm, esquema) DO NOTHING RETURNING id INTO v_rota;
    IF v_rota IS NOT NULL THEN
      INSERT INTO pcp_bom_rota_saidas (rota_id, largura_saida_mm, quantidade, papel, fracao_rateio)
        VALUES (v_rota, r.l_alvo, r.k, 'principal', 1.0);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- 9) RLS staff-read. Cadastro/derivação escrevem via RPC SECURITY DEFINER (gated) => sem grant de DML.
ALTER TABLE public.pcp_bom_rotas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_bom_rota_saidas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pcp_rotas_sel ON public.pcp_bom_rotas;
CREATE POLICY pcp_rotas_sel ON public.pcp_bom_rotas FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
DROP POLICY IF EXISTS pcp_rota_saidas_sel ON public.pcp_bom_rota_saidas;
CREATE POLICY pcp_rota_saidas_sel ON public.pcp_bom_rota_saidas FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
REVOKE ALL ON public.pcp_bom_rotas, public.pcp_bom_rota_saidas FROM anon, authenticated;
GRANT SELECT ON public.pcp_bom_rotas, public.pcp_bom_rota_saidas TO authenticated;

-- Funções: fechar EXECUTE de PUBLIC; conceder o necessário. ratear_corte é INVOKER (RLS da tabela protege).
REVOKE ALL ON FUNCTION public.fn_pcp_ratear_corte(bigint,numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_pcp_cadastrar_rota(text,int,int,jsonb,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_pcp_derivar_rotas_simples() FROM PUBLIC, anon, authenticated;
-- [K] helpers internos: sem superfície pública (o M1 teve esse cuidado).
REVOKE ALL ON FUNCTION public.fn_pcp_rota_fracao_default(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pcp_ratear_corte(bigint,numeric) TO authenticated;  -- RLS barra não-staff
GRANT EXECUTE ON FUNCTION public.fn_pcp_cadastrar_rota(text,int,int,jsonb,text,text) TO authenticated;
-- fn_pcp_derivar_rotas_simples: sem grant a authenticated (chamada 1× por staff/seed via SQL Editor).
-- fn_pcp_validar_rota / fn_pcp_rota_imutavel: funções de trigger (não chamáveis diretamente); sem grant.

COMMIT;
