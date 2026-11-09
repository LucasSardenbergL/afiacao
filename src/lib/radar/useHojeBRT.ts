import { useEffect, useState } from 'react';
import { spDayRangeUtc } from '@/lib/time/sp-day';
import { hojeBRT } from '@/lib/radar/retorno';

/** Folga depois da meia-noite: o timer não acorda um instante ANTES da virada (e relê o mesmo dia). */
const FOLGA_MS = 1_000;

/** Quanto falta até a próxima meia-noite de São Paulo (a virada do "hoje" do servidor), com a folga. */
export function msAteViradaBRT(agora: Date = new Date()): number {
  return Math.max(0, Date.parse(spDayRangeUtc(agora).endUtc) - agora.getTime()) + FOLGA_MS;
}

/**
 * Pacote L (item 6): o "hoje" do /radar no fuso do SERVIDOR (America/Sao_Paulo — o mesmo de `radar_lista`, dos
 * retornos e da posse), e não no fuso do aparelho. Antes era calculado em hora LOCAL e congelado no 1º render
 * (`useMemo([])`): a aba aberta de um dia para o outro seguia pedindo a fila do dia anterior.
 * Recalcula na virada (timer até a meia-noite BRT) e quando a aba volta a ficar visível — o timer de aba em segundo
 * plano dorme, então a volta é o que garante. A string só muda na virada, então não há render à toa.
 */
export function useHojeBRT(): string {
  const [hoje, setHoje] = useState(() => hojeBRT());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const agendar = () => {
      timer = setTimeout(() => { setHoje(hojeBRT()); agendar(); }, msAteViradaBRT());
    };
    const aoVoltar = () => { if (document.visibilityState === 'visible') setHoje(hojeBRT()); };
    agendar();
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, []);
  return hoje;
}
