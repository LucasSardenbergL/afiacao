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

  -- Totais do run: log escopado ao motor (I/J aplicam config mas NÃO contam aqui).
  SELECT total_aplicados, total_segurados, total_pinados, impacto_total_rs, impacto_desconhecido_n
    INTO r FROM public.reposicao_param_auto_run WHERE id=v_run;
  ASSERT r.total_aplicados=3, format('total_aplicados FALHOU: % (esperado 3: A,F,L — I/J aplicam mas não logam)', r.total_aplicados);
  ASSERT r.total_segurados=1, format('total_segurados FALHOU: % (esperado 1: B — cobertura removida, C virou no-op)', r.total_segurados);
  ASSERT r.total_pinados=2, format('total_pinados FALHOU: % (esperado 2: E,H — pin vence o fusível)', r.total_pinados);
  -- impacto_total_rs = soma dos impactos conhecidos: A=200, F=? (pos 30<=70→qtde_depois 150-30=120;
  --   antes pp 40, máx 100 → 30<=40→qtde_antes 100-30=70; Δ50×cmc10=500) → 200+500=700; B=0(segurado);
  --   L=NULL (não soma).
  ASSERT r.impacto_total_rs=700, format('impacto_total_rs FALHOU: % (esperado 700: A 200 + F 500)', r.impacto_total_rs);
  ASSERT COALESCE(r.impacto_desconhecido_n,0)=1, format('impacto_desconhecido_n FALHOU: % (esperado 1: L aplica sem custo)', r.impacto_desconhecido_n);

  RAISE NOTICE 'OK status/impacto/totais (A/F/L aplicam · B segura (3×) · C giro-lento no-op · D bloqueia · E/H pinam · G sem_mudanca · I/J aplicam sem logar · K bloqueia cold-start · L queda aplica)';
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

  -- ── P1/P2 (migration E): cada item é rotulado pela DESCRIÇÃO, não pelo código cru ──
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  -- P1 (positivo): as descrições dos 3 aplicados (A/F/L) aparecem no corpo
  ASSERT position('SKU-A normal' IN v_msg) > 0,         'P1 FALHOU: descrição de A ausente no e-mail';
  ASSERT position('SKU-F pin diferente' IN v_msg) > 0,  'P1 FALHOU: descrição de F ausente no e-mail';
  ASSERT position('SKU-L queda do máximo' IN v_msg) > 0,'P1 FALHOU: descrição de L ausente no e-mail';
  -- P2 (positivo): o código deixou de ser o RÓTULO do item ("<código>: PP")
  ASSERT position('1001: PP' IN v_msg) = 0, 'P2 FALHOU: A ainda rotulado pelo código (1001) em vez da descrição';
  ASSERT position('1006: PP' IN v_msg) = 0, 'P2 FALHOU: F ainda rotulado pelo código (1006)';
  ASSERT position('1012: PP' IN v_msg) = 0, 'P2 FALHOU: L ainda rotulado pelo código (1012)';
  RAISE NOTICE 'OK resumo: 1 alerta (info/pendente) + idempotente + rótulo=descrição (P1) + código não é rótulo (P2)';
END $$;

-- cron registrado
SELECT 'cron' AS k, count(*) AS n FROM cron.job WHERE jobname='reposicao-param-auto-resumo';
SQL

echo ""
echo "→ FALSIFICAÇÃO (sabota a migration E → o e-mail volta ao código; prova o dente de P1)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Versão FURADA: rótulo = sku_codigo_omie cru (como era ANTES da migration E).
CREATE OR REPLACE FUNCTION public.reposicao_param_auto_resumo_tick()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
  AS $fur$
