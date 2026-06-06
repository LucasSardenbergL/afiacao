// Fase 2 — resolução do "último preço praticado" combinando LOCAL × OMIE por DATA.
//
// Fonte LOCAL (rápida/estável, mas pode defasar se a última compra foi fora do app):
//   `sales_orders.items[].valor_unitario` datado por `order_date_kpi`.
// Fonte OMIE (completa/fresca, mas lenta — vem da chamada consolidada da Fase 2):
//   último `ListarPedidos` datado por `infoCadastro.dInc` (data de INCLUSÃO real,
//   NÃO `data_previsao`).
//
// Regra (Codex): por (cliente × conta × produto), o de MAIOR data ganha; empate ou
// data ilegível → OMIE (confirmado no ERP). Determinístico → não pula. O resultado
// deve ser CONGELADO no snapshot do pedido (a UI não muda preço sozinha depois).
//
// Puro/testável; será consumido pelo frontend (não há espelho em edge — o edge só
// devolve os dados; o merge local×omie acontece no cliente, que tem as duas fontes).

/** Parseia DD/MM/YYYY (Omie) ou YYYY-MM-DD[THH:..] (local) → ms UTC do dia, ou null. */
export function parseDataFlexivel(s: string | null | undefined): number | null {
  if (!s || typeof s !== 'string') return null;
  const str = s.trim();
  let y: number, mo: number, d: number;
  const br = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) {
    d = Number(br[1]); mo = Number(br[2]); y = Number(br[3]);
  } else {
    const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!iso) return null;
    y = Number(iso[1]); mo = Number(iso[2]); d = Number(iso[3]);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const ms = Date.UTC(y, mo - 1, d);
  // Guarda contra rollover (ex.: 31 num mês de 30 dias → JS empurra pro mês seguinte).
  const chk = new Date(ms);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) return null;
  return ms;
}

export interface PrecoPonto {
  price: number;
  /** ISO (`order_date_kpi`) no local; DD/MM/YYYY (`dInc`) no Omie. */
  date: string | null;
}
export type FontePreco = 'local' | 'omie';
export interface PrecoResolvido {
  price: number;
  fonte: FontePreco;
}

/**
 * Combina os mapas de último preço LOCAL e OMIE (por omie_codigo_produto), escolhendo
 * por DATA o mais recente. Empate ou data ilegível → Omie. Preço <= 0 é inválido
 * (cai pro outro lado se válido; senão o produto fica de fora → preço de tabela).
 * Local só vence se ESTRITAMENTE mais recente (empate é do Omie, por construção).
 */
export function mergeUltimoPreco(
  local: Record<number, PrecoPonto>,
  omie: Record<number, PrecoPonto>,
): Record<number, PrecoResolvido> {
  const out: Record<number, PrecoResolvido> = {};
  const codes = new Set<number>(
    [...Object.keys(local), ...Object.keys(omie)].map(Number).filter((n) => Number.isFinite(n)),
  );
  for (const code of codes) {
    const l = local[code];
    const o = omie[code];
    const lValid = !!l && typeof l.price === 'number' && l.price > 0;
    const oValid = !!o && typeof o.price === 'number' && o.price > 0;
    if (!lValid && !oValid) continue;
    if (lValid && !oValid) { out[code] = { price: l.price, fonte: 'local' }; continue; }
    if (!lValid && oValid) { out[code] = { price: o.price, fonte: 'omie' }; continue; }

    const lMs = parseDataFlexivel(l.date);
    const oMs = parseDataFlexivel(o.date);
    let fonte: FontePreco;
    if (lMs != null && oMs == null) fonte = 'local';      // só o local tem data
    else if (lMs != null && oMs != null && lMs > oMs) fonte = 'local'; // local estritamente mais novo
    else fonte = 'omie';                                  // empate / só Omie tem data / ambas nulas → Omie
    out[code] = fonte === 'local'
      ? { price: l.price, fonte: 'local' }
      : { price: o.price, fonte: 'omie' };
  }
  return out;
}
