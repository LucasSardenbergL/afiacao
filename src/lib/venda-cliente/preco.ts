// src/lib/venda-cliente/preco.ts
// Contrato TS da RPC `venda_preco_alvo_comprador` (Task 6, money-path): preço alvo SÓ de repasse
// aprovado pelo founder e vigente. A RPC devolve jsonb — a forma é conferida AQUI (fail-closed).
//
// ⚠️ A farmer nunca vê custo. O contrato guarda só o que a ficha pode mostrar: último preço, preço
// alvo, faixa de margem (qualitativa) e validade. Qualquer outro campo que viesse é DESCARTADO aqui.

export type FaixaMargem = 'verde' | 'amarelo' | 'vermelho' | 'neutro';

export interface PrecoAlvo {
  empresa: string;
  omieCodigoProduto: number;
  /** último preço praticado AO VIVO; null = sem leitura (nunca R$ 0,00) */
  ultimoPreco: number | null;
  precoAlvo: number;
  faixaMargem: FaixaMargem;
  validoAte: string;
}

const FAIXAS: readonly FaixaMargem[] = ['verde', 'amarelo', 'vermelho', 'neutro'];

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numPositivoOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Lê a resposta crua. Lança se a forma não for a esperada — nunca exibe um alvo que não leu. */
export function lerPrecoAlvoComprador(raw: unknown): PrecoAlvo[] {
  if (!Array.isArray(raw)) {
    throw new Error('venda_preco_alvo_comprador: resposta não é lista');
  }
  return raw.map((r): PrecoAlvo => {
    if (!ehObjeto(r)) throw new Error('venda_preco_alvo_comprador: item malformado');
    const cod = Number(r.omie_codigo_produto);
    const alvo = numPositivoOuNull(r.preco_alvo);
    const faixa = r.faixa_margem as FaixaMargem;
    if (!Number.isFinite(cod) || alvo == null || !FAIXAS.includes(faixa)
        || typeof r.empresa !== 'string' || typeof r.valido_ate !== 'string') {
      throw new Error('venda_preco_alvo_comprador: item malformado');
    }
    return {
      empresa: r.empresa,
      omieCodigoProduto: cod,
      ultimoPreco: numPositivoOuNull(r.ultimo_preco),
      precoAlvo: alvo,
      faixaMargem: faixa,
      validoAte: r.valido_ate,
    };
  });
}
