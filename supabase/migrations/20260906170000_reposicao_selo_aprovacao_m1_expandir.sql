-- ============================================================================
-- Selo de aprovação do pedido Sayerlack — M1 "EXPANDIR" (money-path, compras)
-- Spec: docs/superpowers/specs/2026-09-05-selo-aprovacao-pedido-sayerlack-design.md
--
-- Invariante alvo: ENVIADO = APROVADO. Esta M1 instala o MECANISMO (colunas,
-- função de selo, snapshot do de-para, conferência para a edge) e os guards que
-- só recusam o que já é perigoso hoje. Ela NÃO instala os 2 triggers de
-- enforcement (§3.2/§3.3) — isso é a M2, depois que a edge v1.4 e a UI estiverem
-- no ar. Motivo: com os triggers e a edge VELHA no ar, a normalização de
-- `qtde_final` da edge tomaria SA001 com o pedido em `enviando_portal` e o
-- watchdog o levaria a "indeterminado" sem nenhum POST.
--
-- DESVIOS DELIBERADOS do spec (registrados, não esquecidos):
--  (a) O 3º argumento `p_itens_vistos` é ACEITO como NULL de QUALQUER chamador
--      nesta M1. A regra "aprovação humana sem token → erro" (§3.4.3) entra na
--      M2. Se entrasse aqui, a UI velha (que chama a assinatura de 2 args) teria
--      TODA aprovação recusada entre o apply da M1 e o Publish.
--  (b) Os claims NÃO mudam de assinatura (o spec §3.6 pedia que devolvessem
--      `aprovacao_selo`). Mudar o RETURNS TABLE exigiria DROP+CREATE, que RESETA
--      o ACL de 2 funções. A edge lê `aprovacao_selo` no SELECT que ela já faz
--      logo após o claim — equivalente, porque o selo é imutável depois da
--      aprovação e o pedido já está em `enviando_portal` (nenhuma aprovação
--      concorrente é possível).
--
-- Pré-voo PROD (psql-ro, 2026-09-05, PG 17.6):
--  · nenhuma das 5 colunas existe;
--  · `private.cap_compras_ler(uuid)` existe; `trim_scale`/`sha256` disponíveis;
--  · os 4 pedidos APROVÁVEIS de hoje selam limpo (0 SA003/SA005/SA006);
--  · 109 pedidos Sayerlack aprovados em 90d: ZERO teriam sido recusados pelo
--    selo — selar na aprovação não bloqueia o caminho feliz (precisão > recall);
--  · 2 splits em 90d; 0 pedidos em `enviando_portal` agora;
--  · pg_get_functiondef pré-voado das 5 funções recriadas (as vivas são as que
--    este arquivo parte, não as do repo).
-- ============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Colunas (aditivas, sem default caro, sem NOT NULL)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS aprovacao_selo       text,
  ADD COLUMN IF NOT EXISTS aprovacao_selo_em    timestamptz,
  ADD COLUMN IF NOT EXISTS portal_recusa_motivo text;

COMMENT ON COLUMN public.pedido_compra_sugerido.aprovacao_selo IS
  'sha256 hex dos itens no instante da aprovação (reposicao_selo_itens). Escritor ÚNICO: reposicao_selar_pedido. A edge confere antes do Browserless.';
COMMENT ON COLUMN public.pedido_compra_sugerido.portal_recusa_motivo IS
  'Motivo da recusa PRÉ-Browserless (requestSent:false). Escritor ÚNICO: recusarPreBrowserless da edge enviar-pedido-portal-sayerlack. Vocabulário: selo_ausente, selo_aprovacao_divergente, depara_aprovado_divergente, fator_aprovado_divergente, qtde_nao_multiplo_embalagem, mapeamento_ambiguo, fator_conversao_invalido. Não-NULL = requer REAPROVAÇÃO (cancelar + o ciclo regrava); os claims recusam.';

ALTER TABLE public.pedido_compra_item
  ADD COLUMN IF NOT EXISTS sku_portal_aprovado   text,
  ADD COLUMN IF NOT EXISTS fator_portal_aprovado numeric;

COMMENT ON COLUMN public.pedido_compra_item.sku_portal_aprovado IS
  'Snapshot do sku_fornecedor_externo.sku_portal no instante da APROVAÇÃO. O de-para é vivo (312 linhas ativas, 5 já editadas): sem este congelamento o portal pode receber outro código do que foi aprovado.';
COMMENT ON COLUMN public.pedido_compra_item.fator_portal_aprovado IS
  'Snapshot do fator_conversao do de-para na APROVAÇÃO. Diferente de fator_embalagem_portal, que é o fator com que o MOTOR arredondou (NULL = não arredondou).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1b. UNIQUE parcial na chave ATIVA do de-para (P1-5 do challenge Codex).
