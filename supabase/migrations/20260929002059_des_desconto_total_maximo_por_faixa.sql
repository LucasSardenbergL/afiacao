-- 20260929002059_des_desconto_total_maximo_por_faixa.sql
-- ============================================================
-- v_des_desconto_por_checkin.desconto_total_maximo passa a ser o máximo DA FAIXA do check-in:
-- o desconto padrão + os percentuais de todos os critérios (qualitativos + bônus) daquela faixa,
-- na versão de contrato '2026' — o mesmo universo que o desconto projetado já usa.
-- ============================================================
-- O defeito: o subselect da coluna filtrava `WHERE cp2.faixa_id = cp2.faixa_id` — a coluna
-- comparada com ela mesma (faixa_id é NOT NULL: sempre verdade). Somava os 54 percentuais das 6
-- faixas, 36,41 p.p. em cima do padrão: na faixa 4, "máximo possível" de 40,78% contra 10,09% de
-- verdade (4,37 do padrão + 4,72 dos qualitativos + 1,00 do bônus). É o bug de escopo clássico:
-- um `faixa_id` sem qualificador dentro do subselect é capturado pela tabela DE DENTRO (cp2), não
-- pela linha de fora — e o deparse o escreve exatamente assim (psql-ro, 2026-09-29).
-- Alcance medido: a view tem 0 linhas na prod (nenhum check-in salvo), então o número inflado
-- nunca foi exibido — a correção é preventiva. A única outra leitora,
-- simular_puxar_volume_trimestre, usa só desconto_total_projetado.
--
-- Intenção confirmada pelo founder (2026-09-29): máximo = padrão + TODOS os critérios da faixa
-- (qualitativos + bônus), com o filtro de versão '2026' do CTE checkin_com_faixa. Mesmo universo
-- do projetado ⇒ projetado ≤ máximo, e = quando todos os critérios são atingidos (cada critério
-- conta 1× — UNIQUE(checkin_id, criterio_id) e UNIQUE(criterio_id, faixa_id)). Faixa sem
-- percentual cadastrado ⇒ NULL (ausente ≠ zero: a tela mostra "—"), nunca o padrão sozinho.
--
-- Única mudança: o WHERE desse subselect. O resto é o `pg_get_viewdef(oid, true)` VIVO da prod
-- (db/fixtures/des-views-predecessoras-prod-20260927.sql; md5 reconferido em 2026-09-29), linha a
-- linha — mesmas 13 colunas, ordem e tipos. A view não tinha CREATE no repo. `security_invoker =
-- on` repetido: omiti-lo num replace RESETA a opção e a view passa a ler como dono, sem RLS
-- (database.md §4). CREATE OR REPLACE preserva ACL e dependentes.
--
-- Prova: db/test-des-desconto-total-maximo.sh (PG17: máximo por faixa com somas distintas, versão
-- de contrato cruzada, faixa sem percentual, colunas vizinhas intactas, RLS sob SET ROLE, PRÉ, PÓS
-- e trava) e o mesmo script com --falsificar.
-- Aplicação: bun run db:aplicar — a transação é do executor, por isso não há BEGIN/COMMIT aqui.
-- Reverter depois do commit = migration compensatória nova.
--
-- Identidade (PRÉ e PÓS): md5 EXATO do `pg_get_viewdef(…, true)` — o mesmo sob o search_path
-- padrão e sob `pg_catalog, public` (todas as relações lidas estão em public).

-- Trava ANTES da pré-condição: o deparse da PRÉ solta o lock da própria view ao terminar (só as
-- relações que ela lê ficam presas), então outra transação poderia recriá-la entre a conferência e
-- o CREATE OR REPLACE, que apagaria a mudança dela em silêncio. Este ALTER sem efeito prende a view
-- até o fim da transação: quem chegar depois espera; quem chegou antes aparece na pré-condição.
DO $trava$
BEGIN
  IF to_regclass('public.v_des_desconto_por_checkin') IS NOT NULL THEN
    ALTER VIEW public.v_des_desconto_por_checkin SET (security_invoker = on);
  END IF;
END
$trava$;

-- Pré-condição: a view viva tem de ser o PREDECESSOR revisado (o da prod em 2026-09-27/29) ou JÁ
-- esta (re-aplicar é seguro). Qualquer outra é mudança concorrente que este CREATE OR REPLACE
-- apagaria em silêncio — aborta. Ausente (ambiente novo) segue.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(pg_catalog.pg_get_viewdef(c.oid, true)) INTO v_vivo
    FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.v_des_desconto_por_checkin');
  IF v_vivo IS NOT NULL AND v_vivo NOT IN ('1c8885b860f65f5c76b1fd5314b96e28', '879fe737d8a8e872ab855c1db35d3179') THEN
    RAISE EXCEPTION 'PRE FALHOU: v_des_desconto_por_checkin vivo (md5 %) não é o predecessor revisado nem este — outra mudança chegou antes; reconcilie antes de aplicar', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE VIEW public.v_des_desconto_por_checkin
