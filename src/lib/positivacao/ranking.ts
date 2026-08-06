import { valorMedido } from '@/lib/scoring/margin';
import type { ClienteAPositivar } from './types';

/** Ordena candidatos "a positivar" por prioridade comercial (não muta a entrada). */
export function rankAPositivar(candidatos: ClienteAPositivar[]): ClienteAPositivar[] {
  return [...candidatos].sort((a, b) => {
    const ps = (b.priority_score ?? 0) - (a.priority_score ?? 0);
    if (ps !== 0) return ps;
    // ⚠️ Desempate por potencial só vale entre valores MEDIDOS. Com a coluna null em 100% da base,
    // `?? 0` fazia todo mundo empatar em 0 — inerte, mas silenciosamente: quando um produtor
    // nascer, cliente sem potencial medido seria ordenado como "potencial zero". Ausente sai do
    // critério e cai para o próximo desempate.
    const rpB = valorMedido(b.revenue_potential);
    const rpA = valorMedido(a.revenue_potential);
    if (rpA != null && rpB != null) {
      const rp = rpB - rpA;
      if (rp !== 0) return rp;
    }
    return (b.churn_risk ?? 0) - (a.churn_risk ?? 0);
  });
}
