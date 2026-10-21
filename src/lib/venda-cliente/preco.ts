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

function centavos(v: number): number {
  return Math.round(v * 100);
}

/**
 * O repasse vigente AO VIVO que corresponde a ESTA linha `preco`: mesmo SKU E mesmo alvo da linha
 * (em centavos). Repasse substituído depois da geração (outro alvo) não casa — a ficha mostra só o
 * último preço e não marca a linha como vista, porque o desfecho mede o alvo GRAVADO (Codex P2).
 */
export function alvoDaSugestao(
  s: { omieCodigoProduto: number | null; precoAlvo: number | null },
  alvos: PrecoAlvo[] | null,
): PrecoAlvo | undefined {
  if (s.omieCodigoProduto == null || s.precoAlvo == null || !alvos) return undefined;
  return alvos.find((a) => a.omieCodigoProduto === s.omieCodigoProduto && centavos(a.precoAlvo) === centavos(s.precoAlvo as number));
}