WITH (security_invoker = on) AS
 WITH checkin_com_faixa AS (
         SELECT vca.empresa,
            vca.ano,
            vca.trimestre,
            vca.checkin_id,
            vca.data_avaliacao,
            vca.tipo,
            vca.codigo AS criterio_codigo,
            vca.nome AS criterio_nome,
            vca.criterio_tipo,
            vca.atingido,
            cp.percentual AS percentual_da_faixa,
            (vptr.faixa_conservadora ->> 'faixa_id'::text)::bigint AS faixa_id,
            (vptr.faixa_conservadora ->> 'faixa_numero'::text)::integer AS faixa_numero,
            (vptr.faixa_conservadora ->> 'estrelas'::text)::integer AS estrelas,
            (vptr.faixa_conservadora ->> 'desconto_padrao_perc'::text)::numeric AS desconto_padrao
           FROM v_des_checkin_atual vca
             LEFT JOIN v_des_posicao_trimestre_ao_vivo vptr ON vptr.empresa = vca.empresa AND vptr.ano = vca.ano AND vptr.trimestre = vca.trimestre
             LEFT JOIN des_criterio_qualitativo cq_full ON cq_full.codigo = vca.codigo AND cq_full.contrato_versao_id = (( SELECT des_contrato_versao.id
                   FROM des_contrato_versao
                  WHERE des_contrato_versao.versao = '2026'::text))
             LEFT JOIN des_criterio_percentual cp ON cp.criterio_id = cq_full.id AND cp.faixa_id = ((vptr.faixa_conservadora ->> 'faixa_id'::text)::bigint)
        )
 SELECT empresa,
    ano,
    trimestre,
    checkin_id,
    data_avaliacao,
    tipo,
    faixa_numero,
    estrelas,
    desconto_padrao,
    sum(
        CASE
            WHEN criterio_tipo = 'qualitativo'::text AND atingido THEN percentual_da_faixa
            ELSE 0::numeric
        END) AS qualitativos_atingidos_perc,
    sum(
        CASE
            WHEN criterio_tipo = 'bonus'::text AND atingido THEN percentual_da_faixa
            ELSE 0::numeric
        END) AS bonus_atingido_perc,
    round(desconto_padrao + sum(
        CASE
            WHEN criterio_tipo = 'qualitativo'::text AND atingido THEN percentual_da_faixa
            ELSE 0::numeric
        END) + sum(
        CASE
            WHEN criterio_tipo = 'bonus'::text AND atingido THEN percentual_da_faixa
            ELSE 0::numeric
        END), 2) AS desconto_total_projetado,
    desconto_padrao + (( SELECT sum(cp2.percentual) AS sum
           FROM des_criterio_percentual cp2
             JOIN des_criterio_qualitativo cq2 ON cq2.id = cp2.criterio_id
          WHERE cp2.faixa_id = checkin_com_faixa.faixa_id AND cq2.contrato_versao_id = (( SELECT des_contrato_versao.id
                   FROM des_contrato_versao
                  WHERE des_contrato_versao.versao = '2026'::text)))) AS desconto_total_maximo
   FROM checkin_com_faixa
  WHERE faixa_id IS NOT NULL
  GROUP BY empresa, ano, trimestre, checkin_id, data_avaliacao, tipo, faixa_id, faixa_numero, estrelas, desconto_padrao;
-- Pós-condição: o que ficou instalado é ESTE texto e a view segue security_invoker.
DO $post$
DECLARE
  v_oid oid := to_regclass('public.v_des_desconto_por_checkin');
  v_md5 text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: v_des_desconto_por_checkin não existe — o card do check-in DES quebraria';
  END IF;
  v_md5 := md5(pg_catalog.pg_get_viewdef(v_oid, true));
  IF v_md5 <> '879fe737d8a8e872ab855c1db35d3179' THEN
    RAISE EXCEPTION 'POS2 FALHOU: a definição instalada de v_des_desconto_por_checkin (md5 %) não é a desta migration', v_md5;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
                  WHERE c.oid = v_oid AND lower(o) IN ('security_invoker=on', 'security_invoker=true')) THEN
    RAISE EXCEPTION 'POS3 FALHOU: v_des_desconto_por_checkin perdeu security_invoker — passaria a ler como dono, sem RLS';
  END IF;
END
$post$;
