-- ============================================================
-- Posse DURÁVEL da edição de pedido com PV no Omie (revisão /sales, leva 1, PR 2)
--
-- O PR 1 (#4258, edge omie-vendas-sync v1.54) reservava o pedido por um UPDATE condicional de
-- updated_at logo antes do 1º AlterarPedidoVenda, e guardava "em voo"/"divergente" só na memória
-- do front (registroEnvios.ts). Ficaram abertos (Codex r9, adiados para cá):
--   • posse entre abas/aparelhos (duas telas do MESMO PV registravam revisão de crédito);
--   • a gravação local (aplicar_edicao_pedido_omie) não conferia posse nem deleted_at;
--   • o soft-delete do front e a exclusão não sabiam de edição em curso;
--   • a divergência (Omie mexido sem prova de como ficou) sumia ao recarregar o app;
--   • o `success: true` que chega depois do prazo do front não tinha onde ser conferido.
--
-- Desenho (Codex no desenho, 2026-11-27): UMA LINHA POR TENTATIVA, chave = token (gerado pela tela).
-- A identidade (conta, PV, pedido) é gravada na tentativa e nunca muda. A exclusão mútua por PV é o
-- índice único parcial: no máximo UMA tentativa viva (sem desfecho) ou divergente por (conta, PV) —
-- o gêmeo do mesmo PV disputa a mesma chave.
-- Situação (now() do servidor, nunca o relógio do aparelho):
--   encerrada  — desfecho concluida | liberada | resolvida | expirada | abandonada;
--   reservada  — reivindicada, não despachada, há ≤ 10 min;
--   vencida    — reivindicada, não despachada, há > 10 min (a edge morreu ANTES de tocar o Omie: o
--                despacho é gravado antes dele; a próxima reivindicação a encerra como expirada);
--   em_voo     — despachada (o Omie pode estar sendo mexido), sem desfecho, há ≤ 10 min;
--   divergente — desfecho divergente, ou despachada há > 10 min sem desfecho (a edge morreu DEPOIS
--                de tocar o Omie). Só um master tira, com `resolver` e o token da divergência vista.
-- 10 min > teto de wall-clock da edge (≤ 400 s).
--
-- A tela, ao perder a resposta, chama `encerrar_envio(token)`: se a edge ainda não despachou, a
-- tentativa vira `abandonada` (ou nasce assim, se a edge nem chegou a reivindicar) e NENHUM despacho
-- desse token passa mais — "não alterou" vira fato, não suposição.
--
-- Compatibilidade: aplicar_edicao_pedido_omie de 8 args e sales_order_excluir_sem_envio ficam
-- INTACTAS (são as que a edge no ar, v1.52/v1.54, chama). A v1.55 chama o overload de 9 args e a
-- sales_order_excluir_conferido. Ordem: migration → edge v1.55 → Publish.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.pedido_edicao_omie_tentativa (
  token           uuid        PRIMARY KEY,
  account         text        NOT NULL CHECK (account IN ('oben', 'colacor')),
  omie_pedido_id  bigint      NOT NULL CHECK (omie_pedido_id > 0),
  -- Sem FK de propósito: RESTRICT quebraria um DELETE legítimo do pedido; CASCADE apagaria uma
  -- tentativa ATIVA (ou a divergência) em silêncio. A RPC confere o pedido sob FOR UPDATE.
  sales_order_id  uuid        NOT NULL,
  ator            uuid,
  reivindicada_em timestamptz NOT NULL DEFAULT now(),
  despachada_em   timestamptz,
  desfecho        text        CHECK (desfecho IN ('concluida', 'liberada', 'divergente', 'resolvida', 'expirada', 'abandonada')),
  desfecho_em     timestamptz,
  motivo          text,
  resolvida_por   uuid,
  CONSTRAINT pedido_edicao_omie_tentativa_desfecho_datado CHECK ((desfecho IS NULL) = (desfecho_em IS NULL)),
  CONSTRAINT pedido_edicao_omie_tentativa_concluida_despachada CHECK (desfecho IS DISTINCT FROM 'concluida' OR despachada_em IS NOT NULL),
  CONSTRAINT pedido_edicao_omie_tentativa_liberada_sem_despacho CHECK (desfecho IS NULL OR desfecho NOT IN ('liberada', 'expirada', 'abandonada') OR despachada_em IS NULL)
);

COMMENT ON TABLE public.pedido_edicao_omie_tentativa IS
  'Uma linha por tentativa de edição de pedido com PV no Omie (token da tela). Escrita só pelas RPCs '
  'pedido_edicao_omie_* e aplicar_edicao_pedido_omie (9 args). Migration 20261127100200.';

-- A exclusão mútua por PV.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pedido_edicao_omie_tentativa_viva_por_pv
  ON public.pedido_edicao_omie_tentativa (account, omie_pedido_id)
  WHERE desfecho IS NULL OR desfecho = 'divergente';

CREATE INDEX IF NOT EXISTS idx_pedido_edicao_omie_tentativa_pedido
  ON public.pedido_edicao_omie_tentativa (sales_order_id);

ALTER TABLE public.pedido_edicao_omie_tentativa ENABLE ROW LEVEL SECURITY;
-- Nenhuma policy: anon/authenticated não leem nem escrevem a tabela; a equipe passa pelas RPCs
-- SECURITY DEFINER com gate de papel.
REVOKE ALL ON TABLE public.pedido_edicao_omie_tentativa FROM PUBLIC, anon, authenticated;
-- Fecho por ALLOWLIST (Codex no diff): o default ACL de public dá escrita também a sandbox_exec* (BYPASSRLS) —
-- quem escrevesse direto aqui tiraria um PV de "divergente" sem o master. Fica só o dono, service_role e claude_ro.
DO $acl_tabela$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
             FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid = 'public.pedido_edicao_omie_tentativa'::regclass
              AND a.grantee <> 0 AND a.grantee <> c.relowner
              AND a.grantee::regrole::text NOT IN ('service_role', 'claude_ro') LOOP
    EXECUTE format('REVOKE ALL ON public.pedido_edicao_omie_tentativa FROM %s', r.papel);
  END LOOP;
END
$acl_tabela$;
GRANT SELECT, INSERT, UPDATE ON TABLE public.pedido_edicao_omie_tentativa TO service_role;
DO $acl_leitor$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT SELECT ON TABLE public.pedido_edicao_omie_tentativa TO claude_ro;  -- diagnóstico read-only
  END IF;
END
$acl_leitor$;

-- Situação de uma tentativa. Só CLASSIFICA os valores (não lê tabela): quem relê a linha é o
-- chamador, num comando próprio. STABLE por now(). Desfecho desconhecido (o CHECK impede) cai em
-- divergente — fail-closed.
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_situacao(
  p_reivindicada_em timestamptz,
  p_despachada_em   timestamptz,
  p_desfecho        text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_desfecho IN ('concluida', 'liberada', 'resolvida', 'expirada', 'abandonada') THEN 'encerrada'
    WHEN p_desfecho IS NOT NULL THEN 'divergente'
    WHEN p_despachada_em IS NOT NULL THEN
      CASE WHEN p_despachada_em >= now() - interval '10 minutes' THEN 'em_voo' ELSE 'divergente' END
    WHEN p_reivindicada_em >= now() - interval '10 minutes' THEN 'reservada'
    ELSE 'vencida'
  END;
$$;

-- ── 1) Reivindicar: ANTES de toda leitura do PV e do registro de revisão de crédito. NÃO toca
--      sales_orders: uma recusa de crédito/ATP depois dela não envelhece a versão da tela. ──
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_reivindicar(
  p_sales_order_id uuid,
  p_versao         timestamptz,
  p_token          uuid,
  p_ator           uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conta     text;
  v_pv        bigint;
  v_excluido  timestamptz;
  v_versao    timestamptz;
  v_n         integer;
  v_situacao  text;
BEGIN
  IF p_sales_order_id IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'pedido_edicao_omie_reivindicar: pedido e token são obrigatórios' USING ERRCODE = '22023';
  END IF;

  -- Serializa com o soft-delete, o despacho e a exclusão da MESMA linha.
  SELECT account, omie_pedido_id, deleted_at, updated_at
    INTO v_conta, v_pv, v_excluido, v_versao
    FROM public.sales_orders
   WHERE id = p_sales_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'ausente';
  END IF;
  IF v_excluido IS NOT NULL THEN
    RETURN 'excluido';
  END IF;
  IF v_pv IS NULL OR v_conta IS NULL OR v_conta NOT IN ('oben', 'colacor') THEN
    RETURN 'sem_pv';
  END IF;
  -- O trigger update_sales_orders_updated_at move a versão em TODO UPDATE: versão igual = linha igual
  -- à que a tela (e a edge, depois dela) leram.
  IF v_versao IS DISTINCT FROM p_versao THEN
    RETURN 'pedido_alterado';
  END IF;

  -- Reserva vencida deste PV (a edge morreu antes de despachar) sai do caminho, com o relógio
  -- avaliado DEPOIS de esperar o lock.
  UPDATE public.pedido_edicao_omie_tentativa
     SET desfecho = 'expirada', desfecho_em = now()
   WHERE account = v_conta
     AND omie_pedido_id = v_pv
     AND desfecho IS NULL
     AND despachada_em IS NULL
     AND reivindicada_em < clock_timestamp() - interval '10 minutes';

  -- Sem alvo: qualquer unicidade (o token já usado OU a tentativa viva do PV) vira DO NOTHING.
  INSERT INTO public.pedido_edicao_omie_tentativa
         (token, account, omie_pedido_id, sales_order_id, ator, reivindicada_em)
  VALUES (p_token, v_conta, v_pv, p_sales_order_id, p_ator, now())
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    RETURN 'reivindicado';
  END IF;

  -- Token já usado: a tela o encerrou (abandonada) ou é um reenvio do MESMO save. Nunca reabre.
  IF EXISTS (SELECT 1 FROM public.pedido_edicao_omie_tentativa WHERE token = p_token) THEN
    RETURN 'token_encerrado';
  END IF;

  SELECT public.pedido_edicao_omie_situacao(t.reivindicada_em, t.despachada_em, t.desfecho)
    INTO v_situacao
    FROM public.pedido_edicao_omie_tentativa t
   WHERE t.account = v_conta AND t.omie_pedido_id = v_pv
     AND (t.desfecho IS NULL OR t.desfecho = 'divergente');
  RETURN CASE WHEN v_situacao = 'divergente' THEN 'divergente' ELSE 'em_edicao' END;
END;
$$;

-- ── 1b) Revisão de crédito COM posse (Codex no diff): a tentativa reservada fica presa (FOR UPDATE) na MESMA
--       transação que grava a revisão. Encerrar o token (tela que desistiu) espera esta gravação; tentativa já
--       encerrada, vencida ou de outro pedido não grava revisão nenhuma — sem isto, a revisão de um save
--       abandonado podia ganhar a `seq` depois da do save que o substituiu. A credito_registrar_revisao é intacta.
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_registrar_revisao(
  p_token               uuid,
  p_sales_order_id      uuid,
  p_company             text,
  p_contexto            text,
  p_omie_codigo_cliente bigint,
  p_codigo_parcela      text,
  p_parcela_origem      text,
  p_itens               jsonb,
  p_user_id             uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  PERFORM 1
     FROM public.pedido_edicao_omie_tentativa
    WHERE token = p_token
      AND sales_order_id = p_sales_order_id
      AND despachada_em IS NULL
      AND desfecho IS NULL
      AND reivindicada_em >= clock_timestamp() - interval '10 minutes'
      FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pedido_edicao_omie_registrar_revisao: a tentativa nao esta mais reservada (encerrada, vencida ou de outro pedido) — revisao nao registrada'
      USING ERRCODE = '55000';
  END IF;
  RETURN public.credito_registrar_revisao(
    p_sales_order_id, p_company, p_contexto, p_omie_codigo_cliente, p_codigo_parcela, p_parcela_origem, p_itens, p_user_id);
END;
$$;

-- ── 2) Despachar: imediatamente antes da 1ª mutação no Omie. Exige a reserva AINDA válida e o
--      gêmeo do PV como a edge o leu; grava o despacho (daqui em diante desfecho sem prova é
--      divergência) e move a versão do pedido (a reserva do PR 1). ──
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_despachar(
  p_sales_order_id  uuid,
  p_token           uuid,
  p_versao          timestamptz,
  p_gemeo_presente  boolean,
  p_gemeo_status    text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conta         text;
  v_pv            bigint;
  v_excluido      timestamptz;
  v_versao        timestamptz;
  v_gemeo_status  text;
  v_gemeo_achou   boolean;
BEGIN
  IF p_sales_order_id IS NULL OR p_token IS NULL OR p_gemeo_presente IS NULL THEN
    RAISE EXCEPTION 'pedido_edicao_omie_despachar: pedido, token e o gêmeo lido são obrigatórios' USING ERRCODE = '22023';
  END IF;

  SELECT account, omie_pedido_id, deleted_at, updated_at
    INTO v_conta, v_pv, v_excluido, v_versao
    FROM public.sales_orders
   WHERE id = p_sales_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'ausente';
  END IF;
  IF v_excluido IS NOT NULL THEN
    RETURN 'excluido';
  END IF;
  IF v_pv IS NULL OR v_versao IS DISTINCT FROM p_versao THEN
    RETURN 'pedido_alterado';
  END IF;

  -- O gêmeo importado (outra linha, a do sync) pode ter avançado sem mexer na versão do recibo.
  SELECT status INTO v_gemeo_status
    FROM public.sales_orders
   WHERE account = v_conta AND hash_payload = 'omie_' || v_conta || '_' || v_pv
     FOR SHARE;
  v_gemeo_achou := FOUND;
  IF v_gemeo_achou IS DISTINCT FROM p_gemeo_presente
     OR (v_gemeo_achou AND v_gemeo_status IS DISTINCT FROM p_gemeo_status) THEN
    RETURN 'gemeo_alterado';
  END IF;

  UPDATE public.pedido_edicao_omie_tentativa
     SET despachada_em = now()
   WHERE token = p_token
     AND sales_order_id = p_sales_order_id
     AND account = v_conta
     AND omie_pedido_id = v_pv
     AND despachada_em IS NULL
     AND desfecho IS NULL
     AND reivindicada_em >= clock_timestamp() - interval '10 minutes';
  IF NOT FOUND THEN
    RETURN 'perdeu_posse';
  END IF;

  -- A linha está presa desde o SELECT acima: este UPDATE casa. O trigger põe updated_at = now().
  UPDATE public.sales_orders SET updated_at = now() WHERE id = p_sales_order_id;
  RETURN 'despachado';
END;
$$;

-- ── 3) Liberar: recusa ANTES do Omie (crédito, ATP, leitura). Despachada não se libera. ──
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_liberar(p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE public.pedido_edicao_omie_tentativa
     SET desfecho = 'liberada', desfecho_em = now()
   WHERE token = p_token AND despachada_em IS NULL AND desfecho IS NULL;
  RETURN FOUND;
END;
$$;

-- ── 4) Marcar divergente: falha DEPOIS do despacho. Write-back já concluído (resposta perdida)
--      não é tocado: desfecho IS NULL. ──
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_marcar_divergente(p_token uuid, p_motivo text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE public.pedido_edicao_omie_tentativa
     SET desfecho = 'divergente', desfecho_em = now(), motivo = left(coalesce(p_motivo, 'sem motivo'), 2000)
   WHERE token = p_token AND despachada_em IS NOT NULL AND desfecho IS NULL;
  RETURN FOUND;
END;
$$;

-- ── 5) Gravação local com posse: overload de 9 args. Sob FOR UPDATE do pai: não excluído, e ESTE
--      token despachou a edição DESTE pedido/PV. Grava pela função de 8 (intacta) e conclui a
--      tentativa na MESMA transação — sucesso local e posse livre andam juntos. ──
CREATE OR REPLACE FUNCTION public.aplicar_edicao_pedido_omie(
  p_sales_order_id uuid,
  p_items          jsonb,
  p_itens          jsonb,
  p_total          numeric,
  p_notes          text,
  p_omie_payload   jsonb,
  p_omie_response  jsonb,
  p_lido_em        timestamptz,
  p_token          uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO ''
AS $$
DECLARE
  v_conta     text;
  v_pv        bigint;
  v_excluido  timestamptz;
  v_res       jsonb;
BEGIN
  IF p_token IS NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: p_token ausente — sem posse nao se grava a edicao'
      USING ERRCODE = '22023';
  END IF;

  SELECT account, omie_pedido_id, deleted_at
    INTO v_conta, v_pv, v_excluido
    FROM public.sales_orders
   WHERE id = p_sales_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: pedido % nao existe', p_sales_order_id USING ERRCODE = 'P0002';
  END IF;
  IF v_excluido IS NOT NULL THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: pedido % foi excluido durante a edicao — o Omie ja foi mutado', p_sales_order_id
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
     FROM public.pedido_edicao_omie_tentativa
    WHERE token = p_token
      AND sales_order_id = p_sales_order_id
      AND account = v_conta
      AND omie_pedido_id = v_pv
      AND despachada_em IS NOT NULL
      AND desfecho IS NULL
      FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'aplicar_edicao_pedido_omie: o pedido % nao esta em edicao por este envio (tentativa ausente, de outro pedido/PV ou ja encerrada)', p_sales_order_id
      USING ERRCODE = '55000';
  END IF;

  v_res := public.aplicar_edicao_pedido_omie(
    p_sales_order_id, p_items, p_itens, p_total, p_notes, p_omie_payload, p_omie_response, p_lido_em);

  UPDATE public.pedido_edicao_omie_tentativa
     SET desfecho = 'concluida', desfecho_em = now()
   WHERE token = p_token;

  RETURN v_res || jsonb_build_object('posse', 'concluida');
END;
$$;

-- ── 6) Exclusão conferida: sob FOR UPDATE, a identidade (conta, PV) é a que a edge provou antes
--      (o cancelamento no Omie é do PV LIDO), e nenhuma edição deste pedido está reservada/em voo.
--      O lock vem num comando PRÓPRIO: no DELETE com NOT EXISTS o EvalPlanQual reavaliaria a
--      subconsulta com o snapshot velho. Divergente NÃO segura: o PV já foi cancelado no Omie, e a
--      tentativa fica (sem FK). A sales_order_excluir_sem_envio antiga segue para a edge no ar. ──
CREATE OR REPLACE FUNCTION public.sales_order_excluir_conferido(
  p_sales_order_id    uuid,
  p_somente_orcamento boolean,
  p_account           text,
  p_omie_pedido_id    bigint,
  p_gemeo_presente    boolean,
  p_gemeo_status      text
)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_conta  text;
  v_pv     bigint;
  v_status text;
  v_envio  timestamptz;
  v_gemeo_status text;
  v_gemeo_achou  boolean;
BEGIN
  SELECT account, omie_pedido_id, status, envio_omie_reivindicado_em
    INTO v_conta, v_pv, v_status, v_envio
    FROM public.sales_orders
   WHERE id = p_sales_order_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'ausente';
  END IF;
  IF v_conta IS DISTINCT FROM p_account OR v_pv IS DISTINCT FROM p_omie_pedido_id THEN
    RETURN 'pedido_alterado';
  END IF;
  -- Com PV, a prova que autorizou a exclusão é o status do GÊMEO (cancelado no Omie, trazido pelo sync):
  -- reconferida sob lock — o sync pode tê-lo reativado depois da leitura da edge (Codex no diff).
  IF v_pv IS NOT NULL THEN
    IF p_gemeo_presente IS NULL THEN
      RAISE EXCEPTION 'sales_order_excluir_conferido: pedido com PV exige o gêmeo lido' USING ERRCODE = '22023';
    END IF;
    SELECT status INTO v_gemeo_status
      FROM public.sales_orders
     WHERE account = v_conta AND hash_payload = 'omie_' || v_conta || '_' || v_pv
       FOR SHARE;
    v_gemeo_achou := FOUND;
    IF v_gemeo_achou IS DISTINCT FROM p_gemeo_presente
       OR (v_gemeo_achou AND v_gemeo_status IS DISTINCT FROM p_gemeo_status) THEN
      RETURN 'gemeo_alterado';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pedido_edicao_omie_tentativa t
     WHERE t.sales_order_id = p_sales_order_id
       AND public.pedido_edicao_omie_situacao(t.reivindicada_em, t.despachada_em, t.desfecho) IN ('reservada', 'em_voo')
  ) THEN
    RETURN 'edicao_em_curso';
  END IF;
  IF v_envio IS NOT NULL AND v_envio >= now() - interval '10 minutes' THEN
    RETURN 'envio_em_curso';
  END IF;
  IF coalesce(p_somente_orcamento, false) AND v_status NOT IN ('orcamento', 'rascunho') THEN
    RETURN 'nao_e_orcamento';
  END IF;

  DELETE FROM public.sales_orders WHERE id = p_sales_order_id;
  RETURN 'excluido';