--     Sem ele, contar e depois consumir são instruções separadas sem lock: um INSERT concorrente
--     entre as duas faz a contagem ver 1 linha e o UPDATE escolher fonte arbitrária entre 2.
--     O índice torna "exatamente uma ativa" invariante da TABELA, não conclusão de uma query.
--     Pré-voo prod (psql-ro, 2026-09-06): ZERO duplicatas na chave ativa — o CREATE não quebra.
--     ⚠️ Se algum dia quebrar, o motor e a edge JÁ dependem dessa unicidade (a edge recusa por
--     `mapeamento_ambiguo`); a duplicata é o defeito, não o índice.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS ux_sku_fornecedor_externo_ativo
  ON public.sku_fornecedor_externo (empresa, fornecedor_nome, sku_omie)
  WHERE ativo;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Predicado ÚNICO de "pedido de portal" (reusado pelo selo e pelos claims)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao_pedido_e_portal(p_empresa text, p_fornecedor_nome text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_empresa = 'OBEN' AND p_fornecedor_nome ILIKE '%SAYERLACK%';
$function$;

COMMENT ON FUNCTION public.reposicao_pedido_e_portal(text, text) IS
  'Definição ÚNICA de "pedido que vai ao portal Sayerlack". Antes vivia copiada em envio_portal_claim_ids e envio_portal_lock_candidatos.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. reposicao_selo_itens — o hash. UMA implementação, em SQL (sem espelho TS).
--    jsonb_agg evita ambiguidade de separador (um '|' dentro do SKU produziria
--    a mesma cadeia para estruturas diferentes); trim_scale faz 0,20 ≡ 0,2.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao_selo_itens(p_pedido_id bigint)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_payload jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_agg(
           jsonb_build_array(
             i.id,
             i.pedido_id,
             i.sku_codigo_omie,
             trim_scale(i.qtde_final)::text,
             trim_scale(i.fator_embalagem_portal)::text,
             i.sku_portal_aprovado,
             trim_scale(i.fator_portal_aprovado)::text
           ) ORDER BY i.id
         ), '[]'::jsonb)
    INTO v_payload
    FROM public.pedido_compra_item i
   WHERE i.pedido_id = p_pedido_id;

  RETURN encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
END;
$function$;

