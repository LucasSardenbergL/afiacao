-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — FASE 5: soft-deactivation da geração SAYERLACK ('1')
-- (plano docs/superpowers/plans/2026-07-17-tint-receita-perdida-remediacao.md)
--
-- ⚠️ SÃO DUAS TRANSAÇÕES SEPARADAS, E A ORDEM IMPORTA. Ver o roteiro de apply
-- no fim do cabeçalho — NÃO cole o arquivo inteiro de uma vez sem ler.
--
-- O QUE FECHA: desde 2026-06 o catálogo tem DUAS gerações ativas para quase
-- toda chave — `subcolecao_id` está na unique key `uq_tint_formulas_chave`,
-- então quando o sync passou a mandar 'SL' onde o import de março mandava '1',
-- virou INSERT em vez de UPDATE e o catálogo DUPLICOU. A Fase 2 resolveu a
-- AMBIGUIDADE por SELEÇÃO (v_tint_formula_canonica); esta fase é o passo
-- destrutivo-REVERSÍVEL: tirar o dado antigo do catálogo vendável.
--
-- Precisão > recall: soft-deactivation (`desativada_em`), NUNCA DELETE.
--
-- ───────────────────────────────────────────────────────────────────────────
-- BASELINE psql-ro 2026-07-21 (re-medido nesta sessão — as medições do plano,
-- de 17/07 e 20/07, estavam STALE; o catálogo se move DIARIAMENTE):
--   geração '1' ativas ................................... 464.007
--   ALVO (chave com gêmea SL de receita VÁLIDA) .......... 463.995
--   PRESERVAR (sem gêmea SL válida) ......................      12
--   chaves: ambas 463.995 · só SL 31.062 · só '1' 12 · person. 907
--   linhas ativas por chave: 2 em 463.995 · 1 em 31.981
--     (31.062 + 12 + 907 = 31.981 ✓ — `sku_id` já discrimina EMBALAGEM, então
--      a chave da view NÃO colapsa embalagens)
--   geração 'SL' com preco_final_sayersystem .............. 0 de 495.057
--
-- ⚠️ AS 12 SÃO PRESERVADAS POR CONSTRUÇÃO, NÃO POR LISTA — são as 4 cores
-- exclusivas ACR MAX (DOURADO 035Y/082P, EMPERADORE 128L, PEROLIZADO
-- 23.2429.CK.JO20) × 3 embalagens. O alvo exige `EXISTS (gêmea SL válida)`,
-- então elas ficam de fora sozinhas. Lista hardcoded envelheceria.
--
-- ───────────────────────────────────────────────────────────────────────────
-- PROVENIÊNCIA (`desativada_motivo`) — por que a coluna existe
--
-- Decisão do founder (2026-07-20, opção B): o CSV SOBREVIVE à desativação —
-- sem isso o `preco_csv_legado` vira NULL em ~464k chaves e o rótulo "Tabela
-- (versão anterior)" some do balcão inteiro.
--
-- ⚠️ MAS relaxar `desativada_em IS NULL` de forma AMPLA **não é no-op hoje**
-- (medido 2026-07-21, achado NOVO — a decisão de 20/07 foi tomada sem este
-- dado): existem **16.958 linhas da geração '1' desativadas, 100% com CSV**,
-- que o `tint_apply_keys_snapshot` desativou porque **a FONTE retirou a
-- chave**. Destas, **1.704 têm SL ativa** e hoje têm `preco_csv_legado = NULL`
-- CORRETAMENTE. Relaxar amplo lhes daria rótulo "versão anterior" indevido e
-- derrubaria o PISO do gate nelas. ⇒ a Fase 5 CARIMBA o que ELA desativa e o
-- relaxamento lê SÓ esse carimbo (decisão do founder 2026-07-21).
--
-- ───────────────────────────────────────────────────────────────────────────
-- ⚠️ CHALLENGE CODEX xhigh (2026-07-22) REPROVOU a v1 — 1 P0 + 7 P1 + 2 P2.
-- O que mudou nesta v2 (parecer cru em docs/historico/, resumo no PR):
--
--  [P0]  A v1 punha ALTER + UPDATE + REPLACE soltos, contando com a transação
--        implícita. Se o executor dividir os statements em autocommit, o UPDATE
--        de 463.995 linhas COMMITA e o `RAISE` do guard não reverte nada — e
--        ainda abre janela com a view antiga (rótulo sumindo de 464k chaves).
--        ⇒ BEGIN/COMMIT EXPLÍCITO em torno de target+UPDATE+guards+view.
--  [P1-8] `ALTER TABLE ADD COLUMN` segura ACCESS EXCLUSIVE até o commit; junto
--        do UPDATE de 464k isso bloquearia até LEITURAS o update inteiro.
--        ⇒ o DDL foi para uma transação curta PRÓPRIA (bloco 1), aplicada
--        ANTES. `NOT VALID` + `VALIDATE` separa o full scan do lock forte.
--  [P1-3] Carimbo sem CHECK deixa reativador incompleto (o promote seta só
--        `desativada_em=NULL`) preservar motivo órfão. ⇒ CHECK barra o estado
--        impossível; a limpeza no promote fica registrada como 5b.
--  [P1-6] O guard da v1 provava só "nenhuma chave zerou". ⇒ agora materializa
--        `_targets` e prova: conjunto atualizado == alvo · todo target inativo
--        E carimbado · toda chave de target tem a gêmea SL ativa e válida · a
--        canônica pós-update É essa gêmea · o complemento seguiu ativo.
--  [P2-10 + Q1] As 3 cópias do predicado tornavam I1 "convenção textual".
--        ⇒ o CSV é calculado UMA VEZ num LATERAL e o piso vira
--        `GREATEST(csv, COALESCE(max_ativo, csv))` — expressão sugerida pelo
--        Codex: I1 e I2 passam a ser verdadeiros POR CONSTRUÇÃO, e o max do
--        piso NÃO passa a ler toda linha carimbada (mais conservador que a v1).
--  [P2-9] Pré-flight de 1 coluna prova pouco. ⇒ confere as 14 colunas por
--        ordinal+nome, `security_invoker=on` e que o gate consome a 14ª.
--
-- Calibrado para FORA desta entrega (registrado, com racional, no PR):
--  [P1-5] serialização com writers → tratada OPERACIONALMENTE: o founder pausa
--         o cron do sync durante o apply (roteiro abaixo). Advisory locks de
--         todos os pares (account,store) numa migration manual é mais frágil
--         que o passo humano reversível.
--  [P1-7] watchdog "tombstone Fase 5 sem SL ativa válida" → Fase 5b. A query
--         de monitoramento vai no handoff e eu a rodo no pós-apply.
--  [P1-2] motivo obsoleto se a fonte retirar a chave DEPOIS → 5b (a correção
--         toca o snapshot, outro writer vivo).
--  [P1-4] `import_tint_formulas` (SECURITY DEFINER, EXECUTE p/ authenticated,
--         ÓRFÃ no código — confirmado por grep e por psql-ro) pode mutar
--         `preco_final_sayersystem` do tombstone. PRÉ-EXISTENTE: hoje a coluna
--         13 já lê essa mesma linha. A Fase 5 não cria o furo, mas piora a
--         garantia (dado vivo vira tombstone sem imutabilidade). Aposentar a
--         RPC é decisão money-path própria → 5b.
--
-- ───────────────────────────────────────────────────────────────────────────
-- ROTEIRO DE APPLY (SQL Editor do Lovable — o founder cola)
--   0. PAUSAR o cron do sync tintométrico (evita o promote reativar linha
--      entre a materialização do alvo e os guards — P1-5 do Codex).
--   1. Rodar o BLOCO 1 sozinho (DDL curto). Espera o OK.
--   2. Rodar o BLOCO 2 (BEGIN…COMMIT). Se qualquer guard falhar, ele mesmo faz
--      ROLLBACK e NADA muda — reporte o erro em vez de tentar de novo.
--   3. Reativar o cron.
--   4. Eu rodo a validação pós-apply via psql-ro (query no handoff do PR).
--
-- ORDEM ENTRE MIGRATIONS: esta é a 6ª da cadeia da view e roda POR CIMA do
-- #1535 (`20260726160000_tint_canonica_piso_legado.sql`, 14 colunas), que
-- MERGEOU em 2026-07-22T02:06Z. O pré-flight do bloco 2 ABORTA se o #1535 não
-- estiver aplicado — "a última a recriar vence", e rodar fora de ordem faria o
-- REPLACE dele apagar este relaxamento em SILÊNCIO.
--
-- REPLACE: 14 colunas na ordem PRESERVADA, nada acrescentado, e
-- `WITH (security_invoker = on)` REPETIDO — omitir RESETA a opção e a view
-- passa a ler como OWNER, bypassando RLS (falha ABERTA que o CI não vê, #1375).
--
-- Prova: db/test-tint-fase5-desativacao.sh (PG17, migration REAL, falsificação)
-- ═══════════════════════════════════════════════════════════════════════════


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ BLOCO 1 — DDL curto. Rode SOZINHO e espere o OK.                        ║
-- ║ Separado do bloco 2 de propósito: ADD COLUMN segura ACCESS EXCLUSIVE,   ║
-- ║ e no mesmo envelope do UPDATE de 464k linhas bloquearia até leituras.   ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
BEGIN;

ALTER TABLE public.tint_formulas
  ADD COLUMN IF NOT EXISTS desativada_motivo text;

COMMENT ON COLUMN public.tint_formulas.desativada_motivo IS
  'Proveniência da desativação. NULL = ativa, ou desativada por outro '
  'mecanismo (hoje o tint_apply_keys_snapshot, quando a chave sai da FONTE). '
  '''fase5_geracao_legada'' = desativada pela Fase 5 por ter gêmea SL válida — '
  'é o ÚNICO valor que a v_tint_formula_canonica aceita para deixar o CSV '
  'legado sobreviver à desativação. Carimbo NOVO exige revisão money-path: '
  'ampliar o conjunto ressuscita preço de linha que a fonte aposentou.';

-- Estado impossível: motivo sem desativação. Barra o reativador INCOMPLETO —
-- o `ON CONFLICT` do tint_promote_sync_run seta `desativada_em = NULL` e não
-- conhece esta coluna, então sem o CHECK ele deixaria motivo órfão numa linha
-- viva, e a desativação SEGUINTE (pela fonte) seria lida como Fase 5 (P1-3 do
-- Codex). Com o CHECK, esse caminho FALHA em vez de corromper em silêncio.
-- ⚠️ Isto faz o promote quebrar se ele reativar uma linha carimbada — é
-- DELIBERADO e fail-closed: melhor o sync acusar do que o piso do gate cair.
-- Limpar o motivo no promote é a Fase 5b.
-- NOT VALID + VALIDATE: separa o full scan (SHARE UPDATE EXCLUSIVE) do lock
-- forte do ADD CONSTRAINT.
ALTER TABLE public.tint_formulas
  DROP CONSTRAINT IF EXISTS tint_formulas_motivo_exige_desativacao;
ALTER TABLE public.tint_formulas
  ADD CONSTRAINT tint_formulas_motivo_exige_desativacao
  CHECK (desativada_em IS NOT NULL OR desativada_motivo IS NULL) NOT VALID;

COMMIT;

ALTER TABLE public.tint_formulas
  VALIDATE CONSTRAINT tint_formulas_motivo_exige_desativacao;


-- ╔═════════════════════════════════════════════════════════════════════════╗
-- ║ BLOCO 2 — dados + view, ATÔMICO. Rode depois do BLOCO 1.                ║
-- ║ BEGIN/COMMIT explícito (P0 do Codex): sem ele, um executor em           ║
-- ║ autocommit commitaria o UPDATE antes do guard e o RAISE não reverteria  ║
-- ║ nada — além de abrir janela com a view antiga.                          ║
-- ╚═════════════════════════════════════════════════════════════════════════╝
BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '30min';

DO $fase5$
DECLARE
  v_cols          text;
  v_invoker       boolean;
  v_gate_le_piso  boolean;
  v_n_alvo        bigint;
  v_n_upd         bigint;
  v_n_preservadas bigint;
  v_ruim          bigint;
  v_cob_antes     bigint;
  v_cob_depois    bigint;
BEGIN
  -- ── PRÉ-FLIGHT DE ORDEM (P2-9: uma coluna prova pouco) ──────────────────
  SELECT string_agg(column_name, ',' ORDER BY ordinal_position)
    INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'v_tint_formula_canonica';

  IF v_cols IS DISTINCT FROM
     'id,account,sku_id,cor_id,nome_cor,preco_final_sayersystem,subcolecao_id,'
     'personalizada,updated_at,is_sl,tem_receita,receita_valida,'
     'preco_csv_legado,preco_piso_legado'
  THEN
    RAISE EXCEPTION
      'FASE 5 ABORTADA — ORDEM/SHAPE ERRADO: a v_tint_formula_canonica não está '
      'na versão do #1535 (14 colunas na ordem esperada). Veio: [%]. Aplique o '
      '20260726160000_tint_canonica_piso_legado.sql PRIMEIRO — rodar fora de '
      'ordem faz o REPLACE dele apagar o relaxamento da Fase 5 em silêncio.',
      COALESCE(v_cols, '(view ausente)');
  END IF;

  SELECT 'security_invoker=on' = ANY(COALESCE(reloptions, '{}'))
    INTO v_invoker
    FROM pg_class WHERE relname = 'v_tint_formula_canonica'
      AND relnamespace = 'public'::regnamespace;
  IF NOT COALESCE(v_invoker, false) THEN
    RAISE EXCEPTION
      'FASE 5 ABORTADA: a view está SEM security_invoker=on — ela leria como '
      'OWNER e bypassaria RLS (#1375). Corrija antes de seguir.';
  END IF;

  -- O gate do submit já tem de consumir a 14ª coluna (senão o #1535 está pela
  -- metade e o piso desta fase não chega a lugar nenhum).
  SELECT position('preco_piso_legado' in
           regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g')) > 0
    INTO v_gate_le_piso
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tint_gate_revalida';
  IF NOT COALESCE(v_gate_le_piso, false) THEN
    RAISE EXCEPTION
      'FASE 5 ABORTADA: tint_gate_revalida não consome preco_piso_legado — o '
      '#1535 não está completo em produção.';
  END IF;

  -- ── ALVO materializado (P1-6: o guard tem de saber QUEM devia mudar) ────
  -- "Gêmea SL válida" espelha `receita_valida` da canônica / `corantes_
  -- completos` da RPC: desativar contra uma gêmea que o motor de preço
  -- rejeitaria deixaria a chave sem preço vendável.
  -- ⚠️ Nada de `min(g.id)` aqui: `id` é uuid e o PostgreSQL NÃO tem agregado
  -- min() para uuid — o DO block compila e só explode ao EXECUTAR (late-bound).
  -- Pego pelo PG17 na 1ª rodada de db/test-tint-fase5-desativacao.sh; em prod
  -- teria estourado no meio do BLOCO 2, com o BLOCO 1 já commitado.
  -- E a correção certa não é castar para text: eleger "a SL de menor id" seria
  -- reimplementar o desempate da view (que é por RANK, não por id) e divergiria
  -- dela em chave com 2 linhas SL. Os guards abaixo passam a falar de
  -- PROPRIEDADE ("existe SL ativa e válida" / "a canônica É SL válida"), que é
  -- o invariante real e não depende de eleger linha nenhuma.
  CREATE TEMP TABLE _fase5_targets ON COMMIT DROP AS
  WITH sl_valida AS (
    SELECT DISTINCT g.account, g.sku_id, g.cor_id
      FROM public.tint_formulas g
      JOIN public.tint_subcolecoes s
        ON s.id = g.subcolecao_id AND s.account = g.account
       AND s.id_subcolecao_sayersystem = 'SL'
     WHERE g.desativada_em IS NULL
       AND g.sku_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.tint_formula_itens fi
                    WHERE fi.formula_id = g.id)
       AND NOT EXISTS (
             SELECT 1 FROM public.tint_formula_itens fi
             LEFT JOIN public.tint_corantes c   ON c.id = fi.corante_id
             LEFT JOIN public.omie_products op  ON op.id = c.omie_product_id
              WHERE fi.formula_id = g.id
                AND NOT (COALESCE(op.valor_unitario, 0) > 0
                         AND COALESCE(op.ativo, false)
                         AND c.volume_total_ml IS NOT NULL
                         AND c.volume_total_ml > 0))
     GROUP BY g.account, g.sku_id, g.cor_id
  )
  SELECT f.id, f.account, f.sku_id, f.cor_id
    FROM public.tint_formulas f
    JOIN public.tint_subcolecoes s1
      ON s1.id = f.subcolecao_id AND s1.account = f.account
     AND s1.id_subcolecao_sayersystem = '1'
    JOIN sl_valida v
      ON v.account = f.account AND v.sku_id = f.sku_id AND v.cor_id = f.cor_id
   WHERE f.desativada_em IS NULL
     AND f.sku_id IS NOT NULL;

  SELECT count(*) INTO v_n_alvo FROM _fase5_targets;
  IF v_n_alvo = 0 THEN
    RAISE EXCEPTION 'FASE 5 ABORTADA: alvo VAZIO — ou já foi aplicada, ou o '
      'catálogo mudou de forma inesperada. Investigue antes de reaplicar.';
  END IF;

  -- Cobertura ANTES: nº de chaves (account,sku_id,cor_id) com >=1 linha ATIVA.
  -- Barato (1 count) e é a rede MAIS AMPLA: o G2 prova a propriedade nos
  -- targets, mas só esta contagem pega uma chave que suma por um caminho que
  -- eu não previ. Reconstruível depois do apply? NÃO — a linha desativada muda
  -- de lado —, por isso tem de ser medida aqui dentro.
  SELECT count(*) INTO v_cob_antes FROM (
    SELECT DISTINCT f.account, f.sku_id, f.cor_id
      FROM public.tint_formulas f
     WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL) t;

  -- ── A DESATIVAÇÃO, restrita ao alvo materializado ──────────────────────
  UPDATE public.tint_formulas f
     SET desativada_em     = now(),
         desativada_motivo = 'fase5_geracao_legada',
         updated_at        = now()
    FROM _fase5_targets t
   WHERE t.id = f.id;
  GET DIAGNOSTICS v_n_upd = ROW_COUNT;

  IF v_n_upd <> v_n_alvo THEN
    RAISE EXCEPTION 'FASE 5 ABORTADA: atualizou % linha(s), alvo era % — '
      'writer concorrente mexeu no catálogo durante a operação. Pause o cron '
      'do sync e refaça.', v_n_upd, v_n_alvo;
  END IF;

  -- ── GUARDS PÓS-CONDIÇÃO (P1-6) ─────────────────────────────────────────
  -- G1: todo target ficou inativo E carimbado.
  SELECT count(*) INTO v_ruim
    FROM _fase5_targets t JOIN public.tint_formulas f ON f.id = t.id
   WHERE f.desativada_em IS NULL
      OR f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';
  IF v_ruim > 0 THEN
    RAISE EXCEPTION 'FASE 5 ABORTADA: % target(s) sem desativação/carimbo.', v_ruim;
  END IF;

  -- G2: toda chave de target continua com uma gêmea SL ATIVA E VÁLIDA. O guard
  -- da v1 aceitava "sobrevivente qualquer" (podia ser uma personalizada, ou uma
  -- SL que o motor de preço rejeitaria) — aqui a propriedade exigida é a MESMA
  -- que justificou a desativação, re-verificada DEPOIS do UPDATE.
  SELECT count(*) INTO v_ruim
    FROM _fase5_targets t
   WHERE NOT EXISTS (
     SELECT 1 FROM public.tint_formulas g
      JOIN public.tint_subcolecoes s
        ON s.id = g.subcolecao_id AND s.account = g.account
       AND s.id_subcolecao_sayersystem = 'SL'
      WHERE g.account = t.account AND g.sku_id = t.sku_id AND g.cor_id = t.cor_id
        AND g.desativada_em IS NULL
        AND EXISTS (SELECT 1 FROM public.tint_formula_itens fi
                     WHERE fi.formula_id = g.id)
        AND NOT EXISTS (
              SELECT 1 FROM public.tint_formula_itens fi
              LEFT JOIN public.tint_corantes c   ON c.id = fi.corante_id
              LEFT JOIN public.omie_products op  ON op.id = c.omie_product_id
               WHERE fi.formula_id = g.id
                 AND NOT (COALESCE(op.valor_unitario, 0) > 0
                          AND COALESCE(op.ativo, false)
                          AND c.volume_total_ml IS NOT NULL
                          AND c.volume_total_ml > 0)));
  IF v_ruim > 0 THEN
    RAISE EXCEPTION 'FASE 5 ABORTADA: % chave(s) ficaram sem gêmea SL ativa e '
      'válida — a propriedade que justificou a desativação não vale mais.', v_ruim;
  END IF;

  -- G3: a canônica de cada chave de target É uma linha SL de receita VÁLIDA.
  -- Prova o efeito de PRODUTO (o balcão passa a servir a SL), não só a
  -- integridade referencial.
  -- ⚠️ Formulado como PROPRIEDADE, não como "é o id X": eleger a SL esperada
  -- exigiria reimplementar o desempate da view (por RANK, e id só no empate) —
  -- um guard que diverge da view que ele fiscaliza é pior que nenhum guard.
  SELECT count(*) INTO v_ruim
    FROM _fase5_targets t
   WHERE NOT EXISTS (SELECT 1 FROM public.v_tint_formula_canonica c
                      WHERE c.account = t.account AND c.sku_id = t.sku_id
                        AND c.cor_id = t.cor_id
                        AND c.is_sl AND c.receita_valida);
  IF v_ruim > 0 THEN
    RAISE EXCEPTION 'FASE 5 ABORTADA: em % chave(s) a canônica pós-update não '
      'é uma SL de receita válida — o balcão ficaria sem a fórmula certa.', v_ruim;
  END IF;

  -- G4: o COMPLEMENTO preservado (as "12") continua ATIVO e SEM carimbo.
  SELECT count(*) INTO v_n_preservadas
    FROM public.tint_formulas f
    JOIN public.tint_subcolecoes s1
      ON s1.id = f.subcolecao_id AND s1.account = f.account
     AND s1.id_subcolecao_sayersystem = '1'
   WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL;
  SELECT count(*) INTO v_ruim
    FROM public.tint_formulas f
    JOIN public.tint_subcolecoes s1
      ON s1.id = f.subcolecao_id AND s1.account = f.account
     AND s1.id_subcolecao_sayersystem = '1'
   WHERE f.desativada_em IS NULL AND f.desativada_motivo IS NOT NULL;
  IF v_ruim > 0 THEN
    RAISE EXCEPTION 'FASE 5 ABORTADA: % linha(s) ATIVAS ficaram carimbadas.', v_ruim;
  END IF;

  -- G5: COBERTURA GLOBAL — nenhuma chave pode ter perdido TODA fórmula ativa.
  -- Rede mais ampla que G2/G3 (que só olham os targets): pega qualquer caminho
  -- não previsto. Por construção o UPDATE só toca linha com gêmea SL válida, e
  -- as gêmeas compartilham a chave — então o número tem de bater EXATAMENTE.
  SELECT count(*) INTO v_cob_depois FROM (
    SELECT DISTINCT f.account, f.sku_id, f.cor_id
      FROM public.tint_formulas f
     WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL) t;
  IF v_cob_depois <> v_cob_antes THEN
    RAISE EXCEPTION
      'FASE 5 ABORTADA: chaves com fórmula ativa mudaram de % para % — alguma '
      'combinação vendável sumiria do balcão. Nada foi aplicado.',
      v_cob_antes, v_cob_depois;
  END IF;

  -- G6: as chaves SEM gêmea SL válida (as "12" de prod) seguem com a '1' ATIVA.
  -- Complemento direto do alvo: o G2 prova que quem foi desativado tinha
  -- respaldo; este prova que quem NÃO tinha respaldo não foi tocado.
  IF v_n_preservadas = 0 THEN
    RAISE EXCEPTION
      'FASE 5 ABORTADA: ZERO linhas da geração ''1'' sobraram ativas. O '
      'baseline de 2026-07-21 tinha 12 (as 4 cores exclusivas ACR MAX x 3 '
      'embalagens). Se o catálogo mudou a ponto de zerar, isso é achado novo — '
      'investigue ANTES de reaplicar.';
  END IF;

  RAISE NOTICE 'Fase 5: desativadas % | geração ''1'' preservada (sem gêmea SL '
               'válida): % | esperado ~463.995 e ~12 no baseline de 2026-07-21',
               v_n_upd, v_n_preservadas;
END
$fase5$;

-- ───────────────────────────────────────────────────────────────────────────
-- A VIEW — o CSV legado sobrevive À DESATIVAÇÃO DESTA FASE.
-- 14 colunas, ordem preservada, security_invoker repetido.
--
-- ⚠️ Estrutura NOVA (P2-10 + Q1 do Codex): o CSV é calculado UMA VEZ no LATERAL
-- `lg` e reusado nas colunas 13 e 14. Na v1 o mesmo predicado aparecia TRÊS
-- vezes e I1 dependia de as três ficarem sincronizadas — "uma convenção
-- textual". Agora:
--     preco_piso_legado = GREATEST(csv, COALESCE(max_ativo, csv))
-- ⇒ I1 ((csv NULL) ⟺ (piso NULL)) e I2 (piso >= csv) são verdadeiros POR
--   CONSTRUÇÃO, não por manutenção cuidadosa.
-- ⇒ e `max_ativo` segue lendo SÓ linhas ATIVAS: o piso NÃO passa a varrer toda
--   linha carimbada — mais conservador que a v1, que relaxava o max inteiro.
-- Antes da Fase 5 isto é IDÊNTICO ao #1535 (o CSV pertence ao conjunto ativo,
-- então GREATEST devolve max_ativo); depois, injeta exatamente o preço que
-- migrou para o tombstone.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_tint_formula_canonica
WITH (security_invoker = on)
AS
SELECT
  f.id,
  f.account,
  f.sku_id,
  f.cor_id,
  f.nome_cor,
  f.preco_final_sayersystem,
  f.subcolecao_id,
  f.personalizada,
  f.updated_at,
  rf.is_sl,
  rf.tem_receita,
  rf.receita_valida,
  -- 13ª — RÓTULO ("Tabela (versão anterior)"): allowlist da geração '1'
  -- (20260724130000, semântica preservada) + [FASE 5] a linha CARIMBADA por
  -- esta fase segue contando mesmo desativada. Linha desativada por OUTRO
  -- motivo (a fonte retirou a chave — 16.958 hoje, 1.704 em chave com SL
  -- ativa) continua FORA.
  lg.csv_legado AS preco_csv_legado,
  -- 14ª — PISO do gate de submit: conservadorismo, NÃO proveniência.
  CASE
    WHEN lg.csv_legado IS NULL THEN NULL
    ELSE GREATEST(lg.csv_legado, COALESCE(lg.max_ativo, lg.csv_legado))
  END AS preco_piso_legado
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  -- rank de preferência da PRÓPRIA linha (bloco gêmeo do rank da gêmea, abaixo)
  SELECT v.is_sl,
         v.tem_receita,
         (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (
    SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s
              WHERE s.id = f.subcolecao_id
                AND s.account = f.account
                AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi
              WHERE fi.formula_id = f.id) AS tem_receita,
      -- [MIRROR get_tint_prices.corantes_completos] todo item precisa de corante
      -- com omie valor>0 + ativo + volume>0; item órfão de corante conta como ruim.
      NOT EXISTS (
        SELECT 1
        FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
        LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
        WHERE fi.formula_id = f.id
          AND NOT (COALESCE(op.valor_unitario, 0) > 0
                   AND COALESCE(op.ativo, false)
                   AND c.volume_total_ml IS NOT NULL
                   AND c.volume_total_ml > 0)
      ) AS corantes_ok
  ) v
) rf
CROSS JOIN LATERAL (
  -- CSV legado (uma única vez) + max das ATIVAS. Depende de rf.is_sl, por isso
  -- vem depois do LATERAL rf.
  SELECT
    (SELECT max(g2.preco_final_sayersystem)
       FROM public.tint_formulas g2
      WHERE g2.account = f.account
        AND g2.sku_id  = f.sku_id
        AND g2.cor_id  = f.cor_id
        AND (g2.desativada_em IS NULL
             OR g2.desativada_motivo = 'fase5_geracao_legada')
        AND (NOT rf.is_sl
             OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                        WHERE s2.id = g2.subcolecao_id
                          AND s2.account = g2.account
                          AND s2.id_subcolecao_sayersystem = '1'))) AS csv_legado,
    (SELECT max(g3.preco_final_sayersystem)
       FROM public.tint_formulas g3
      WHERE g3.account = f.account
        AND g3.sku_id  = f.sku_id
        AND g3.cor_id  = f.cor_id
        AND g3.desativada_em IS NULL) AS max_ativo
) lg
-- NÃO relaxa: só linha ATIVA é candidata a canônica. Relaxar aqui ressuscitaria
-- no catálogo exatamente o que esta fase tira dele.
WHERE f.desativada_em IS NULL
  AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    -- existe gêmea MELHOR na mesma chave? (rank menor; empate → menor id vence)
    SELECT 1
    FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      -- rank de preferência da GÊMEA — bloco gêmeo verbatim do rank acima
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (
        SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s
                  WHERE s.id = g.subcolecao_id
                    AND s.account = g.account
                    AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi
                  WHERE fi.formula_id = g.id) AS tem_receita,
          NOT EXISTS (
            SELECT 1
            FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
            LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
            WHERE fi.formula_id = g.id
              AND NOT (COALESCE(op.valor_unitario, 0) > 0
                       AND COALESCE(op.ativo, false)
                       AND c.volume_total_ml IS NOT NULL
                       AND c.volume_total_ml > 0)
          ) AS corantes_ok
      ) w
    ) rg
    WHERE g.account = f.account
      AND g.sku_id  = f.sku_id
      AND g.cor_id  = f.cor_id
      -- NÃO relaxa, mesmo motivo do filtro de candidata acima
      AND g.desativada_em IS NULL
      AND g.id <> f.id
      AND (rg.rank_pref < rf.rank_pref
           OR (rg.rank_pref = rf.rank_pref AND g.id < f.id))
  );

COMMENT ON VIEW public.v_tint_formula_canonica IS
  'Fase 2 tintométrico: 1 fórmula canônica por (account, sku_id, cor_id) — '
  'preferência SL válida, fallback SAYERLACK/personalizada; não desativa nada. '
  'receita_valida espelha corantes_completos da RPC get_tint_prices (validade '
  'POR FÓRMULA; base_disponivel fica fora — gêmeas compartilham o SKU). '
  'preco_csv_legado = RÓTULO "Tabela (versão anterior)" (allowlist da geração '
  '''1'' quando a canônica é SL — precisão de PROVENIÊNCIA). '
  'preco_piso_legado = PISO do gate de submit (CONSERVADORISMO) = '
  'GREATEST(csv, COALESCE(max das ATIVAS, csv)) — I1 ((csv NULL) ⟺ (piso '
  'NULL)) e I2 (piso >= csv) por CONSTRUÇÃO, não por convenção textual. '
  'FASE 5 (2026-07-27): o CSV aceita também a linha DESATIVADA carimbada '
  'desativada_motivo=''fase5_geracao_legada'' — sobrevive à desativação da '
  'geração ''1'' (decisão do founder, opção B); linha desativada por OUTRO '
  'motivo (fonte retirou a chave) segue FORA, senão o rótulo afirmaria '
  'proveniência de dado aposentado e o piso cairia junto. O max do PISO lê só '
  'ATIVAS. O filtro de CANDIDATA a canônica NÃO foi relaxado. '
  'security_invoker=on: repetir o WITH em todo replace (#1375).';

-- Grants inalterados (REPLACE preserva ACL); re-afirmados por idempotência.
REVOKE ALL ON public.v_tint_formula_canonica FROM PUBLIC;
REVOKE ALL ON public.v_tint_formula_canonica FROM anon;
GRANT SELECT ON public.v_tint_formula_canonica TO authenticated;
GRANT SELECT ON public.v_tint_formula_canonica TO service_role;

COMMIT;
