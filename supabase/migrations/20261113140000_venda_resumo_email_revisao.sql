-- ════════════════════════════════════════════════════════════════════════════════════════════════════════
-- Venda R2 · Entrega 1 — REVISÃO do resumo por e-mail (code review do PR #3873, 13/11/2026). Recria 3 funções da
-- 20261113110100 (já aplicada em prod, recibo #1108) a partir dos corpos VIVOS (md5 medidos via psql-ro):
--  1. venda_resumo_preparar — (a) saudação só com nome de gente: o profiles.name da Tatyana em prod é um username
--     com dígitos, e o 1º e-mail diria "Bom dia, Tatyanamartins2002!"; (b) o gate de versão da edge passa a ser por
--     NÚMERO (≥ v1.3) — a denylist das 3 versões antigas deixava passar qualquer string desconhecida (rollback para
--     um hotfix 'v1.2b-…' mandaria o resumo pela edge que não conhece venda_resumo_envio, e o sensor o contaria
--     como entregue à farmer).
--  2. private.venda_resumo_oportunidades — oferta exige o contato CRIADO depois do envio: venda_contato é upsert
--     "último toque do dia vence", e um contato de antes do e-mail re-tocado depois virava "oferta do resumo".
--  3. venda_resumo_painel — IC95 da diferença por Newcombe (Wilson por braço, private.venda_wilson): o Wald dava
--     largura ZERO com 0% num braço, precisão falsa justamente quando há menos dado.
-- Aplicar: `bun run db:aplicar` (sem BEGIN/COMMIT). Prova: db/test-venda-resumo-email.sh (aplica as duas).
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── TRAVA: prende as 3 vivas antes de ler ─────────────────────────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.venda_resumo_preparar(date,uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.venda_resumo_preparar(date, uuid) VOLATILE;
  END IF;
  IF to_regprocedure('private.venda_resumo_oportunidades()') IS NOT NULL THEN
    ALTER FUNCTION private.venda_resumo_oportunidades() STABLE;
  END IF;
  IF to_regprocedure('public.venda_resumo_painel(date,date)') IS NOT NULL THEN
    ALTER FUNCTION public.venda_resumo_painel(date, date) STABLE;
  END IF;
END
$trava$;

-- ── PRE: cada corpo vivo é o da 20261113110100 (medido em prod 13/11) ou já é este ───────────────────────
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('public.venda_resumo_preparar(date,uuid)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.venda_resumo_preparar(date,uuid)')),
         'ad8b87e661cd540966b9058f2a8635a4', '31a29f5d85d1d52e600c6ee808969fd8'),
        ('private.venda_resumo_oportunidades()',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('private.venda_resumo_oportunidades()')),
         'a06cf6c18bc216bfa0fd55692a869d66', '2de7b60b5546ca1610daf25529dcea36'),
        ('public.venda_resumo_painel(date,date)',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.venda_resumo_painel(date,date)')),
         'f419c73ff662d9a3204096a0a04507a3', '715e028256fb813fa5416299593810e0')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) nao e o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- Intervalo de Wilson (95%) de uma proporção p com n observações. NULL com n < 1 (ausente ≠ zero).
CREATE OR REPLACE FUNCTION private.venda_wilson(p numeric, n integer, OUT lo numeric, OUT hi numeric)
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN n >= 1 THEN c - m END, CASE WHEN n >= 1 THEN c + m END
    FROM (SELECT (p + 1.96 ^ 2 / (2 * n)) / (1 + 1.96 ^ 2 / n) AS c,
                 1.96 * sqrt(p * (1 - p) / n + 1.96 ^ 2 / (4 * n ^ 2)) / (1 + 1.96 ^ 2 / n) AS m
           WHERE n >= 1) w
  UNION ALL
  SELECT NULL, NULL WHERE n IS NULL OR n < 1
