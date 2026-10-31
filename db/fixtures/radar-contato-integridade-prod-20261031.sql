-- radar-contato-integridade-prod-20261031.sql — o corpo VIVO de public.desfazer_contato_radar(uuid) em prod
-- (pg_get_functiondef via psql-ro, 2026-10-31, md5(prosrc) f695b1e6ca8fd9dac19f7b0ea08897e7), que
-- db/test-radar-contato-integridade.sh monta ANTES da 20261031111000. O snapshot de 2026-10-15 tem outro corpo; a
-- prova confere o md5 depois de carregar este arquivo (colagem que perdeu 1 byte aborta antes da migration).
-- As outras RPCs que a prova exercita (registrar_contato_radar, radar_registrar_cadastro_omie e a v2) chegam pelo
-- retrato de 2026-10-29 + a 20261029201200, e a prova confere o md5 de prod delas também.
CREATE OR REPLACE FUNCTION public.desfazer_contato_radar(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_cnpj text;
  v_acao text;
  v_anterior text;
  v_status_atual text;
BEGIN
  SELECT cnpj, acao, status_anterior INTO v_cnpj, v_acao, v_anterior
    FROM public.radar_contatos
   WHERE id = p_id AND criado_por = v_uid AND created_at > now() - interval '5 minutes';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('deleted', false);
  END IF;

  SELECT prospeccao_status INTO v_status_atual
    FROM public.radar_empresas WHERE cnpj = v_cnpj FOR UPDATE;
  IF v_status_atual = v_acao THEN
    UPDATE public.radar_empresas SET
      prospeccao_status = COALESCE(v_anterior, 'a_contatar'),
      prospeccao_atualizado_em = now(), updated_at = now()
    WHERE cnpj = v_cnpj;
  END IF;

  DELETE FROM public.radar_contatos WHERE id = p_id;
  RETURN jsonb_build_object('deleted', true);
END $function$
;
