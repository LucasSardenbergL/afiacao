// src/lib/venda-cliente/sugestoes.ts
// Contrato TS da RPC `venda_minhas_sugestoes` (Task 1, SECURITY DEFINER, auth.uid()).
// A RPC devolve jsonb — o tipo gerado é `Json`, então a forma é conferida AQUI, em runtime.
// Fail-closed: forma inesperada lança (a fila mostra "não consegui carregar"), nunca vira
// lista vazia. Ausente ≠ zero: número ausente/ilegível vira `null`, nunca `0`.
//
// ⚠️ A farmer nunca vê custo: a RPC não devolve cmc/markup/piso, e este contrato também não
// tem onde guardar. `preco_alvo` (Onda 3, só repasse aprovado) só aparece na seção Preço.

export interface SugestaoItem {
  id: string;
  /** 'recompra' na Onda 1; 'complemento'/'preco' chegam nas Ondas 2–3. */
  tipo: string;
  /** conta Omie: 'oben' | 'colacor' */
  empresa: string;
  omieCodigoProduto: number | null;
  descricao: string | null;
  familia: string | null;
  qtdRef: number | null;
  valorRef: number | null;
  precoAlvo: number | null;
  /** Só recompra: a cada quantos dias o cliente costuma comprar este SKU (null = sem leitura). */
  cadenciaDias: number | null;
}

export interface CompradorSugerido {
  compradorId: string;
  nome: string | null;
  telefone: string | null;
  motivoEntrada: string;
  /** soma dos valores de referência; `null` se QUALQUER sugestão não tem valor (a RPC decide). */
  valorRefTotal: number | null;
  sugestoes: SugestaoItem[];
}

/** Liga/desliga das Ondas 2 e 3 no SERVIDOR (`venda_config`, avaliado por `venda_avaliar_ondas`). */
export interface OndasVenda {
  complemento: boolean;
  preco: boolean;
}

export const ONDAS_DESLIGADAS: OndasVenda = { complemento: false, preco: false };

export interface MinhasSugestoesResp {
  dia: string;
  ondas: OndasVenda;
  compradores: CompradorSugerido[];
}

function numOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function textoOuNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

function exigirTexto(v: unknown, campo: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new Error(`venda_minhas_sugestoes: campo ${campo} ausente`);
  }
  return v;
}

function ehObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * `ondas` ausente = servidor anterior à migration das Ondas 2–3 (o Publish pode chegar antes dela):
 * seções novas DESLIGADAS — portão fechado, não número fabricado. Presente com forma errada lança.
 */
function lerOndas(v: unknown): OndasVenda {
  if (v === undefined || v === null) return ONDAS_DESLIGADAS;
  if (!ehObjeto(v) || typeof v.complemento !== 'boolean' || typeof v.preco !== 'boolean') {
    throw new Error('venda_minhas_sugestoes: ondas malformadas');
  }
  return { complemento: v.complemento, preco: v.preco };
}

/** Lê a resposta crua da RPC. Lança se a forma não for a esperada (fail-closed). */
export function lerMinhasSugestoes(raw: unknown): MinhasSugestoesResp {
  if (!ehObjeto(raw) || !Array.isArray(raw.compradores)) {
    throw new Error('venda_minhas_sugestoes: resposta sem compradores');
  }
  return {
    dia: exigirTexto(raw.dia, 'dia'),
    ondas: lerOndas(raw.ondas),
    compradores: raw.compradores.map((c): CompradorSugerido => {
      if (!ehObjeto(c) || !Array.isArray(c.sugestoes)) {
        throw new Error('venda_minhas_sugestoes: comprador malformado');
      }
      return {
        compradorId: exigirTexto(c.comprador_id, 'comprador_id'),
        nome: textoOuNull(c.nome),
        telefone: textoOuNull(c.telefone),
        motivoEntrada: textoOuNull(c.motivo_entrada) ?? 'recompra atrasada',
        valorRefTotal: numOuNull(c.valor_ref_total),
        sugestoes: c.sugestoes.map((s): SugestaoItem => {
          if (!ehObjeto(s)) throw new Error('venda_minhas_sugestoes: sugestão malformada');
          return {
            id: exigirTexto(s.id, 'sugestoes.id'),
            tipo: exigirTexto(s.tipo, 'sugestoes.tipo'),
            empresa: exigirTexto(s.empresa, 'sugestoes.empresa'),
            omieCodigoProduto: numOuNull(s.omie_codigo_produto),
            descricao: textoOuNull(s.descricao),
            familia: textoOuNull(s.familia),
            qtdRef: numOuNull(s.qtd_ref),
            valorRef: numOuNull(s.valor_ref),
            precoAlvo: numOuNull(s.preco_alvo),
            cadenciaDias: numOuNull(s.cadencia_dias),
          };
        }),
      };
    }),
  };
}

/** Só as sugestões de RECOMPRA (as outras ondas têm seção própria na ficha, sem score comum). */
export function sugestoesDeRecompra(c: CompradorSugerido): SugestaoItem[] {
  return c.sugestoes.filter((s) => s.tipo === 'recompra');
}

/** "Oferecer também" (Onda 2): uma sugestão por família, gerada no servidor. */
export function sugestoesDeComplemento(c: CompradorSugerido): SugestaoItem[] {
  return c.sugestoes.filter((s) => s.tipo === 'complemento' && s.familia != null);
}

/** "Preço" (Onda 3): só SKU com repasse aprovado e vigente quando a lista foi gerada. */
export function sugestoesDePreco(c: CompradorSugerido): SugestaoItem[] {
  return c.sugestoes.filter((s) => s.tipo === 'preco' && s.omieCodigoProduto != null);
}