$$;
REVOKE ALL ON FUNCTION private.venda_wilson(numeric, integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.venda_resumo_preparar(
  p_dia date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'))::date,
  p_teste_para uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_app_padrao constant text := 'https://steu.lovable.app';
  c_url_ok     constant text := '^https://[A-Za-z0-9.-]+(:[0-9]+)?$';
  c_email_ok   constant text := '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';
  c_versao     constant text := 'r2-v1';
  v_ini        timestamptz := clock_timestamp();
  v_teste      boolean := p_teste_para IS NOT NULL;
  v_app        text;
  v_inicio     date;
  v_edge       text;
  r            record;
  d            record;
  k            record;
  v_sel_id     uuid;
  v_nome       text;
  v_saud       text;
  v_email      text;
  v_tent       integer;
  v_envio      uuid;
  v_alerta     bigint;
  v_lista      text;
  v_titulo     text;
  v_corpo      text;
  v_tokens     uuid[];
  v_pos        integer[];
  v_comps      uuid[];
  v_sels       uuid[];
  v_token      uuid;
  v_texto      text;
  v_ids        uuid[];
  v_n          integer;
  v_enviados   jsonb := '[]'::jsonb;
  v_pulados    jsonb := '[]'::jsonb;
  v_erros      jsonb := '[]'::jsonb;
  v_out        jsonb;
BEGIN
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_resumo_preparar: p_dia NULL' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('venda.resumo_preparar'));

  SELECT NULLIF(btrim(cc.value), '') INTO v_app FROM public.company_config cc WHERE cc.key = 'app_url_publica';
  v_app := rtrim(COALESCE(v_app, c_app_padrao), '/');
  SELECT s.inicio INTO v_inicio FROM public.venda_braco_sorteio s WHERE s.id = 1;
  -- ORDEM (gate de runtime, não só de apply): a dispatch-notifications ANTERIOR à v1.3 não conhece venda_resumo_envio —
  -- mandaria o resumo ao endereço padrão com o corpo técnico e marcaria `notificado`, e o sensor contaria como entregue
  -- à farmer. Só enfileira com a atestação MAIS RECENTE da edge (ledger + janela viva, a leitura de
  -- scripts/pendencias-deploy.ts) em v1.3 ou acima — pelo NÚMERO (revisão 13/11: a denylist das 3 antigas deixava
  -- passar qualquer string desconhecida, ex. um rollback para 'v1.2b-hotfix'). Fora da forma vN.M-… = bloqueia.
  WITH tudo AS (
    SELECT a.request_id, a.edge, a.versao, a.observado_em FROM public.deploy_atestacoes a
    UNION ALL
    SELECT j.request_id, j.edge, j.versao, j.observado_em FROM public.deploy_atestacoes_janela_viva() j
  )
  SELECT t.versao INTO v_edge FROM tudo t
   WHERE t.edge = 'dispatch-notifications'
   ORDER BY t.observado_em DESC, t.request_id DESC
   LIMIT 1;

  IF v_edge IS NULL OR v_edge !~ '^v[0-9]+\.[0-9]+-'
     OR (substring(v_edge FROM '^v([0-9]+)\.')::int, substring(v_edge FROM '^v[0-9]+\.([0-9]+)-')::int) < (1, 3) THEN
    v_out := jsonb_build_object('dia', p_dia, 'erro', 'edge_desatualizada', 'versao_atestada', v_edge);
  ELSIF v_app !~ c_url_ok THEN
    v_out := jsonb_build_object('dia', p_dia, 'erro', 'app_url_publica_invalida');
  ELSIF NOT v_teste AND (v_inicio IS NULL OR p_dia < v_inicio) THEN
    v_out := jsonb_build_object('dia', p_dia, 'erro', 'antes_do_inicio', 'inicio', v_inicio);
  ELSIF NOT EXISTS (SELECT 1 FROM public.venda_gerador_execucao e
                     WHERE e.dia_referencia = p_dia AND e.fase = 'ativa') THEN
    -- Sem lista ativa do dia (gerador não rodou, onda desligada): não inventa resumo com a lista de ontem.
    v_out := jsonb_build_object('dia', p_dia, 'erro', 'lista_do_dia_ausente');
  END IF;
  IF v_out IS NOT NULL THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('venda.resumo_email', CASE WHEN v_teste THEN 'manual' ELSE 'automatica' END, v_ini, clock_timestamp(),
            'erro', v_out);
    RETURN v_out;
  END IF;

  FOR r IN SELECT c.* FROM public.venda_resumo_config c WHERE c.ativo ORDER BY c.farmer_user_id LOOP
    -- Cada farmer numa subtransação: o erro de uma desfaz só o dela, vai para `erros` e a outra segue.
    BEGIN
      -- (a) A SELEÇÃO do experimento: uma vez por farmer × dia, nos dois braços, com os itens que o e-mail mostraria.
      IF NOT v_teste AND NOT EXISTS (SELECT 1 FROM public.venda_resumo_selecao x
                                      WHERE x.dia = p_dia AND x.farmer_user_id = r.farmer_user_id) THEN
        FOR k IN SELECT * FROM private.venda_resumo_ranking(r.farmer_user_id, p_dia, r.max_oportunidades, r.max_cidade)
        LOOP
          IF k.braco IS NULL THEN
            RAISE EXCEPTION 'venda_resumo_preparar: comprador % sem braco no dia %', k.comprador_id, p_dia
              USING ERRCODE = '55000';
          END IF;
          INSERT INTO public.venda_resumo_selecao
                 (dia, farmer_user_id, comprador_id, posicao, braco, grupo, motivo_entrada, valor_ref_total, versao_ranking)
          VALUES (p_dia, r.farmer_user_id, k.comprador_id, k.posicao, k.braco, k.grupo, k.motivo_entrada,
                  k.valor_ref_total, c_versao || ':k=' || r.max_oportunidades || ',cidade=' || r.max_cidade)
          RETURNING id INTO v_sel_id;
          SELECT b.sugestao_ids INTO v_ids
            FROM private.venda_resumo_bloco(r.farmer_user_id, p_dia, k.comprador_id, k.posicao, k.motivo_entrada,
                                            k.valor_ref_total, '') b;
          INSERT INTO public.venda_resumo_item (selecao_id, sugestao_id, ordem)
          SELECT v_sel_id, u.id, u.ord FROM unnest(v_ids) WITH ORDINALITY AS u(id, ord);
        END LOOP;
      END IF;

      SELECT COALESCE(NULLIF(split_part(btrim(p.name), ' ', 1), ''), 'vendedora') INTO v_nome
        FROM public.profiles p WHERE p.user_id = r.farmer_user_id ORDER BY p.created_at LIMIT 1;
      v_nome := COALESCE(v_nome, 'vendedora');
      v_nome := upper(left(v_nome, 1)) || lower(substr(v_nome, 2));
      -- Saudação só com nome de GENTE (revisão 13/11): o profiles.name da Tatyana em prod é um username com dígitos,
      -- e "Bom dia, Tatyanamartins2002!" seria o 1º contato do canal. Token com dígito, _, @ ou ponto → "Bom dia!".
      -- (A cópia do founder segue rotulando com o token cru: ali ele identifica, não cumprimenta.)
      v_saud := CASE WHEN v_nome ~ '^[^0-9_@.[:space:]]+$' THEN v_nome END;

      -- (b) Os destinos: farmer + cópia (ou só o teste).
      FOR d IN
        SELECT x.tipo, x.user_id
          FROM (VALUES ('farmer', r.farmer_user_id, 1), ('copia', r.copia_user_id, 2)) AS x(tipo, user_id, ord)
         WHERE NOT v_teste AND x.user_id IS NOT NULL
        UNION ALL
        SELECT 'teste', p_teste_para WHERE v_teste
      LOOP
        IF d.tipo <> 'teste' AND EXISTS (
             SELECT 1 FROM public.venda_resumo_envio e
               LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
              WHERE e.dia = p_dia AND e.farmer_user_id = r.farmer_user_id AND e.tipo = d.tipo
                AND fa.status IS DISTINCT FROM 'falha_notificacao') THEN
          v_pulados := v_pulados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'motivo', 'ja_enviado_no_dia');
          CONTINUE;
        END IF;

        SELECT btrim(p.email) INTO v_email FROM public.profiles p WHERE p.user_id = d.user_id ORDER BY p.created_at LIMIT 1;
        IF v_email IS NULL OR v_email !~ c_email_ok THEN
          v_pulados := v_pulados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'motivo', 'sem_email');
          CONTINUE;
        END IF;

        -- As oportunidades DO E-MAIL: o tratamento da seleção gravada (no teste, o ranking ao vivo sem o controle).
        v_lista := ''; v_tokens := '{}'; v_pos := '{}'; v_comps := '{}'; v_sels := '{}'; v_n := 0;
        FOR k IN
          SELECT x.comprador_id, x.id AS selecao_id, x.motivo_entrada, x.valor_ref_total, x.posicao
            FROM public.venda_resumo_selecao x
           WHERE NOT v_teste AND x.dia = p_dia AND x.farmer_user_id = r.farmer_user_id AND x.braco = 'tratamento'
          UNION ALL
          SELECT g.comprador_id, NULL::uuid, g.motivo_entrada, g.valor_ref_total, g.posicao
            FROM private.venda_resumo_ranking(r.farmer_user_id, p_dia, r.max_oportunidades, r.max_cidade) g
           WHERE v_teste AND g.braco IS DISTINCT FROM 'controle'
           ORDER BY 5
        LOOP
          v_n := v_n + 1;
          v_token := gen_random_uuid();
          SELECT b.texto INTO v_texto
            FROM private.venda_resumo_bloco(r.farmer_user_id, p_dia, k.comprador_id, v_n, k.motivo_entrada,
                                            k.valor_ref_total, v_app || '/meu-dia/abrir/' || v_token) b;
          IF v_texto IS NULL THEN   -- ausente ≠ vazio: um bloco NULL apagaria o e-mail inteiro em silêncio
            RAISE EXCEPTION 'venda_resumo_preparar: bloco NULL para o comprador %', k.comprador_id USING ERRCODE = '22004';
          END IF;
          v_lista := v_lista || v_texto || E'\n\n';
          v_tokens := v_tokens || v_token; v_pos := v_pos || v_n;
          v_comps := v_comps || k.comprador_id; v_sels := v_sels || k.selecao_id;
        END LOOP;
        IF v_n = 0 THEN
          v_pulados := v_pulados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'motivo', 'sem_oportunidades');
          CONTINUE;
        END IF;

        v_titulo := 'Meu Dia: ' || v_n || CASE WHEN v_n = 1 THEN ' cliente' ELSE ' clientes' END
                 || ' para ligar hoje (' || to_char(p_dia, 'DD/MM') || ')';
        v_corpo := 'Bom dia' || COALESCE(', ' || v_saud, '') || '!' || E'\n\n'
          || 'Separei ' || v_n || CASE WHEN v_n = 1 THEN ' cliente' ELSE ' clientes' END
          || ' para você ligar hoje: primeiro os das cidades com entrega amanhã, depois os maiores atrasos da carteira. '
          || 'Os valores são o que o cliente costuma comprar desses itens, ao último preço que ele pagou.' || E'\n\n'
          || v_lista
          || 'O link abre a ficha do cliente no app, com o histórico e o botão para registrar a ligação. '
          || 'Registre o resultado de cada uma (1 toque): é assim que a gente sabe o que funcionou.';
        IF d.tipo = 'copia' THEN
          v_titulo := '[Cópia · ' || v_nome || '] ' || v_titulo;
          v_corpo := 'Cópia do resumo enviado hoje a ' || v_nome || ' — para o ritual de 10 minutos com ela. '
            || 'Os links desta cópia são seus: abrir não conta como clique dela.' || E'\n\n' || v_corpo;
        ELSIF d.tipo = 'teste' THEN
          v_titulo := '[TESTE] ' || v_titulo;
          v_corpo := '[TESTE] Resumo de ' || v_nome || ' de ' || to_char(p_dia, 'DD/MM')
            || ', desviado para você. Não entra em nenhuma conta.' || E'\n\n' || v_corpo;
        END IF;

        SELECT COALESCE(max(e.tentativa), 0) + 1 INTO v_tent FROM public.venda_resumo_envio e
         WHERE e.dia = p_dia AND e.farmer_user_id = r.farmer_user_id AND e.tipo = d.tipo;
        v_envio := gen_random_uuid();

        IF v_corpo IS NULL OR v_titulo IS NULL THEN
          RAISE EXCEPTION 'venda_resumo_preparar: corpo/titulo NULL (farmer %)', r.farmer_user_id USING ERRCODE = '22004';
        END IF;
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
        VALUES ('oben', 'outro', 'info', v_titulo, v_corpo, 'pendente_notificacao',
                jsonb_build_object('origem', 'venda.resumo_email', 'envio_id', v_envio, 'dia', p_dia, 'tipo', d.tipo,
                                   'farmer', r.farmer_user_id, 'n_oportunidades', v_n, 'tentativa', v_tent))
        RETURNING id INTO v_alerta;

        INSERT INTO public.venda_resumo_envio
               (id, dia, farmer_user_id, tipo, tentativa, destinatario_user_id, destinatario_email, alerta_id, n_oportunidades)
        VALUES (v_envio, p_dia, r.farmer_user_id, d.tipo, v_tent, d.user_id, v_email, v_alerta, v_n);

        INSERT INTO public.venda_resumo_link (token, envio_id, posicao, comprador_id, selecao_id)
        SELECT u.token, v_envio, u.pos, u.comp, u.sel
          FROM unnest(v_tokens, v_pos, v_comps, v_sels) AS u(token, pos, comp, sel);

        v_enviados := v_enviados || jsonb_build_object('farmer', r.farmer_user_id, 'tipo', d.tipo, 'envio_id', v_envio,
                                                       'alerta_id', v_alerta, 'oportunidades', v_n, 'tentativa', v_tent);
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      v_erros := v_erros || jsonb_build_object('farmer', r.farmer_user_id, 'sqlstate', SQLSTATE, 'erro', left(SQLERRM, 300));
    END;
  END LOOP;

  v_out := jsonb_build_object('dia', p_dia, 'teste', v_teste, 'enviados', v_enviados, 'pulados', v_pulados,
                              'erros', v_erros);
  INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('venda.resumo_email', CASE WHEN v_teste THEN 'manual' ELSE 'automatica' END, v_ini, clock_timestamp(),
          CASE WHEN jsonb_array_length(v_erros) > 0 THEN 'erro' ELSE 'sucesso' END, v_out);
  RETURN v_out;
