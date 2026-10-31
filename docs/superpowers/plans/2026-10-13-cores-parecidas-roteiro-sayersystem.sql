-- =====================================================================================
-- Roteiro de discovery no banco do Sayersystem (PostgreSQL) — usuário `integra`, SÓ LEITURA
-- Plano: docs/superpowers/plans/2026-10-13-cores-parecidas-tintometrico.md (§7, adendo de 2026-10-31)
-- Responde junto: (a) o "Passo 0" da frente de giro de corante (spec 2026-10-27 §6) e
--                 (b) as perguntas de cores parecidas / ordem de dosagem (controle_interno, RGB, cartela).
--
-- COMO RODAR: no cliente SQL do balcão (pgAdmin, psql ou DBeaver), conectado ao banco do
-- Sayersystem como `integra`. Rode UM BLOCO por vez e copie a saída de cada um (texto ou CSV),
-- com o número do bloco. Erro também é resposta: copie a mensagem e siga para o próximo bloco.
-- Nada aqui escreve no banco. Não cole a senha em lugar nenhum.
--
-- LGPD: nenhuma consulta devolve a coluna `cliente` (nome digitado no balcão) nem outra coluna
-- pessoal. Onde a coluna ainda não é conhecida, a linha passa por to_jsonb e só sai pela
-- ALLOWLIST abaixo (lista do que pode sair; coluna desconhecida é omitida). O valor de `cliente`
-- é lido na memória do servidor e descartado antes da saída — ele nunca aparece no resultado.
-- =====================================================================================

-- ── BLOCO 0 — sessão de leitura (pode dar erro de permissão no SET: ignore e siga) ─────
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SELECT version() AS versao_postgres, current_user AS usuario, now() AS agora_no_servidor;
-- Aceite: usuario = integra. A versão dimensiona o que o conector pode usar.


-- ── BLOCO 1 — colunas de vendas / vendas_item e onde mora o controle_interno ──────────
SELECT table_name, ordinal_position, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('vendas', 'vendas_item')
ORDER BY table_name, ordinal_position;
-- Aceite: as duas tabelas listadas com TODAS as colunas. Responde: em qual tabela está
-- `controle_interno` (ou nas duas); nome físico da data da dosagem; formato dos slots de
-- corante (coranteN/qtdN ou linha por corante); coluna de status/cancelamento, se houver.
-- Tabela ausente = 0 linhas dela → registrar como "não existe com esse nome".


-- ── BLOCO 2 — chave primária e ligação vendas ↔ vendas_item ───────────────────────────
SELECT tc.table_name, tc.constraint_type, tc.constraint_name,
       kcu.column_name, ccu.table_name AS tabela_referenciada, ccu.column_name AS coluna_referenciada
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
LEFT JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_type = 'FOREIGN KEY'
 AND ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
WHERE tc.table_schema = 'public' AND tc.table_name IN ('vendas', 'vendas_item')
  AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
ORDER BY tc.table_name, tc.constraint_type, kcu.ordinal_position;
-- Aceite: PK de cada tabela (Passo 0 do giro, critério 1) e a FK vendas_item → vendas.
-- Sem FK declarada (0 linhas FOREIGN KEY) → o Bloco 5 mede a ligação pelo nome da coluna.


-- ── BLOCO 3 — volume e profundidade: todas as colunas de data, nas duas tabelas ──────
-- (min/max em texto ISO; colunas de data são descobertas pelo nome, sem precisar conhecê-las)
SELECT 'vendas' AS tabela, e.key AS coluna, count(*) AS total_linhas,
       count(e.value) AS preenchidas, min(e.value) AS minimo, max(e.value) AS maximo