-- P0-2 (challenge Codex): primitiva INTERNA. `authenticated` NÃO alcança — quem a chama é a RPC
-- de aprovação (SECURITY DEFINER, dona postgres) e a edge (service_role). Expor a primitiva
-- permitiria selar fora da trilha e depois flipar o status por UPDATE direto, e o guard da M2
-- (que autoriza por ESTADO) veria "selo bate com os itens" e aceitaria.
REVOKE ALL ON FUNCTION public.reposicao_selo_itens(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_selo_itens(bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_selo_itens(bigint) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. reposicao_selar_pedido — o ÚNICO escritor do selo.
--    VALIDA (não transforma): quantidade não-canônica é RECUSA com o SKU na
--    mensagem, nunca arredondamento silencioso.
--    SECURITY DEFINER de propósito (achado P0-1 do challenge Codex): como
--    INVOKER, um aprovador sem SELECT em sku_fornecedor_externo veria 0 linhas e
--    o pedido seria recusado por SA006 pela razão ERRADA.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao_selar_pedido(
  p_pedido_id bigint,
  p_reusar_snapshot boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ped     RECORD;
  v_portal  boolean;
  v_n       integer;
  v_bad     RECORD;
  v_selo    text;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;

  SELECT id, empresa, fornecedor_nome INTO v_ped
    FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido % não encontrado', p_pedido_id USING ERRCODE = 'SA005';
  END IF;

  v_portal := public.reposicao_pedido_e_portal(v_ped.empresa, v_ped.fornecedor_nome);

  -- Trava os itens: serializa UPDATE/DELETE concorrentes com a aprovação.
  PERFORM 1 FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id ORDER BY id FOR UPDATE;

  SELECT count(*) INTO v_n FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;
  IF v_n = 0 THEN
    RAISE EXCEPTION 'Pedido % não tem itens — nada a aprovar', p_pedido_id USING ERRCODE = 'SA005';
  END IF;

  -- (2) Canonicidade. `< 1e9` não é frescura: em numeric, NaN e Infinity são
  -- MAIORES que tudo, então `> 0` sozinho deixa os dois passarem (mesma lição do
  -- CHECK sku_fornecedor_externo_fator_positivo).
  SELECT i.sku_codigo_omie, i.qtde_final INTO v_bad
    FROM public.pedido_compra_item i
   WHERE i.pedido_id = p_pedido_id
     AND NOT (i.qtde_final IS NOT NULL
              AND i.qtde_final > 0
              AND i.qtde_final < 1e9
              AND i.qtde_final = trunc(i.qtde_final))
   ORDER BY i.id LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Quantidade não é inteira/positiva no SKU % (qtde=%) — corrija antes de aprovar',
      v_bad.sku_codigo_omie, v_bad.qtde_final USING ERRCODE = 'SA005';
  END IF;

  IF v_portal THEN
    IF p_reusar_snapshot THEN
      -- Split: deriva do snapshot JÁ gravado pelo pai; NÃO relê o de-para vivo
      -- (reler reabriria a janela que o selo existe para fechar).
      SELECT i.sku_codigo_omie INTO v_bad
        FROM public.pedido_compra_item i
       WHERE i.pedido_id = p_pedido_id
         AND (i.sku_portal_aprovado IS NULL OR i.fator_portal_aprovado IS NULL)
       ORDER BY i.id LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'Item do SKU % sem snapshot de de-para para reusar', v_bad.sku_codigo_omie
          USING ERRCODE = 'SA006';
      END IF;
    ELSE
      -- (3) Snapshot pela MESMA chave do motor e da edge (fornecedor EXATO).
      -- P1-5 (Codex): conta ATIVAS e UTILIZÁVEIS separadamente. Contar só as utilizáveis faria
      -- "1 válida + 1 ativa com sku_portal vazio" passar na aprovação e falhar no envio, porque
      -- `reposicao_conferir_envio` conta as ATIVAS. Os dois lados têm de contar a mesma coisa.
      SELECT i.sku_codigo_omie, d.n_util AS n, d.n_ativas INTO v_bad
        FROM public.pedido_compra_item i
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (
                   WHERE COALESCE(btrim(s.sku_portal), '') <> ''
                     AND s.fator_conversao IS NOT NULL
                     AND s.fator_conversao > 0
                     AND s.fator_conversao < 1e9
                 ) AS n_util,
                 count(*) AS n_ativas
            FROM public.sku_fornecedor_externo s
           WHERE s.empresa = v_ped.empresa
             AND s.fornecedor_nome = v_ped.fornecedor_nome
             AND s.sku_omie = i.sku_codigo_omie
             AND s.ativo
        ) d
       WHERE i.pedido_id = p_pedido_id AND (d.n_util <> 1 OR d.n_ativas <> 1)
       ORDER BY i.id LIMIT 1;
      IF FOUND THEN
        IF v_bad.n_ativas > 1 THEN
          RAISE EXCEPTION 'SKU % tem % linhas ativas no de-para de % — ambíguo, resolva antes de aprovar',
            v_bad.sku_codigo_omie, v_bad.n_ativas, v_ped.fornecedor_nome USING ERRCODE = 'SA003';
        END IF;
        IF v_bad.n = 0 THEN
          RAISE EXCEPTION 'SKU % não tem de-para ativo utilizável para % — cadastre antes de aprovar',
            v_bad.sku_codigo_omie, v_ped.fornecedor_nome USING ERRCODE = 'SA006';
        END IF;
        RAISE EXCEPTION 'SKU % tem de-para ativo inutilizável em % (código vazio ou fator fora do domínio)',
          v_bad.sku_codigo_omie, v_ped.fornecedor_nome USING ERRCODE = 'SA006';
      END IF;

      UPDATE public.pedido_compra_item i
         SET sku_portal_aprovado   = s.sku_portal,
             fator_portal_aprovado = s.fator_conversao
        FROM public.sku_fornecedor_externo s
       WHERE i.pedido_id = p_pedido_id
         AND s.empresa = v_ped.empresa
         AND s.fornecedor_nome = v_ped.fornecedor_nome
         AND s.sku_omie = i.sku_codigo_omie
         AND s.ativo
         AND COALESCE(btrim(s.sku_portal), '') <> ''
         AND s.fator_conversao IS NOT NULL
         AND s.fator_conversao > 0
         AND s.fator_conversao < 1e9;

      -- (4) O fator com que o MOTOR arredondou tem de ser o que está vivo agora. Este teste vem
      -- ANTES do round-trip de propósito: com o de-para trocado (0,2 -> 0,18) a quantidade
      -- aprovada deixa de ser múltiplo POR CONSEQUÊNCIA, e apontar SA005 mandaria o comprador
      -- ajustar uma quantidade que não é o problema. A causa raiz é o de-para ter mudado.
      -- (comentário original abaixo)
      -- O fator com que o MOTOR arredondou tem de ser o que está vivo agora.
      SELECT i.sku_codigo_omie INTO v_bad
        FROM public.pedido_compra_item i
       WHERE i.pedido_id = p_pedido_id
         AND i.fator_embalagem_portal IS NOT NULL
         AND i.fator_embalagem_portal IS DISTINCT FROM i.fator_portal_aprovado
       ORDER BY i.id LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'O de-para do SKU % mudou depois que o motor gerou o pedido — cancele e aguarde o próximo ciclo',
          v_bad.sku_codigo_omie USING ERRCODE = 'SA004';
      END IF;
      -- P1-2 (Codex): o round-trip da embalagem vale para TODO item de portal, com o fator do
      -- SNAPSHOT — não só quando `fator_embalagem_portal` não é NULL. Medido em prod: 16 itens
      -- têm fator do motor NULL e fator vivo <> 1; para eles a aprovação selaria 41 e a edge
      -- VELHA gravaria 45 antes do Browserless, invalidando o próprio selo. A checagem anterior,
      -- gateada por `fator_embalagem_portal IS NOT NULL`, era cega a exatamente esses.
      SELECT i.sku_codigo_omie, i.qtde_final INTO v_bad
        FROM public.pedido_compra_item i
       WHERE i.pedido_id = p_pedido_id
         AND i.fator_portal_aprovado IS NOT NULL
         AND trim_scale(round(GREATEST(1, ceil(round(i.qtde_final * i.fator_portal_aprovado, 6)))
                              / i.fator_portal_aprovado, 6)) IS DISTINCT FROM trim_scale(i.qtde_final)
       ORDER BY i.id LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'Quantidade % do SKU % não é múltiplo da embalagem do portal — ajuste na tela antes de aprovar',
          v_bad.qtde_final, v_bad.sku_codigo_omie USING ERRCODE = 'SA005';
      END IF;

    END IF;
  END IF;

  -- (5) Sela.
  -- ⚠️ NÃO use GUC para autorizar o trigger da M2. Uma função com cláusula SET
  -- (todas aqui têm `SET search_path`) roda num NEST LEVEL de GUC próprio, e o
  -- Postgres reverte em AtEOXact_GUC TUDO que foi setado lá dentro quando a
  -- função retorna — inclusive um set_config(..., is_local => true). O GUC
  -- morreria antes de o CHAMADOR fazer o flip de status, e a M2 recusaria TODA
  -- aprovação por SA007. A M2 autoriza por ESTADO, que é mais forte que um GUC:
  --   · flip para aprovado_aguardando_disparo exige
  --     NEW.aprovacao_selo = reposicao_selo_itens(NEW.id) (selo presente E conferido);
  --   · aprovacao_selo só muda enquanto o status ainda é pendente/bloqueado.
  -- Assim o UPDATE direto do runAutoApprove é recusado por não ter selo válido,
  -- sem depender de nenhum sinal fora da linha.
  v_selo := public.reposicao_selo_itens(p_pedido_id);

  UPDATE public.pedido_compra_sugerido
     SET aprovacao_selo = v_selo, aprovacao_selo_em = now()
   WHERE id = p_pedido_id;

  RETURN v_selo;
END;
$function$;

-- P0-2: idem. É esta a função cujo GRANT a `authenticated` fechava o buraco por fora da RPC.
REVOKE ALL ON FUNCTION public.reposicao_selar_pedido(bigint, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_selar_pedido(bigint, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_selar_pedido(bigint, boolean) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. reposicao_conferir_envio — o que a edge chama ANTES do Browserless.
--    A comparação de numeric é feita AQUI, em SQL, com IS DISTINCT FROM: o
--    Number() do TS colapsa decimais distintos no mesmo IEEE-754 (P2-12 Codex).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reposicao_conferir_envio(p_pedido_id bigint)
RETURNS TABLE(selo_ok boolean, depara_ok boolean, motivo text, divergencias jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ped    RECORD;
  v_atual  text;
  v_div    jsonb;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;

  SELECT id, empresa, fornecedor_nome, aprovacao_selo INTO v_ped
    FROM public.pedido_compra_sugerido WHERE id = p_pedido_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 'pedido_inexistente'::text, '[]'::jsonb;
    RETURN;
  END IF;

  IF v_ped.aprovacao_selo IS NULL THEN
    RETURN QUERY SELECT false, false, 'selo_ausente'::text, '[]'::jsonb;
    RETURN;
  END IF;

  v_atual := public.reposicao_selo_itens(p_pedido_id);
  IF v_atual IS DISTINCT FROM v_ped.aprovacao_selo THEN
    RETURN QUERY SELECT false, false, 'selo_aprovacao_divergente'::text,
      jsonb_build_object('selo_aprovado', v_ped.aprovacao_selo, 'selo_atual', v_atual);
    RETURN;
  END IF;

  IF NOT public.reposicao_pedido_e_portal(v_ped.empresa, v_ped.fornecedor_nome) THEN
    RETURN QUERY SELECT true, true, NULL::text, '[]'::jsonb;
    RETURN;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'sku', x.sku_codigo_omie,
           'linhas_ativas', x.n,
           'sku_portal_aprovado', x.sku_portal_aprovado,
           'sku_portal_vivo', x.sku_portal_vivo,
           'fator_aprovado', trim_scale(x.fator_portal_aprovado)::text,
           'fator_vivo', trim_scale(x.fator_vivo)::text
         ) ORDER BY x.id), '[]'::jsonb)
    INTO v_div
    FROM (
      SELECT i.id, i.sku_codigo_omie, i.sku_portal_aprovado, i.fator_portal_aprovado,
             COALESCE(d.n, 0) AS n, d.sku_portal AS sku_portal_vivo, d.fator_conversao AS fator_vivo
        FROM public.pedido_compra_item i
        -- LEFT, não CROSS: com CROSS, o item que ficou SEM de-para (a linha foi
        -- desativada depois da aprovação) sumiria do resultado e a conferência
        -- diria "de-para ok" — falha ABERTA no exato caso que ela existe pra pegar.
        LEFT JOIN LATERAL (
          SELECT s.sku_portal, s.fator_conversao,
                 (SELECT count(*) FROM public.sku_fornecedor_externo s2
                   WHERE s2.empresa = v_ped.empresa
                     AND s2.fornecedor_nome = v_ped.fornecedor_nome
                     AND s2.sku_omie = i.sku_codigo_omie
                     AND s2.ativo) AS n
            FROM public.sku_fornecedor_externo s
           WHERE s.empresa = v_ped.empresa
             AND s.fornecedor_nome = v_ped.fornecedor_nome
             AND s.sku_omie = i.sku_codigo_omie
             AND s.ativo
           ORDER BY s.id LIMIT 1
        ) d ON true
       WHERE i.pedido_id = p_pedido_id
         AND (COALESCE(d.n, 0) <> 1
              OR d.sku_portal IS DISTINCT FROM i.sku_portal_aprovado
              OR d.fator_conversao IS DISTINCT FROM i.fator_portal_aprovado)
    ) x;

  IF jsonb_array_length(v_div) > 0 THEN
    RETURN QUERY SELECT true, false, 'depara_aprovado_divergente'::text, v_div;
    RETURN;
  END IF;

  RETURN QUERY SELECT true, true, NULL::text, '[]'::jsonb;
END;
$function$;

-- Só a edge chama (service_role). A UI não confere selo — ela nem sabe que ele existe.
REVOKE ALL ON FUNCTION public.reposicao_conferir_envio(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_conferir_envio(bigint) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_conferir_envio(bigint) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. aprovar_pedido_sugerido — 3 args (novo) + o de 2 args vira WRAPPER.
--    SEM DROP: overload por conjuntos de argumentos distintos, então o PostgREST
--    resolve as duas sem PGRST203 e o ACL do de 2 args é preservado (CREATE OR
--    REPLACE). O de 3 args nasce com EXECUTE de PUBLIC — revogado abaixo.
-- ─────────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER com gate EXPLÍCITO (P0-2): a RPC passa a ser a ÚNICA porta para o selo, e
-- por isso precisa executar as primitivas que `authenticated` já não alcança. DEFINER bypassa a
-- RLS, então o gate no corpo substitui a policy — não é decoração.
-- ⚠️ O WRAPPER de 2 args continua INVOKER de propósito: a postcondição da 20260906151715 (outra
-- sessão) exige `prosecdef=false` nele, e é a assinatura que a UI velha chama.
CREATE OR REPLACE FUNCTION public.aprovar_pedido_sugerido(
  p_pedido_id bigint,
  p_usuario text,
  p_itens_vistos jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pedido RECORD;
  v_div    integer;
  v_corte  timestamptz;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_pedido FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;
  IF v_pedido.status NOT IN ('pendente_aprovacao', 'bloqueado_guardrail') THEN
    RETURN jsonb_build_object('error', 'pedido já está no estado ' || v_pedido.status);
  END IF;

  -- Trava os itens ANTES de comparar o token: sem isto a comparação olharia um
  -- estado que outra aba pode trocar entre a conferência e o selo.
  PERFORM 1 FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id ORDER BY id FOR UPDATE;

  -- Token de revisão. NULL = chamador legado (wrapper de 2 args). A M2 passa a
  -- exigir token de aprovação humana; aqui NULL ainda é aceito de propósito,
  -- senão a UI velha pararia de aprovar entre o apply da M1 e o Publish.
  IF p_itens_vistos IS NOT NULL THEN
    BEGIN
      WITH visto AS (
        SELECT (e->>'id')::bigint AS id,
               e->>'sku_codigo_omie' AS sku,
               trim_scale((e->>'qtde_final')::numeric)::text AS q,
               trim_scale((e->>'fator_embalagem_portal')::numeric)::text AS f
          FROM jsonb_array_elements(p_itens_vistos) e
      ), atual AS (
        SELECT i.id, i.sku_codigo_omie AS sku,
               trim_scale(i.qtde_final)::text AS q,
               trim_scale(i.fator_embalagem_portal)::text AS f
          FROM public.pedido_compra_item i WHERE i.pedido_id = p_pedido_id
      )
      SELECT count(*) INTO v_div FROM (
        (SELECT * FROM visto EXCEPT SELECT * FROM atual)
        UNION ALL
        (SELECT * FROM atual EXCEPT SELECT * FROM visto)
      ) d;
    EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value OR wrong_object_type THEN
      RETURN jsonb_build_object('error', 'itens_vistos inválido — recarregue a tela');
    END;
    IF v_div > 0 THEN
      RETURN jsonb_build_object('error', 'os itens mudaram desde que você abriu a tela — recarregue e confira antes de aprovar');
    END IF;
  END IF;

  BEGIN
    PERFORM public.reposicao_selar_pedido(p_pedido_id);
  EXCEPTION
    WHEN SQLSTATE 'SA003' OR SQLSTATE 'SA004' OR SQLSTATE 'SA005' OR SQLSTATE 'SA006' THEN
      RETURN jsonb_build_object('error', SQLERRM);
  END;

  -- O predicado de status vive DENTRO da escrita (padrão do 20260906151715, que fechou o
  -- TOCTOU desta RPC). Aqui ele é redundante com o FOR UPDATE acima — que é obrigatório, porque
  -- o selo precisa do lock segurado ATRAVÉS de várias instruções — mas redundância barata no
  -- money-path é defesa, e a falsificação F12 prova que este WHERE tem dente.
  UPDATE public.pedido_compra_sugerido
     SET status = 'aprovado_aguardando_disparo',
         aprovado_por = p_usuario,
         aprovado_em = NOW(),
         atualizado_em = NOW()
   WHERE id = p_pedido_id
     AND status IN ('pendente_aprovacao', 'bloqueado_guardrail')
  RETURNING horario_corte_planejado INTO v_corte;

  IF NOT FOUND THEN
    -- Impossível sob o FOR UPDATE (ninguém consegue mudar o status enquanto seguramos a linha).
    -- RAISE, não RETURN: precisa DESFAZER o selo já gravado nesta transação.
    RAISE EXCEPTION 'Pedido % mudou de estado durante a aprovação', p_pedido_id USING ERRCODE = 'SA008';
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id,
                            'sera_disparado_em', v_corte);
END;
$function$;

REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text, jsonb) TO authenticated, service_role;

-- O wrapper de 2 args ganha o MESMO gate de capacidade. Três razões, nesta ordem:
--  1. defesa em profundidade real — é esta a assinatura que a UI velha chama;
--  2. o `authz:check` colapsa overloads por NOME e mede a ÚLTIMA definição do arquivo; sem o
--     gate aqui, o gate do de 3 args fica invisível para ele (limite do detector, não do desenho);
--  3. continua INVOKER — a postcondição da 20260906151715 (outra sessão) exige `prosecdef=false`
--     nesta assinatura, e a RLS de `pedido_compra_sugerido` segue valendo para ela.
-- ⚠️ Deixou de ser `BEGIN ATOMIC`, então NÃO há mais dependência em `pg_depend` para conferir.
-- A postcondição passou a PROVAR POR EXECUÇÃO (chama o wrapper e exige a resposta que só o de
-- 3 args produz) — mais forte que texto e que dependência: prova CONTROLE, não presença.
CREATE OR REPLACE FUNCTION public.aprovar_pedido_sugerido(p_pedido_id bigint, p_usuario text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL AND NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;
  RETURN public.aprovar_pedido_sugerido(p_pedido_id, p_usuario, NULL::jsonb);
END;
$function$;

-- `anon` tinha EXECUTE explícito (e PUBLIC também) na de 2 args: aprovar pedido
-- de compra nunca é ação de anônimo. REVOKE FROM PUBLIC não tira grant NOMEADO.
REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.aprovar_pedido_sugerido(bigint, text) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. cancelar_pedido_sugerido — o guard de envio EM VOO entra no MESMO WHERE.
--    ⚠️ PARTE DA VERSÃO ATÔMICA VIVA EM PROD (20260905224959), não da antiga do repo: aquela
--    migration tirou o SELECT-decide-UPDATE porque ele deixava um cancelamento gravar por cima
--    de um disparo concorrente. Recriar a partir do corpo velho REVERTERIA essa correção em
--    silêncio — a armadilha "a última a rodar vence" da database.md §2.
--    O guard novo (Codex P0-3) é o envio em voo: hoje o botão fica habilitado em
--    aprovado_aguardando_disparo mesmo com status_envio_portal='enviando_portal', e a edge já
--    tem o payload em memória — o fornecedor recebe e aqui o pedido consta cancelado.
--    Ele vive no MESMO UPDATE, pelo mesmo motivo que o de status: em READ COMMITTED o Postgres
--    RE-AVALIA o WHERE contra a linha recém-commitada (EvalPlanQual). Num SELECT acima, não.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cancelar_pedido_sugerido(
  p_pedido_id bigint, p_usuario text, p_justificativa text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id       bigint;
  v_status   text;
  v_portal   text;
  v_disparo  timestamptz;
BEGIN
  -- ⚠️ Guard e escrita são UMA instrução. Não separe: é o predicado preso a este WHERE que faz
  -- o Postgres re-avaliá-lo contra a versão nova da linha depois de esperar o lock.
  UPDATE pedido_compra_sugerido
  SET status = 'cancelado_humano',
      cancelado_por = p_usuario,
      cancelado_em = NOW(),
      justificativa_cancelamento = p_justificativa,
      status_envio_portal = 'nao_aplicavel',
      portal_proximo_retry_em = NULL,
      atualizado_em = NOW()
  WHERE id = p_pedido_id
    AND status NOT IN ('disparado', 'concluido_recebido')
    AND COALESCE(status_envio_portal, 'nao_aplicavel') NOT IN (
          'enviando_portal', 'enviado_portal', 'sucesso_portal',
          'aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao')
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada pelo predicado — esta leitura só MONTA A MENSAGEM.
  SELECT status, status_envio_portal, horario_disparo_real
    INTO v_status, v_portal, v_disparo
    FROM pedido_compra_sugerido WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;

  IF v_status IN ('disparado', 'concluido_recebido') THEN
    RETURN jsonb_build_object('error', 'pedido já foi disparado em ' || COALESCE(v_disparo::text, '(sem carimbo)'));
  END IF;

  IF COALESCE(v_portal, 'nao_aplicavel') IN (
       'enviando_portal', 'enviado_portal', 'sucesso_portal',
       'aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao') THEN
    RETURN jsonb_build_object('error',
      'envio ao portal em ' || v_portal ||
      ' — cancelar agora deixaria o fornecedor com um pedido que aqui consta cancelado. Aguarde o desfecho ou concilie.');
  END IF;

  -- Estado cancelável AGORA mas o UPDATE não pegou ⇒ mudou entre as instruções. Não FABRICAR
  -- motivo: dizer "já está em X" seria mentira quando X é cancelável.
  RETURN jsonb_build_object('error',
    'pedido mudou de estado durante o cancelamento (estado atual: ' || COALESCE(v_status, '(desconhecido)') || ') - tente de novo');
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Claims POSITIVOS: só pedido elegível e SEM recusa durável entra na fila.
--    Em M1 portal_recusa_motivo é sempre NULL (só a edge v1.4 escreve), então
--    isto é no-op hoje e vira a trava assim que a edge nova subir.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.iniciar_envio_portal_pre_claim(p_pedido_id bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status_envio_portal = 'pendente_envio_portal',
         portal_erro = NULL,
         portal_proximo_retry_em = now() + interval '15 minutes'
   WHERE id = p_pedido_id
     AND COALESCE(status_envio_portal, 'nao_aplicavel') <> 'enviando_portal'
     AND status IN ('aprovado_aguardando_disparo', 'disparado', 'falha_envio')
     AND portal_recusa_motivo IS NULL
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.envio_portal_claim_ids(p_ids bigint[])
RETURNS TABLE(id bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role)
              OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  UPDATE public.pedido_compra_sugerido p
     SET status_envio_portal = 'enviando_portal',
         portal_erro = NULL,
         -- P1-4 (Codex): sem este carimbo o claim nasce VELHO num retry de 15 min e o watchdog
         -- (stale = atualizado_em < now()-5min) o declara `indeterminado_requer_conciliacao`
         -- enquanto o Browserless ainda está executando. A irmã lock_candidatos já carimbava.
         atualizado_em = now()
   WHERE p.id = ANY(p_ids)
     AND public.reposicao_pedido_e_portal(p.empresa, p.fornecedor_nome)
     AND p.status IN ('aprovado_aguardando_disparo', 'disparado', 'falha_envio')
     AND p.portal_recusa_motivo IS NULL
     AND p.status_envio_portal IN ('pendente_envio_portal', 'erro_retentavel')
  RETURNING p.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.envio_portal_lock_candidatos(p_max integer DEFAULT 5)
RETURNS TABLE(id bigint, empresa text, fornecedor_nome text, status_envio_portal text,
              portal_tentativas integer, portal_protocolo text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'employee'::app_role)
              OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH candidatos AS (
    SELECT p.id, p.status_envio_portal AS status_anterior
      FROM public.pedido_compra_sugerido p
     WHERE public.reposicao_pedido_e_portal(p.empresa, p.fornecedor_nome)
       AND p.status IN ('aprovado_aguardando_disparo', 'disparado', 'falha_envio')
       AND p.portal_recusa_motivo IS NULL
       AND p.status_envio_portal IN ('pendente_envio_portal', 'erro_retentavel')
       AND COALESCE(p.portal_tentativas, 0) < 3
       AND (p.portal_proximo_retry_em IS NULL OR p.portal_proximo_retry_em <= now())
     ORDER BY p.aprovado_em ASC NULLS LAST, p.id ASC
     LIMIT p_max FOR UPDATE SKIP LOCKED
  ),
  travados AS (
    UPDATE public.pedido_compra_sugerido p
       SET status_envio_portal = 'enviando_portal', atualizado_em = now()
      FROM candidatos c WHERE p.id = c.id
    RETURNING p.id, p.empresa, p.fornecedor_nome, c.status_anterior AS status_envio_portal,
              COALESCE(p.portal_tentativas, 0) AS portal_tentativas, p.portal_protocolo
  )
  SELECT t.id, t.empresa, t.fornecedor_nome, t.status_envio_portal, t.portal_tentativas, t.portal_protocolo
    FROM travados t;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. pedido_compra_split SEAL-AWARE. O filho nasce `pendente_aprovacao`, recebe
--    os itens e SÓ ENTÃO é selado e promovido — senão o filho nasceria aprovado
--    e vazio (o trigger da M2 recusaria por SA005) ou sem selo (a edge recusaria
--    por selo_ausente, e todo pedido Sayerlack > 20 itens pararia).
--    Reusa o snapshot do PAI quando ele tem selo; para pai LEGADO (aprovado
--    antes da M1) lê o de-para vivo — mesmo comportamento de hoje, sem quebrar
--    o disparo no dia do apply.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pedido_compra_split(p_pedido_id bigint, p_chunk_size integer DEFAULT 4)
RETURNS TABLE(filho_id bigint, lote integer, total integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status        text;
  v_split_parent  bigint;
  v_selo_pai      text;
  v_portal_pai    text;
  v_itens_total   integer;
  v_total_chunks  integer;
  v_chunk_idx     integer;
  v_filho_id      bigint;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
      RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_chunk_size < 1 THEN
    RAISE EXCEPTION 'chunk_size deve ser >= 1';
  END IF;

  SELECT status, split_parent_id, aprovacao_selo, COALESCE(status_envio_portal, 'nao_aplicavel')
    INTO v_status, v_split_parent, v_selo_pai, v_portal_pai
    FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido % não encontrado', p_pedido_id;
  END IF;
  IF v_status <> 'aprovado_aguardando_disparo' THEN
    RAISE EXCEPTION 'Pedido % com status=% não pode ser dividido (esperado: aprovado_aguardando_disparo)', p_pedido_id, v_status;
  END IF;
  IF v_split_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Pedido % já é filho de um split (parent=%)', p_pedido_id, v_split_parent;
  END IF;

  -- P0-1 (challenge Codex): o lock do pai serializa as transações, mas sem LER o status do
  -- PORTAL o predicado fica incompleto. Sequência que duplicava pedido no fornecedor:
  --   claim marca `enviando_portal` (NÃO mexe no status principal) → a edge lê os itens em
  --   memória → o split pega o lock DEPOIS, vê só `aprovado_aguardando_disparo`, move os itens e
  --   cria filhos aprovados → a edge envia o PAI com o payload que tinha → os filhos também
  --   ficam elegíveis ⇒ PO do pai + POs dos filhos.
  -- Fail-closed: só divide quem NUNCA tocou o portal.
  IF v_portal_pai <> 'nao_aplicavel' THEN
    RAISE EXCEPTION 'Pedido % está em status_envio_portal=% — dividir agora pode duplicar o pedido no fornecedor',
      p_pedido_id, v_portal_pai USING ERRCODE = 'SA009';
  END IF;

  -- P1-3 (challenge Codex): `v_selo_pai IS NOT NULL` provava que o pai FOI selado um dia, não que
  -- ele continua íntegro. Como a M1 ainda não tem o trigger de trava, uma edição posterior pode
  -- ter invalidado o pai — e o split abençoaria o estado alterado gerando selos VÁLIDOS para os
  -- filhos. Reusar snapshot exige o selo do pai BATENDO agora.
  IF v_selo_pai IS NOT NULL AND v_selo_pai IS DISTINCT FROM public.reposicao_selo_itens(p_pedido_id) THEN
    RAISE EXCEPTION 'Pedido % foi alterado depois de aprovado (selo não confere) — cancele e aguarde o ciclo',
      p_pedido_id USING ERRCODE = 'SA010';
  END IF;

  SELECT count(*) INTO v_itens_total FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;
  IF v_itens_total <= p_chunk_size THEN
    RETURN;
  END IF;

  -- Mover item de pedido SELADO é escrita em coluna selada: o split é o único
  -- caminho legítimo. O GUC só é honrado para postgres/service_role (M2).
  PERFORM set_config('reposicao.selo_bypass', 'on', true);

  v_total_chunks := ceil(v_itens_total::numeric / p_chunk_size)::integer;
  FOR v_chunk_idx IN 1..v_total_chunks LOOP
    INSERT INTO public.pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_geracao, horario_corte_planejado,
      valor_total, num_skus,
      status,
      condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem,
      aprovado_em, aprovado_por,
      criado_em, atualizado_em,
      split_parent_id, split_lote, split_total
    )
    SELECT
      p.empresa, p.fornecedor_nome, p.grupo_codigo, p.data_ciclo,
      p.horario_geracao, p.horario_corte_planejado,
      0, 0,
      'pendente_aprovacao',
      p.condicao_pagamento_codigo, p.condicao_pagamento_descricao,
      p.num_parcelas, p.dias_parcelas, p.condicao_origem,
      p.aprovado_em, p.aprovado_por,
      now(), now(),
      p_pedido_id, v_chunk_idx, v_total_chunks
    FROM public.pedido_compra_sugerido p
    WHERE p.id = p_pedido_id
    RETURNING id INTO v_filho_id;

    WITH lote_ids AS (
      SELECT id FROM public.pedido_compra_item
       WHERE pedido_id = p_pedido_id
       ORDER BY id
       LIMIT p_chunk_size
    )
    UPDATE public.pedido_compra_item pci
       SET pedido_id = v_filho_id
      FROM lote_ids
     WHERE pci.id = lote_ids.id;

    UPDATE public.pedido_compra_sugerido f
       SET num_skus = (SELECT count(*) FROM public.pedido_compra_item WHERE pedido_id = f.id),
           valor_total = COALESCE(
             (SELECT sum(COALESCE(valor_linha, qtde_final * preco_unitario, 0))
                FROM public.pedido_compra_item WHERE pedido_id = f.id), 0)
     WHERE f.id = v_filho_id;

    PERFORM public.reposicao_selar_pedido(v_filho_id, v_selo_pai IS NOT NULL);

    UPDATE public.pedido_compra_sugerido
       SET status = 'aprovado_aguardando_disparo', atualizado_em = now()
     WHERE id = v_filho_id;

    filho_id := v_filho_id;
    lote := v_chunk_idx;
    total := v_total_chunks;
    RETURN NEXT;
  END LOOP;

  UPDATE public.pedido_compra_sugerido SET
    status = 'split_em_filhos',
    status_envio_portal = 'nao_aplicavel',
    split_total = v_total_chunks,
    atualizado_em = now()
  WHERE id = p_pedido_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────────────
-- Postcondição: uma M1 que não pegou NÃO termina em silêncio.
-- ─────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_faltando text;
BEGIN
  SELECT string_agg(x.q, ', ') INTO v_faltando FROM (
    SELECT 'pedido_compra_sugerido.' || c.q AS q
      FROM (VALUES ('aprovacao_selo'), ('aprovacao_selo_em'), ('portal_recusa_motivo')) c(q)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='pedido_compra_sugerido' AND column_name=c.q)
    UNION ALL
    SELECT 'pedido_compra_item.' || c.q
      FROM (VALUES ('sku_portal_aprovado'), ('fator_portal_aprovado')) c(q)
     WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema='public' AND table_name='pedido_compra_item' AND column_name=c.q)
  ) x;
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'M1 FALHOU: colunas ausentes (%) — o selo não teria onde ser gravado', v_faltando;
  END IF;

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname IN
         ('reposicao_pedido_e_portal','reposicao_selo_itens','reposicao_selar_pedido','reposicao_conferir_envio')) <> 4 THEN
    RAISE EXCEPTION 'M1 FALHOU: faltam funções do selo — a aprovação não selaria';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='aprovar_pedido_sugerido'
       AND pg_get_function_identity_arguments(p.oid) = 'p_pedido_id bigint, p_usuario text, p_itens_vistos jsonb'
  ) THEN
    RAISE EXCEPTION 'M1 FALHOU: aprovar_pedido_sugerido de 3 argumentos ausente';
  END IF;

  -- Suficiência, não existência: as 5 funções recriadas têm de estar na forma NOVA.
  -- Assert POR EXECUÇÃO: chama o wrapper de 2 args num id inexistente e exige a resposta que
  -- SÓ o corpo do de 3 args produz. `CREATE` de plpgsql é late-bound — passa com o corpo
  -- quebrado e só falha em runtime; e um LIKE no corpo provaria presença de texto, nunca que a
  -- chamada acontece. Efeito colateral: nenhum (id negativo não existe).
  DECLARE v_resp jsonb;
  BEGIN
    v_resp := public.aprovar_pedido_sugerido(-1::bigint, 'postcondicao-m1');
    IF v_resp->>'error' IS DISTINCT FROM 'pedido não encontrado' THEN
      RAISE EXCEPTION 'M1 FALHOU: o wrapper de 2 args não delega ao de 3 args (resposta inesperada: %)', v_resp;
    END IF;
  END;

  IF (SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='aprovar_pedido_sugerido'
         AND pg_get_function_identity_arguments(p.oid)='p_pedido_id bigint, p_usuario text') THEN
    RAISE EXCEPTION 'M1 FALHOU [SECDEF]: o de 2 args virou SECURITY DEFINER — bypassaria a RLS (invariante do 20260906151715)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='cancelar_pedido_sugerido'
                    AND pg_get_functiondef(p.oid) LIKE '%enviando_portal%') THEN
    RAISE EXCEPTION 'M1 FALHOU: cancelar_pedido_sugerido sem o guard de envio em voo';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('iniciar_envio_portal_pre_claim','envio_portal_claim_ids','envio_portal_lock_candidatos')
         AND pg_get_functiondef(p.oid) LIKE '%portal_recusa_motivo%') <> 3 THEN
    RAISE EXCEPTION 'M1 FALHOU: algum claim ainda aceita pedido com recusa durável';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='pedido_compra_split'
                    AND pg_get_functiondef(p.oid) LIKE '%reposicao_selar_pedido%') THEN
    RAISE EXCEPTION 'M1 FALHOU: pedido_compra_split não sela os filhos — todo pedido Sayerlack grande viraria selo_ausente';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'ux_sku_fornecedor_externo_ativo' AND i.indisunique AND i.indisvalid) THEN
    RAISE EXCEPTION 'M1 FALHOU: ux_sku_fornecedor_externo_ativo ausente ou inválido — a unicidade do de-para ativo voltaria a ser conclusão de query';
  END IF;

  RAISE NOTICE 'OK M1: 5 colunas + 4 funções do selo + RPC 3-args e wrapper + cancelar/claims/split seal-aware. Triggers de enforcement ficam para a M2.';
END
$post$;

COMMIT;