END;
$$;

-- ── 7) Soft-delete do front (UPDATE deleted_at como authenticated) respeitando edição em curso.
--      SECURITY DEFINER: authenticated não lê a tabela. Função VOLATILE: o EXISTS roda num snapshot
--      NOVO, depois de o UPDATE obter o lock da linha — vê a reivindicação recém-commitada. ──
CREATE OR REPLACE FUNCTION public.sales_orders_exclusao_respeita_edicao()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.pedido_edicao_omie_tentativa t
     WHERE t.sales_order_id = OLD.id
       AND public.pedido_edicao_omie_situacao(t.reivindicada_em, t.despachada_em, t.desfecho) IN ('reservada', 'em_voo')
  ) THEN
    RAISE EXCEPTION 'Exclusão recusada: este pedido está sendo salvo no Omie agora (edição em curso). Tente de novo em alguns minutos.'
      USING ERRCODE = '55P03';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sales_orders_exclusao_respeita_edicao ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_exclusao_respeita_edicao
  BEFORE UPDATE OF deleted_at ON public.sales_orders
  FOR EACH ROW
  WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION public.sales_orders_exclusao_respeita_edicao();

-- Gate de papel das RPCs da tela.
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_exige_equipe(p_so_master boolean)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL
     OR NOT (public.has_role(v_uid, 'master'::public.app_role)
             OR (NOT p_so_master AND public.has_role(v_uid, 'employee'::public.app_role))) THEN
    RAISE EXCEPTION 'pedido_edicao_omie: papel insuficiente' USING ERRCODE = '42501';
  END IF;
  RETURN v_uid;