FROM vendas x, LATERAL jsonb_each_text(to_jsonb(x)) e
WHERE e.key ~* '^(data|dt_|hora)'
GROUP BY e.key
UNION ALL
SELECT 'vendas_item', e.key, count(*), count(e.value), min(e.value), max(e.value)
FROM vendas_item x, LATERAL jsonb_each_text(to_jsonb(x)) e
WHERE e.key ~* '^(data|dt_|hora)'
GROUP BY e.key
UNION ALL
SELECT 'vendas', '(contagem)', (SELECT count(*) FROM vendas), NULL, NULL, NULL
UNION ALL
SELECT 'vendas_item', '(contagem)', (SELECT count(*) FROM vendas_item), NULL, NULL, NULL
ORDER BY 1, 2;
-- Aceite: total de linhas de cada tabela e a faixa de datas (Passo 0, critério 4 — dimensiona
-- o backfill). Datas fora do formato AAAA-MM-DD aparecem cruas: registrar o formato.


-- ── BLOCO 4 — preenchimento do controle_interno (últimos 90 dias) ─────────────────────
-- Data de referência = 1ª coluna existente entre os nomes candidatos (a usada sai na saída).
-- Classe do valor: coluna_ausente · nulo · vazio · zero · so_digitos · digitos_com_separador · com_letras.
WITH linhas AS (
  SELECT 'vendas' AS tabela, to_jsonb(x) AS j FROM vendas x
  UNION ALL
  SELECT 'vendas_item', to_jsonb(x) FROM vendas_item x
), ref AS (
  SELECT tabela, j,
         COALESCE(j->>'data_venda', j->>'data_dosagem', j->>'data', j->>'data_hora', j->>'data_cadastro') AS data_ref,
         CASE WHEN j ? 'data_venda' THEN 'data_venda' WHEN j ? 'data_dosagem' THEN 'data_dosagem'
              WHEN j ? 'data' THEN 'data' WHEN j ? 'data_hora' THEN 'data_hora'
              WHEN j ? 'data_cadastro' THEN 'data_cadastro' ELSE '(nenhuma)' END AS coluna_data,
         j ? 'controle_interno' AS tem_coluna,
         btrim(j->>'controle_interno') AS ci
  FROM linhas
), janela AS (
  -- linha sem nenhuma coluna de data candidata fica (coluna_data = '(nenhuma)'), para a tabela não sumir
  SELECT * FROM ref WHERE data_ref IS NULL OR left(data_ref, 10) >= to_char(current_date - 90, 'YYYY-MM-DD')
), classe AS (
  SELECT tabela, coluna_data, ci,
         CASE WHEN NOT tem_coluna THEN 'coluna_ausente'
              WHEN ci IS NULL THEN 'nulo'
              WHEN ci = '' THEN 'vazio'
              WHEN ci ~ '^0+$' THEN 'zero'
              WHEN ci ~ '^[0-9]+$' THEN 'so_digitos'
              WHEN ci ~ '^[0-9 ./-]+$' THEN 'digitos_com_separador'
              ELSE 'com_letras' END AS classe
  FROM janela
)
SELECT tabela, coluna_data, classe, count(*) AS linhas,
       round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY tabela), 1) AS pct_da_tabela,
       sum(count(*)) OVER (PARTITION BY tabela) AS denominador_90d,
       min(length(ci)) AS compr_min, max(length(ci)) AS compr_max,
       count(DISTINCT ci) AS valores_distintos
FROM classe
GROUP BY tabela, coluna_data, classe
ORDER BY tabela, linhas DESC;
-- Aceite: para a tabela que TEM a coluna, a soma das classes = denominador_90d (total de
-- linhas nos 90 dias). Responde: % vazio/0/preenchido, comprimento e se é só dígito.
-- coluna_data = '(nenhuma)' ou denominador 0 → a janela não pegou: mandar o Bloco 3 que eu ajusto.


