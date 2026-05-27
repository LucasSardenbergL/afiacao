import type { MixGap } from '@/hooks/useMyMixGap';

export type MixGapStatus = 'ofertado' | 'convertido' | 'recusado';

/** Aplica o feedback ao cache do Mix/Gap (puro, não muta). ofertado → selo;
 * convertido/recusado → remove a linha e decrementa o total. */
export function applyFeedbackToMixGap(
  mix: MixGap,
  customerUserId: string,
  _familia: string,
  status: MixGapStatus,
): MixGap {
  if (status === 'ofertado') {
    return {
      ...mix,
      lista: mix.lista.map((g) =>
        g.customer_user_id === customerUserId ? { ...g, feedback_status: 'ofertado' } : g,
      ),
    };
  }
  const lista = mix.lista.filter((g) => g.customer_user_id !== customerUserId);
  return { totalComGap: Math.max(0, mix.totalComGap - (mix.lista.length - lista.length)), lista };
}
