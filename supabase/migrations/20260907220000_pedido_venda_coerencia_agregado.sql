-- ============================================================================================
-- pedido_venda_coerencia — a invariante do AGREGADO passa a ter dono no BANCO
-- ============================================================================================
-- CLASSE (não instância): "a invariante pertence ao pedido, mas implementação e verificação
-- cobrem só um escritor". O agregado pedido de venda tem TRÊS invariantes; só UMA é estrutural
-- hoje, e é justamente a única que não viola:
--
--   I1 identidade  (1 pedido Omie = 1 linha canônica) -> uniq_sales_orders_omie_pedido_id
--                  ESTRUTURAL. 25 grupos duplicados, 25 com exatamente 1 canônico, 0 violação.
--   I2 composição  (jsonb items == order_items)       -> nada. 39 pedidos divergentes.
--   I3 valor       (total = Σ itens)                  -> nada. 7 pedidos divergentes.
--
-- Mesma tabela, mesmos escritores, mesmo time. A variável é ter ou não estrutura na escrita.
--
-- POR QUE A CENTRALIZAÇÃO ANTERIOR NÃO FECHOU: 2026-06-17 criou a RPC atômica
-- criar_pedidos_com_itens e 2026-08-30 a reconciliar_pedidos_omie (FOR UPDATE, 87 asserts).
-- Ainda assim 8 pedidos divergentes nasceram depois, o mais recente 2026-08-11 — porque a
-- proteção ficou DENTRO do escritor certo e o agregado continuou sem dono. O escritor
-- alternativo é real e está em produção: supabase/functions/omie-vendas-sync/index.ts:3381
-- atualiza items + subtotal + total de um pedido canônico e NUNCA toca order_items. Aquele
-- código é cuidadoso (checa 0 linhas, mensagem honesta, passou por revisão) — o revisor
-- perguntou "esta escrita está correta?" e não "o pedido segue coerente depois dela?".
--
-- DANO MEDIDO (psql-ro, 2026-09-07): 15 pedidos canônicos reprovados, 14 `faturado`,
-- R$ 27.795,25, 63 diferenças de item. Efeito no money-path: fin-valor-cockpit,
-- algorithm-a-audit e apriori ancoram em order_items, então item que não foi escrito
-- vira VAZIO — não erro. R$ 10.676,56 de venda faturada invisível.
--
-- ESCOPO DELIBERADO — esta migration NÃO valida I3 (valor). A semântica do campo `desconto`
-- está contraditória entre escritores (o sync aplica qtd*preço*(1-desconto/100), o cockpit
-- aplica qtd*preço-desconto) e hoje isso é LATENTE: desconto é 0 em 100% dos 70.889 itens do
-- jsonb e das 70.860 linhas. Fixar uma fórmula agora seria escolher uma regra financeira sem
-- decisão de produto. A comparação abaixo confere IGUALDADE LITERAL entre os dois espelhos,
-- sem interpretar a semântica.
--
-- APLICAÇÃO: SQL Editor do Lovable (custom migration NÃO auto-aplica).
-- PASSIVO: 15 pedidos preexistentes ficam impedidos de receber UPDATE até reparo.
--          Reparo NÃO vai junto — mexer em total/itens de pedido faturado é correção
--          financeira, não centralização de proteção, e precisa de decisão caso a caso.
-- ============================================================================================

-- ╔══════════════════════════════════════════════════════════════════════════════╗
-- ║ INVARIANTE DO AGREGADO — pedido de venda                                      ║
-- ║                                                                                ║
-- ║ "Se um pedido TEM linhas em order_items, o conjunto dessas linhas descreve os  ║
-- ║  MESMOS itens que sales_orders.items (jsonb)."                                 ║
-- ║                                                                                ║
-- ║ Por que CONDICIONADA à existência de linhas: o push do app cria pedido com     ║
-- ║ jsonb e sem linhas (9 dos 11 escritores de jsonb; desenho legítimo). Uma       ║
-- ║ invariante "sempre coerente" reprovaria o desenho certo junto com o defeito.   ║
-- ║                                                                                ║
-- ║ Por que CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED: as RPCs legítimas    ║
-- ║ (criar_pedidos_com_itens, reconciliar_pedidos_omie) escrevem cabeçalho e       ║
-- ║ linhas em statements sucessivos DENTRO de uma transação — só o COMMIT é um     ║
-- ║ instante em que a coerência precisa valer. Uma trigger AFTER comum reprovaria  ║
-- ║ o meio da transação correta; a deferred vê só o estado final.                  ║
-- ║ Já um escritor PostgREST (1 statement = 1 transação) é avaliado imediatamente  ║
-- ║ no commit dele — que é exatamente o que se quer barrar.                        ║
-- ╚══════════════════════════════════════════════════════════════════════════════╝