-- ── BLOCO 4b — formato do controle_interno sem expor conteúdo ─────────────────────────
-- Forma: dígito → 9, qualquer outro caractere (exceto espaço . / -) → A (ex.: "12345-6" vira "99999-9"). Amostra de no máx. 10 valores
-- SÓ DE DÍGITOS (nº de pedido, não é dado pessoal), os mais recentes.
WITH linhas AS (
  SELECT 'vendas' AS tabela, to_jsonb(x) AS j FROM vendas x
  UNION ALL
  SELECT 'vendas_item', to_jsonb(x) FROM vendas_item x
), ci AS (
  SELECT tabela, btrim(j->>'controle_interno') AS v,
         COALESCE(j->>'data_venda', j->>'data_dosagem', j->>'data', j->>'data_hora', j->>'data_cadastro') AS data_ref
  FROM linhas
  WHERE j ? 'controle_interno' AND btrim(j->>'controle_interno') !~ '^0*$'
)
(SELECT 'forma' AS tipo, tabela,
        regexp_replace(regexp_replace(v, '[0-9]', '9', 'g'), '[^9 ./-]', 'A', 'g') AS valor,
        count(*) AS linhas
 FROM ci GROUP BY 1, 2, 3 ORDER BY linhas DESC LIMIT 15)
UNION ALL
(SELECT 'amostra_digitos', tabela, v, NULL
 FROM (SELECT tabela, v, max(data_ref) AS data_ref FROM ci WHERE v ~ '^[0-9]+$' GROUP BY 1, 2) u
 ORDER BY data_ref DESC NULLS LAST LIMIT 10)
UNION ALL
(SELECT 'repetido_em_mais_de_1_linha', tabela, NULL, count(*)
 FROM (SELECT tabela, v FROM ci GROUP BY 1, 2 HAVING count(*) > 1) r GROUP BY 1, 2);
-- Aceite: formas dominantes (ex.: "99999" ⇒ nº puro); amostra ≤ 10; quantos nº de pedido
-- aparecem em mais de uma linha (um pedido com várias latas é legítimo — dimensiona o casamento).


-- ── BLOCO 5 — ligação vendas ↔ vendas_item pela coluna id_venda (se existir) ──────────
SELECT count(*) AS itens,
       count(*) FILTER (WHERE (to_jsonb(vi) ? 'id_venda')) AS itens_com_coluna_id_venda,
       count(v.id) AS itens_que_acham_a_venda,
       count(DISTINCT vi_j.id_venda) AS vendas_distintas_nos_itens
FROM vendas_item vi
CROSS JOIN LATERAL (SELECT to_jsonb(vi)->>'id_venda' AS id_venda) vi_j
LEFT JOIN vendas v ON v.id::text = vi_j.id_venda;
-- Aceite: itens_que_acham_a_venda = itens ⇒ a ligação é vendas_item.id_venda → vendas.id.
-- 0 em itens_com_coluna_id_venda ⇒ a coluna tem outro nome: usar o Bloco 1/2 para achar.


-- ── BLOCO 6 — Passo 0 do giro: 30 dosagens recentes com corante denso (sem cliente) ──
-- WP07 = id 12 (peso 1,95) · WP69 = id 11 (1,85) · WP02 = id 5 (1,58) — ids de tint_corantes/oben.
-- Saída pela ALLOWLIST (ids, slots, datas, status, quantidades, volumes); qualquer coluna com
-- nome de cliente/pessoa/contato/observação/usuário é removida mesmo que case a allowlist.
WITH it AS (
  SELECT x.id, to_jsonb(x) AS j FROM vendas_item x
  WHERE EXISTS (SELECT 1 FROM jsonb_each_text(to_jsonb(x)) e
                WHERE e.key ~* '^(id_)?corante' AND e.value IN ('12', '11', '5', 'WP07', 'WP69', 'WP02'))
  ORDER BY x.id DESC LIMIT 30
)
SELECT it.id,
       (SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each(it.j) e
         WHERE e.key ~* '^(id|id_[a-z0-9_]+|corante[0-9]*|qtd[a-z0-9_]*|quantidade[a-z_]*|data[a-z_]*|dt_[a-z_]*|hora[a-z_]*|status[a-z_]*|situacao[a-z_]*|cancel[a-z_]*|tipo[a-z_]*|controle_interno|volume[a-z_]*|lote[a-z_]*|fator[a-z_]*|unidade[a-z_]*|preco[a-z_]*|valor[a-z_]*|desconto[a-z_]*)$'
           AND e.key !~* '(client|nome|cpf|cnpj|fone|tel|email|ender|obs|usuario|operador|vendedor)') AS item_allowlist,
       (SELECT jsonb_object_agg(e.key, e.value) FROM vendas v, jsonb_each(to_jsonb(v)) e
         WHERE v.id::text = it.j->>'id_venda'
           AND e.key ~* '^(id|id_[a-z0-9_]+|data[a-z_]*|dt_[a-z_]*|hora[a-z_]*|status[a-z_]*|situacao[a-z_]*|cancel[a-z_]*|tipo[a-z_]*|controle_interno|quantidade[a-z_]*|volume[a-z_]*|preco[a-z_]*|valor[a-z_]*|desconto[a-z_]*)$'
           AND e.key !~* '(client|nome|cpf|cnpj|fone|tel|email|ender|obs|usuario|operador|vendedor)') AS venda_allowlist