END;
$$;

-- ── 8) Estado do PV do pedido, para a TELA ao abrir: livre | reservada | em_voo | divergente
--      (+ o token da divergência, que o resolver exige). ──
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_estado(p_sales_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conta text;
  v_pv    bigint;
  r       public.pedido_edicao_omie_tentativa%ROWTYPE;
  v_sit   text;
BEGIN
  PERFORM public.pedido_edicao_omie_exige_equipe(false);

  SELECT account, omie_pedido_id INTO v_conta, v_pv FROM public.sales_orders WHERE id = p_sales_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('situacao', 'ausente');
  END IF;
  IF v_pv IS NULL THEN
    RETURN jsonb_build_object('situacao', 'livre');
  END IF;

  SELECT * INTO r FROM public.pedido_edicao_omie_tentativa t
   WHERE t.account = v_conta AND t.omie_pedido_id = v_pv
     AND (t.desfecho IS NULL OR t.desfecho = 'divergente');
  IF NOT FOUND THEN
    RETURN jsonb_build_object('situacao', 'livre');
  END IF;
  v_sit := public.pedido_edicao_omie_situacao(r.reivindicada_em, r.despachada_em, r.desfecho);
  RETURN jsonb_build_object(
    'situacao', CASE WHEN v_sit = 'vencida' THEN 'livre' ELSE v_sit END,
    'token',    CASE WHEN v_sit = 'divergente' THEN r.token END,
    'desde',    coalesce(r.desfecho_em, r.despachada_em, r.reivindicada_em),
    'motivo',   CASE WHEN v_sit = 'divergente' THEN r.motivo END);
END;
$$;

-- ── 9) Encerrar o envio da tela (perdeu a resposta / prazo vencido). Atômico com a reivindicação:
--      sem tentativa → nasce `abandonada` e o token nunca mais reivindica; reservada → `abandonada`
--      e o despacho desse token não passa. Devolve o desfecho do token:
--      abandonada | liberada | expirada (nada foi ao Omie) · concluida · em_voo · divergente ·
--      resolvida · sem_pv · ausente. ──
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_encerrar_envio(p_sales_order_id uuid, p_token uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid   uuid := public.pedido_edicao_omie_exige_equipe(false);
  v_conta text;
  v_pv    bigint;
  r       public.pedido_edicao_omie_tentativa%ROWTYPE;
  v_n     integer;
BEGIN
  IF p_sales_order_id IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'pedido_edicao_omie_encerrar_envio: pedido e token são obrigatórios' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO r FROM public.pedido_edicao_omie_tentativa WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    SELECT account, omie_pedido_id INTO v_conta, v_pv FROM public.sales_orders WHERE id = p_sales_order_id;
    IF NOT FOUND THEN
      RETURN 'ausente';
    END IF;
    IF v_pv IS NULL OR v_conta IS NULL OR v_conta NOT IN ('oben', 'colacor') THEN
      RETURN 'sem_pv';
    END IF;
    -- Lápide: a reivindicação desse token (que ainda pode estar a caminho) cai em token_encerrado.
    INSERT INTO public.pedido_edicao_omie_tentativa
           (token, account, omie_pedido_id, sales_order_id, ator, reivindicada_em, desfecho, desfecho_em, motivo)
    VALUES (p_token, v_conta, v_pv, p_sales_order_id, v_uid, now(), 'abandonada', now(), 'encerrado pela tela antes de a edge reivindicar')
    ON CONFLICT (token) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      RETURN 'abandonada';
    END IF;
    -- A edge reivindicou no mesmo instante: relê com lock.
    SELECT * INTO r FROM public.pedido_edicao_omie_tentativa WHERE token = p_token FOR UPDATE;
  END IF;

  IF r.sales_order_id IS DISTINCT FROM p_sales_order_id THEN
    RAISE EXCEPTION 'pedido_edicao_omie_encerrar_envio: o token é de outro pedido' USING ERRCODE = '22023';
  END IF;

  IF r.desfecho IS NULL AND r.despachada_em IS NULL THEN
    UPDATE public.pedido_edicao_omie_tentativa
       SET desfecho = 'abandonada', desfecho_em = now(), motivo = 'encerrado pela tela antes do despacho'
     WHERE token = p_token;
    RETURN 'abandonada';
  END IF;
  IF r.desfecho IS NOT NULL THEN
    RETURN r.desfecho;
  END IF;
  -- Despachada sem desfecho: em_voo (≤ 10 min) ou divergente (> 10 min).
  RETURN public.pedido_edicao_omie_situacao(r.reivindicada_em, r.despachada_em, r.desfecho);
END;
$$;

-- ── 10) Resolver a divergência VISTA (token): o master conferiu o pedido no Omie. Move a versão do
--       pedido — todo formulário aberto antes vira retrato velho e é recusado. ──
CREATE OR REPLACE FUNCTION public.pedido_edicao_omie_resolver(p_sales_order_id uuid, p_token uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := public.pedido_edicao_omie_exige_equipe(true);
BEGIN
  PERFORM 1 FROM public.sales_orders WHERE id = p_sales_order_id FOR UPDATE;

  UPDATE public.pedido_edicao_omie_tentativa t
     SET desfecho = 'resolvida', desfecho_em = now(), resolvida_por = v_uid
   WHERE t.token = p_token
     AND t.sales_order_id = p_sales_order_id
     AND public.pedido_edicao_omie_situacao(t.reivindicada_em, t.despachada_em, t.desfecho) = 'divergente';
  IF NOT FOUND THEN
    RETURN 'nada_a_resolver';
  END IF;
  UPDATE public.sales_orders SET updated_at = now() WHERE id = p_sales_order_id;
  RETURN 'resolvida';
END;
$$;

COMMENT ON FUNCTION public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid) IS
  'Tentativa de edição por (conta, PV): reivindicado | ausente | excluido | sem_pv | pedido_alterado | token_encerrado | em_edicao | divergente. Só service_role. Migration 20261127100200.';
