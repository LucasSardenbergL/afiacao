import type { MixGap } from '@/hooks/useMyMixGap';
import type { AcaoSugerida, AcaoPayload } from '../types';

export function mixGapParaAcoes(mixgap: MixGap | null): AcaoSugerida[] {
  if (!mixgap) return [];
  return mixgap.lista
    .filter(g => g.feedback_status !== 'ofertado')
    .map(g => {
      // confidence/lift vêm de RPC jsonb (tipo só em compile-time) — sanear em runtime.
      const conf = Number.isFinite(g.confidence) ? Math.max(0, Math.min(1, g.confidence)) : 0;
      const liftRaw = Number.isFinite(g.lift) ? g.lift : 1;
      const liftCap = Math.min(Math.max(liftRaw, 1), 3);
      const score = Math.min(1, conf * (liftCap / 3));
      const nome = g.nome ?? 'cliente';
      return {
        fonte: 'mixgap' as const,
        entidadeId: `${g.customer_user_id}:${g.familia_faltante}`,
        clienteUserId: g.customer_user_id,
        clienteNome: g.nome,
        telefone: null,
        acao: 'Oferecer',
        titulo: `Oferecer ${g.familia_faltante} para ${nome}`,
        motivo: `Clientes parecidos compram ${g.familia_faltante} (confiança ${(conf * 100).toFixed(0)}%)`,
        categoria: 'esperado' as const,
        score,
        valorEsperado: null,
        tipoValor: 'estimado' as const,
        cta: 'pedido' as const,
        dedupeKey: `${g.customer_user_id}:oferecer:${g.familia_faltante}`,
        payload: { kind: 'mixgap', customerUserId: g.customer_user_id, familia: g.familia_faltante } satisfies AcaoPayload,
      };
    });
}
