/**
 * ATP fase 2 — contrato client-side do BLOQUEIO de estoque devolvido pelo edge
 * omie-vendas-sync ({success:false, blocked:'atp', recusas, …}). A garantia
 * mora no edge (RPC atp_gate_pedido, migration 20260807015000); aqui é a
 * ÚNICA tradução desse payload para o serviço de envio e a UI de backorder.
 * Parse fail-closed: shape fora do contrato NUNCA vira sucesso.
 */

/** Recusa estruturada repassada da RPC. `motivo` conhecido:
 *  'saldo_indisponivel' | 'saldo_insuficiente' (string aberta: motivo novo
 *  degrada para mensagem genérica, não quebra). */
export interface RecusaAtp {
  omie_codigo_produto: number;
  motivo: string;
  /** null = não informado (ausente ≠ zero — nunca fabricar número). */
  solicitado: number | null;
  disponivel: number | null;
}

export interface BloqueioAtpPedido {
  /** 'recusa' = sem saldo p/ reservar (backorder explícito é elegível);
   *  'verificacao_indisponivel' = o gate não obteve veredito (contingência). */
  tipo: 'recusa' | 'verificacao_indisponivel';
  recusas: RecusaAtp[];
  /** true = classe 42501/22023 (autorização/bug) — NUNCA oferece backorder. */
  semOverride: boolean;
  detalhe: string | null;
}

function parseRecusa(raw: unknown): RecusaAtp | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.omie_codigo_produto !== 'number' || !Number.isFinite(r.omie_codigo_produto)) return null;
  if (typeof r.motivo !== 'string' || r.motivo.length === 0) return null;
  return {
    omie_codigo_produto: r.omie_codigo_produto,
    motivo: r.motivo,
    solicitado: typeof r.solicitado === 'number' && Number.isFinite(r.solicitado) ? r.solicitado : null,
    disponivel: typeof r.disponivel === 'number' && Number.isFinite(r.disponivel) ? r.disponivel : null,
  };
}

/**
 * Interpreta o payload do edge. Devolve null quando NÃO é um bloqueio ATP
 * (payload de sucesso, outro gate, etc.). Quando É bloqueio: recusa malformada
 * é FILTRADA (nunca vira linha com undefined na UI) e o bloqueio permanece.
 */
export function parseBloqueioAtp(payload: unknown): BloqueioAtpPedido | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  if (p.blocked !== 'atp') return null;
  if (p.verificacao_indisponivel === true) {
    return {
      tipo: 'verificacao_indisponivel',
      recusas: [],
      semOverride: p.sem_override === true,
      detalhe: typeof p.detalhe === 'string' ? p.detalhe : null,
    };
  }
  const recusasRaw = Array.isArray(p.recusas) ? p.recusas : [];
  const recusas = recusasRaw.map(parseRecusa).filter((r): r is RecusaAtp => r !== null);
  return { tipo: 'recusa', recusas, semOverride: false, detalhe: null };
}

/** Mensagem pt-BR das recusas p/ o erro do envio (a UI estruturada usa as
 *  recusas cruas). disponivel null exibe "—" (indisponível ≠ zero). */
export function mensagemRecusasAtp(recusas: RecusaAtp[], descricaoPorSku?: Map<number, string>): string {
  const linhas = recusas.map(r => {
    const nome = descricaoPorSku?.get(r.omie_codigo_produto) ?? String(r.omie_codigo_produto);
    if (r.motivo === 'saldo_indisponivel') {
      return `${nome}: sem posição de estoque confiável (disponível —)`;
    }
    const soli = r.solicitado == null ? '—' : String(r.solicitado);
    const disp = r.disponivel == null ? '—' : String(r.disponivel);
    return `${nome}: ${soli} solicitado(s), ${disp} disponível(is)`;
  });
  return `Sem estoque disponível para reservar: ${linhas.join('; ')}.`;
}
