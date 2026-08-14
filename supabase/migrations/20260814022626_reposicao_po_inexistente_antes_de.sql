-- Reposição — o guard temporal passa a ler um limite CAUSAL, não o instante do UPDATE (money-path)
-- ============================================================================
-- O QUE ESTA MIGRATION CORRIGE (P1 da revisão independente do #1718, `/codex challenge` gpt-5.6-sol):
-- o guard temporal entregue no #1718 é
--     AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em)
-- e `omie_registrado_em` é `new Date().toISOString()` do processo Deno da edge, capturado DEPOIS de a
-- resposta do Omie voltar. São dois defeitos empilhados: relógios diferentes (edge × banco) e — o grave —
-- o carimbo NÃO é o instante causal do fato que ele pretende representar.
--
-- CONTRAEXEMPLO COM RELÓGIOS PERFEITOS (o guard suprime um alerta VERDADEIRO):
--     11:59:59.900  ConsultarPedCompra responde: o PO existe
--     12:00:00.000  o comprador EXCLUI o PO no Omie
--     12:00:00.100  o run completo varre e NÃO encontra o PO
--     12:00:00.200  o banco fecha o run                    → M = finalizado_em
--     12:00:00.300  a edge grava                            → R = omie_registrado_em
--   PO legitimamente ausente, run que PRESENCIOU a ausência — e como R > M o guard SUPRIME. O card
--   existe pelo caso 281/286 (~R$3.060), cuja instrução é "não cancele, RECRIE": cancelar faz o motor
--   re-sugerir e a compra sai DUAS vezes. Suprimir esse alerta é money-path.
--
-- A EMENDA — trocar a pergunta que o guard faz.
--   `omie_registrado_em` responde "quando a edge terminou de gravar" e era usado como se respondesse
--   "quando o PO passou a existir". Nasce a coluna `omie_po_inexistente_antes_de`, cujo NOME é o
--   predicado: o PO comprovadamente NÃO existia antes deste instante. Ela é lida do relógio do BANCO
--   (`clock_timestamp()`, via `reposicao_marco_pre_omie()`) ANTES de `IncluirPedCompra` sair da edge, e
--   só é persistida se a chamada CONFIRMAR a criação. Logo `valor <= instante real de nascimento`, e a
--   supressão passa a ser uma dedução válida:
--       inexistente_antes_de > finalizado_em  ⇒  o PO não existia quando o run fechou  ⇒  o run não
--       testemunha nada sobre ele  ⇒  não é candidato.
--   Com o carimbo antigo a dedução era inválida (R é POSTERIOR ao nascimento, então R > M não implica
--   nascimento > M). Por isso a coluna nova SUBSTITUI a antiga no predicado, em vez de somar a ela.
--
-- ⚠️ A RECONCILIAÇÃO NÃO CARIMBA — e isso é desenho, não esquecimento. No caminho em que o Omie recusa
-- "já cadastrado" e `ConsultarPedCompra` confirma, o PO nasceu ANTES da chamada: um marco lido ali é
-- POSTERIOR ao nascimento e portanto um limite inferior INVÁLIDO — gravá-lo reintroduziria, naquele
-- caminho, exatamente o defeito que esta migration elimina. Sem marco ⇒ NULL ⇒ candidato (fail-closed).
--
-- O QUE NÃO MUDA (a forma do predicado é a mesma, de propósito):
--   • `IS NULL` segue candidato — sem limite causal não se prova impossibilidade (fail-closed).
--   • `<=` (não `<`) mantém candidato o PO cujo limite cai exatamente no fim do run: suprime-se o
--     impossível, nunca o duvidoso.
--   • A RPC segue LISTANDO e EVIDENCIANDO, sem decidir. `omie_registrado_em` continua existindo e sendo
--     escrito (a UI o usa na trilha de ações) — ele só deixa de ser insumo de DECISÃO.
--
-- PASSIVO (medido em prod 14/08 02:24Z, psql-ro): 94 pedidos elegíveis ao card, 90 já vistos no marcador
-- atual, 4 não vistos — e os 4 são exatamente os que o guard do #1718 suprime hoje (os POs de 13/08,
-- nascidos 1,8h a 9,6h depois do marcador). Eles NÃO recebem backfill: o único valor disponível seria o
-- próprio `omie_registrado_em`, que é limite inferior INVÁLIDO (posterior ao nascimento) — copiá-lo
-- carregaria para a coluna nova o viés que esta migration existe para eliminar. Ficam NULL ⇒ voltam ao
-- card por até um ciclo de run completo (intervalo médio medido: 22h) e saem sozinhos assim que o
-- próximo run enxergar os POs (que existem). Ruído transitório e honesto > supressão fabricada.
--
-- BOUND DE FINITUDE (money-path.md §2): nada impedia carimbo no FUTURO — e um carimbo em 2099 suprimiria
-- o pedido para sempre, porque `finalizado_em` nunca o alcança. Medido: 0 linhas no futuro em 395, ou
-- seja, é defesa preventiva. `CHECK (col <= now())` é IMPOSSÍVEL (o PG exige expressão IMMUTABLE em
-- CHECK, e now()/clock_timestamp() não são), então o fecho vira TRIGGER — que aproveita para fechar o
-- outro lado: o limite nunca REGRIDE (GREATEST), nem é apagado por um UPDATE que mande NULL.
--
-- ⚠️⚠️ POR QUE A FUNÇÃO É RECRIADA POR `regexp_replace` SOBRE A DEFINIÇÃO VIVA, E NÃO ESCRITA AQUI
-- (mesmo padrão da 20260720120000/FU4-G): há OUTRA migration em voo (`20260814000125`, frescor do
-- marcador) que faz DROP+CREATE desta mesma função para ACRESCENTAR 2 colunas ao RETURNS TABLE. Se eu
-- colasse aqui um corpo completo, "a última a rodar vence" apagaria o trabalho da outra — e como o
-- RETURNS TABLE dela difere, nem dá para eu reproduzi-lo às cegas. Trocando só a LINHA do predicado
-- sobre o corpo que estiver vivo, esta migration funciona ANTES ou DEPOIS dela.
--   ⚠️ O que ainda NÃO é resolvido por aqui: a 20260814000125 exige o guard ANTIGO na pré-condição E o
--   re-afirma na pós-condição. Se ela rodar DEPOIS desta, ela ABORTA ("corpo divergente") — falha alta e
--   visível, não silenciosa. A ordem e a incompatibilidade estão declaradas no PR.
--
-- Prova PG17: db/test-po-inexistente-antes-de.sh
-- NÃO editar esta migration depois de aplicada (snapshot é a fonte de DR).
-- ============================================================================
BEGIN;