FROM it
ORDER BY it.id DESC;
-- Aceite (Passo 0 do giro, critérios 1–3 e 5): 30 linhas (ou menos, se houver menos). Eu cruzo
-- qtdN com a fórmula da mesma cor/produto/base/embalagem em tint_formula_itens para decidir ml × g
-- (corante denso separa as hipóteses: g = ml × 1,95 no WP07). 0 linhas ⇒ os slots não usam
-- esses valores: mandar o Bloco 1 que eu ajusto o filtro.


-- ── BLOCO 7 — valores de status/tipo/cancelamento (Passo 0 do giro, critério 5) ──────
SELECT 'vendas' AS tabela, e.key AS coluna, e.value AS valor, count(*) AS linhas
FROM vendas x, LATERAL jsonb_each_text(to_jsonb(x)) e
WHERE e.key ~* '(status|situac|cancel|tipo|estorn|orcament|excluid|ativo)'
  AND e.key !~* '(client|nome|obs|usuario|operador)'
GROUP BY 1, 2, 3
UNION ALL
SELECT 'vendas_item', e.key, e.value, count(*)
FROM vendas_item x, LATERAL jsonb_each_text(to_jsonb(x)) e
WHERE e.key ~* '(status|situac|cancel|tipo|estorn|orcament|excluid|ativo)'
  AND e.key !~* '(client|nome|obs|usuario|operador)'
GROUP BY 1, 2, 3
ORDER BY 1, 2, linhas DESC;
-- Aceite: se existir coluna de status, os valores e a contagem de cada um (separa dosagem
-- executada de orçamento/cancelada). 0 linhas = não há coluna desse tipo (toda linha conta).


