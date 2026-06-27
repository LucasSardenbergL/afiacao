// supabase/functions/reposicao-depara-sayerlack-auto/index.ts
// De-para de fornecedor Sayerlack AUTOMÁTICO (cold-start) — money-path.
// ----------------------------------------------------------------------------
// Itens compráveis sem de-para (ex.: FOA05.6717) são invisíveis pro motor de reposição.
// Esta edge fecha esse gap automaticamente: lê o catálogo elegível, extrai o código do
// portal da descrição (parser determinístico), e grava só os mapeamentos SEGUROS (1 match),
// via RPC transacional e auditável. NÃO toca parâmetro nem dispara compra (isso é Fase 2 +
// aprovação humana). Só remove o bloqueio "sem fornecedor".
//
// GATE DE GABARITO (trava de regressão): antes de gravar, roda o parser contra os de-paras
// feitos À MÃO. Se o parser DIVERGIR de qualquer mapa manual (ou a base for pequena demais),
// ABORTA sem gravar — o parser regrediu e auto-gravar seria perigoso. (Codex: gates atuais não
// provam que o código novo está certo; o gabarito é a melhor defesa disponível.)
// A escrita em si (insert-only, gate de colisão de destino, re-validação de elegibilidade,
// auditoria) vive na RPC reposicao_aplicar_depara_sayerlack_auto — provada no PG17.
//
// Setup pg_cron (manual pós-merge). Roda 4:00 UTC — DEPOIS do omie-sync-status-produtos-diario
// (3:30 UTC, que atualiza as descrições/fonte do parser) e bem ANTES de gerar-pedidos-diario-oben
// (9:15 UTC). Codex: não rodar com catálogo velho.
//   SELECT cron.schedule('reposicao-depara-sayerlack-auto-diario', '0 4 * * *',
//     $$ SELECT net.http_post(
//       url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/reposicao-depara-sayerlack-auto',
//       headers := jsonb_build_object('x-cron-secret',
//         (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
//       timeout_milliseconds := 120000
//     ); $$);

import { createClient } from 'npm:@supabase/supabase-js@^2';
import { authorizeCronOrStaff, corsHeaders } from '../_shared/auth.ts';
import { fetchAll } from '../_shared/paginate.ts';
import { sugerirMapeamentos, validarGabarito, PARSER_VERSION } from '../_shared/sayerlack-sku.ts';

const MIN_GABARITO = 20; // base mínima de de-paras manuais p/ confiar no parser (185 em prod)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    // 1) universo elegível (catálogo comprável SEM de-para, guards do motor espelhados na view)
    const elegiveis = await fetchAll<{ sku_omie: string; sku_descricao: string | null }>(
      (f, t) => supabase.from('v_reposicao_depara_sayerlack_elegivel')
        .select('sku_omie, sku_descricao').order('sku_omie', { ascending: true }).range(f, t),
      'v_reposicao_depara_sayerlack_elegivel',
    );

    // 2) GATE DE GABARITO — o parser reproduz os de-paras MANUAIS? (exclui os automáticos: tautológico)
    const manuais = await fetchAll<{ sku_omie: string; sku_portal: string | null; observacoes: string | null }>(
      (f, t) => supabase.from('sku_fornecedor_externo')
        .select('sku_omie, sku_portal, observacoes')
        .eq('empresa', 'OBEN').ilike('fornecedor_nome', '%SAYERLACK%').eq('ativo', true)
        .order('sku_omie', { ascending: true }).range(f, t),
      'sku_fornecedor_externo:manuais',
    );
    const manuaisHumanos = manuais.filter(
      (m) => !(m.observacoes ?? '').toLowerCase().includes('extraído automaticamente'),
    );
    // descrições do catálogo p/ o gabarito (chunked p/ caber no .in())
    const codigos = [...new Set(manuaisHumanos.map((m) => Number(m.sku_omie)).filter(Number.isFinite))];
    const descMap = new Map<string, string>();
    for (let i = 0; i < codigos.length; i += 500) {
      const { data, error } = await supabase.from('omie_products')
        .select('omie_codigo_produto, descricao').in('omie_codigo_produto', codigos.slice(i, i + 500));
      if (error) throw new Error(`omie_products desc: ${error.message}`);
      (data ?? []).forEach((d: { omie_codigo_produto: number; descricao: string | null }) => {
        if (d.descricao) descMap.set(String(d.omie_codigo_produto), d.descricao);
      });
    }
    const gabarito = validarGabarito(
      manuaisHumanos.map((m) => ({ sku_omie: m.sku_omie, sku_portal: m.sku_portal, descricao: descMap.get(m.sku_omie) ?? null })),
    );
    if (gabarito.divergem.length > 0 || gabarito.batem < MIN_GABARITO) {
      return json({
        aborted: true,
        motivo: gabarito.divergem.length > 0 ? 'gabarito divergente (parser regrediu)' : 'base de gabarito insuficiente',
        gabarito: { batem: gabarito.batem, divergem: gabarito.divergem.length, nao_validavel: gabarito.naoValidavel },
        divergem_amostra: gabarito.divergem.slice(0, 10),
      });
    }

    // 3) candidatos SEGUROS (1 código extraído) do universo elegível
    const sug = sugerirMapeamentos(
      elegiveis.map((e) => ({ sku_codigo_omie: e.sku_omie, sku_descricao: e.sku_descricao })),
    );
    const candidatos = sug.seguros.map((s) => ({
      sku_omie: s.sku_omie, sku_portal: s.sku_portal, unidade_portal: s.sufixo || 'UN', sku_descricao: s.descricao,
    }));

    // 4) escrita transacional/auditável (RPC provada no PG17)
    const run_id = crypto.randomUUID();
    let resultado: Record<string, number> | null = null;
    if (candidatos.length > 0) {
      const { data, error } = await supabase.rpc('reposicao_aplicar_depara_sayerlack_auto', {
        p_candidatos: candidatos, p_parser_version: PARSER_VERSION, p_run_id: run_id,
      });
      if (error) throw new Error(`rpc aplicar de-para: ${error.message}`);
      resultado = Array.isArray(data) ? data[0] : data;
    }

    return json({
      run_id,
      elegiveis: elegiveis.length,
      seguros: sug.seguros.length,
      sem_codigo: sug.semCodigo.length,
      multiplos: sug.multiplos.length,
      gabarito: { batem: gabarito.batem, divergem: gabarito.divergem.length, nao_validavel: gabarito.naoValidavel },
      resultado, // { inseridos, colisao_destino, ja_existe, nao_elegivel }
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
