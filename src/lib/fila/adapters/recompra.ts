import type { MinhasSugestoesResp } from '@/lib/venda-cliente/sugestoes';
import { sugestoesDeRecompra } from '@/lib/venda-cliente/sugestoes';
import type { AcaoSugerida, AcaoPayload } from '../types';

function itensAtrasados(n: number): string {
  return n === 1 ? '1 item atrasado' : `${n} itens atrasados`;
}

/**
 * Lista de recompra (gerada no servidor, `venda_minhas_sugestoes`) → ações da fila.
 * 1 ação por COMPRADOR (a ligação é por cliente, não por SKU). Quem entra e em que ordem
 * o servidor já decidiu; aqui só se traduz para o contrato da fila.
 * Ausente ≠ zero: comprador sem valor de referência → `valorEsperado: null` (vai por último).
 */
export function adaptarRecompra(resp: MinhasSugestoesResp | null): AcaoSugerida[] {
  if (!resp) return [];
  const out: AcaoSugerida[] = [];
  for (const c of resp.compradores) {
    const itens = sugestoesDeRecompra(c);
    if (itens.length === 0) continue;
    const nome = c.nome ?? 'cliente';
    const valor = c.valorRefTotal != null && Number.isFinite(c.valorRefTotal) ? c.valorRefTotal : null;
    out.push({
      fonte: 'recompra',
      entidadeId: c.compradorId,
      clienteUserId: c.compradorId,
      clienteNome: c.nome,
      telefone: c.telefone,
      acao: 'Ligar',
      titulo: nome,
      motivo: `${c.motivoEntrada} · ${itensAtrasados(itens.length)}`,
      categoria: 'esperado',
      // a ordem dentro da categoria vem do valor; o score só desempata (mais itens primeiro).
      score: Math.min(1, itens.length / 10),
      valorEsperado: valor,
      tipoValor: valor != null ? 'estimado' : 'sem_valor',
      cta: 'ligar',
      dedupeKey: `recompra:${c.compradorId}`,
      payload: {
        kind: 'recompra',
        compradorId: c.compradorId,
        sugestaoIds: itens.map((s) => s.id),
      } satisfies AcaoPayload,
    });
  }
  return out;
}