END
$$;

CREATE OR REPLACE FUNCTION private.venda_resumo_oportunidades()
RETURNS TABLE (dia date, farmer_user_id uuid, comprador_id uuid, enviado_em timestamptz, clicado boolean, resultado text)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH ops AS (
    SELECT e.dia, e.farmer_user_id, l.comprador_id, fa.email_enviado_em AS enviado_em,
           (l.clicado_em IS NOT NULL AND l.clicado_por = e.destinatario_user_id) AS clicado
      FROM public.venda_resumo_envio e
      JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id AND fa.status = 'notificado'
      JOIN public.venda_resumo_link l ON l.envio_id = e.id
     WHERE e.tipo = 'farmer'
  )
  SELECT o.dia, o.farmer_user_id, o.comprador_id, o.enviado_em, o.clicado, ct.resultado
    FROM ops o
    LEFT JOIN LATERAL (
      SELECT vc.resultado FROM public.venda_contato vc
       WHERE vc.farmer_user_id = o.farmer_user_id AND vc.comprador_id = o.comprador_id
         AND vc.dia >= o.dia AND vc.dia <= private.venda_prox_dia_util(o.dia)
         -- criado_em, não atualizado_em: o upsert "último toque do dia vence" re-toca atualizado_em (revisão 13/11)
         AND vc.criado_em >= COALESCE(o.enviado_em, 'infinity'::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM ops o2
                          WHERE o2.farmer_user_id = o.farmer_user_id AND o2.comprador_id = o.comprador_id
                            AND o2.dia > o.dia AND o2.dia <= vc.dia)
       ORDER BY vc.dia LIMIT 1) ct ON true