-- ── BLOCO 8 — padraocor: RGB, família, página e XYZ editado à mão ─────────────────────
-- XYZ esperado = sRGB → linear → matriz IEC 61966-2-1 (branco D65), escala 0–100.
-- Δ = maior diferença absoluta entre (x,y,z) gravado e o calculado. Faixas em vez de um corte
-- único, porque matriz arredondada a 4 casas já dá ~0,003 de diferença no branco.
WITH p AS (
  SELECT pc.*,
         EXISTS (SELECT 1 FROM formula f WHERE f.id_padraocor = pc.id) AS tem_formula,
         (pc.r IS NOT NULL AND pc.g IS NOT NULL AND pc.b IS NOT NULL) AS rgb_presente
  FROM padraocor pc
), q AS (
  SELECT p.*,
    CASE WHEN NOT rgb_presente THEN 'nulo'
         WHEN r::numeric NOT BETWEEN 0 AND 255 OR g::numeric NOT BETWEEN 0 AND 255 OR b::numeric NOT BETWEEN 0 AND 255 THEN 'fora_0_255'
         WHEN r::numeric = 0 AND g::numeric = 0 AND b::numeric = 0 THEN 'tudo_zero'
         ELSE 'valido' END AS rgb_classe
  FROM p
), lin AS (
  SELECT q.*,
    CASE WHEN r::float8/255 <= 0.04045 THEN r::float8/255/12.92 ELSE power((r::float8/255 + 0.055)/1.055, 2.4) END AS rl,
    CASE WHEN g::float8/255 <= 0.04045 THEN g::float8/255/12.92 ELSE power((g::float8/255 + 0.055)/1.055, 2.4) END AS gl,
    CASE WHEN b::float8/255 <= 0.04045 THEN b::float8/255/12.92 ELSE power((b::float8/255 + 0.055)/1.055, 2.4) END AS bl
  FROM q WHERE rgb_classe = 'valido'
), d AS (
  SELECT id, tem_formula,
    greatest(abs(x::float8 - 100*(0.4124564*rl + 0.3575761*gl + 0.1804375*bl)),
             abs(y::float8 - 100*(0.2126729*rl + 0.7151522*gl + 0.0721750*bl)),
             abs(z::float8 - 100*(0.0193339*rl + 0.1191920*gl + 0.9503041*bl))) AS delta
  FROM lin WHERE x IS NOT NULL AND y IS NOT NULL AND z IS NOT NULL
)
SELECT u.universo,
  count(*)                                                             AS total_cores,
  count(*) FILTER (WHERE q.rgb_classe = 'valido')                      AS rgb_valido,
  count(*) FILTER (WHERE q.rgb_classe = 'nulo')                        AS rgb_nulo,
  count(*) FILTER (WHERE q.rgb_classe = 'tudo_zero')                   AS rgb_tudo_zero,
  count(*) FILTER (WHERE q.rgb_classe = 'fora_0_255')                  AS rgb_fora_0_255,
  count(*) FILTER (WHERE NULLIF(btrim(q.familia::text), '') IS NOT NULL) AS com_familia,
  count(*) FILTER (WHERE NULLIF(btrim(q.pagina::text), '') IS NOT NULL
                     AND btrim(q.pagina::text) !~ '^0+$')              AS com_pagina,
  count(d.id)                                                          AS xyz_comparavel,
  count(*) FILTER (WHERE d.delta <= 0.01)                              AS xyz_delta_ate_0_01,
  count(*) FILTER (WHERE d.delta > 0.01 AND d.delta <= 0.05)           AS xyz_delta_0_01_a_0_05,
  count(*) FILTER (WHERE d.delta > 0.05 AND d.delta <= 0.5)            AS xyz_delta_0_05_a_0_5,
  count(*) FILTER (WHERE d.delta > 0.5)                                AS xyz_delta_acima_0_5
FROM q
LEFT JOIN d ON d.id = q.id
CROSS JOIN LATERAL (VALUES ('todas'), (CASE WHEN q.tem_formula THEN 'com_formula' END)) u(universo)
WHERE u.universo IS NOT NULL
GROUP BY u.universo
ORDER BY u.universo DESC;
-- Aceite: 2 linhas (todas · com_formula). Em cada: rgb_valido+rgb_nulo+rgb_tudo_zero+rgb_fora_0_255
-- = total_cores, e a soma das 4 faixas de Δ = xyz_comparavel. "XYZ editado à mão" = Δ > 0,05.


-- ── BLOCO 8b — família (top 15) e mesma cor com RGB diferente entre subcoleções ──────
(SELECT 'familia' AS tipo, COALESCE(NULLIF(btrim(familia::text), ''), '(vazio)') AS valor, count(*) AS cores
 FROM padraocor GROUP BY 1, 2 ORDER BY cores DESC LIMIT 15)
UNION ALL
(SELECT 'codigo_em_mais_de_1_linha', NULL, count(*) FROM (
   SELECT codigo FROM padraocor GROUP BY codigo HAVING count(*) > 1) s)
UNION ALL
(SELECT 'codigo_repetido_com_rgb_diferente', NULL, count(*) FROM (
   SELECT codigo FROM padraocor WHERE r IS NOT NULL
   GROUP BY codigo HAVING count(DISTINCT (r::text || ',' || g::text || ',' || b::text)) > 1) s);
-- Aceite: famílias com contagem (o vocabulário real de "tom"); quantos códigos repetem e
-- quantos destes divergem no RGB (decide se dá para consolidar a referência por código).


