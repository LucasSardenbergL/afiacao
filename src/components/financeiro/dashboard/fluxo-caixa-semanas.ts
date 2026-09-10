// Agrupamento semanal do fluxo de caixa do dashboard financeiro.
//
// Extraído de FluxoCaixaTab.tsx para virar função PURA e testável sem render: a
// aritmética do acumulado é money-path e precisa de teste que não dependa do
// relógio nem do DOM.
import type { FluxoCaixaDiario } from '@/services/financeiroService';
import { getWeekLabel } from '@/components/financeiro/dashboard/format';

export type SemanaFluxo = {
  /** Rótulo do domingo da semana (DD/MM) — o que a tela exibe. */
  label: string;
  entradas: number;
  saidas: number;
  /** Movimento da semana: realizado nos dias passados, previsto nos dias futuros. */
  saldo: number;
  /** Tem ao menos um dia `>= hoje` — está no horizonte de projeção (semana corrente em diante). */
  projetada: boolean;
  /**
   * Saldo em conta projetado para o FIM da semana. `null` quando não é projetável:
   * semana inteiramente passada (o saldo dela já é história, não projeção) ou sem
   * âncora de saldo. Nunca um número fabricado.
   */
  acumulado: number | null;
};

/** Domingo da semana de `iso` (yyyy-mm-dd), como yyyy-mm-dd. Chave de agrupamento. */
function chaveSemana(d: Date): string {
  const dom = new Date(d);
  dom.setDate(dom.getDate() - dom.getDay());
  return `${dom.getFullYear()}-${String(dom.getMonth() + 1).padStart(2, '0')}-${String(dom.getDate()).padStart(2, '0')}`;
}

/**
 * Agrupa os dias em semanas e projeta o saldo em conta.
 *
 * ⚠️ A ÂNCORA É O PRESENTE. `saldoCC` é o saldo bancário de HOJE — o dinheiro das
 * semanas PASSADAS já está dentro dele. Somar o realizado do passado por cima seria
 * contá-lo duas vezes (medido em prod 2026-09-09: a visão "todas" partia de R$ 581 mil
 * contra R$ 134 mil reais, 4,3×; oben +89%). Por isso a corrente só acumula o que ainda
 * NÃO aconteceu — os dias `>= hoje` —, e as semanas passadas não têm acumulado.
 *
 * A semana CORRENTE é o ponto onde a dupla contagem se esconde: ela mistura dias já
 * realizados (dentro do `saldoCC`) com dias a vencer. Só a parte futura dela entra na
 * corrente.
 *
 * @param hoje data de negócio em São Paulo (yyyy-mm-dd) — ver `spBusinessDate`.
 * @param saldoCC saldo bancário atual, ou `null` quando indisponível (ausente ≠ zero:
 *        sem âncora não há projeção, e a coluna degrada para "—").
 */
export function agruparSemanasFluxo(
  dias: FluxoCaixaDiario[],
  { hoje, saldoCC }: { hoje: string; saldoCC: number | null },
): SemanaFluxo[] {
  type Acc = { label: string; entradas: number; saidas: number; deltaFuturo: number; temFuturo: boolean };
  const porSemana = new Map<string, Acc>();

  // Ordena por data: o agrupamento sequencial do componente antigo dependia da ordem
  // do serviço; aqui a ordem é garantida na fonte.
  const ordenados = [...dias].sort((a, b) => a.data.localeCompare(b.data));

  for (const dia of ordenados) {
    const d = new Date(dia.data + 'T00:00:00');
    const chave = chaveSemana(d);
    let sem = porSemana.get(chave);
    if (!sem) {
      sem = { label: getWeekLabel(d), entradas: 0, saidas: 0, deltaFuturo: 0, temFuturo: false };
      porSemana.set(chave, sem);
    }

    const futuro = dia.data >= hoje;
    const entradas = futuro ? (dia.entradas_previstas || 0) : (dia.entradas_realizadas || 0);
    const saidas = futuro ? (dia.saidas_previstas || 0) : (dia.saidas_realizadas || 0);
    sem.entradas += entradas;
    sem.saidas += saidas;
    if (futuro) {
      sem.temFuturo = true;
      sem.deltaFuturo += entradas - saidas;
    }
  }

  const chaves = [...porSemana.keys()].sort();
  let ancora = saldoCC;

  return chaves.map((chave) => {
    const sem = porSemana.get(chave)!;
    if (sem.temFuturo && ancora !== null) ancora += sem.deltaFuturo;
    return {
      label: sem.label,
      entradas: sem.entradas,
      saidas: sem.saidas,
      saldo: sem.entradas - sem.saidas,
      projetada: sem.temFuturo,
      acumulado: sem.temFuturo ? ancora : null,
    };
  });
}
