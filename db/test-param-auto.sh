#!/usr/bin/env bash
# Prova PG17 da auto-aplicação de parâmetros da Reposição (money-path).
# Aplica o schema-snapshot + foundation (pode_ver_carteira_completa + stub cron.schedule, ambos
# ausentes/parciais no snapshot) + as 4 migrations A/B/C/D, substitui v_sku_parametros_sugeridos por
# uma view controlada (db/seed-param-auto.sql), roda o wrapper e assere o FUSÍVEL RECALIBRADO (BLOCO D):
#   A/F/L aplicam · B segura (salto 3×) · C giro-lento no-op = sem_mudanca (PROVA cobertura removida)
#   · D bloqueia (máx<pp) · E/H pinam (pin vence o fusível) · G sem_mudanca · I/J aplicam config sem logar
#   · K bloqueia cold-start (base NULL) · L queda do máximo = aplicado (assimétrico)
#   · impacto best-effort (L sem custo = desconhecido) · idempotência (2º run/dia = no-op) · revert
#   restaura+pina · conflito (estado divergente) · despinar.
# Base: db/verify-snapshot-replay.sh + db/test-minimo-forcado.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5438
DATA="$(mktemp -d /tmp/pgtest-paramauto.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-paramauto.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres paramauto_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d paramauto_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-paramauto.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ foundation (ausentes/parciais no snapshot)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- pode_ver_carteira_completa: vive numa migration (20260526020000), não no snapshot. Verbatim.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    has_role(_uid, 'master'::app_role)
    OR (
      has_role(_uid, 'employee'::app_role)
      AND get_commercial_role(_uid) IN (
        'gerencial'::commercial_role,
        'estrategico'::commercial_role,
        'super_admin'::commercial_role
      )
    );
$$;

-- cron.schedule: pg_cron fica desabilitado no replay (prelude) → stub que registra em cron.job
-- (upsert por jobname, idempotente, igual ao pg_cron real) p/ a migration C e a validação rodarem.
CREATE OR REPLACE FUNCTION cron.schedule(p_job_name text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_job_name;
  IF v_id IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, schedule, command, active, jobname)
      VALUES (v_id, p_schedule, p_command, true, p_job_name);
  ELSE
    UPDATE cron.job SET schedule=p_schedule, command=p_command WHERE jobid=v_id;
  END IF;
  RETURN v_id;
END $$;

-- auth.uid() via GUC de sessão test.uid (impersonação de teste — mesmo padrão do verify-snapshot-replay).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
SQL

echo "→ migration A (tabelas/RLS/seeds/CHECK)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260605120000_param_auto_tabelas.sql"
echo "→ migration B (core instrumentada)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260605130000_param_auto_core.sql"
echo "→ migration C (wrapper + revert/pin + cron)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260605140000_param_auto_wrapper_revert_cron.sql"
echo "→ migration D (recalibra fusível: dropa cobertura, no-op antes do fusível, guard de base)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260605150000_param_auto_fusivel_calibracao.sql"
echo "→ migration E (resumo 18h: rótulo = descrição do produto, fallback p/ código)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260619120000_param_auto_resumo_descricao.sql"
echo "→ migration F (resumo: altas/reduções separadas + segurado pelo nome)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260711193000_param_auto_resumo_altas_reducoes_segurado.sql"
echo "→ migration G (log grava valor barrado + tick mostra 'quis subir máx X → Y')…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260712140000_param_auto_log_valor_barrado_fusivel.sql"

echo "→ seed dos cenários (view controlada + sku_parametros + pins + estoque/custo)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/seed-param-auto.sql"

# ── Master p/ as RPCs de revert (gate pode_ver_carteira_completa) ──
P -v ON_ERROR_STOP=1 -qtA <<'SQL'
INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','master') ON CONFLICT DO NOTHING;
SQL

