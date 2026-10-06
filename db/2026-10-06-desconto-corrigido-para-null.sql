-- ╔════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ O sensor do desconto passa a dizer SE VIROU NULL — e não só que "mudou".                ║
-- ║                                                                                        ║
-- ║ PROBLEMA: `desconto_corrigido` é verdadeiro em DOIS eventos distintos — (1) o desconto  ║
-- ║ conhecido virou NULL (nulificação) e (2) mudou para outro valor. Em 2026-09-20 a        ║
-- ║ suspeita foi de nulificação em massa na oben; o log não distinguia, e a hipótese só caiu ║
-- ║ 15 dias depois, pelo `updated_at` dos pedidos. Com um contador só, "o reprocesso está    ║
-- ║ nulificando?" continua sendo investigação, não query.                                   ║
-- ║                                                                                        ║
-- ║ SUBCONJUNTO, NÃO PARTIÇÃO: `desconto_corrigido` fica EXATAMENTE como está (os dois      ║
-- ║ ramos) e nasce `desconto_corrigido_para_null` contando só o ramo do NULL. Reparticionar  ║
-- ║ mudaria o significado das 195 runs já logadas desde 2026-09-20 sem mudar o nome da       ║
-- ║ chave — série histórica que mente é pior que chave redundante. O NOME carrega a          ║
-- ║ contenção (`corrigido_para_null` ⊆ `corrigido`): quem somar as duas conta duas vezes, e  ║
-- ║ o nome é o que avisa. A pós-condição (c) PROVA a contenção executando, não afirmando.    ║
-- ║                                                                                        ║
-- ║ O CORPO ABAIXO NÃO É COPIADO: é o `pg_get_functiondef` VIVO, com 7 edições ancoradas     ║
-- ║ (cada uma exigida EXATAMENTE 1x). Corpo colado reverte endurecimento posterior em        ║
-- ║ silêncio — "a última a recriar vence".                                                  ║
-- ║                                                                                        ║
-- ║ CAMINHO B: o Codex NÃO foi consultado — cota em 92,0% (teto 85%), janela reabre em       ║
-- ║ 09/10 19:30. `scripts/codex-async.sh` saiu 79 SEM gastar a chamada. Por isso o PR        ║
-- ║ nasce DRAFT: cota alta não é gatilho de pular, é gatilho de DRAFT.                       ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════╝

-- A transacao e do `db:aplicar` (o corpo roda dentro dela, via EXECUTE): este arquivo NAO
-- leva BEGIN;/COMMIT;. Migration para colar no SQL Editor leva — sao caminhos diferentes.

