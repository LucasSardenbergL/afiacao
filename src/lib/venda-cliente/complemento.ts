// src/lib/venda-cliente/complemento.ts
// Contrato TS da RPC `venda_complemento_comprador` (Task 5): os SKUs de referência de cada família
// que "clientes parecidos compram". A RPC devolve jsonb — a forma é conferida AQUI (fail-closed).
// Nunca há estoque/disponibilidade neste contrato: sem fonte confiável, a ficha não mostra.

interface SkuReferencia {
  omieCodigoProduto: number;
  descricao: string | null;
}

export interface FamiliaComplemento {
  familia: string;
  empresa: string;
  /** `[]` = nenhum comprador parecido comprou nesta família (a RPC não inventa SKU). */
  skus: SkuReferencia[];
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Lê a resposta crua. Lança se a forma não for a esperada — a seção mostra "não consegui ler". */
export function lerComplementoComprador(raw: unknown): FamiliaComplemento[] {
  if (!ehObjeto(raw) || !Array.isArray(raw.familias)) {
    throw new Error('venda_complemento_comprador: resposta sem familias');
  }
  return raw.familias.map((f): FamiliaComplemento => {
    if (!ehObjeto(f) || typeof f.familia !== 'string' || f.familia === '' || typeof f.empresa !== 'string'
        || !Array.isArray(f.skus)) {
      throw new Error('venda_complemento_comprador: família malformada');
    }
    return {
      familia: f.familia,
      empresa: f.empresa,
      skus: f.skus.map((s): SkuReferencia => {
        const cod = ehObjeto(s) ? Number(s.omie_codigo_produto) : NaN;
        if (!ehObjeto(s) || !Number.isFinite(cod)) {
          throw new Error('venda_complemento_comprador: SKU malformado');
        }
        return {
          omieCodigoProduto: cod,
          descricao: typeof s.descricao === 'string' && s.descricao.trim() !== '' ? s.descricao : null,
        };
      }),
    };
  });
}