echo ""
echo "→ RUN diário + ASSERTS de status/impacto…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE v_run uuid; r record; n int;
BEGIN
  v_run := public.aplicar_parametros_automatico_diario('OBEN');
  ASSERT v_run IS NOT NULL, 'RUN1: wrapper devolveu NULL (deveria criar run)';

  -- A: aplicado
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1001';
  ASSERT r.status='aplicado', format('A FALHOU: status=% (esperado aplicado)', r.status);
  -- e os 5 campos de config de A foram sobrescritos em sku_parametros
  SELECT ponto_pedido, estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1001;
  ASSERT r.ponto_pedido=60 AND r.estoque_maximo=140, format('A config FALHOU: pp=% max=% (esperado 60/140)', r.ponto_pedido, r.estoque_maximo);

  -- B: segurado (>3x); config PRESERVADA (100, não 400)
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1002';
  ASSERT r.status='segurado', format('B FALHOU: status=% (esperado segurado)', r.status);
  SELECT estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1002;
  ASSERT r.estoque_maximo=100, format('B preservou FALHOU: max=% (esperado 100, não 400)', r.estoque_maximo);
  -- B: o LOG agora grava o valor SUGERIDO barrado (400), mesmo o parâmetro ficando em 100 (migration G).
  SELECT estoque_maximo_sugerido INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1002';
  ASSERT r.estoque_maximo_sugerido=400, format('B sugerido FALHOU: %s (esperado 400: o valor que o fusível barrou, gravado no log)', r.estoque_maximo_sugerido);

  -- C: GIRO LENTO inalterado → sem_mudanca (NÃO loga). Prova que o gatilho de cobertura morreu:
  --    demanda 1/dia + máx 200 daria 200d de cobertura (>120) → a versão antiga seguraria; agora
  --    máx==antes e ≤3× → no-op. config preservada (200).
  SELECT count(*) INTO n FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1003';
  ASSERT n=0, 'C FALHOU: giro lento no-op NÃO deve logar (cobertura removida → sem_mudanca, não segurado)';
  SELECT estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1003;
  ASSERT r.estoque_maximo=200, format('C preservou FALHOU: max=% (esperado 200)', r.estoque_maximo);

  -- D: bloqueado_validacao (máx<pp); config preservada (120, não 40)
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1004';
  ASSERT r.status='bloqueado_validacao', format('D FALHOU: status=% (esperado bloqueado_validacao)', r.status);
  SELECT estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1004;
  ASSERT r.estoque_maximo=120, format('D preservou FALHOU: max=% (esperado 120, não 40)', r.estoque_maximo);

  -- E: pinado (sug == rejeitado); config preservada (antes 40/100)
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1005';
  ASSERT r.status='pinado', format('E FALHOU: status=% (esperado pinado)', r.status);
  SELECT ponto_pedido, estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1005;
  ASSERT r.ponto_pedido=40 AND r.estoque_maximo=100, format('E preservou FALHOU: pp=% max=% (esperado 40/100)', r.ponto_pedido, r.estoque_maximo);
  SELECT count(*) INTO n FROM public.reposicao_param_pin WHERE sku_codigo_omie='1005';
  ASSERT n=1, 'E pin FALHOU: pin de E deveria permanecer';

  -- F: aplicado (sug != rejeitado) + pin LIMPO; config aplicada (70/150)
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1006';
  ASSERT r.status='aplicado', format('F FALHOU: status=% (esperado aplicado)', r.status);
  SELECT ponto_pedido, estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1006;
  ASSERT r.ponto_pedido=70 AND r.estoque_maximo=150, format('F config FALHOU: pp=% max=% (esperado 70/150)', r.ponto_pedido, r.estoque_maximo);
  SELECT count(*) INTO n FROM public.reposicao_param_pin WHERE sku_codigo_omie='1006';
  ASSERT n=0, 'F pin FALHOU: pin de F deveria ser apagado (sugestão mudou e aplicou)';
  -- F impacto: pos 30 <= pp_depois 70 → qtde_depois=150-30=120; 30<=pp_antes 40 → qtde_antes=100-30=70; Δ50×cmc10=500
  SELECT impacto_rs INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1006';
  ASSERT r.impacto_rs=500, format('F impacto FALHOU: impacto=% (esperado 500: Δ50×cmc10)', r.impacto_rs);

  -- G: sem_mudanca → NÃO loga
  SELECT count(*) INTO n FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1007';
  ASSERT n=0, 'G FALHOU: sem_mudanca NÃO deve gerar linha de log';

  -- H: pin bate (50/400) E salto>3x. Precedência nova: PIN (passo 4) vem ANTES do fusível (passo 6)
  --    → pinado (não segurado). Pin permanece (pinado não limpa pin).
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1008';
  ASSERT r.status='pinado', format('H FALHOU: status=% (esperado pinado: pin vence o fusível na nova precedência)', r.status);
  SELECT count(*) INTO n FROM public.reposicao_param_pin WHERE sku_codigo_omie='1008';
  ASSERT n=1, 'H pin FALHOU: pin de H deveria permanecer (pinado não limpa pin)';

  -- I: habilitado=false → config aplicada (sug != antes) MAS NÃO logado (escopo do log = motor)
  SELECT count(*) INTO n FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1009';
  ASSERT n=0, 'I FALHOU: SKU desabilitado NÃO deve entrar no log';
  SELECT ponto_pedido, estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1009;
  ASSERT r.ponto_pedido=65 AND r.estoque_maximo=145, format('I config FALHOU: pp=% max=% (esperado 65/145 — aplica config, só não loga)', r.ponto_pedido, r.estoque_maximo);

  -- J: produto_acabado → config aplicada MAS NÃO logado
  SELECT count(*) INTO n FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1010';
  ASSERT n=0, 'J FALHOU: produto_acabado NÃO deve entrar no log';
  SELECT estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1010;
  ASSERT r.estoque_maximo=145, format('J config FALHOU: max=% (esperado 145)', r.estoque_maximo);

  -- K: BASE NULL (primeira parametrização) + sugestão coerente → bloqueado_validacao (cold-start manual).
  --    config preservada (NULL — não auto-aplica primeiro parâmetro sem baseline pra checar).
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1011';
  ASSERT r.status='bloqueado_validacao', format('K FALHOU: status=% (esperado bloqueado_validacao: base NULL = cold-start)', r.status);
  SELECT estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1011;
  ASSERT r.estoque_maximo IS NULL, format('K preservou FALHOU: max=% (esperado NULL — não aplica cold-start)', r.estoque_maximo);

  -- L: QUEDA do máximo 120→4 (pp 50→2) → APLICADO (fusível é upward-only; queda nunca segura).
  SELECT status INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1012';
  ASSERT r.status='aplicado', format('L FALHOU: status=% (esperado aplicado: queda do máximo não é segurada)', r.status);
  SELECT ponto_pedido, estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1012;
  ASSERT r.ponto_pedido=2 AND r.estoque_maximo=4, format('L config FALHOU: pp=% max=% (esperado 2/4)', r.ponto_pedido, r.estoque_maximo);

  -- IMPACTO best-effort:
  -- A: Δqtde 20 × cmc 10 = 200, custo_fonte=cmc
  SELECT impacto_rs, custo_fonte, qtde_compra_antes, qtde_compra_depois INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1001';
  ASSERT r.impacto_rs=200, format('A impacto FALHOU: impacto=% (esperado 200)', r.impacto_rs);
  ASSERT r.custo_fonte='cmc', format('A custo_fonte FALHOU: % (esperado cmc)', r.custo_fonte);
  ASSERT r.qtde_compra_antes=90 AND r.qtde_compra_depois=110, format('A qtde FALHOU: antes=% depois=%', r.qtde_compra_antes, r.qtde_compra_depois);
  -- B: segurado → Δqtde 0 → impacto 0 (com custo presente)
  SELECT impacto_rs INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1002';
  ASSERT r.impacto_rs=0, format('B impacto FALHOU: % (esperado 0; segurado não muda a compra)', r.impacto_rs);
  -- L: aplicado sem inventory_position/estoque → custo ausente → impacto_rs NULL (desconhecido, não 0)
  SELECT impacto_rs INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1012';
  ASSERT r.impacto_rs IS NULL, format('L impacto FALHOU: % (esperado NULL — custo ausente = desconhecido)', r.impacto_rs);

  -- M: REDUÇÃO do máximo (120→90) com estoque 30 abaixo do ponto → aplicado com impacto NEGATIVO
  --    (qtde_antes 120-30=90, qtde_depois 90-30=60, Δ-30 × cmc10 = -300). É o caso do resumo "reduções".
  SELECT status, impacto_rs INTO r FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1013';
  ASSERT r.status='aplicado', format('M FALHOU: status=% (esperado aplicado: queda do máximo não é segurada)', r.status);
  ASSERT r.impacto_rs=-300, format('M impacto FALHOU: % (esperado -300: Δ-30 × cmc10 — capital LIBERADO)', r.impacto_rs);

  -- Totais do run: log escopado ao motor (I/J aplicam config mas NÃO contam aqui).
  SELECT total_aplicados, total_segurados, total_pinados, impacto_total_rs, impacto_desconhecido_n
    INTO r FROM public.reposicao_param_auto_run WHERE id=v_run;
  ASSERT r.total_aplicados=4, format('total_aplicados FALHOU: % (esperado 4: A,F,L,M — I/J aplicam mas não logam)', r.total_aplicados);
  ASSERT r.total_segurados=1, format('total_segurados FALHOU: % (esperado 1: B — cobertura removida, C virou no-op)', r.total_segurados);
  ASSERT r.total_pinados=2, format('total_pinados FALHOU: % (esperado 2: E,H — pin vence o fusível)', r.total_pinados);
  -- impacto_total_rs = soma dos impactos conhecidos: A=200, F=500 (pos 30<=70→qtde_depois 150-30=120;
  --   antes pp 40, máx 100 → 30<=40→qtde_antes 100-30=70; Δ50×cmc10=500); M=-300 (redução); B=0(segurado);
  --   L=NULL (não soma). → 200+500-300 = 400 (o total JÁ é líquido: inclui a redução de M).
  ASSERT r.impacto_total_rs=400, format('impacto_total_rs FALHOU: % (esperado 400 líquido: A 200 + F 500 - M 300)', r.impacto_total_rs);
  ASSERT COALESCE(r.impacto_desconhecido_n,0)=1, format('impacto_desconhecido_n FALHOU: % (esperado 1: L aplica sem custo)', r.impacto_desconhecido_n);

  RAISE NOTICE 'OK status/impacto/totais (A/F/L/M aplicam · B segura (3×) · C giro-lento no-op · D bloqueia · E/H pinam · G sem_mudanca · I/J aplicam sem logar · K bloqueia cold-start · L queda aplica · M reduz -300)';
