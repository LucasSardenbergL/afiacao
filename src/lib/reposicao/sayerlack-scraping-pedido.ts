// Helpers puros do scraping do pedido Sayerlack (valida grupo via Prz Ent + captura custo).
// ⚠️ A captura de custo (casarLinhasComItens/derivarCustos) é espelhada VERBATIM no Deno da
// edge enviar-pedido-portal-sayerlack (Deno não importa de src/). Mantenha as duas em sincronia.

export function parseBRL(s: string): number | null {
  if (typeof s !== 'string') return null;
  const limpo = s.replace(/[^\d,.-]/g, '').trim();
  if (!limpo) return null;
  const normal = limpo.replace(/\./g, '').replace(',', '.'); // pt-BR: ponto=milhar, vírgula=decimal
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

export function parseDiasPrzEnt(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) ? n : null;
}

export interface LinhaPortal { sku_portal: string; prz_ent_raw: string; total_raw: string; }
export interface ItemPedido {
  item_id: number; sku_codigo_omie: string; sku_descricao: string | null;
  sku_portal: string | null; qtde_final: number; preco_atual: number;
}
export interface Casado { item: ItemPedido; prz_ent: number | null; total_linha: number | null; }
export interface ResultadoMatch { casados: Casado[]; naoCasados: ItemPedido[]; ambiguos: ItemPedido[]; }

function normPortal(s: string | null): string { return (s ?? '').trim().toUpperCase(); }

export function casarLinhasComItens(linhas: LinhaPortal[], itens: ItemPedido[]): ResultadoMatch {
  const casados: Casado[] = [];
  const naoCasados: ItemPedido[] = [];
  const ambiguos: ItemPedido[] = [];

  const itensPorSku = new Map<string, ItemPedido[]>();
  for (const it of itens) {
    const k = normPortal(it.sku_portal);
    if (!k) { naoCasados.push(it); continue; }
    const arr = itensPorSku.get(k) ?? [];
    arr.push(it); itensPorSku.set(k, arr);
  }
  const linhasPorSku = new Map<string, LinhaPortal[]>();
  for (const ln of linhas) {
    const k = normPortal(ln.sku_portal);
    if (!k) continue;
    const arr = linhasPorSku.get(k) ?? [];
    arr.push(ln); linhasPorSku.set(k, arr);
  }
  for (const [k, its] of itensPorSku) {
    const lns = linhasPorSku.get(k) ?? [];
    if (its.length > 1 || lns.length > 1) { ambiguos.push(...its); continue; }
    if (lns.length === 0) { naoCasados.push(its[0]); continue; }
    casados.push({ item: its[0], prz_ent: parseDiasPrzEnt(lns[0].prz_ent_raw), total_linha: parseBRL(lns[0].total_raw) });
  }
  return { casados, naoCasados, ambiguos };
}

export interface ResultadoValidacao {
  status: 'ok' | 'mismatch' | 'indisponivel';
  mismatches: { sku_codigo_omie: string; prz_ent: number; lt_esperado: number }[];
  pulados: string[];
}

export function validarGrupoLeadtime(res: ResultadoMatch, ltEsperado: number | null): ResultadoValidacao {
  const mismatches: ResultadoValidacao['mismatches'] = [];
  const pulados: string[] = [];
  const pularTudo = () => {
    for (const c of res.casados) pulados.push(c.item.sku_codigo_omie);
    for (const i of res.naoCasados) pulados.push(i.sku_codigo_omie);
    for (const i of res.ambiguos) pulados.push(i.sku_codigo_omie);
  };
  if (ltEsperado == null || !Number.isInteger(ltEsperado)) {
    pularTudo();
    return { status: 'indisponivel', mismatches, pulados };
  }
  let validados = 0;
  for (const c of res.casados) {
    if (c.prz_ent == null) { pulados.push(c.item.sku_codigo_omie); continue; }
    validados++;
    if (c.prz_ent !== ltEsperado) {
      mismatches.push({ sku_codigo_omie: c.item.sku_codigo_omie, prz_ent: c.prz_ent, lt_esperado: ltEsperado });
    }
  }
  for (const i of res.naoCasados) pulados.push(i.sku_codigo_omie);
  for (const i of res.ambiguos) pulados.push(i.sku_codigo_omie);
  if (mismatches.length > 0) return { status: 'mismatch', mismatches, pulados };
  if (validados > 0) return { status: 'ok', mismatches, pulados };
  return { status: 'indisponivel', mismatches, pulados };
}

export interface CustoUpdate { item_id: number; preco_unitario: number; valor_linha: number; }
export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function derivarCustos(res: ResultadoMatch): { updates: CustoUpdate[]; pulados: { sku_codigo_omie: string; motivo: string }[] } {
  const updates: CustoUpdate[] = [];
  const pulados: { sku_codigo_omie: string; motivo: string }[] = [];
  for (const c of res.casados) {
    const total = c.total_linha; const qtde = c.item.qtde_final;
    if (total == null || !(total > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'total_invalido' }); continue; }
    if (!(qtde > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'qtde_invalida' }); continue; }
    if (round2(total) === round2(qtde * c.item.preco_atual)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'sem_mudanca' }); continue; }
    updates.push({ item_id: c.item.item_id, preco_unitario: total / qtde, valor_linha: total }); // precisão cheia
  }
  return { updates, pulados };
}
