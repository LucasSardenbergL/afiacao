-- Ensaio de RUNTIME da 20261113213317 em prod (PL/pgSQL é late-bound): roda os 4 corpos recriados com os dados reais.
-- SÓ com `bun run db:aplicar db/ensaio-venda-sistema.sql --ensaio` (o executor faz ROLLBACK; nada é gravado).
DO $ensaio$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_f uuid; v_c uuid; v_j jsonb; v_t text; v_ids uuid[]; v_n integer; v_g integer; v_l integer;
BEGIN
  SELECT s.farmer_user_id, min(s.comprador_id::text)::uuid INTO v_f, v_c
    FROM public.venda_sugestao s
   WHERE s.fase = 'ativa' AND s.tipo = 'recompra' AND s.dia_referencia = v_hoje AND s.braco = 'tratamento'
   GROUP BY s.farmer_user_id ORDER BY count(*) DESC LIMIT 1;
  IF v_f IS NULL THEN RAISE EXCEPTION 'ENSAIO: sem lista ativa de hoje para exercitar'; END IF;

  v_j := private._venda_sugestoes_json(v_f, v_hoje);
  IF (v_j -> 'ondas' ->> 'sistema') IS DISTINCT FROM 'true' OR jsonb_array_length(v_j -> 'compradores') < 1 THEN
    RAISE EXCEPTION 'ENSAIO: _venda_sugestoes_json sem ondas.sistema ou sem compradores: %', left(v_j::text, 200);
  END IF;
  SELECT b.texto, b.sugestao_ids INTO v_t, v_ids FROM private.venda_resumo_bloco(v_f, v_hoje, v_c, 1, 'm', 10, 'l') b;
  IF v_t IS NULL OR cardinality(v_ids) < 1 THEN RAISE EXCEPTION 'ENSAIO: bloco do e-mail vazio'; END IF;
  SELECT count(*) INTO v_l FROM private.venda_lista_sistema(v_hoje);
  v_g := public.venda_gerar_lista(v_hoje, 'ativa');
  v_n := public.venda_fechar_desfechos(v_hoje);
  RAISE NOTICE 'ENSAIO OK: compradores=% bloco=%c lista_sistema=% gerou=% fechou=%',
    jsonb_array_length(v_j -> 'compradores'), length(v_t), v_l, v_g, v_n;
END
$ensaio$;
