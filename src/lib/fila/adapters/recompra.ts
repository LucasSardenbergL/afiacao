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
 * Ausente ≠ zero: o servidor zera o total (null) se QUALQUER item não tem valor. Aí a ação usa o
 * PISO — a soma só dos itens com valor, `tipoValor: 'piso'` (exibido "≥") — para não afundar quem
 * mais compra só porque um item está sem preço. Nenhum item com valor → `valorEsperado: null`.
 */
export function adaptarRecompra(resp: MinhasSugestoesResp | null): AcaoSugerida[] {
  if (!resp) return [];
  const out: AcaoSugerida[] = [];
  for (const c of resp.compradores) {
    const itens = sugestoesDeRecompra(c);
    if (itens.length === 0) continue;
    const nome = c.nome ?? 'cliente';
    const total = c.valorRefTotal != null && Number.isFinite(c.valorRefTotal) ? c.valorRefTotal : null;
    const conhecidos = itens.map((s) => s.valorRef).filter((v): v is number => v != null && Number.isFinite(v));
    const piso = total == null && conhecidos.length > 0 ? conhecidos.reduce((a, v) => a + v, 0) : null;
    const valor = total ?? piso;
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
      tipoValor: total != null ? 'estimado' : piso != null ? 'piso' : 'sem_valor',
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