END $$;
SQL

echo ""
echo "→ IDEMPOTÊNCIA (2º run no mesmo dia = no-op)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE v2 uuid; nruns int;
BEGIN
  v2 := public.aplicar_parametros_automatico_diario('OBEN');
  ASSERT v2 IS NULL, format('IDEMPOTENCIA FALHOU: 2º run devolveu % (esperado NULL)', v2);
  SELECT count(*) INTO nruns FROM public.reposicao_param_auto_run WHERE empresa='OBEN' AND status='completo';
  ASSERT nruns=1, format('IDEMPOTENCIA FALHOU: % runs completos (esperado 1)', nruns);
  RAISE NOTICE 'OK idempotência: 2º run no mesmo dia é no-op (1 run completo)';
END $$;
SQL

echo ""
echo "→ REVERT (gate master) + pin + CONFLITO…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SET test.uid = '11111111-1111-1111-1111-111111111111';   -- master (auth.uid lê este GUC)
DO $$
DECLARE log_a uuid; res text; r record; n int;
BEGIN
  -- gate negativo: sem uid → sem permissão
  PERFORM set_config('test.uid', '', true);
  BEGIN
    PERFORM public.reverter_parametro_auto((SELECT id FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1001'));
    RAISE EXCEPTION 'GATE FALHOU: revert sem permissão passou';
  EXCEPTION WHEN sqlstate 'P0001' THEN
    IF SQLERRM LIKE 'GATE FALHOU%' THEN RAISE; END IF;
    RAISE NOTICE 'OK gate: revert sem permissão BLOQUEADO (%)', SQLERRM;
  END;
  PERFORM set_config('test.uid', '11111111-1111-1111-1111-111111111111', true);

  -- reverte A → restaura antes (50/120) + cria pin + marca revertido
  SELECT id INTO log_a FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1001';
  res := public.reverter_parametro_auto(log_a);
  ASSERT res='revertido', format('REVERT A FALHOU: % (esperado revertido)', res);
  SELECT ponto_pedido, estoque_maximo INTO r FROM public.sku_parametros WHERE sku_codigo_omie=1001;
  ASSERT r.ponto_pedido=50 AND r.estoque_maximo=120, format('REVERT restaura FALHOU: pp=% max=% (esperado 50/120)', r.ponto_pedido, r.estoque_maximo);
  SELECT count(*) INTO n FROM public.reposicao_param_pin WHERE sku_codigo_omie='1001';
  ASSERT n=1, 'REVERT pin FALHOU: pin de A deveria ser criado (rejeita 60/140)';
  SELECT ponto_pedido_rejeitado, estoque_maximo_rejeitado INTO r FROM public.reposicao_param_pin WHERE sku_codigo_omie='1001';
  ASSERT r.ponto_pedido_rejeitado=60 AND r.estoque_maximo_rejeitado=140, format('REVERT pin valor FALHOU: %/%', r.ponto_pedido_rejeitado, r.estoque_maximo_rejeitado);
  SELECT revertido_em IS NOT NULL AS rv INTO r FROM public.reposicao_param_auto_log WHERE id=log_a;
  ASSERT r.rv, 'REVERT marca FALHOU: revertido_em deveria ser preenchido';

  -- re-revert do mesmo log → nao_encontrado (já revertido)
  res := public.reverter_parametro_auto(log_a);
  ASSERT res='nao_encontrado', format('RE-REVERT FALHOU: % (esperado nao_encontrado)', res);

  RAISE NOTICE 'OK revert: restaura antes + cria pin (rejeitado=depois) + marca + não repete';
END $$;
SQL

echo ""
echo "→ CONFLITO (estado divergente do 'depois' logado)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SET test.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE log_f uuid; res text;
BEGIN
  -- F está 'aplicado' (pp 70/máx 150, min 18). Editamos SÓ o estoque_minimo (PP+máx INTACTOS) →
  -- a guarda dos 5 campos (FIX 3) deve detectar conflito. (A guarda antiga, só PP+máx, daria 'revertido'
  -- e atropelaria a edição humana de min — exatamente o furo que esta versão fecha.)
  SELECT id INTO log_f FROM public.reposicao_param_auto_log WHERE sku_codigo_omie='1006';
  UPDATE public.sku_parametros SET estoque_minimo = estoque_minimo + 99 WHERE sku_codigo_omie=1006;
  res := public.reverter_parametro_auto(log_f);
  ASSERT res='conflito', format('CONFLITO FALHOU: % (esperado conflito; edição humana de estoque_minimo, PP+máx intactos)', res);
  RAISE NOTICE 'OK conflito: edição de estoque_minimo (PP+máx intactos) detectada pela guarda dos 5 campos';
END $$;
SQL

echo ""
echo "→ DESPINAR (devolve ao automático)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SET test.uid = '11111111-1111-1111-1111-111111111111';
DO $$
DECLARE ok boolean; n int;
BEGIN
  ok := public.despinar_parametro('OBEN','1005');   -- remove o pin de E
  ASSERT ok, 'DESPINAR FALHOU: deveria remover o pin de E';
  SELECT count(*) INTO n FROM public.reposicao_param_pin WHERE sku_codigo_omie='1005';
  ASSERT n=0, 'DESPINAR FALHOU: pin de E ainda existe';
  RAISE NOTICE 'OK despinar: pin removido (volta a poder aplicar)';
END $$;
SQL

echo ""
echo "→ RESUMO 18h (enfileira fornecedor_alerta + idempotência) …"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int; r record; v_msg text;
BEGIN
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT count(*) INTO n FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  ASSERT n=1, format('RESUMO FALHOU: % alertas (esperado 1)', n);
  SELECT severidade, status, empresa INTO r FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  ASSERT r.severidade='info' AND r.status='pendente_notificacao', format('RESUMO campos FALHOU: sev=% status=%', r.severidade, r.status);
  -- idempotência: 2ª chamada não duplica (resumo_enviado_em já setado)
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT count(*) INTO n FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  ASSERT n=1, format('RESUMO idempotência FALHOU: % alertas (esperado 1)', n);

  -- ── Corpo do e-mail: altas / reduções / segurado-pelo-nome (migration F) ──
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  RAISE NOTICE E'\n──── CORPO DO E-MAIL ────\n%\n─────────────────────────', v_msg;

  -- P-ALTAS (positivo): seção "Maiores altas" com A (+200) e F (+500), pela DESCRIÇÃO e com sinal +.
  ASSERT position('Maiores altas:' IN v_msg) > 0,        'P-ALTAS FALHOU: seção "Maiores altas" ausente';
  ASSERT position('SKU-A normal' IN v_msg) > 0,          'P-ALTAS FALHOU: A (alta +200) ausente';
  ASSERT position('SKU-F pin diferente' IN v_msg) > 0,   'P-ALTAS FALHOU: F (alta +500) ausente';
  ASSERT position('(R$ +500)' IN v_msg) > 0,             'P-ALTAS FALHOU: sinal/valor "+500" de F ausente';
  ASSERT position('(R$ +200)' IN v_msg) > 0,             'P-ALTAS FALHOU: sinal/valor "+200" de A ausente';

  -- P-REDUÇÕES (o bug do founder): seção PRÓPRIA "Maiores reduções" com M (-300) — nunca cortada.
  ASSERT position('Maiores reduções:' IN v_msg) > 0,     'P-REDUCOES FALHOU: seção "Maiores reduções" ausente (o bug: só mostrava alta)';
  ASSERT position('SKU-M reducao capital' IN v_msg) > 0, 'P-REDUCOES FALHOU: M (redução -300) ausente';
  ASSERT position('(R$ -300)' IN v_msg) > 0,             'P-REDUCOES FALHOU: valor "-300" de M ausente';
  -- ordem: altas ANTES de reduções (a seção de alta precede a de baixa no corpo)
  ASSERT position('Maiores altas:' IN v_msg) < position('Maiores reduções:' IN v_msg),
    'P-ORDEM FALHOU: "Maiores reduções" deveria vir DEPOIS de "Maiores altas"';

  -- P-SEGURADO (o "confira" agora diz o quê E quanto): B pelo NOME + o VALOR BARRADO (máx 100→400).
  ASSERT position('Segurados pelo fusível (confira): 1' IN v_msg) > 0, 'P-SEGURADO FALHOU: contador do fusível ausente';
  ASSERT position('SKU-B salto>3x' IN v_msg) > 0,        'P-SEGURADO FALHOU: item segurado (B) não listado pelo nome';
  ASSERT position('quis subir máx 100 → 400' IN v_msg) > 0, 'P-BARRADO FALHOU: valor barrado (100→400) ausente no segurado (migration G)';

  -- P-SEM-CUSTO: L (aplicado, impacto NULL) NÃO é listado (sem custo), mas conta no "(+1 sem custo)".
  ASSERT position('SKU-L queda do máximo' IN v_msg) = 0, 'P-SEM-CUSTO FALHOU: L (impacto NULL) não deveria ser listado';
  ASSERT position('(+1 sem custo)' IN v_msg) > 0,        'P-SEM-CUSTO FALHOU: rótulo "(+1 sem custo)" do L ausente no cabeçalho';

  -- P-CÓDIGO-NÃO-É-RÓTULO: com descrição presente, o código cru não vira rótulo ("<código>: PP").
  ASSERT position('1001: PP' IN v_msg) = 0, 'P-RÓTULO FALHOU: A ainda rotulado pelo código (1001)';
  ASSERT position('1006: PP' IN v_msg) = 0, 'P-RÓTULO FALHOU: F ainda rotulado pelo código (1006)';
  RAISE NOTICE 'OK resumo: altas só-positivas (A/F) · reduções em seção própria (M -300) · segurado pelo nome (B) · L sem custo não-listado · idempotente';
END $$;

-- cron registrado
SELECT 'cron' AS k, count(*) AS n FROM cron.job WHERE jobname='reposicao-param-auto-resumo';
SQL

echo ""
echo "→ FALSIFICAÇÃO 1 (reverte o TICK à migration F: 'máx atual' em vez de 'quis subir') → dente do valor barrado…"
# A F (#1302) lista o segurado pelo nome mas SEM o valor barrado ("máx atual N"). Reverter só o tick
# deixa o CORE G gravando o sugerido no log (400), mas o tick F o IGNORA → "quis subir" some, o nome
# permanece. Sentinela de dente = 'quis subir máx', string que SÓ a migration G emite.
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260711193000_param_auto_resumo_altas_reducoes_segurado.sql"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DELETE FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=NULL
  WHERE status='completo' AND data_negocio_brt=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
DO $$
DECLARE v_msg text;
BEGIN
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  ASSERT position('quis subir máx' IN v_msg) = 0,
    'FALSIFICAÇÃO FRACA: "quis subir" apareceria sem a migration G → P-BARRADO sem dente';
  -- confirma que a reversão rodou: a F ainda lista o segurado pelo nome, mas no formato "máx atual".
  ASSERT position('SKU-B salto>3x' IN v_msg) > 0 AND position('máx atual 100' IN v_msg) > 0,
    'FALSIFICAÇÃO INCONCLUSIVA: a F deveria listar o segurado pelo nome com "máx atual 100"';
  RAISE NOTICE 'OK falsificação 1: sem a migration G o segurado volta a "máx atual" (o valor barrado SOME → P-BARRADO VERMELHO)';
END $$;
SQL
echo "→ restaura a migration G (tick com valor barrado)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260712140000_param_auto_log_valor_barrado_fusivel.sql"

echo ""
echo "→ FALSIFICAÇÃO 2 (reverte à migration E: lista única DESC LIMIT 10 → prova o dente de reduções/segurado)…"
# Sabotagem = voltar à versão ANTERIOR (E), que tem UMA lista "Maiores mudanças" sem seção de reduções
# nem segurado-por-nome. Com só 4 aplicados (<10), a E até mostraria M na lista única — por isso a
# sentinela de dente NÃO é 'SKU-M' (apareceria nas duas), e sim a SEÇÃO "Maiores reduções:" e o NOME
# do segurado 'SKU-B', strings que SÓ as migrations F/G emitem.
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260619120000_param_auto_resumo_descricao.sql"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DELETE FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=NULL
  WHERE status='completo' AND data_negocio_brt=(now() AT TIME ZONE 'America/Sao_Paulo')::date;

DO $$
DECLARE v_msg text;
BEGIN
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  -- Dente de P-REDUCOES: a SEÇÃO própria some sem a F (a redução voltaria a competir/ser cortada pelo LIMIT).
  ASSERT position('Maiores reduções:' IN v_msg) = 0,
    'FALSIFICAÇÃO FRACA: "Maiores reduções" apareceria sem a migration F → P-REDUCOES sem dente';
  -- Dente de P-SEGURADO: o segurado deixa de ser listado pelo nome (E só mostra o contador).
  ASSERT position('SKU-B salto>3x' IN v_msg) = 0,
    'FALSIFICAÇÃO FRACA: o segurado (B) seria listado pelo nome sem a migration F → P-SEGURADO sem dente';
  -- Confirma que a reversão REALMENTE rodou (a E emite a lista única "Maiores mudanças"):
  ASSERT position('Maiores mudanças:' IN v_msg) > 0,
    'FALSIFICAÇÃO INCONCLUSIVA: nem "Maiores mudanças" (rótulo da versão E) apareceu — a reversão não rodou';
  RAISE NOTICE 'OK falsificação 2: sem F/G o e-mail volta à lista única (reduções e segurado-por-nome SOMEM → P-REDUCOES/P-SEGURADO VERMELHOS)';
END $$;
SQL

echo "→ restaura a migration G verdadeira…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260712140000_param_auto_log_valor_barrado_fusivel.sql"

echo ""
echo "→ FALLBACK (descrição NULL/só-espaços → cai no código nas 3 superfícies, nunca rótulo vazio)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE public.reposicao_param_auto_log SET sku_descricao=NULL  WHERE sku_codigo_omie='1001';  -- A (alta): NULL
UPDATE public.reposicao_param_auto_log SET sku_descricao='   ' WHERE sku_codigo_omie='1013';  -- M (redução): só-espaços
UPDATE public.reposicao_param_auto_log SET sku_descricao=NULL  WHERE sku_codigo_omie='1002';  -- B (segurado): NULL
DELETE FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=NULL
  WHERE status='completo' AND data_negocio_brt=(now() AT TIME ZONE 'America/Sao_Paulo')::date;

DO $$
DECLARE v_msg text;
BEGIN
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  ASSERT position('1001: PP' IN v_msg) > 0,          'FALLBACK FALHOU: descrição NULL (A) não caiu no código nas altas';
  ASSERT position('SKU-A normal' IN v_msg) = 0,      'FALLBACK FALHOU: A ainda mostra a descrição apagada';
  ASSERT position('1013: PP' IN v_msg) > 0,          'FALLBACK FALHOU: descrição só-espaços (M) não caiu no código nas reduções (nullif/btrim)';
  ASSERT position('• 1002' IN v_msg) > 0,            'FALLBACK FALHOU: segurado B com descrição NULL não caiu no código';
  ASSERT position('quis subir máx 100 → 400' IN v_msg) > 0, 'FALLBACK FALHOU: B (segurado) deveria manter o valor barrado junto do código';
  ASSERT position('SKU-F pin diferente' IN v_msg) > 0,'FALLBACK FALHOU: F (com descrição) deveria manter o texto';
  ASSERT position('• : PP' IN v_msg) = 0,            'FALLBACK FALHOU: rótulo vazio nas listas (money-path: ausente≠vazio)';
  ASSERT position(E'• \n' IN v_msg) = 0,             'FALLBACK FALHOU: rótulo vazio no segurado (bullet+espaço+newline)';
  RAISE NOTICE 'OK fallback: NULL/só-espaços caem no código (altas, reduções e segurado); com descrição mantém; sem rótulo vazio';
END $$;
SQL

echo ""
echo "→ DEGRADAÇÃO GRACIOSA (run gravado pelo core ANTIGO: sugerido NULL → 'máx atual', nunca '→ ?')…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Simula um run gravado ANTES da migration G (sem o valor sugerido) — ex.: o run de hoje na prod.
UPDATE public.reposicao_param_auto_log SET estoque_maximo_sugerido=NULL WHERE sku_codigo_omie='1002';
DELETE FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=NULL
  WHERE status='completo' AND data_negocio_brt=(now() AT TIME ZONE 'America/Sao_Paulo')::date;
DO $$
DECLARE v_msg text;
BEGIN
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  ASSERT position('quis subir' IN v_msg) = 0,    'DEGRADAÇÃO FALHOU: sem sugerido não deveria dizer "quis subir"';
  ASSERT position('máx atual 100' IN v_msg) > 0, 'DEGRADAÇÃO FALHOU: sem sugerido deveria cair em "máx atual 100" (só-nome)';
  ASSERT position('→ ?' IN v_msg) = 0,           'DEGRADAÇÃO FALHOU: nunca mostrar "→ ?" (sugerido ausente = formato só-nome)';
  ASSERT position('Segurados pelo fusível (confira): 1' IN v_msg) > 0, 'DEGRADAÇÃO FALHOU: o segurado ainda deve ser contado';
  RAISE NOTICE 'OK degradação graciosa: run sem sugerido → "máx atual", sem "→ ?" feio';
END $$;
SQL

echo ""
echo "✓ db/test-param-auto.sh — TODOS OS ASSERTS PASSARAM"