$$;

CREATE OR REPLACE FUNCTION public.venda_resumo_painel(p_de date, p_ate date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_hoje   date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_s      record;
  v_dias   jsonb;
  v_farm   jsonb;
  v_ef     jsonb;
  v_aa     jsonb;
  t        record;
  c        record;
  v_dif    numeric;
  v_lo     numeric;
  v_hi     numeric;
  w1       record;
  w0       record;
BEGIN
  IF v_uid IS NULL OR NOT COALESCE(public.has_role(v_uid, 'master'::public.app_role), false) THEN
    RAISE EXCEPTION 'venda_resumo_painel: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_de IS NULL OR p_ate IS NULL OR p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'PAINEL_PERIODO: periodo invalido (de=%, ate=%; maximo 400 dias)', p_de, p_ate USING ERRCODE = '22023';
  END IF;

  SELECT s.* INTO v_s FROM public.venda_braco_sorteio s WHERE s.id = 1;

  -- por dia × farmer (no período)
  SELECT COALESCE(jsonb_agg(x ORDER BY x.dia DESC, x.farmer_user_id), '[]'::jsonb) INTO v_dias
    FROM (
      SELECT e.dia, e.farmer_user_id,
             (SELECT COALESCE(NULLIF(btrim(p.name), ''), e.farmer_user_id::text) FROM public.profiles p
               WHERE p.user_id = e.farmer_user_id ORDER BY p.created_at LIMIT 1) AS nome,
             fa.status AS envio_status, fa.email_enviado_em AS enviado_em, e.aberto_em, e.tentativa,
             (SELECT count(*) FROM private.venda_resumo_oportunidades() o WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS entregues,
             (SELECT count(*) FILTER (WHERE o.clicado) FROM private.venda_resumo_oportunidades() o
               WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS clicadas,
             (SELECT count(*) FILTER (WHERE o.resultado IS NOT NULL) FROM private.venda_resumo_oportunidades() o
               WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS tentativas,
             (SELECT count(*) FILTER (WHERE o.resultado IN ('vendeu', 'vai_pedir', 'sem_interesse')) FROM private.venda_resumo_oportunidades() o
               WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id) AS ofertadas,
             (fa.status = 'notificado' AND (
                EXISTS (SELECT 1 FROM private.venda_resumo_oportunidades() o WHERE o.dia = e.dia AND o.farmer_user_id = e.farmer_user_id AND o.clicado)
                OR EXISTS (SELECT 1 FROM public.venda_lista_acesso a WHERE a.farmer_user_id = e.farmer_user_id AND a.dia = e.dia)
             )) AS acesso_validado,
             (SELECT fc.status FROM public.venda_resumo_envio ec
                JOIN public.fornecedor_alerta fc ON fc.id = ec.alerta_id
               WHERE ec.dia = e.dia AND ec.farmer_user_id = e.farmer_user_id AND ec.tipo = 'copia'
               ORDER BY ec.tentativa DESC LIMIT 1) AS copia_status
        FROM public.venda_resumo_envio e
        LEFT JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
       WHERE e.tipo = 'farmer' AND e.dia BETWEEN p_de AND p_ate
         AND e.tentativa = (SELECT max(e2.tentativa) FROM public.venda_resumo_envio e2
                             WHERE e2.dia = e.dia AND e2.farmer_user_id = e.farmer_user_id AND e2.tipo = 'farmer')
    ) x;

  -- por farmer, desde o início: o critério de desligar
  SELECT COALESCE(jsonb_agg(y ORDER BY y.farmer_user_id), '[]'::jsonb) INTO v_farm
    FROM (
      SELECT z.*,
             CASE WHEN z.entregues > 0 THEN round(z.ofertadas::numeric / z.entregues, 4) END AS taxa_ofertada,
             CASE WHEN z.dias_com_envio < 10 THEN 'medindo'
                  WHEN z.dias_acesso_validado = 0 THEN 'acesso_pendente'
                  WHEN z.ofertadas::numeric / NULLIF(z.entregues, 0) < 0.5 THEN 'desligar'
                  ELSE 'manter' END AS status
        FROM (
          SELECT f.farmer_user_id,
                 (SELECT COALESCE(NULLIF(btrim(p.name), ''), f.farmer_user_id::text) FROM public.profiles p
                   WHERE p.user_id = f.farmer_user_id ORDER BY p.created_at LIMIT 1) AS nome,
                 (SELECT min(o.dia) FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS primeiro_envio,
                 (SELECT count(DISTINCT o.dia) FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS dias_com_envio,
                 (SELECT count(DISTINCT o.dia) FROM private.venda_resumo_oportunidades() o
                   WHERE o.farmer_user_id = f.farmer_user_id
                     AND (EXISTS (SELECT 1 FROM private.venda_resumo_oportunidades() o3 WHERE o3.farmer_user_id = o.farmer_user_id
                                   AND o3.dia = o.dia AND o3.clicado)
                          OR EXISTS (SELECT 1 FROM public.venda_lista_acesso a
                                      WHERE a.farmer_user_id = o.farmer_user_id AND a.dia = o.dia))) AS dias_acesso_validado,
                 (SELECT count(*) FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS entregues,
                 (SELECT count(*) FILTER (WHERE o.clicado) FROM private.venda_resumo_oportunidades() o
                   WHERE o.farmer_user_id = f.farmer_user_id) AS clicadas,
                 (SELECT count(*) FILTER (WHERE o.resultado IS NOT NULL) FROM private.venda_resumo_oportunidades() o
                   WHERE o.farmer_user_id = f.farmer_user_id) AS tentativas,
                 (SELECT count(*) FILTER (WHERE o.resultado IN ('vendeu', 'vai_pedir', 'sem_interesse'))
                    FROM private.venda_resumo_oportunidades() o WHERE o.farmer_user_id = f.farmer_user_id) AS ofertadas
            FROM public.venda_resumo_config f
        ) z
    ) y;

  -- efeito por braço: comprador na 1ª seleção desde o início
  WITH prim AS (
    SELECT DISTINCT ON (x.comprador_id) x.comprador_id, x.dia, x.farmer_user_id, x.braco
      FROM public.venda_resumo_selecao x
     ORDER BY x.comprador_id, x.dia, x.posicao
  ),
  d AS (
    SELECT p.braco,
           count(s.id) AS linhas,
           count(s.id) FILTER (WHERE s.desfecho IS NULL) AS abertas,
           COALESCE(bool_or(s.desfecho = 'virou_pedido'), false) AS virou,
           COALESCE(bool_or(s.desfecho = 'nao_medivel'), false) AS algum_nm
      FROM prim p
      LEFT JOIN public.venda_sugestao s
             ON s.fase = 'ativa' AND s.tipo = 'recompra' AND s.farmer_user_id = p.farmer_user_id
            AND s.comprador_id = p.comprador_id AND s.dia_referencia = p.dia
     GROUP BY p.comprador_id, p.braco
  ),
  b AS (
    SELECT d.braco,
           count(*) AS compradores,
           count(*) FILTER (WHERE d.linhas = 0) AS sem_linhas,
           count(*) FILTER (WHERE d.linhas > 0 AND d.abertas = 0) AS maduros,
           count(*) FILTER (WHERE d.linhas > 0 AND d.abertas = 0 AND d.virou) AS converteram,
           count(*) FILTER (WHERE d.linhas > 0 AND d.abertas = 0 AND NOT d.virou AND d.algum_nm) AS nao_medivel
      FROM d GROUP BY d.braco
  )
  SELECT jsonb_object_agg(b.braco, jsonb_build_object(
           'compradores', b.compradores, 'maduros', b.maduros, 'converteram', b.converteram,
           'nao_medivel', b.nao_medivel, 'sem_linhas', b.sem_linhas,
           'taxa', CASE WHEN b.maduros - b.nao_medivel > 0
                        THEN round(b.converteram::numeric / (b.maduros - b.nao_medivel), 4) END))
    INTO v_ef FROM b;
  v_ef := COALESCE(v_ef, '{}'::jsonb);

  v_dif := (v_ef -> 'tratamento' ->> 'taxa')::numeric - (v_ef -> 'controle' ->> 'taxa')::numeric;
  IF v_dif IS NOT NULL THEN
    SELECT (v_ef -> 'tratamento' ->> 'taxa')::numeric AS p,
           ((v_ef -> 'tratamento' ->> 'maduros')::int - (v_ef -> 'tratamento' ->> 'nao_medivel')::int) AS n INTO t;
    SELECT (v_ef -> 'controle' ->> 'taxa')::numeric AS p,
           ((v_ef -> 'controle' ->> 'maduros')::int - (v_ef -> 'controle' ->> 'nao_medivel')::int) AS n INTO c;
    -- Newcombe (híbrido de Wilson) — revisão 13/11: o Wald dava largura ZERO com 0% num braço (precisão falsa
    -- justamente com pouco dado).
    SELECT * INTO w1 FROM private.venda_wilson(t.p, t.n);
    SELECT * INTO w0 FROM private.venda_wilson(c.p, c.n);
    v_lo := v_dif - sqrt((t.p - w1.lo) ^ 2 + (w0.hi - c.p) ^ 2);
    v_hi := v_dif + sqrt((w1.hi - t.p) ^ 2 + (c.p - w0.lo) ^ 2);
  END IF;
  v_ef := v_ef || jsonb_build_object(
    'diferenca', round(v_dif, 4),
    'ic95', CASE WHEN v_dif IS NOT NULL THEN jsonb_build_array(round(v_lo, 4), round(v_hi, 4)) END,
    'aviso', 'Controle = compradores sorteados que seriam enviados e não foram. Só coorte madura (14 dias fechados). '
          || 'Com poucos compradores o intervalo é largo: inconclusivo não significa ausência de efeito.');

  -- A/A no histórico (diagnóstico do sorteio, por linha): os braços deviam converter igual ANTES do e-mail existir.
  SELECT COALESCE(jsonb_object_agg(q.braco, jsonb_build_object('virou', q.virou, 'nao_virou', q.nao_virou,
           'taxa', CASE WHEN q.virou + q.nao_virou > 0 THEN round(q.virou::numeric / (q.virou + q.nao_virou), 4) END)), '{}'::jsonb)
    INTO v_aa
    FROM (SELECT bc.braco,
                 count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
                 count(*) FILTER (WHERE s.desfecho = 'nao_virou') AS nao_virou
            FROM public.venda_sugestao s
            JOIN public.venda_braco_comprador bc ON bc.comprador_id = s.comprador_id
           WHERE s.fase = 'historico' AND s.tipo = 'recompra'
           GROUP BY bc.braco) q;

  RETURN jsonb_build_object(
    'periodo', jsonb_build_object('de', p_de, 'ate', p_ate),
    'hoje', v_hoje,
    'sorteio', CASE WHEN v_s.id IS NOT NULL THEN jsonb_build_object(
                 'inicio', v_s.inicio, 'fracao_controle', v_s.fracao_controle, 'algoritmo', v_s.algoritmo,
                 'realizado_em', v_s.realizado_em,
                 'compradores', (SELECT count(*) FROM public.venda_braco_comprador),
                 'controle', (SELECT count(*) FROM public.venda_braco_comprador WHERE braco = 'controle')) END,
    'dias', v_dias,
    'farmers', v_farm,
    'efeito', v_ef,
    'aa_historico', v_aa);
END
$$;

-- ACL: CREATE OR REPLACE preserva; re-emitido para não depender disso.
REVOKE ALL ON FUNCTION public.venda_resumo_preparar(date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_resumo_oportunidades() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.venda_resumo_painel(date, date) FROM PUBLIC, anon;

-- ── PÓS ──────────────────────────────────────────────────────────────────────────────────────────────────
DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_resumo_preparar(date,uuid)')) IS DISTINCT FROM '31a29f5d85d1d52e600c6ee808969fd8'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('private.venda_resumo_oportunidades()')) IS DISTINCT FROM '2de7b60b5546ca1610daf25529dcea36'
     OR (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.venda_resumo_painel(date,date)')) IS DISTINCT FROM '715e028256fb813fa5416299593810e0' THEN
    RAISE EXCEPTION 'R1 FALHOU: corpo recriado nao e o deste arquivo';
  END IF;
  IF to_regprocedure('private.venda_wilson(numeric,integer)') IS NULL
     OR has_function_privilege('anon', 'private.venda_wilson(numeric,integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.venda_resumo_painel(date,date)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.venda_resumo_preparar(date,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.venda_resumo_preparar(date,uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'public.venda_resumo_preparar(date,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.venda_resumo_painel(date,date)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.venda_resumo_preparar(date,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'R2 FALHOU: ACL fora do desenho';
  END IF;
  -- Wilson nos extremos não degenera: 0/12 tem teto > 0; 12/12 tem piso < 1.
  IF NOT ((SELECT hi FROM private.venda_wilson(0, 12)) > 0 AND (SELECT lo FROM private.venda_wilson(1, 12)) < 1) THEN
    RAISE EXCEPTION 'R3 FALHOU: Wilson degenerou nos extremos';
  END IF;
  RAISE NOTICE 'venda-resumo-email revisao OK';
END
$post$;
