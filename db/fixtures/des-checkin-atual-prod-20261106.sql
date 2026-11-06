-- v_des_checkin_atual como a PROD a tem (pg_get_viewdef(oid, true), psql-ro 2026-11-06; md5 cd1c2b4f0b815e35c0ae5540f54443e5).
CREATE VIEW public.v_des_checkin_atual
WITH (security_invoker = on)
AS
 WITH checkin_mais_recente AS (
         SELECT DISTINCT ON (des_checkin_qualitativo.empresa, des_checkin_qualitativo.ano, des_checkin_qualitativo.trimestre) des_checkin_qualitativo.id,
            des_checkin_qualitativo.empresa,
            des_checkin_qualitativo.ano,
            des_checkin_qualitativo.trimestre,
            des_checkin_qualitativo.data_avaliacao,
            des_checkin_qualitativo.tipo,
            des_checkin_qualitativo.avaliado_com,
            des_checkin_qualitativo.avaliado_por,
            des_checkin_qualitativo.observacoes_gerais
           FROM des_checkin_qualitativo
          ORDER BY des_checkin_qualitativo.empresa, des_checkin_qualitativo.ano, des_checkin_qualitativo.trimestre, des_checkin_qualitativo.data_avaliacao DESC, des_checkin_qualitativo.criado_em DESC
        )
 SELECT cr.empresa,
    cr.ano,
    cr.trimestre,
    cr.id AS checkin_id,
    cr.data_avaliacao,
    cr.tipo,
    cr.avaliado_com,
    cr.avaliado_por,
    cq.codigo,
    cq.nome,
    cq.tipo AS criterio_tipo,
    COALESCE(cr_resp.atingido, false) AS atingido,
    cr_resp.observacao AS observacao_criterio
   FROM checkin_mais_recente cr
     CROSS JOIN des_criterio_qualitativo cq
     LEFT JOIN des_checkin_qualitativo_resposta cr_resp ON cr_resp.checkin_id = cr.id AND cr_resp.criterio_id = cq.id
  WHERE cq.contrato_versao_id = (( SELECT des_contrato_versao.id
           FROM des_contrato_versao
          WHERE des_contrato_versao.versao = '2026'::text));