-- ── PRÉ-CONDIÇÃO: o gate de authz atual precisa existir ANTES de mexermos na função ────────────
-- Sem isto, aplicar num banco onde o FU4-G ainda não passou deixaria uma RPC SECURITY DEFINER chamando
-- função inexistente: plpgsql é late-bound e a falha só apareceria ao EXECUTAR — com o card de compras
-- morto em silêncio.
DO $pre$
BEGIN
  IF to_regprocedure('private.cap_compras_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'po-inexistente-antes: private.cap_compras_ler(uuid) ausente — aplique o FU4-G (20260720120000) antes'
      USING ERRCODE = '42883';
  END IF;
  IF to_regprocedure('public.reposicao_pos_candidatos(text)') IS NULL THEN
    RAISE EXCEPTION 'po-inexistente-antes: reposicao_pos_candidatos(text) ausente — aplique a 20260721190000 e a 20260813195914 antes'
      USING ERRCODE = '42883';
  END IF;
END $pre$;

-- ── 1. A coluna ────────────────────────────────────────────────────────────────────────────────
-- NULLABLE de propósito: o passivo não tem valor, e o ramo `IS NULL` do guard o trata como "não sei" ⇒
-- candidato. Preencher com um palpite seria trocar ausência por número fabricado (money-path.md §2).
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS omie_po_inexistente_antes_de timestamptz;

COMMENT ON COLUMN public.pedido_compra_sugerido.omie_po_inexistente_antes_de IS
  'Limite CAUSAL: o pedido de compra no Omie comprovadamente NÃO existia antes deste instante. Lido do relógio do BANCO (clock_timestamp() via reposicao_marco_pre_omie()) ANTES de IncluirPedCompra sair da edge, e persistido só se a chamada CONFIRMAR a criação — logo é sempre <= o instante real de nascimento do PO. NÃO confundir com omie_registrado_em, que é o relógio da EDGE lido DEPOIS da resposta (posterior ao nascimento, e por isso inválido como limite inferior). Consumido pelo guard temporal de reposicao_pos_candidatos(text): valor > finalizado_em do marcador ⇒ o run terminou antes de o PO existir ⇒ o silêncio dele não é evidência de ausência. NULL = sem limite conhecido ⇒ segue candidato (fail-closed). Monotônico e nunca no futuro (trigger trg_po_inexistente_antes_de_guard). 1 writer: a edge disparar-pedidos-aprovados, no caminho de INCLUSÃO. A RECONCILIAÇÃO (Omie recusa "já cadastrado" e ConsultarPedCompra confirma) NÃO carimba: ali o PO nasceu ANTES da chamada, então o marco da consulta não é limite inferior válido.';

-- ── 2. O relógio do BANCO, exposto à edge ──────────────────────────────────────────────────────
-- A edge fala com o banco por PostgREST e não tem como pedir `clock_timestamp()` dentro do UPDATE. Esta
-- RPC existe só para que o marco venha do MESMO relógio que depois o compara com `finalizado_em` —
-- comparar dois relógios foi metade do defeito do #1718.
-- ⚠️ `clock_timestamp()`, NUNCA `now()`: `now()` é o instante do BEGIN e entre o BEGIN e a leitura pode
-- haver espera arbitrária (money-path.md §2, "o RELÓGIO DA TRANSAÇÃO mente"). E VOLATILE, não STABLE:
-- STABLE promete o mesmo valor dentro do statement e o planner pode reusar a primeira avaliação — o
-- marco viraria constante da transação, que é o próprio defeito que evitamos.
CREATE OR REPLACE FUNCTION public.reposicao_marco_pre_omie()
RETURNS timestamptz
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT clock_timestamp() $$;

COMMENT ON FUNCTION public.reposicao_marco_pre_omie() IS
  'Devolve clock_timestamp() do banco. Uso ÚNICO: a edge disparar-pedidos-aprovados lê este marco ANTES de chamar IncluirPedCompra e o persiste em pedido_compra_sugerido.omie_po_inexistente_antes_de se o Omie confirmar a criação — assim o limite causal e o finalizado_em do marcador saem do MESMO relógio. Não é relógio de uso geral: nada de prazo/TTL deve pendurar-se aqui.';

REVOKE ALL ON FUNCTION public.reposicao_marco_pre_omie() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_marco_pre_omie() TO service_role;

-- ── 3. O fecho dos dois lados (o CHECK que o Postgres não deixa escrever) ──────────────────────
CREATE OR REPLACE FUNCTION public.reposicao__po_inexistente_antes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- (a) NUNCA no futuro. Um carimbo adiantado suprimiria o pedido até `finalizado_em` alcançá-lo — em
  -- 2099, para sempre. Clampa para o agora (direção fail-closed: menor ⇒ mais alerta) e DEIXA RASTRO,
  -- em vez de abortar: derrubar este UPDATE perderia o `omie_pedido_compra_id` de um PO que já existe
  -- no Omie, estrago muito maior que um carimbo torto.
  IF NEW.omie_po_inexistente_antes_de > clock_timestamp() THEN
    RAISE WARNING 'pedido % : omie_po_inexistente_antes_de no futuro (%) — clampado para o agora',
      NEW.id, NEW.omie_po_inexistente_antes_de;
    NEW.omie_po_inexistente_antes_de := clock_timestamp();
  END IF;

  -- (b) NUNCA regride. O limite conquistado é uma prova; escrita posterior só pode SOMAR a ela.
  -- GREATEST ignora NULL, então um UPDATE que não carrega a coluna (ou a manda NULL) PRESERVA o valor
  -- em vez de apagá-lo — o que importa porque o UPDATE da reconciliação, por desenho, não a carimba.
  IF TG_OP = 'UPDATE' THEN
    NEW.omie_po_inexistente_antes_de :=
      GREATEST(OLD.omie_po_inexistente_antes_de, NEW.omie_po_inexistente_antes_de);
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.reposicao__po_inexistente_antes_guard() IS
  'Invariante de pedido_compra_sugerido.omie_po_inexistente_antes_de: nunca no futuro (clamp + WARNING) e nunca decrescente (GREATEST, que preserva o valor quando o UPDATE manda NULL). Mora na TABELA e não no writer porque a próxima via de escrita não vai reler o writer de hoje (money-path.md §2).';

DROP TRIGGER IF EXISTS trg_po_inexistente_antes_de_guard ON public.pedido_compra_sugerido;
CREATE TRIGGER trg_po_inexistente_antes_de_guard
  BEFORE INSERT OR UPDATE OF omie_po_inexistente_antes_de ON public.pedido_compra_sugerido
  FOR EACH ROW EXECUTE FUNCTION public.reposicao__po_inexistente_antes_guard();

-- ── 4. O guard do card passa a ler o limite CAUSAL ─────────────────────────────────────────────
-- Troca CIRÚRGICA sobre a definição VIVA (motivo no cabeçalho). Preserva por construção tudo que um
-- corpo colado poderia perder: SECURITY DEFINER, STABLE, `SET search_path`, o gate FU4-G e — se a
-- 20260814000125 já tiver rodado — as colunas de frescor no RETURNS TABLE.
DO $rpc$
DECLARE
  v_def    text := pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure);
  c_alvo   constant text := 'AND (p.omie_registrado_em IS NULL OR p.omie_registrado_em <= m.finalizado_em)';
  -- A linha nova leva junto o aviso, porque os comentários VIZINHOS (do #1718) descrevem o predicado
  -- ANTIGO e continuam no corpo — comentário órfão que contradiz o código engana o próximo leitor.
  c_troca  constant text :=
      '-- ⚠️ 14/08/2026: este predicado passou a ler o limite CAUSAL. Os comentários ACIMA que citam'
   || E'\n      -- omie_registrado_em descrevem a versão ANTERIOR (#1718) e ficaram para contexto.'
   || E'\n      -- Migration 20260814022626 · prova db/test-po-inexistente-antes-de.sh'
   || E'\n      AND (p.omie_po_inexistente_antes_de IS NULL OR p.omie_po_inexistente_antes_de <= m.finalizado_em)';
  v_ocorr  integer;
  v_limpa  text := regexp_replace(v_def, '--[^\n]*', '', 'g');
BEGIN
  v_ocorr := (length(v_def) - length(replace(v_def, c_alvo, ''))) / length(c_alvo);

  IF v_ocorr = 1 THEN
    EXECUTE replace(v_def, c_alvo, c_troca);

  -- IDEMPOTÊNCIA: re-colar o arquivo no SQL Editor tem de ser seguro. Sem guard antigo E com o causal
  -- já no lugar, não há o que trocar. Medido no corpo SEM COMENTÁRIOS — a linha nova traz junto um
  -- comentário que cita a coluna, e casá-lo confundiria "aplicado" com "documentado".
  ELSIF v_ocorr = 0 AND v_limpa ~ 'p\.omie_po_inexistente_antes_de\s+IS NULL' THEN
    RAISE NOTICE 'po-inexistente-antes: guard causal já estava aplicado — nada a trocar';

  -- 0 sem nenhum dos dois = o corpo vivo não é o que esperamos (outra migration reescreveu a função);
  -- >1 = replace cego mudaria mais que a linha do WHERE. Nos dois casos, PARE em vez de sobrescrever.
  ELSE
    RAISE EXCEPTION 'po-inexistente-antes: esperava 1 ocorrência do guard do #1718 na definição VIVA, achei % e o guard causal % está lá — NÃO sobrescrevo às cegas',
      v_ocorr, CASE WHEN v_limpa ~ 'p\.omie_po_inexistente_antes_de\s+IS NULL' THEN 'JÁ' ELSE 'NÃO' END
      USING ERRCODE = '22000';
  END IF;
END $rpc$;

COMMENT ON FUNCTION public.reposicao_pos_candidatos(text) IS
  'PR2 (NÃO-MUTANTE): pedidos disparado/aprovado cujo PO não apareceu no último run VÁLIDO. LISTA e EVIDENCIA — NÃO decide. GUARD TEMPORAL CAUSAL (14/08/2026): suprime o pedido cujo omie_po_inexistente_antes_de é POSTERIOR ao finalizado_em do marcador — ou seja, o PO comprovadamente ainda não existia quando o run fechou, e o silêncio desse run não é evidência de ausência. O limite vem do relógio do BANCO, lido ANTES de IncluirPedCompra e persistido só sob confirmação. A versão anterior (13/08) comparava com omie_registrado_em, que é o relógio da EDGE lido DEPOIS da resposta e portanto POSTERIOR ao nascimento do PO — com ele a supressão não era dedutível e podia apagar alerta verdadeiro (caso 281/286, ~R$3.060 comprados em dobro). Suprime só o IMPOSSÍVEL: limite NULL e limite dentro da janela de coleta seguem candidatos (fail-closed). Deliberadamente SEM rota automática: em prod 59/59 dos disparados acionaram portal do fornecedor, então "elegível a auto-cancelamento" é logicamente vazio; e canal/status/resposta são text/jsonb livres onde regex prova presença, nunca ausência. Todo candidato exige decisão humana (provável: RECRIAR o PO, não cancelar). Sem marcador válido retorna VAZIO (fail-closed).';

-- `CREATE OR REPLACE` preserva o ACL, mas repetir é barato e deixa a fronteira explícita no arquivo.
REVOKE ALL ON FUNCTION public.reposicao_pos_candidatos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reposicao_pos_candidatos(text) TO authenticated, service_role;

-- ── PÓS-CONDIÇÃO: o corpo final tem o gate certo e o guard CAUSAL — e não o antigo ─────────────
-- ⚠️ Medir sobre a definição SEM COMENTÁRIOS. O corpo CITA `omie_registrado_em` de propósito (para
-- explicar por que ele saiu), e uma sentinela crua acusaria a própria prosa — foi assim que a 1ª versão
-- da pós-condição do #1718 passou verde com o gate REGREDIDO (os comentários citavam o nome do gate
-- novo). Casar a FORMA DO PREDICADO, nunca a menção.
DO $pos$
DECLARE
  v_def  text := regexp_replace(
                   pg_get_functiondef('public.reposicao_pos_candidatos(text)'::regprocedure),
                   '--[^\n]*', '', 'g');
  c_novo    constant text := 'private\.cap_compras_ler\s*\(\s*\(\s*SELECT';
  c_velho   constant text := 'pode_ver_carteira_completa\s*\(\s*\(\s*SELECT';
  c_guard   constant text := 'p\.omie_po_inexistente_antes_de\s+IS NULL\s+OR\s+p\.omie_po_inexistente_antes_de\s*<=\s*m\.finalizado_em';
  c_antigo  constant text := 'p\.omie_registrado_em\s*<=\s*m\.finalizado_em';
