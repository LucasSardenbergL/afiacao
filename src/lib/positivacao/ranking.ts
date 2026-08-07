import { valorMedido } from '@/lib/scoring/margin';
import type { ClienteAPositivar } from './types';

/** Ordena candidatos "a positivar" por prioridade comercial (não muta a entrada). */
export function rankAPositivar(candidatos: ClienteAPositivar[]): ClienteAPositivar[] {
  return [...candidatos].sort((a, b) => {
    const ps = (b.priority_score ?? 0) - (a.priority_score ?? 0);
    if (ps !== 0) return ps;
    // ⚠️ Desempate por potencial só vale entre valores MEDIDOS. Com a coluna null em 100% da base,
    // `?? 0` fazia todo mundo empatar em 0 — inerte, mas silenciosamente: quando um produtor
    // nascer, cliente sem potencial medido seria ordenado como "potencial zero".
    //
    // Ausente é empurrado pro FIM *dentro deste critério* (medido sempre vence não-medido, mesmo
    // um medido baixo) — não pula pro próximo desempate quando só um lado tem o dado. Pular quebra
    // transitividade: A(rp=100) vs C(rp=1) decide por potencial, mas A(rp=100) vs B(rp=null) e
    // B(rp=null) vs C(rp=1) cairiam os dois no churn_risk, podendo formar ciclo A>C>B>A —
    // `Array.sort` com comparador não-transitivo devolve ordem dependente da implementação.
    const rpA = valorMedido(a.revenue_potential);
    const rpB = valorMedido(b.revenue_potential);
    if (rpA != null && rpB == null) return -1;
    if (rpA == null && rpB != null) return 1;
    if (rpA != null && rpB != null) {
      const rp = rpB - rpA;
      if (rp !== 0) return rp;
    }
    return (b.churn_risk ?? 0) - (a.churn_risk ?? 0);
  });
}
