-- Retirar a exclusão de outlier — a promessa era cosmética e não há efeito para ligar.
--
-- CONTEXTO: a tela oferecia "Excluir" afirmando "one-off, remove da estatística", com um
-- painel "σ atual → sem outlier". Nada disso acontecia: `observacoes_excluidas` não entra
-- em NENHUM ponto da cadeia que alimenta o motor
--   (v_sku_leadtime_estatisticas / v_sku_demanda_estatisticas → v_sku_parametros_sugeridos
--    → atualizar_parametros_numericos_skus → sku_parametros → gerar_pedidos_sugeridos_ciclo).
-- A tabela é lida por 2 funções apenas: este resolver (writer) e o anti-reflag de
-- detectar_outliers_empresa. Nenhuma view. Lacuna registrada como fora de escopo no #1357.
--
-- POR QUE RETIRAR EM VEZ DE LIGAR (medido em prod, read-only, antes de decidir):
--  • LEADTIME — excluir não move NADA. ss = ceil(z·sqrt(LT·σ_d² + d²·σ_LT²)): o termo do
--    leadtime é d²·σ_LT², e nos SKUs flagrados d é da ordem de 0,1/dia ⇒ ao quadrado,
--    esmaga o termo. Excluir derruba σ_LT pela metade ou mais (e baixa o LT médio) e
--    NEM ss NEM pp mudam — a queda efetiva em sigma_lt_d fica abaixo de 4% e o ceil()
--    come o resto. Quem domina a compra é o σ da DEMANDA (CV 3–5), não o leadtime.
--  • VENDA — excluir move DEMAIS: derruba `d`, que entra em pp = d·LT + … Efeito grande
--    aumenta o RISCO, não a legitimidade: um pedido que responde por boa parte da demanda
--    pode ser atípico e, ao mesmo tempo, o dado comercial mais importante da série.
--  • PREFERÊNCIA REVELADA — toda decisão humana já registrada nesta tela foi 'aceitar';
--    nenhuma exclusão jamais. E não é dado censurado: o 42703 afetava só o ramo de
--    leadtime; no de venda o painel de impacto FUNCIONAVA e mesmo assim a escolha foi
--    'aceitar' todas as vezes. 'ignorar' também nunca foi usado.
--
-- O QUE ESTA MIGRATION FAZ: `resolver_outlier` passa a aceitar somente 'aceitar' e para de
-- gravar `observacoes_excluidas`. Como a tabela NÃO TEM GRANT ALGUM para anon/authenticated/
-- service_role (conferido na prod), este SECURITY DEFINER era o ÚNICO caminho de escrita:
-- sem o INSERT, ela fica permanentemente vazia e sem writer. Isso é o ponto — gravar sob
-- semântica cosmética criaria ORDENS LATENTES que um filtro futuro aplicaria
-- RETROATIVAMENTE à compra. Um (A) futuro terá de introduzir semântica nova por migration
-- deliberada, em vez de herdar decisões velhas.
--
-- FORA DE ESCOPO, de propósito (spec §4.1): não dropa `observacoes_excluidas` (o anti-reflag
-- do detector a lê; NOT EXISTS sobre tabela vazia é inócuo), não toca
-- `detectar_outliers_empresa` (função quente, recém-aplicada pelo #1357), não dropa
-- `estimar_impacto_exclusao_outlier` (só COMMENT — migration e Publish do Lovable são
-- manuais e independentes; DROP com Publish atrasado quebraria o card em produção).
--
-- Base: pg_get_functiondef da PROD em 2026-07-16 (pós-#1357). Diferenças para o repo eram
-- só de comentário. Único delta funcional aqui: o gate de decisão e o INSERT.
-- Prova: db/test-exclusao-outlier-removida.sh (PG17, asserts + falsificação).
-- Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md

CREATE OR REPLACE FUNCTION public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL::text, p_usuario_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_evento RECORD;
BEGIN
  -- Gate de staff: byte-a-byte o da prod.
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- 'aceitar' é a única decisão. Rejeição EXPLÍCITA (não normalizar silenciosamente para
  -- 'aceitar'): na janela entre o apply e o Publish, a tela velha ainda mostra os botões
  -- antigos — ela tem de FALHAR FECHADA em vez de gravar sob semântica que não existe mais.
  -- ERRCODE explícito para o teste negativo capturar a condição certa e re-lançar o resto.
  IF p_decisao <> 'aceitar' THEN
    RAISE EXCEPTION 'Decisão inválida: %. Esta tela é de revisão: a observação permanece no cálculo — use aceitar.', p_decisao
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento outlier % não encontrado', p_evento_id;
  END IF;
  IF v_evento.status != 'pendente' THEN
    RAISE EXCEPTION 'Evento já resolvido com status: %', v_evento.status;
  END IF;

  UPDATE eventos_outlier
  SET status = 'aceito', decidido_em = now(),
      decidido_por = p_usuario_email, justificativa_decisao = p_justificativa
  WHERE id = p_evento_id;

  RETURN jsonb_build_object('evento_id', p_evento_id, 'novo_status', 'aceito', 'decisao', p_decisao);
END;
$function$;

COMMENT ON FUNCTION public.resolver_outlier(bigint, text, text, text) IS
  'Registra a revisão humana de um evento de outlier. ACEITAR é a única decisão: a '
  'observação permanece no cálculo. ''excluir'' e ''ignorar'' foram REMOVIDOS (2026-07-16). '
  '''excluir'' nunca alcançou o motor (observacoes_excluidas não entra na cadeia de '
  'estatística) e, medido em prod, não há efeito para ligar no leadtime (ss/pp invariantes); '
  'no lado da venda o efeito seria grande demais para um botão sem gate. ''ignorar'' '
  'arquivava igual a ''aceitar'' e nunca foi usado. '
  'Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md';

COMMENT ON TABLE public.observacoes_excluidas IS
  'SEM WRITER desde 2026-07-16 — permanece vazia. Lida apenas pelo anti-reflag de '
  'detectar_outliers_empresa, onde o NOT EXISTS sobre tabela vazia é inócuo. NÃO '
  'reintroduzir escrita sem migration deliberada: gravar aqui sob semântica cosmética cria '
  'ordens latentes que um filtro futuro aplicaria retroativamente à compra. '
  'Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md';

COMMENT ON FUNCTION public.estimar_impacto_exclusao_outlier(bigint) IS
  'DEPRECADA (2026-07-16) — sem chamador. Estimava o impacto de uma exclusão que nunca '
  'alcançou o motor. NÃO usar como fonte de número: (a) a fórmula diverge da do motor '
  '(z fixo 1.65 × z por classe; sigma por-venda × sigma diário; 180d × 90d), (b) '
  'COALESCE(sigma,0) fabrica zero quando o desvio é desconhecido (viola ausente != zero), '
  '(c) não trata sku_inativado_omie/sku_reativado_omie — cai no ramo de leadtime, não acha '
  'dedup_key e devolve error, que a tela exibia como "Calculando..." para sempre. '
  'DROP pendente de faxina após o Publish confirmado. '
  'Spec: docs/superpowers/specs/2026-07-16-reposicao-exclusao-outlier-escopo-design.md';