-- ── BLOCO 9 — cartela (RAL / NCS / Pantone) em formula.tag e padraocor.descricao ─────
-- Padrões conservadores (falso positivo é pior que falso negativo):
--   RAL      = "RAL" + 4 dígitos (RAL 7016, RAL-9010)
--   NCS      = a palavra NCS, ou código S 2010-Y30R
--   Pantone  = a palavra PANTONE ou "PMS" + número
WITH tags AS (
  SELECT id_padraocor, string_agg(DISTINCT btrim(tag), ' | ') AS tags
  FROM formula WHERE NULLIF(btrim(tag), '') IS NOT NULL GROUP BY id_padraocor
), c AS (
  SELECT pc.id, pc.descricao, t.tags,
         EXISTS (SELECT 1 FROM formula f WHERE f.id_padraocor = pc.id) AS tem_formula,
         t.tags ~* '(^|[^a-z])ral[ -]?[0-9]{4}([^0-9]|$)'                  AS tag_ral,
         t.tags ~* '\mncs\M|(^|[^a-z0-9])s ?[0-9]{4}-[a-z][0-9]{0,2}[a-z]?'  AS tag_ncs,
         t.tags ~* '\mpantone\M|\mpms ?[0-9]{2,4}'                          AS tag_pantone,
         pc.descricao ~* '(^|[^a-z])ral[ -]?[0-9]{4}([^0-9]|$)'                 AS desc_ral,
         pc.descricao ~* '\mncs\M|(^|[^a-z0-9])s ?[0-9]{4}-[a-z][0-9]{0,2}[a-z]?' AS desc_ncs,
         pc.descricao ~* '\mpantone\M|\mpms ?[0-9]{2,4}'                         AS desc_pantone,
         substring(lower(t.tags) FROM 'ral[ -]?([0-9]{4})')        AS ral_tag,   -- substring, não regexp_matches:
         substring(lower(pc.descricao) FROM 'ral[ -]?([0-9]{4})')  AS ral_desc   -- este descartaria a cor sem casamento
  FROM padraocor pc LEFT JOIN tags t ON t.id_padraocor = pc.id
)
SELECT
  count(*)                                                     AS total_cores,
  count(*) FILTER (WHERE tem_formula)                          AS cores_com_formula,
  count(*) FILTER (WHERE tags IS NOT NULL)                     AS cores_com_tag,
  count(*) FILTER (WHERE COALESCE(tag_ral, false))             AS tag_ral,
  count(*) FILTER (WHERE COALESCE(tag_ncs, false))             AS tag_ncs,
  count(*) FILTER (WHERE COALESCE(tag_pantone, false))         AS tag_pantone,
  count(*) FILTER (WHERE COALESCE(desc_ral, false))            AS descricao_ral,
  count(*) FILTER (WHERE COALESCE(desc_ncs, false))            AS descricao_ncs,
  count(*) FILTER (WHERE COALESCE(desc_pantone, false))        AS descricao_pantone,
  count(*) FILTER (WHERE COALESCE(tag_ral OR tag_ncs OR tag_pantone OR desc_ral OR desc_ncs OR desc_pantone, false))
                                                               AS alguma_cartela,
  count(*) FILTER (WHERE ral_tag IS NOT NULL AND ral_desc IS NOT NULL AND ral_tag <> ral_desc)
                                                               AS ral_tag_diverge_da_descricao,
  (SELECT count(*) FROM formula)                               AS total_formulas,
  (SELECT count(*) FROM formula WHERE NULLIF(btrim(tag), '') IS NOT NULL) AS formulas_com_tag
FROM c;
-- Aceite: denominador = total_cores (e cores_com_formula ao lado). Decisão do plano: se
-- alguma_cartela < ~5% das cores com fórmula, a busca por cartela vira baixa prioridade.


-- ── BLOCO 9b — amostra das 15 TAGs mais frequentes (texto de catálogo, não é dado pessoal) ─
SELECT btrim(tag) AS tag, count(*) AS formulas, count(DISTINCT id_padraocor) AS cores
FROM formula WHERE NULLIF(btrim(tag), '') IS NOT NULL
GROUP BY 1 ORDER BY formulas DESC LIMIT 15;
-- Aceite: até 15 linhas. Mostra o padrão real de escrita da TAG (afina o parser do F0 item 7).
-- (Não amostramos personcor.descricao: ela pode trazer nome de cliente.)