DECLARE r record; v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date; v_corpo text; v_top text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('param_auto_resumo'));
  SELECT * INTO r FROM public.reposicao_param_auto_run
    WHERE data_negocio_brt=v_hoje AND status='completo' AND resumo_enviado_em IS NULL
    ORDER BY concluido_em DESC LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(r.total_aplicados,0)=0 AND COALESCE(r.total_segurados,0)=0 THEN
    UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id; RETURN;
  END IF;
  SELECT string_agg(format('• %s: PP %s→%s, máx %s→%s%s', sku_codigo_omie,
            coalesce(ponto_pedido_antes::text,'—'), coalesce(ponto_pedido_depois::text,'—'),
            coalesce(estoque_maximo_antes::text,'—'), coalesce(estoque_maximo_depois::text,'—'),
            CASE WHEN impacto_rs IS NULL THEN ' (R$ ?)' ELSE ' (R$ '||round(impacto_rs)::text||')' END), E'\n')
    INTO v_top FROM (
      SELECT * FROM public.reposicao_param_auto_log WHERE run_id=r.id AND status='aplicado'
      ORDER BY impacto_rs DESC NULLS LAST LIMIT 10) t;
  v_corpo := format(E'%s parâmetros mudaram hoje (OBEN).\nImpacto estimado total: R$ %s%s\n\nMaiores mudanças:\n%s\n\nSegurados pelo fusível (confira): %s\n\nVeja e reverta em: /admin/reposicao/mudancas-automaticas',
    r.total_aplicados, round(COALESCE(r.impacto_total_rs,0)),
    CASE WHEN COALESCE(r.impacto_desconhecido_n,0)>0 THEN ' (+'||r.impacto_desconhecido_n||' sem custo)' ELSE '' END,
    COALESCE(v_top,'—'), COALESCE(r.total_segurados,0));
  INSERT INTO public.fornecedor_alerta (tipo, titulo, mensagem, empresa, severidade, status)
    VALUES ('param_auto_resumo', 'Parâmetros de reposição — resumo do dia', v_corpo, r.empresa, 'info', 'pendente_notificacao');
  UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=now() WHERE id=r.id;
END;
$fur$;

DELETE FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=NULL
  WHERE status='completo' AND data_negocio_brt=(now() AT TIME ZONE 'America/Sao_Paulo')::date;

DO $$
DECLARE v_msg text;
BEGIN
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  -- Sentinela ASCII que SÓ a versão verdadeira emite (a descrição). Com a furada deve SUMIR:
  ASSERT position('SKU-A normal' IN v_msg) = 0,
    'FALSIFICAÇÃO FRACA: P1 ficaria verde mesmo sem a migration E (rótulo=código) → assert sem dente';
  -- e o código volta a ser o rótulo (confirma que a sabotagem rodou de fato):
  ASSERT position('1001: PP' IN v_msg) > 0,
    'FALSIFICAÇÃO INCONCLUSIVA: nem o código apareceu — a versão furada não rodou como esperado';
  RAISE NOTICE 'OK falsificação: sem a migration E o e-mail volta ao código cru (P1 ficaria VERMELHO)';
END $$;
SQL

echo "→ restaura a migration E verdadeira…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260619120000_param_auto_resumo_descricao.sql"

echo ""
echo "→ P3 FALLBACK (descrição NULL/só-espaços → cai no código, nunca rótulo vazio)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE public.reposicao_param_auto_log SET sku_descricao=NULL  WHERE sku_codigo_omie='1001';  -- A: NULL
UPDATE public.reposicao_param_auto_log SET sku_descricao='   ' WHERE sku_codigo_omie='1012';  -- L: só-espaços
DELETE FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
UPDATE public.reposicao_param_auto_run SET resumo_enviado_em=NULL
  WHERE status='completo' AND data_negocio_brt=(now() AT TIME ZONE 'America/Sao_Paulo')::date;

DO $$
DECLARE v_msg text;
BEGIN
  PERFORM public.reposicao_param_auto_resumo_tick();
  SELECT mensagem INTO v_msg FROM public.fornecedor_alerta WHERE tipo='param_auto_resumo';
  ASSERT position('1001: PP' IN v_msg) > 0,          'P3 FALHOU: descrição NULL (A) não caiu no código';
  ASSERT position('SKU-A normal' IN v_msg) = 0,      'P3 FALHOU: A ainda mostra a descrição apagada';
  ASSERT position('1012: PP' IN v_msg) > 0,          'P3 FALHOU: descrição só-espaços (L) não caiu no código (nullif/btrim)';
  ASSERT position('SKU-F pin diferente' IN v_msg) > 0,'P3 FALHOU: F (com descrição) deveria manter o texto';
  ASSERT position('• : PP' IN v_msg) = 0,            'P3 FALHOU: rótulo vazio no e-mail (money-path: ausente≠vazio)';
  RAISE NOTICE 'OK fallback: NULL e só-espaços caem no código; com descrição mantém; sem rótulo vazio';
END $$;
SQL

echo ""
echo "✓ db/test-param-auto.sh — TODOS OS ASSERTS PASSARAM"
