// Helpers PUROS da discriminação de paginação do sync de pedidos (sem fetch/DB →
// testáveis em isolamento; ver pagination_test.ts, que roda o CÓDIGO REAL daqui).
//
// Contexto money-path (spec 2026-06-17-vendas-omie-cursor-lease-design.md): o
// backfill de pedidos do Omie quebrava porque (defeito #1) `null` colapsava
// "fim real" e "rate-limit esgotado". O conserto é usar throwOnTransient no loop
// (rate-limit → throw; fim real → null) e decidir a completude pelo FIM REAL, nunca
// por total_de_paginas (que mente — CLAUDE.md "paginar até página vazia + guard").
// Estas três decisões são o núcleo testável dessa lógica.

// Converte data do Omie (DD/MM/YYYY) para ISO (YYYY-MM-DD), usada como PK (date) do
// vendas_sync_cursor. Retorna null se o formato OU o calendário não casar — valida data
// real (31/02 não existe) por round-trip UTC, rejeitando na BORDA em vez de estourar no
// cast SQL/RPC depois (Codex: guard de borda money-path).
export function omieDateToIso(ddmmyyyy: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmyyyy.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const iso = `${yyyy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (
    Number.isNaN(d.getTime()) ||
    d.getUTCFullYear() !== Number(yyyy) ||
    d.getUTCMonth() + 1 !== Number(mm) ||
    d.getUTCDate() !== Number(dd)
  ) return null; // data impossível (ex.: 31/02, 00/13) → rejeita
  return iso;
}

// Gera janelas MENSAIS [de..ate] em DD/MM/YYYY entre duas datas ISO (YYYY-MM-DD), o mês de `ate`
// INCLUSIVE — p/ a sonda de counts (action probe_count_pedidos, Fase 2b colacor): 1 ListarPedidos
// por mês p/ achar janelas sub-sincronizadas SEM semear às cegas (veto do Codex ao buraco de ~5
// anos). Último dia do mês via Date.UTC (calendário/bissexto correto, sem timezone local). Guard
// anti-loop (600 meses ~50 anos) p/ input invertido/absurdo.
export function gerarJanelasMensais(fromIso: string, toIso: string): Array<{ mes: string; de: string; ate: string }> {
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fromIso.trim());
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(toIso.trim());
  if (!f || !t) throw new Error(`gerarJanelasMensais: datas ISO inválidas: ${fromIso}..${toIso}`);
  let y = Number(f[1]), m = Number(f[2]);
  const ty = Number(t[1]), tm = Number(t[2]);
  const out: Array<{ mes: string; de: string; ate: string }> = [];
  let guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard++ < 600) {
    const mm = String(m).padStart(2, "0");
    const ultimo = String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0");
    out.push({ mes: `${y}-${mm}`, de: `01/${mm}/${y}`, ate: `${ultimo}/${mm}/${y}` });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

// Classifica o erro transitório do Omie a partir da mensagem do OMIE_TRANSIENT
// (lançado por callOmieVendasApi quando throwOnTransient e os retries esgotaram).
// Vira o `last_error_kind` gravado no cursor (rate_limit | transient).
export function classifyOmieTransient(msg: string): 'rate_limit' | 'transient' {
  return msg.includes('rate limit') ? 'rate_limit' : 'transient';
}

// Classifica uma página de ListarPedidos (3 vias). Com throwOnTransient, rate-limit/
// transitório JÁ viraram throw antes daqui, então:
//   • 'data'    → tem pedidos → processar.
//   • 'end'     → FIM REAL: result null ("Não existem registros") OU página vazia
//                 que NÃO contradiz total_de_paginas → marca completo.
//   • 'anomaly' → página vazia que CONTRADIZ total_de_paginas (Omie diz que há mais
//                 páginas) → SUSPEITO → PAUSA, NUNCA completa.
//
// Money-path (achado Codex #6): tratar TODA página vazia como fim podia setar
// completed_at com páginas faltando (ex.: Omie devolve {total_de_paginas:8,
// pedido_venda_produto:[]} na pág 5 → pgs 6-8 perdidas). total_de_paginas NÃO é a
// autoridade de fim (ele mente — CLAUDE.md), mas serve de GUARD: precisão > recall,
// uma janela presa (visível no cursor, retomável) é infinitamente melhor que uma
// falsamente completa (perda silenciosa de pedido = comissão errada). `null` segue
// sendo o fim autoritativo; o guard só pega o caso vazio-no-meio.
export function classifyPedidosPage(
  result: Record<string, unknown> | null,
  pagina: number,
): 'data' | 'end' | 'anomaly' {
  if (!result) return 'end'; // null = "Não existem registros para a página"
  const pedidos = (result.pedido_venda_produto as unknown[] | undefined) ?? [];
  if (pedidos.length > 0) return 'data';
  // página vazia: usa total_de_paginas SÓ como guard anti-falsa-completude
  const total = Number(result.total_de_paginas) || 0;
  if (total > 0 && pagina < total) return 'anomaly'; // Omie afirma que há mais → não completa
  return 'end';
}