-- Verificador do agregado. Recebe UM pedido e exige coerência.
-- SECURITY DEFINER + search_path fixo: a checagem nao pode depender do caller.
CREATE OR REPLACE FUNCTION public.pedido_venda_exigir_coerencia(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_n_linhas bigint;
  v_divergiu boolean;
BEGIN
  IF p_id IS NULL THEN RETURN; END IF;

  -- pedido apagado na mesma transacao (CASCADE): nada a exigir
  PERFORM 1 FROM sales_orders WHERE id = p_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT count(*) INTO v_n_linhas FROM order_items WHERE sales_order_id = p_id;

  -- Sem linhas = push do app. Desenho legitimo, nao e defeito. Fora do escopo.
  IF v_n_linhas = 0 THEN RETURN; END IF;

  -- Com linhas: os dois lados descrevem o MESMO multiconjunto de itens.
  -- Comparacao por (produto, quantidade, preco) -- a identidade que o money-path
  -- consome. EXCEPT ALL trata NULL como NAO-DISTINTO de NULL: duas ausencias
  -- casam entre si, e ausente NUNCA casa com 0 (ausente != zero).
  WITH lado_rel AS (
    SELECT omie_codigo_produto AS prod, quantity AS qtd, unit_price AS preco,
           discount AS desc_item
    FROM order_items WHERE sales_order_id = p_id
  ),
  lado_json AS (
    SELECT (el->>'omie_codigo_produto')::bigint AS prod,
           (el->>'quantidade')::numeric        AS qtd,
           (el->>'valor_unitario')::numeric    AS preco,
           (el->>'desconto')::numeric          AS desc_item
    FROM sales_orders so CROSS JOIN LATERAL jsonb_array_elements(so.items) el
    WHERE so.id = p_id AND jsonb_typeof(so.items) = 'array'
  )
  SELECT EXISTS (
    (TABLE lado_rel EXCEPT ALL TABLE lado_json)
    UNION ALL
    (TABLE lado_json EXCEPT ALL TABLE lado_rel)
  ) INTO v_divergiu;

  IF v_divergiu THEN
    RAISE EXCEPTION
      'pedido % incoerente: order_items e items(jsonb) descrevem conjuntos diferentes', p_id
      USING ERRCODE = '23514',  -- check_violation: nome identificavel pelo caller
            CONSTRAINT = 'pedido_venda_coerencia',
            HINT = 'escreva cabecalho e linhas na MESMA transacao (RPC criar_pedidos_com_itens / reconciliar_pedidos_omie)';
  END IF;
END;
$fn$;

-- Adaptadores de trigger. PL/pgSQL e LATE-BOUND: tocar NEW.sales_order_id numa
-- trigger de sales_orders compila e SO quebra em runtime -- por isso cada tabela
-- tem seu proprio adaptador, sem COALESCE entre campos de tabelas diferentes.
CREATE OR REPLACE FUNCTION public.pedido_venda_coerencia_cab()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  -- DELETE do cabecalho leva as linhas junto (CASCADE): nada a exigir
  IF TG_OP = 'DELETE' THEN RETURN NULL; END IF;
  PERFORM public.pedido_venda_exigir_coerencia(NEW.id);
  RETURN NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.pedido_venda_coerencia_lin()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
  -- UPDATE que move a linha de pedido exige coerencia dos DOIS pedidos
  IF TG_OP = 'DELETE' THEN
    PERFORM public.pedido_venda_exigir_coerencia(OLD.sales_order_id);
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.pedido_venda_exigir_coerencia(NEW.sales_order_id);
  ELSE
    PERFORM public.pedido_venda_exigir_coerencia(NEW.sales_order_id);
    IF OLD.sales_order_id IS DISTINCT FROM NEW.sales_order_id THEN
      PERFORM public.pedido_venda_exigir_coerencia(OLD.sales_order_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$fn$;

-- As DUAS pontas: quem mexe no jsonb e quem mexe nas linhas responde pela mesma
-- invariante. Um só lado deixaria a outra borda aberta -- foi assim que a
-- centralização anterior (só na RPC) nao fechou a classe.
DROP TRIGGER IF EXISTS trg_pedido_venda_coerencia_cab ON sales_orders;
CREATE CONSTRAINT TRIGGER trg_pedido_venda_coerencia_cab
  AFTER INSERT OR UPDATE OR DELETE ON sales_orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.pedido_venda_coerencia_cab();

DROP TRIGGER IF EXISTS trg_pedido_venda_coerencia_lin ON order_items;
CREATE CONSTRAINT TRIGGER trg_pedido_venda_coerencia_lin
  AFTER INSERT OR UPDATE OR DELETE ON order_items
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.pedido_venda_coerencia_lin();

-- Sem ENABLE ALWAYS, session_replication_role='replica' desliga a invariante
-- inteira (o parecer: "Sim, por padrão, se a role tiver poder para configurar").
ALTER TABLE sales_orders ENABLE ALWAYS TRIGGER trg_pedido_venda_coerencia_cab;
ALTER TABLE order_items  ENABLE ALWAYS TRIGGER trg_pedido_venda_coerencia_lin;

-- ────────────────────────────────────────────────────────────────────────────
-- FECHAR POR PRIVILÉGIO. As três são SECURITY DEFINER e leem `unit_price`; nenhuma
-- precisa ser chamável por usuário — quem as invoca é o executor de trigger, que
-- não reavalia EXECUTE do chamador a cada disparo. Deixar EXECUTE aberto seria
-- superfície SECDEF sem gate. REVOKE exige as DUAS pontas: `anon` e `authenticated`
-- são MEMBROS de PUBLIC, então revogar só deles é NO-OP enquanto PUBLIC tiver =X/.
-- ────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.pedido_venda_exigir_coerencia(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pedido_venda_coerencia_cab()        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pedido_venda_coerencia_lin()        FROM PUBLIC, anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- POSTCONDIÇÃO — falha o apply se qualquer peça não ficou de pé.
-- (o apply manual diverge do repo; ausência de erro não é prova de instalação)
-- ────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM pg_trigger t
  WHERE NOT t.tgisinternal
    AND t.tgname IN ('trg_pedido_venda_coerencia_cab','trg_pedido_venda_coerencia_lin');
  IF v_n <> 2 THEN RAISE EXCEPTION '[POSTCOND] esperava 2 triggers, achei %', v_n; END IF;

  -- tgenabled: 'A' = ENABLE ALWAYS. Sem isso session_replication_role='replica' desliga tudo.
  SELECT count(*) INTO v_n FROM pg_trigger t
  WHERE NOT t.tgisinternal
    AND t.tgname IN ('trg_pedido_venda_coerencia_cab','trg_pedido_venda_coerencia_lin')
    AND t.tgenabled = 'A';
  IF v_n <> 2 THEN RAISE EXCEPTION '[POSTCOND] triggers sem ENABLE ALWAYS (tgenabled A): %', v_n; END IF;

  -- deferrable: sem isso a RPC legítima (cabeçalho e linhas em statements sucessivos)
  -- seria reprovada no meio da própria transação correta.
  SELECT count(*) INTO v_n FROM pg_trigger t
  WHERE NOT t.tgisinternal
    AND t.tgname IN ('trg_pedido_venda_coerencia_cab','trg_pedido_venda_coerencia_lin')
    AND t.tgdeferrable AND t.tginitdeferred;
  IF v_n <> 2 THEN RAISE EXCEPTION '[POSTCOND] triggers nao sao DEFERRABLE INITIALLY DEFERRED: %', v_n; END IF;

  -- ACL medido, nao declarado: has_function_privilege e a fonte, o REVOKE e a intencao
  SELECT count(*) INTO v_n
  FROM (VALUES ('public.pedido_venda_exigir_coerencia(uuid)'),
               ('public.pedido_venda_coerencia_cab()'),
               ('public.pedido_venda_coerencia_lin()')) AS f(sig),
       (VALUES ('public'),('anon'),('authenticated')) AS r(role)
  WHERE has_function_privilege(r.role, f.sig, 'EXECUTE');
  IF v_n <> 0 THEN
    RAISE EXCEPTION '[POSTCOND] % pares role/funcao ainda com EXECUTE — SECDEF sensivel aberta', v_n;
  END IF;

  RAISE NOTICE '[POSTCOND-OK] pedido_venda_coerencia instalada (2 triggers, ALWAYS, deferred, ACL fechado)';
END
$post$;
