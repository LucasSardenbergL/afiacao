import type { MixGap } from '@/hooks/useMyMixGap';
import type { AcaoSugerida } from '../types';

export function mixGapParaAcoes(mixgap: MixGap | null): AcaoSugerida[] {
  if (!mixgap) return [];
  return mixgap.lista
    .filter(g => g.feedback_status !== 'ofertado')
    .map(g => {
      const liftCap = Math.min(Math.max(g.lift, 1), 3);
      const score = Math.min(1, g.confidence * (liftCap / 3));
      const nome = g.nome ?? 'cliente';
      return {
        fonte: 'mixgap' as const,
        entidadeId: `${g.customer_user_id}:${g.familia_faltante}`,
        clienteUserId: g.customer_user_id,
        clienteNome: g.nome,
        telefone: null,
        acao: 'Oferecer',
        titulo: `Oferecer ${g.familia_faltante} para ${nome}`,
        motivo: `Clientes parecidos compram ${g.familia_faltante} (confiança ${(g.confidence * 100).toFixed(0)}%)`,
        categoria: 'esperado' as const,
        score,
        valorEsperado: null,
        tipoValor: 'estimado' as const,
        cta: 'pedido' as const,
        dedupeKey: `${g.customer_user_id}:oferecer:${g.familia_faltante}`,
      };
    });
}
