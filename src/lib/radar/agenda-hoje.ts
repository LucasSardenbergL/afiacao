/**
 * Pacote L (item 3): o que a agenda "Hoje" do /radar mostra, a partir da MESMA resposta do card "Prospectar hoje"
 * (`radar_prospectar_hoje`, pacote G: `retornos` e `posses`). Puro e testado.
 * Vazia = nada a FAZER hoje (nenhum retorno, nenhuma posse vencendo em 48 h): o bloco some. Posse que já venceu não é
 * ação (o lead voltou à distribuição) — só entra no rodapé quando há outra coisa para mostrar.
 * RPC anterior ao pacote G (`retornos`/`posses` null) = não sei → também não mostra (nunca "nada para hoje").
 */
import type { ProspectarHoje, RetornoHoje } from '@/lib/radar/prospectar-hoje';

type PosseVencendo = NonNullable<ProspectarHoje['posses']>['vencendo'][number];

export interface ResumoAgendaHoje {
  vazia: boolean;
  retornos: RetornoHoje[];
  /** Total de retornos do servidor (pode passar dos itens que vieram). */
  totalRetornos: number;
  retornosFora: number;
  posses: PosseVencendo[];
  vencidas7d: number;
  rotulo: string;
}

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

export function resumoAgendaHoje(d: Pick<ProspectarHoje, 'retornos' | 'posses'>): ResumoAgendaHoje {
  const retornos = d.retornos?.itens ?? [];
  const totalRetornos = d.retornos?.total ?? 0;
  const posses = d.posses?.vencendo ?? [];
  const vencidas7d = d.posses?.vencidas7d ?? 0;
  const atrasados = retornos.filter((r) => r.atrasado).length;
  const partes = [
    totalRetornos > 0 ? plural(totalRetornos, 'retorno', 'retornos') + (atrasados > 0 ? ` (${atrasados} atrasado${atrasados === 1 ? '' : 's'})` : '') : null,
    posses.length > 0 ? plural(posses.length, 'posse vencendo', 'posses vencendo') : null,
  ].filter(Boolean);
  return {
    vazia: totalRetornos === 0 && posses.length === 0,
    retornos,
    totalRetornos,
    retornosFora: Math.max(0, totalRetornos - retornos.length),
    posses,
    vencidas7d,
    rotulo: partes.join(' · '),
  };
}
