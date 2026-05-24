CREATE OR REPLACE FUNCTION fin_check_mapping_complete_trigger() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pendentes jsonb;
  v_target_date date;
BEGIN
  -- só verifica na transição para aprovado (status='fechado' AND aprovado_em vira NOT NULL)
  IF (NEW.status <> 'fechado' OR NEW.aprovado_em IS NULL)
     OR (OLD.status = 'fechado' AND OLD.aprovado_em IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  v_target_date := make_date(NEW.ano, NEW.mes, 1);

  WITH categorias_periodo AS (
    SELECT DISTINCT categoria_codigo AS omie_codigo, categoria_descricao AS nome
      FROM fin_contas_receber
     WHERE company = NEW.company
       AND data_emissao >= v_target_date
       AND data_emissao < (v_target_date + interval '1 month')
       AND COALESCE(valor_documento, 0) > 0
       AND categoria_codigo IS NOT NULL
    UNION
    SELECT DISTINCT categoria_codigo, categoria_descricao
      FROM fin_contas_pagar
     WHERE company = NEW.company
       AND data_emissao >= v_target_date
       AND data_emissao < (v_target_date + interval '1 month')
       AND COALESCE(valor_documento, 0) > 0
       AND categoria_codigo IS NOT NULL
  ),
  pendentes AS (
    SELECT cp.omie_codigo, cp.nome
      FROM categorias_periodo cp
      LEFT JOIN fin_categoria_dre_mapping m
        ON (m.company = NEW.company OR m.company = '_default')
       AND m.omie_codigo = cp.omie_codigo
     WHERE m.id IS NULL
  )
  SELECT jsonb_agg(jsonb_build_object('id', omie_codigo, 'nome', nome))
    INTO v_pendentes FROM pendentes;

  IF v_pendentes IS NOT NULL AND jsonb_array_length(v_pendentes) > 0 THEN
    RAISE EXCEPTION 'MAPPING_INCOMPLETE: % categorias sem mapeamento DRE: %',
      jsonb_array_length(v_pendentes), v_pendentes::text
      USING ERRCODE = 'P0002';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_mapping_gate ON fin_fechamentos;
CREATE TRIGGER trg_mapping_gate
  BEFORE UPDATE ON fin_fechamentos
  FOR EACH ROW EXECUTE FUNCTION fin_check_mapping_complete_trigger();

COMMENT ON FUNCTION fin_check_mapping_complete_trigger() IS
  'Bloqueia aprovação de fechamento (status=fechado E aprovado_em vira NOT NULL) se houver categoria sem mapping com valor>0.';
