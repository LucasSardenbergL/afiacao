/**
 * Sucessor declarado na ficha do vendedor (migration 20261108000000, `venda_heranca_comprador`): o que este cliente
 * HERDOU (papel `novo`) ou REPASSOU (papel `antigo`) pelo plano de rateio vigente de uma sucessão ativa. Só itens e
 * datas — nenhum valor. Forma inesperada LANÇA: ausente ≠ "sem herança".
 */

export interface ItemHerdado {
  empresa: string;
  omieCodigoProduto: number;
  descricao: string | null;
  familia: string | null;
}

export interface Heranca {
  papel: 'novo' | 'antigo';
  eventoId: string;
  tipo: 'cisao' | 'sucessao';
  dataCorte: string;
  revisao: number;
  outroDocumento: string;
  outroNome: string | null;
  itens: ItemHerdado[];
}

const ehTexto = (v: unknown): v is string => typeof v === 'string';
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === 'string';
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function lerHerancaComprador(data: unknown): Heranca[] {
  const rpc = 'venda_heranca_comprador';
  const r = obj(data);
  if (!r || !Array.isArray(r.herancas)) throw new Error(`${rpc}: resposta fora da forma esperada`);
  return r.herancas.map((x) => {
    const h = obj(x);
    if (!h || (h.papel !== 'novo' && h.papel !== 'antigo') || !ehTexto(h.evento_id)
        || (h.tipo !== 'cisao' && h.tipo !== 'sucessao') || !ehTexto(h.data_corte)
        || typeof h.revisao !== 'number' || !ehTexto(h.outro_documento) || !textoOuNulo(h.outro_nome)
        || !Array.isArray(h.itens)) {
      throw new Error(`${rpc}: herança fora da forma esperada`);
    }
    return {
      papel: h.papel, eventoId: h.evento_id, tipo: h.tipo, dataCorte: h.data_corte, revisao: h.revisao,
      outroDocumento: h.outro_documento, outroNome: h.outro_nome,
      itens: h.itens.map((y) => {
        const i = obj(y);
        if (!i || !ehTexto(i.empresa) || typeof i.omie_codigo_produto !== 'number'
            || !textoOuNulo(i.descricao) || !textoOuNulo(i.familia)) {
          throw new Error(`${rpc}: item fora da forma esperada`);
        }
        return { empresa: i.empresa, omieCodigoProduto: i.omie_codigo_produto, descricao: i.descricao, familia: i.familia };
      }),
    };
  });
}

function dataBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** "Herdou 3 itens de DIVIMOVEIS (cisão, corte em 06/10/2026)" / "Repassou 3 itens para MARQUES (…)". */
export function textoHeranca(h: Heranca): string {
  const n = h.itens.length === 1 ? '1 item' : `${h.itens.length} itens`;
  const quem = h.outroNome ?? h.outroDocumento;
  const ctx = `${h.tipo === 'cisao' ? 'cisão' : 'sucessão'}, corte em ${dataBr(h.dataCorte)}`;
  return h.papel === 'novo' ? `Herdou ${n} de ${quem} (${ctx})` : `Repassou ${n} para ${quem} (${ctx})`;
}

/** As famílias que este cliente HERDOU, por "família|empresa" — o complemento rotula a que ele já compra via a antiga. */
export function familiasHerdadas(hs: Heranca[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const h of hs) {
    if (h.papel !== 'novo') continue;
    for (const i of h.itens) {
      if (i.familia) m.set(`${i.familia}|${i.empresa}`, h.outroNome ?? h.outroDocumento);
    }
  }
  return m;
}