COMMENT ON FUNCTION public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text) IS
  'Grava o despacho (antes da 1ª mutação no Omie) e move a versão do pedido: despachado | ausente | excluido | pedido_alterado | gemeo_alterado | perdeu_posse. Só service_role. Migration 20261127100200.';
COMMENT ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid) IS
  'Write-back da edição com posse: confere deleted_at e a tentativa despachada deste token sob FOR UPDATE, grava pela versão de 8 args e conclui a tentativa na mesma transação. Só service_role. Migration 20261127100200.';
COMMENT ON FUNCTION public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text) IS
  'Exclusão do pedido com identidade (conta, PV) e status do gêmeo conferidos sob lock, respeitando edição em curso: excluido | ausente | pedido_alterado | gemeo_alterado | edicao_em_curso | envio_em_curso | nao_e_orcamento. Só service_role. Migration 20261127100200.';

-- ── Privilégios: o default do Supabase concede EXECUTE a anon/authenticated em função nova. ──
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_situacao(timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_situacao(timestamptz, timestamptz, text) TO service_role;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_registrar_revisao(uuid, uuid, text, text, bigint, text, text, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_registrar_revisao(uuid, uuid, text, text, bigint, text, text, jsonb, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_liberar(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_liberar(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_marcar_divergente(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_marcar_divergente(uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.sales_orders_exclusao_respeita_edicao() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_exige_equipe(boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_estado(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_estado(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_encerrar_envio(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_encerrar_envio(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.pedido_edicao_omie_resolver(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pedido_edicao_omie_resolver(uuid, uuid) TO authenticated, service_role;

-- Fecho por ALLOWLIST também no EXECUTE (o default ACL concede a sandbox_exec*): fica o dono, service_role e,
-- nas 3 RPCs da tela, authenticated (o gate de papel é dentro delas).
DO $acl_funcoes$
DECLARE
  f text;
  r record;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.pedido_edicao_omie_situacao(timestamptz, timestamptz, text)',
    'public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid)',
    'public.pedido_edicao_omie_registrar_revisao(uuid, uuid, text, text, bigint, text, text, jsonb, uuid)',
    'public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text)',
    'public.pedido_edicao_omie_liberar(uuid)',
    'public.pedido_edicao_omie_marcar_divergente(uuid, text)',
    'public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid)',
    'public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text)',
    'public.sales_orders_exclusao_respeita_edicao()',
    'public.pedido_edicao_omie_exige_equipe(boolean)',
    'public.pedido_edicao_omie_estado(uuid)',
    'public.pedido_edicao_omie_encerrar_envio(uuid, uuid)',
    'public.pedido_edicao_omie_resolver(uuid, uuid)'] LOOP
    FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid = f::regprocedure
                AND a.grantee <> 0 AND a.grantee <> p.proowner
                AND a.grantee::regrole::text NOT IN ('service_role', 'authenticated') LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', f, r.papel);
    END LOOP;
  END LOOP;
END
$acl_funcoes$;

-- ── PÓS: existência, privilégios, as funções da edge no ar preservadas, e a régua EXECUTADA. ──
DO $post$
BEGIN
  IF to_regclass('public.pedido_edicao_omie_tentativa') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.pedido_edicao_omie_tentativa'::regclass) THEN
    RAISE EXCEPTION 'A1 FALHOU: tabela de tentativas ausente ou sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.pedido_edicao_omie_tentativa', 'SELECT')
     OR has_table_privilege('anon', 'public.pedido_edicao_omie_tentativa', 'SELECT')
     OR has_table_privilege('authenticated', 'public.pedido_edicao_omie_tentativa', 'INSERT') THEN
    RAISE EXCEPTION 'A2 FALHOU: anon/authenticated acessam a tabela de tentativas direto';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                  WHERE i.indexrelid = to_regclass('public.uq_pedido_edicao_omie_tentativa_viva_por_pv')
                    AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL) THEN
    RAISE EXCEPTION 'A3 FALHOU: índice único parcial por PV ausente/inválido — duas edições do mesmo PV passariam';
  END IF;
  IF to_regprocedure('public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz)') IS NULL
     OR to_regprocedure('public.sales_order_excluir_sem_envio(uuid, boolean)') IS NULL THEN
    RAISE EXCEPTION 'A4 FALHOU: função da edge no ar (8 args / exclusão antiga) sumiu';
  END IF;
  IF to_regprocedure('public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid)') IS NULL
     OR to_regprocedure('public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid)') IS NULL
     OR to_regprocedure('public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text)') IS NULL
     OR to_regprocedure('public.pedido_edicao_omie_liberar(uuid)') IS NULL
     OR to_regprocedure('public.pedido_edicao_omie_marcar_divergente(uuid, text)') IS NULL
     OR to_regprocedure('public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text)') IS NULL
     OR to_regprocedure('public.pedido_edicao_omie_estado(uuid)') IS NULL
     OR to_regprocedure('public.pedido_edicao_omie_encerrar_envio(uuid, uuid)') IS NULL
     OR to_regprocedure('public.pedido_edicao_omie_resolver(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'A5 FALHOU: alguma RPC da posse está ausente — a edge v1.55 recusaria toda edição';
  END IF;
  IF has_function_privilege('anon', 'public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pedido_edicao_omie_liberar(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pedido_edicao_omie_marcar_divergente(uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pedido_edicao_omie_exige_equipe(boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pedido_edicao_omie_estado(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pedido_edicao_omie_encerrar_envio(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.pedido_edicao_omie_resolver(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A6 FALHOU: RPC da posse executável por quem não deve — cliente forjaria posse ou desfecho';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pedido_edicao_omie_estado(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.pedido_edicao_omie_encerrar_envio(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A7 FALHOU: quem precisa chamar ficou sem EXECUTE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                  WHERE tgrelid = 'public.sales_orders'::regclass
                    AND tgname = 'trg_sales_orders_exclusao_respeita_edicao' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'A8 FALHOU: trigger do soft-delete ausente/desligado — exclusão apagaria pedido em edição';
  END IF;
  IF public.pedido_edicao_omie_situacao(now(), NULL, NULL) <> 'reservada'
     OR public.pedido_edicao_omie_situacao(now() - interval '11 minutes', NULL, NULL) <> 'vencida'
     OR public.pedido_edicao_omie_situacao(now(), now(), NULL) <> 'em_voo'
     OR public.pedido_edicao_omie_situacao(now() - interval '20 minutes', now() - interval '11 minutes', NULL) <> 'divergente'
     OR public.pedido_edicao_omie_situacao(now(), now(), 'divergente') <> 'divergente'
     OR public.pedido_edicao_omie_situacao(now(), now(), 'concluida') <> 'encerrada'
     OR public.pedido_edicao_omie_situacao(now(), NULL, 'abandonada') <> 'encerrada'
     OR public.pedido_edicao_omie_situacao(now(), now(), 'resolvida') <> 'encerrada' THEN
    RAISE EXCEPTION 'A9 FALHOU: régua da situação errada — posse presa para sempre ou liberada com o Omie mexido';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid = 'public.pedido_edicao_omie_tentativa'::regclass
                AND a.grantee <> c.relowner
                AND (a.grantee = 0 OR a.grantee::regrole::text NOT IN ('service_role', 'claude_ro'))) THEN
    RAISE EXCEPTION 'A10 FALHOU: algum papel fora da allowlist acessa a tabela de tentativas (sandbox_exec?) — tiraria um PV de divergente sem o master';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid IN (SELECT x::regprocedure FROM unnest(ARRAY[
    'public.pedido_edicao_omie_situacao(timestamptz, timestamptz, text)',
    'public.pedido_edicao_omie_reivindicar(uuid, timestamptz, uuid, uuid)',
    'public.pedido_edicao_omie_registrar_revisao(uuid, uuid, text, text, bigint, text, text, jsonb, uuid)',
    'public.pedido_edicao_omie_despachar(uuid, uuid, timestamptz, boolean, text)',
    'public.pedido_edicao_omie_liberar(uuid)',
    'public.pedido_edicao_omie_marcar_divergente(uuid, text)',
    'public.aplicar_edicao_pedido_omie(uuid, jsonb, jsonb, numeric, text, jsonb, jsonb, timestamptz, uuid)',
    'public.sales_order_excluir_conferido(uuid, boolean, text, bigint, boolean, text)',
    'public.sales_orders_exclusao_respeita_edicao()',
    'public.pedido_edicao_omie_exige_equipe(boolean)',
    'public.pedido_edicao_omie_estado(uuid)',
    'public.pedido_edicao_omie_encerrar_envio(uuid, uuid)',
    'public.pedido_edicao_omie_resolver(uuid, uuid)']) x)
                AND a.grantee <> p.proowner
                AND (a.grantee = 0 OR a.grantee::regrole::text NOT IN ('service_role', 'authenticated'))) THEN
    RAISE EXCEPTION 'A11 FALHOU: alguma RPC da posse executável por papel fora da allowlist';
  END IF;
  IF to_regprocedure('public.pedido_edicao_omie_registrar_revisao(uuid, uuid, text, text, bigint, text, text, jsonb, uuid)') IS NULL THEN
    RAISE EXCEPTION 'A12 FALHOU: revisão de crédito com posse ausente — a edge v1.55 registraria revisão de save abandonado';
  END IF;
  RAISE NOTICE 'posse durável: tentativas (RLS, sem acesso direto, 1 viva por PV) + 10 RPCs + trigger do soft-delete; funções da edge no ar preservadas';
END
$post$;

COMMIT;
