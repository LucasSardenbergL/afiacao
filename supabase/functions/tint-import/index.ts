import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authorizeCronOrStaff } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// MIRROR-START tint parse-decimal-br — espelhado VERBATIM de src/lib/preco/parse-decimal-br.ts
// (Deno não importa de src/). Paridade textual garantida no CI (edge-parse-parity.test.ts).
// NÃO edite este bloco sem editar a fonte — a última a divergir quebra o teste de paridade.
export function parseDecimalBR(input: string): number | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s === '') return null;
  if (!/^-?[\d.,]+$/.test(s)) return null;

  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;

  const finish = (intPart: string, frac: string): number | null => {
    const norm = frac ? `${intPart}.${frac}` : intPart;
    if (!/^\d+(\.\d+)?$/.test(norm)) return null;
    const n = Number((neg ? '-' : '') + norm);
    return Number.isFinite(n) ? n : null;
  };
  // Agrupamento de milhar válido: primeiro grupo 1-3 dígitos, os demais exatamente 3.
  const validGrouping = (groups: string[]): boolean =>
    groups.length > 1 &&
    groups[0].length >= 1 && groups[0].length <= 3 &&
    groups.slice(1).every((g) => g.length === 3);

  const lastComma = body.lastIndexOf(',');
  const lastDot = body.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    const decSep = lastComma > lastDot ? ',' : '.';
    const grpSep = decSep === ',' ? '.' : ',';
    const parts = body.split(decSep);
    if (parts.length !== 2) return null; // 2+ separadores decimais = malformado
    const groups = parts[0].split(grpSep);
    if (!validGrouping(groups)) return null;
    return finish(groups.join(''), parts[1]);
  }

  if (lastComma >= 0) {
    const parts = body.split(',');
    if (parts.length === 2) return finish(parts[0], parts[1]);
    return validGrouping(parts) ? finish(parts.join(''), '') : null;
  }

  if (lastDot >= 0) {
    const parts = body.split('.');
    if (parts.length === 2) {
      const [intP, frac] = parts;
      // "1.234" (3 casas + inteiro 1-3 díg sem zero à esquerda) é ambíguo: 1234 ou 1.234 → null.
      if (frac.length === 3 && /^[1-9]\d{0,2}$/.test(intP)) return null;
      return finish(intP, frac);
    }
    return validGrouping(parts) ? finish(parts.join(''), '') : null;
  }

  return finish(body, '');
}
// MIRROR-END
//
// O espelho acima fica mesmo SEM uso local: `edge-parse-parity.test.ts` (vitest) lê ESTE
// arquivo e exige a função verbatim + os marcadores MIRROR. Não remova por parecer órfão.

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const auth = await authorizeCronOrStaff(req);
  if (!auth.ok) return auth.response;

  // ══════════════════════════════════════════════════════════════════════════════
  // APOSENTADO — 410 Gone (FASE 1b money-path, 2026-07-17).
  // O import CSV manual saiu do frontend no #1314 (12/07: removidos TintImport/
  // ImportCard/useDirectTintImport/preflight-files) e NÃO tem mais nenhum chamador.
  // Medido em prod antes de fechar: 0 invocações desde o #1314 (última linha
  // não-`sync_agent` em tint_importacoes é de 2026-04-17), 0 crons apontando pra cá,
  // 0 imports em andamento. O writer VIVO do catálogo é `tint_promote_sync_run`
  // (via tint-sync-agent), que ganhou a fronteira fail-closed por-linha na migration
  // 20260717163000_tint_promote_fail_closed_receita_parcial.sql.
  //
  // POR QUE 410 EM VEZ DE CONSERTAR: `processFormulas` carregava o MESMO fail-open de
  // receita PARCIAL do promote — um slot com corante presente e qtd inválida era PULADO
  // em vez de rejeitar a linha, e o delete+insert de itens não era transacional (erro só
  // em console.error). Manter uma via de ESCRITA money-path capaz de corromper receita
  // EM SILÊNCIO, sem nenhum consumidor, é superfície pura: precisão > recall manda
  // FECHAR, não remendar. O 410 torna qualquer dependência oculta VISÍVEL (erro
  // explícito) em vez de deixá-la corromper dado silenciosamente.
  //
  // O CORPO FOI REMOVIDO (#1437-fu, 18/07). O #1401 deixou as ~473 linhas do writer
  // mortas abaixo deste return — a um `return` de distância de serem ressuscitadas por
  // quem "limpasse o 410". Segue o precedente do `syncOrdersIncremental` em
  // omie-analytics-sync (aposentado em 24/06 na mesma decisão Claude+Codex): no-op puro,
  // corpo fora. O código antigo vive no git: `git show b0092d88:supabase/functions/tint-import/index.ts`.
  //
  // SE O IMPORT MANUAL VOLTAR A SER REQUISITO: implemente o fail-closed por-linha
  // (all-or-nothing por fórmula, como o Guard 4 do promote) — não ressuscite o writer
  // antigo do git direto, ele é a versão fail-open.
  // Decisão validada por Codex (gpt-5.6-sol) + fatos de prod. docs/agent/tintometrico.md.
  // ══════════════════════════════════════════════════════════════════════════════
  console.log(`[tint-import] 410 RETIRED — method=${req.method} content-type=${req.headers.get("content-type") ?? "-"}`);
  return new Response(JSON.stringify({
    error: "tint-import foi aposentado",
    code: "TINT_IMPORT_RETIRED",
    detail: "O catálogo tintométrico é alimentado pelo sync SayerSystem (tint-sync-agent → tint_promote_sync_run). O import CSV manual foi removido no #1314.",
  }), { status: 410, headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
