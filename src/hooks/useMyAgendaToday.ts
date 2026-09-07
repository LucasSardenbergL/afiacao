import { useMemo } from 'react';
import { useMyCarteiraScores } from './useMyCarteiraScores';
import { estadoDeLeitura, naoConsegui, desatualizado, type EstadoSemLeitura } from '@/lib/leitura/estado-de-leitura';
import { buildAgendaItems, type AgendaItem } from '@/lib/scoring/agenda';

export type { AgendaItem };

/**
 * Top N clientes da carteira priorizados por prioridade EFETIVA (base do
 * calculate-scores + nudge dos sinais de call), com tipo de ação derivado
 * dos scores (escala 0..100).
 *
 * A modulação de prioridade pelos sinais acontece aqui (read-time): a coluna
 * priority_score continua sendo a base rica do calculate-scores; o
 * scoring-recalc só persiste signal_modifiers. Ver src/lib/scoring/agenda.ts.
 *
 * 🔇 POR QUE O ESTADO DA LEITURA SAI DAQUI (classe "erro colapsado em vazio",
 * docs/historico/fase-sem-sinal.md): `useMyCarteiraScores` LANÇA quando o SELECT em
 * `farmer_client_scores` falha, então `data` fica `undefined` — a MESMA condição de
 * "a carteira não tem cliente nenhum". O `data ? … : []` abaixo colapsa as duas, e o
 * consumidor herda um vazio que não sabe distinguir. Não é dano hipotético: a tabela
 * tem 6.633 linhas para os 3 vendedores, todas repontuadas hoje (psql-ro, 2026-08-23)
 * — o vazio dessa leitura é FALSO em 100% dos casos vivos hoje.
 *
 * `agenda` SEGUE degradando para `[]` de propósito (mesma decisão de `useCarteirasQueEuCubro`:
 * a tela mostra o que sabe); o que muda é que a ausência agora viaja ACOMPANHADA do motivo.
 * Dois campos porque são dois estados distintos, e o segundo é justamente o que engana
 * quem "já trata erro": com lista no cache e a rede caindo, `status` continua `success`
 * (`naoConsegui` é FALSE) e só o `fetchStatus: 'paused'` denuncia que ela está velha.
 */
export function useMyAgendaToday(limit = 10) {
  const q = useMyCarteiraScores();
  const { data, isLoading } = q;
  const estado = estadoDeLeitura(q);

  const agenda: AgendaItem[] = useMemo(
    () => (data ? buildAgendaItems(data, limit) : []),
    [data, limit],
  );

  const semLeitura: EstadoSemLeitura | null = naoConsegui(estado) ? estado : null;

  return {
    agenda,
    isLoading,
    /**
     * `erro`/`sem-rede` E nada em mãos: a tela NÃO PODE afirmar "não há" — nem, pior,
     * mandar agir sobre esse vazio. `null` quando a leitura aconteceu (inclusive quando
     * ela respondeu vazio de verdade) e em `desabilitada`, que é a pergunta não feita.
     */
    agendaIndisponivel: data === undefined ? semLeitura : null,
    /**
     * Há lista em mãos, mas a releitura falhou (erro ou sem rede): mostre a lista **e** o
     * aviso. Apagar uma agenda que está no cache porque um refetch falhou seria trocar um
     * defeito por outro — o vendedor em campo perderia justamente o que ele tem.
     */
    agendaDesatualizada: desatualizado(q, data !== undefined),
  };
}
