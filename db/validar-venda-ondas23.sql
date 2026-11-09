-- Validação pós-apply da 20261021031000_venda_cliente_ondas23.sql (read-only).
--   ~/.config/afiacao/psql-ro -X -tA -v ON_ERROR_STOP=1 -f db/validar-venda-ondas23.sql
-- Esperado: uma linha começando com ✅. Antes do apply: ❌ (nunca erro — a existência é checada primeiro).
--
-- Confere as REGRAS da Task 9 no corpo vivo, não o md5: as três funções seguem evoluindo por outras entregas
-- (lente 20261021070000 e sensor 20261028220003 em venda_minhas_sugestoes; sucessor declarado do radar em
-- venda_gerar_lista, que passou a ler private.venda_lista_calc_efetiva) e o md5 fixo dava ❌ a cada evolução
-- serial legítima — validação que mente na evolução vira ruído que ninguém lê. Cada marcador abaixo é o trecho
-- que carrega UMA regra; sumir qualquer um é regressão real da Task 9.
WITH corpo AS (
  SELECT
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.venda_gerar_lista(date,text)'))      AS gerar,
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.venda_minhas_sugestoes(date)'))      AS minhas,
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private._venda_sugestoes_json(uuid,date)')) AS minhas_json,
    (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.venda_fechar_desfechos(date)'))      AS fechar
),
lista AS (
  -- A montagem do JSON da farmer mora no helper desde a 20261021070000; antes, no próprio corpo público.
  SELECT c.*, CASE WHEN position('private._venda_sugestoes_json(' IN c.minhas) > 0 THEN c.minhas_json ELSE c.minhas END AS json_src
    FROM corpo c
)
SELECT CASE
  WHEN to_regprocedure('private.venda_lista_complemento(date)') IS NULL
    OR to_regprocedure('private.venda_lista_preco(date)') IS NULL
    OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'venda_sugestao' AND column_name = 'preco_anterior')
    OR l.gerar IS NULL OR l.minhas IS NULL OR l.fechar IS NULL OR l.json_src IS NULL
    THEN '❌ FALTANDO — migration 20261021031000 não aplicada'
  -- Gerador: recompra da lista do dia; complemento/preço só na lista ATIVA de hoje, cada um atrás da sua onda.
  WHEN position('private.venda_lista_calc' IN l.gerar) = 0
    OR position('private.venda_lista_complemento(p_dia)' IN l.gerar) = 0
    OR position('private.venda_lista_preco(p_dia)' IN l.gerar) = 0
    OR position('p_fase = ''ativa'' AND p_dia = (now() AT TIME ZONE ''America/Sao_Paulo'')::date' IN l.gerar) = 0
    OR position('chave = ''onda_complemento'' AND valor = ''true''::jsonb' IN l.gerar) = 0
    OR position('chave = ''onda_preco'' AND valor = ''true''::jsonb' IN l.gerar) = 0
    OR position('preco_anterior' IN l.gerar) = 0
    THEN '❌ gerador perdeu uma regra das ondas 2/3 (fonte, gate de onda, só ativa de hoje ou preco_anterior)'
  -- Lista da farmer: por auth.uid(), expõe as ondas e a cadência, total/motivo só da recompra.
  WHEN position('auth.uid()' IN l.minhas) = 0
    OR position('''ondas''' IN l.json_src) = 0
    OR position('''cadencia_dias''' IN l.json_src) = 0
    OR position('FILTER (WHERE s.tipo = ''recompra'')' IN l.json_src) = 0
    THEN '❌ lista da farmer perdeu ondas, cadência ou o total/motivo só da recompra'
  -- Desfecho de preço: pedido é a unidade, exige alta sobre o anterior; não exibida = nao_medivel.
  WHEN position('pp.preco_medio_liq > pp.preco_anterior' IN l.fechar) = 0
    OR position('pp.preco_medio_bruto <= pp.preco_anterior' IN l.fechar) = 0
    OR position('a.mostrada_em IS NULL THEN ''nao_medivel''' IN l.fechar) = 0
    OR position('''nao_exibida''' IN l.fechar) = 0
    THEN '❌ desfecho de preço/complemento perdeu a alta sobre o anterior ou o nao_exibida'
  WHEN has_function_privilege('anon', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.venda_minhas_sugestoes(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_gerar_lista(date,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.venda_fechar_desfechos(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private.venda_lista_complemento(date)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private.venda_lista_preco(date)', 'EXECUTE')
    OR has_function_privilege('anon', 'private.venda_lista_preco(date)', 'EXECUTE')
    THEN '❌ ACL errada (anon aberta, farmer sem a lista, ou gerador/listas privadas abertas)'
  WHEN NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.venda_sugestao'::regclass
                      AND conname = 'venda_sugestao_preco_anterior_ck' AND convalidated)
    THEN '❌ CHECK venda_sugestao_preco_anterior_ck ausente ou NOT VALID'
  ELSE '✅ ondas 2/3 no ar: gerador com complemento/preço, lista com ondas, desfecho de preço exige alta'
END AS status
FROM lista l;