BEGIN
  IF v_def !~ c_novo THEN
    RAISE EXCEPTION 'po-inexistente-antes: gate de authz REGREDIU — sem CHAMADA a private.cap_compras_ler' USING ERRCODE = '42501';
  END IF;
  IF v_def ~ c_velho THEN
    RAISE EXCEPTION 'po-inexistente-antes: gate ANTIGO (pode_ver_carteira_completa) ainda é CHAMADO — FU4-G regrediu' USING ERRCODE = '42501';
  END IF;
  IF v_def !~ c_guard THEN
    RAISE EXCEPTION 'po-inexistente-antes: o guard CAUSAL NAO entrou na definição final' USING ERRCODE = '22000';
  END IF;
  IF v_def ~ c_antigo THEN
    RAISE EXCEPTION 'po-inexistente-antes: o guard ainda COMPARA omie_registrado_em — a troca nao aconteceu' USING ERRCODE = '22000';
  END IF;
  IF to_regprocedure('public.reposicao_marco_pre_omie()') IS NULL THEN
    RAISE EXCEPTION 'po-inexistente-antes: reposicao_marco_pre_omie() ausente — a edge nao teria de onde ler o marco' USING ERRCODE = '42883';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.pedido_compra_sugerido'::regclass
      AND tgname = 'trg_po_inexistente_antes_de_guard'
  ) THEN
    RAISE EXCEPTION 'po-inexistente-antes: trigger de monotonicidade ausente — o limite poderia regredir ou nascer no futuro' USING ERRCODE = '22000';
  END IF;
END $pos$;

COMMIT;