-- ─── 1. A substituição programática ───────────────────────────────────────────────────────
DO $patch$
DECLARE
  v_fn   text := 'public.reconciliar_pedidos_omie(jsonb,text[],timestamptz)';
  v_def  text;
  v_novo text;

  -- A1 — declaração dos contadores POR PEDIDO.
  v_a1v text := $a1v$  v_del int; v_upd int; v_ins int; v_adot int; v_apur int; v_corr int; v_upd_tot int;$a1v$;
  v_a1n text := $a1n$  v_del int; v_upd int; v_ins int; v_adot int; v_apur int; v_corr int; v_upd_tot int;
  v_corr_null int;$a1n$;

  -- A2 — declaração do contador AGREGADO da chamada.
  v_a2v text := $a2v$  v_desc_corr     integer := 0;   -- linhas cujo desconto CONHECIDO mudou (inclusive para NULL)$a2v$;
  v_a2n text := $a2n$  v_desc_corr     integer := 0;   -- linhas cujo desconto CONHECIDO mudou (inclusive para NULL)
  -- SUBCONJUNTO do de cima: so o ramo em que o conhecido virou NULL. Separar os dois ramos e o
  -- que torna "o reprocesso esta nulificando?" uma QUERY — com o contador unico, nulificacao e
  -- troca de valor somam no mesmo numero e a pergunta so se responde por forense de updated_at.
  v_desc_corr_null integer := 0;$a2n$;

  -- A3 — zeramento por pedido (o contador novo zera junto, senao vaza do pedido anterior).
  v_a3v text := $a3v$      v_del := 0; v_upd := 0; v_ins := 0; v_adot := 0; v_apur := 0; v_corr := 0; v_upd_tot := 0;$a3v$;
  v_a3n text := $a3n$      v_del := 0; v_upd := 0; v_ins := 0; v_adot := 0; v_apur := 0; v_corr := 0; v_upd_tot := 0;
      v_corr_null := 0;$a3n$;

  -- A4 — o predicado no RETURNING do CTE `upd`. O ramo do NULL e o PRIMEIRO disjunto do
  --      `desc_corrigido`, entao a contencao e ESTRUTURAL, nao uma asserção à parte.
  v_a4v text := $a4v$                    (d.traz_desconto AND a.desconto_valor IS NOT NULL
                     AND (d.desconto_valor IS NULL
                          OR abs(a.desconto_valor - d.desconto_valor) >= 1e-6)) AS desc_corrigido,$a4v$;
  v_a4n text := $a4n$                    (d.traz_desconto AND a.desconto_valor IS NOT NULL
                     AND (d.desconto_valor IS NULL
                          OR abs(a.desconto_valor - d.desconto_valor) >= 1e-6)) AS desc_corrigido,
                    -- NULIFICACAO: o primeiro disjunto do predicado acima, isolado. `traz_desconto`
                    -- fora deixaria todo payload da edge antiga parecer nulificacao em massa; linha
                    -- NOVA nao entra aqui (nasce no CTE `ins`, nao no `upd`) porque nao havia valor
                    -- conhecido a perder — nascer NULL e NAO APURADO, nao nulificado. E NULL nao e
                    -- 0: desconto conhecido que vira 0 e troca de valor, nao perda do dado.
                    (d.traz_desconto AND a.desconto_valor IS NOT NULL
                     AND d.desconto_valor IS NULL)                              AS desc_corrigido_para_null,$a4n$;

  -- A5 — a projeção que alimenta os contadores.
  v_a5v text := $a5v$               (SELECT count(*) FROM upd WHERE desc_corrigido),
               (SELECT count(*) FROM upd)
          INTO v_del, v_upd, v_adot, v_ins, v_apur, v_corr, v_upd_tot;$a5v$;
  v_a5n text := $a5n$               (SELECT count(*) FROM upd WHERE desc_corrigido),
               (SELECT count(*) FROM upd WHERE desc_corrigido_para_null),
               (SELECT count(*) FROM upd)
          INTO v_del, v_upd, v_adot, v_ins, v_apur, v_corr, v_corr_null, v_upd_tot;$a5n$;

  -- A6 — acumulação. Fica DEPOIS da checagem de coerência, junto das outras: pedido revertido
  --      nao pode somar aqui, senao o sensor afirma nulificacao que foi desfeita.
  v_a6v text := $a6v$      v_desc_corr   := v_desc_corr + v_corr;$a6v$;
  v_a6n text := $a6n$      v_desc_corr   := v_desc_corr + v_corr;
      v_desc_corr_null := v_desc_corr_null + v_corr_null;$a6n$;

  -- A7 — a chave no jsonb de retorno, que a edge leva ao `metadata` do `sync_reprocess_log`.
  v_a7v text := $a7v$    'desconto_corrigido', v_desc_corr,$a7v$;
  v_a7n text := $a7n$    'desconto_corrigido', v_desc_corr,
    -- SUBCONJUNTO de `desconto_corrigido` (nunca somar as duas). Ausente no retorno = RPC
    -- anterior no ar; a edge grava `null`, nunca 0 — ausente != zero.
    'desconto_corrigido_para_null', v_desc_corr_null,$a7n$;
