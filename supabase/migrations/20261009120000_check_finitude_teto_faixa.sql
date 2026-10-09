-- ============================================================
-- TETO DE FAIXA nos CHECKs de finitude money-path (corrige 20260807223000, PR #1691)
--
-- POR QUÊ: o #1691 fechou NaN e ±Infinity, mas o challenge Codex (xhigh) mostrou o lado
-- que ficou aberto — FINITUDE NÃO É FAIXA. Medido em prod:
--     ('1e100000'::numeric > 0 AND <> 'NaN' AND < 'Infinity')  = TRUE   ← passa no CHECK atual
--     Number('1e100000') em JS = Infinity ; JSON.stringify → null
-- ⇒ um número finito-porém-absurdo entra no banco e vira Infinity ao cruzar para o app,
--   reintroduzindo exatamente o veneno que o CHECK existe para barrar.
-- O padrão certo já existia no repo e foi descrito (não aplicado) no #1691:
--     estoque_reservas_qtd_check = CHECK (quantidade > 0 AND quantidade <= 1000000)
-- Um teto superior fecha NaN (NaN é o topo da ordem em numeric), +Infinity e o absurdo finito.
-- Os predicados <> NaN e < Infinity ficam EXPLÍCITOS (documentação executável).
--
-- TETOS (medidos em prod 2026-10-09, 0 violações em ambos):
--   tint_formula_itens.qtd_ml : 3.492.901 linhas, max 171.143,11 → teto 1.000.000 ml
--   cmc_snapshot.cmc          :    41.869 linhas, max 218.715,88 → teto 10.000.000
--
-- ESTADO DE PARTIDA: as duas constraints do #1691 JÁ estão aplicadas e validadas em prod
-- (o apply aconteceu em 2026-08-08). Esta migration as SUBSTITUI.
--
-- APPLY EM 3 BLOCOS SEPARADOS (colar um de cada vez no SQL Editor — o achado P1 do Codex:
-- se o script todo for numa mensagem só, roda numa transação implícita e o ACCESS EXCLUSIVE
-- do ADD fica preso durante o VALIDATE de ~1 GB, bloqueando até SELECT).
--   BLOCO A — cmc_snapshot (8 MB): DROP + ADD atômico, sem detector textual.
--   BLOCO B — tint: ADD da constraint NOVA (nome novo) NOT VALID + DROP da antiga.
--   BLOCO C — tint: VALIDATE da nova.
-- A janela entre B e C NÃO abre buraco: constraint NOT VALID já vale para toda escrita nova;
-- só o passivo fica por verificar, e ele foi medido limpo.
--
-- IDEMPOTÊNCIA por NOME + convalidated, nunca por LIKE na representação textual
-- (pg_get_constraintdef é reconstrução — achado P2 do Codex; lição do database.md).
-- O nome novo (`_faixa`) é o marcador: se existe, o teto foi aplicado.
--
-- PROVADO EXECUTANDO em PG17: db/test-check-finitude-money-path.sh (falsificação: remover o
-- teto deixa 1e100000 entrar → assert VERMELHO).
-- ⚠️ MIGRATION MANUAL (nome custom não auto-aplica no Lovable).
-- ============================================================

-- ═══════════════ BLOCO A — cmc_snapshot (colar e rodar sozinho) ═══════════════
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.cmc_snapshot DROP CONSTRAINT IF EXISTS cmc_snapshot_cmc_check;
ALTER TABLE public.cmc_snapshot DROP CONSTRAINT IF EXISTS cmc_snapshot_cmc_faixa;
ALTER TABLE public.cmc_snapshot
  ADD CONSTRAINT cmc_snapshot_cmc_faixa
  CHECK (cmc > 0 AND cmc <> 'NaN'::numeric AND cmc < 'Infinity'::numeric AND cmc <= 10000000);
COMMIT;

-- ═══════════════ BLOCO B — tint: constraint nova NOT VALID (colar e rodar sozinho) ═══════════════
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.tint_formula_itens DROP CONSTRAINT IF EXISTS tint_formula_itens_qtd_ml_faixa;
ALTER TABLE public.tint_formula_itens
  ADD CONSTRAINT tint_formula_itens_qtd_ml_faixa
  CHECK (qtd_ml > 0 AND qtd_ml <> 'NaN'::numeric AND qtd_ml < 'Infinity'::numeric AND qtd_ml <= 1000000)
  NOT VALID;
-- a antiga (sem teto) sai na MESMA transação: nunca há instante sem guarda de escrita nova
ALTER TABLE public.tint_formula_itens DROP CONSTRAINT IF EXISTS tint_formula_itens_qtd_ml_finita;
COMMIT;

-- ═══════════════ BLOCO C — tint: VALIDATE (colar e rodar sozinho) ═══════════════
-- SHARE UPDATE EXCLUSIVE: não bloqueia leitura nem escrita. Sobre dado sujo ABORTA (23514) e a
-- constraint fica NOT VALID — ainda guardando escrita nova; a validação pós-apply denuncia.
ALTER TABLE public.tint_formula_itens VALIDATE CONSTRAINT tint_formula_itens_qtd_ml_faixa;

COMMENT ON CONSTRAINT tint_formula_itens_qtd_ml_faixa ON public.tint_formula_itens IS
  'Dose do corante: finita, positiva e <= 1.000.000 ml. Finitude não é faixa: 1e100000 é finito e vira Infinity em JS. Ver docs/agent/money-path.md §2.';

-- ═══════════════ POSTCONDIÇÃO (falha alto em vez de terminar em silêncio) ═══════════════
-- Lê CATÁLOGO por nome + convalidated + efeito do predicado (nunca LIKE na representação).
DO $post$
DECLARE v_t boolean; v_c boolean;
BEGIN
  SELECT convalidated INTO v_t FROM pg_constraint WHERE conname = 'tint_formula_itens_qtd_ml_faixa';
  SELECT convalidated INTO v_c FROM pg_constraint WHERE conname = 'cmc_snapshot_cmc_faixa';
  IF v_t IS DISTINCT FROM true OR v_c IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDICAO_FALHOU: faixa tint=% cmc=% (esperado true/true)', v_t, v_c;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conname IN ('tint_formula_itens_qtd_ml_finita','cmc_snapshot_cmc_check')) THEN
    RAISE EXCEPTION 'POSTCONDICAO_FALHOU: constraint antiga (sem teto) ainda presente';
  END IF;
  RAISE NOTICE 'POSTCONDICAO_OK: teto de faixa ativo e validado nas duas tabelas';
END $post$;