BEGIN
  -- `to_regprocedure` resolve por TIPOS e devolve NULL em vez de erro: o cast cru derrubaria o
  -- apply inteiro com a mensagem errada.
  IF to_regprocedure(v_fn) IS NULL THEN
    RAISE EXCEPTION 'patch: % nao existe nesta base', v_fn;
  END IF;
  v_def := pg_get_functiondef(to_regprocedure(v_fn));

  IF position('desc_corrigido_para_null' IN v_def) > 0 THEN
    RAISE NOTICE 'patch: a funcao JA separa a nulificacao — idempotente, nada a trocar';
    RETURN;
  END IF;

  -- Cada ancora EXATAMENTE 1x no corpo VIVO. 0x = o corpo mudou e esta troca precisa ser revista;
  -- 2x+ = a troca atingiria um sitio que eu nao inspecionei.
  IF (length(v_def) - length(replace(v_def, v_a1v, ''))) / length(v_a1v) <> 1 THEN
    RAISE EXCEPTION 'patch: ancora A1 (declaracao por pedido) nao aparece 1x no corpo vivo';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a2v, ''))) / length(v_a2v) <> 1 THEN
    RAISE EXCEPTION 'patch: ancora A2 (declaracao agregada) nao aparece 1x no corpo vivo';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a3v, ''))) / length(v_a3v) <> 1 THEN
    RAISE EXCEPTION 'patch: ancora A3 (zeramento por pedido) nao aparece 1x no corpo vivo';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a4v, ''))) / length(v_a4v) <> 1 THEN
    RAISE EXCEPTION 'patch: ancora A4 (predicado desc_corrigido) nao aparece 1x no corpo vivo';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a5v, ''))) / length(v_a5v) <> 1 THEN
    RAISE EXCEPTION 'patch: ancora A5 (projecao INTO) nao aparece 1x no corpo vivo';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a6v, ''))) / length(v_a6v) <> 1 THEN
    RAISE EXCEPTION 'patch: ancora A6 (acumulacao) nao aparece 1x no corpo vivo';
  END IF;
  IF (length(v_def) - length(replace(v_def, v_a7v, ''))) / length(v_a7v) <> 1 THEN
    RAISE EXCEPTION 'patch: ancora A7 (chave do retorno) nao aparece 1x no corpo vivo';
  END IF;

  v_novo := replace(replace(replace(replace(replace(replace(replace(
              v_def, v_a1v, v_a1n), v_a2v, v_a2n), v_a3v, v_a3n), v_a4v, v_a4n),
              v_a5v, v_a5n), v_a6v, v_a6n), v_a7v, v_a7n);
  IF v_novo = v_def THEN
    RAISE EXCEPTION 'patch: a substituicao nao mudou nada — nao reexecuto corpo identico';
  END IF;

  -- CREATE OR REPLACE (nunca DROP): `REPLACE` preserva o ACL; `DROP`+`CREATE` o RESETA.
  EXECUTE v_novo;
END
$patch$;

-- ─── 2. Pós-condições — a (b) e a (c) EXECUTAM a funcao, nao so a criam ───────────────────
DO $post$
DECLARE
  v_def text := pg_get_functiondef(to_regprocedure('public.reconciliar_pedidos_omie(jsonb,text[],timestamptz)'));
  v_ret jsonb;
  v_i   int;
  v_j   int;
BEGIN
  -- (a) o corpo recriado tem a chave nova E manteve a antiga.
  IF position('desconto_corrigido_para_null' IN v_def) = 0
     OR position($q$'desconto_corrigido', v_desc_corr$q$ IN v_def) = 0 THEN
    RAISE EXCEPTION 'postcondicao (a): o corpo recriado perdeu uma das duas chaves de desconto';
  END IF;

  -- (b) plpgsql e LATE-BOUND: `CREATE` passar nao prova nada. Esta chamada EXECUTA a funcao com
  --     payload VAZIO — zero pedido, zero escrita — e so assim o corpo novo e de fato compilado.
  v_ret := public.reconciliar_pedidos_omie(
             '[]'::jsonb,
             ARRAY['importado','separacao','enviado','faturado','cancelado'],
             now());
  IF (v_ret -> 'desconto_corrigido_para_null') IS NULL THEN
    RAISE EXCEPTION 'postcondicao (b): a funcao EXECUTOU mas nao devolveu desconto_corrigido_para_null';
  END IF;
  IF (v_ret ->> 'desconto_corrigido_para_null') <> '0'
     OR (v_ret ->> 'desconto_corrigido') <> '0'
     OR (v_ret ->> 'desconto_apurado') <> '0' THEN
    RAISE EXCEPTION 'postcondicao (b): payload vazio devia dar 0/0/0, veio %/%/%',
      v_ret ->> 'desconto_apurado', v_ret ->> 'desconto_corrigido',
      v_ret ->> 'desconto_corrigido_para_null';
  END IF;

  -- (c) CONTENCAO estrutural: o predicado da nulificacao e o PRIMEIRO disjunto do `desc_corrigido`,
  --     entao `desc_corrigido_para_null` TRUE implica `desc_corrigido` TRUE. Aqui se prova que o
  --     predicado novo nasceu DEPOIS do antigo e dentro do mesmo CTE `upd` — se alguem reordenar a
  --     ponto de inverter isso, a conta de subconjunto deixa de valer e este apply reclama.
  v_i := position('AS desc_corrigido,' IN v_def);
  v_j := position('AS desc_corrigido_para_null,' IN v_def);
  IF v_i = 0 OR v_j = 0 OR v_j <= v_i THEN
    RAISE EXCEPTION 'postcondicao (c): a contencao corrigido_para_null ⊆ corrigido nao esta '
                    'estrutural no corpo (i=%, j=%)', v_i, v_j;
  END IF;
END
$post$;

SELECT 'FIM_APLICACAO_OK';
