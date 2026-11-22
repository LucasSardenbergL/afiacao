import { useEffect, useState } from 'react';
import { addDays, format, isSameDay } from 'date-fns';
import { ptBR } from 'date-fns/locale';

export interface DiaEntrega {
  date: Date;
  /** "hoje · sexta 21/11", "segunda 24/11"… */
  label: string;
  /** yyyy-MM-dd — o que vai em `ready_by_date`. */
  value: string;
}

/**
 * B3 (rodada 2): o seletor "Dia de entrega" montava seg–sex da semana CORRENTE (`startOfWeek`) — na
 * quinta oferecia segunda, terça e quarta já passadas, e o pedido ia com entrega no passado.
 * Agora: os próximos `n` dias ÚTEIS a partir de hoje (hoje entra se for dia útil). `hoje` é injetado
 * para o teste; a tela passa `new Date()`.
 */
export function proximosDiasUteis(hoje: Date, n = 5): DiaEntrega[] {
  const dias: DiaEntrega[] = [];
  for (let d = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate()); dias.length < n; d = addDays(d, 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const base = format(d, 'EEEE dd/MM', { locale: ptBR });
    dias.push({
      date: d,
      label: isSameDay(d, hoje) ? `hoje · ${base}` : base,
      value: format(d, 'yyyy-MM-dd'),
    });
  }
  return dias;
}

/** Dia LOCAL em yyyy-MM-dd (o mesmo eixo de `proximosDiasUteis` e do `ready_by_date`). */
export function diaLocalISO(agora: Date = new Date()): string {
  return format(agora, 'yyyy-MM-dd');
}

/** Meia-noite local de um yyyy-MM-dd (inverso de `diaLocalISO`). */
export function dataLocalDeISO(dia: string): Date {
  const [y, m, d] = dia.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Follow-up do #4068 (Codex): data escolhida que ficou ANTES do 1º dia oferecido (a tela atravessou a
 * virada do dia) — ir assim seria `ready_by_date` no passado. Comparação lexical de yyyy-MM-dd.
 */
export function dataEntregaVencida(escolhida: string | null | undefined, dias: ReadonlyArray<DiaEntrega>): boolean {
  if (!escolhida || dias.length === 0) return false;
  return escolhida < dias[0].value;
}

/**
 * Follow-up do #4068 (Codex P2): o timer da virada acorda com folga, então um clique em Enviar logo
 * após a meia-noite ainda via a data de ontem. O caminho de envio confere pelo relógio de AGORA.
 */
export function dataEntregaJaPassou(escolhida: string | null | undefined, hoje: string = diaLocalISO()): boolean {
  return !!escolhida && escolhida < hoje;
}

/** Folga depois da meia-noite: o timer não acorda um instante ANTES da virada. */
const FOLGA_VIRADA_MS = 1_000;

/**
 * Follow-up do #4068 (Codex): o "hoje" do seletor ficava congelado no 1º render (`useMemo([])`) — a
 * tela aberta de um dia para o outro seguia rotulando ontem como "hoje". Recalcula na meia-noite local
 * (timer) e quando a aba volta a ficar visível (o timer de aba em segundo plano dorme). Só muda na
 * virada, então não há render à toa.
 */
export function useHojeLocal(): string {
  const [hoje, setHoje] = useState(() => diaLocalISO());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const agendar = () => {
      const agora = new Date();
      const amanha = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1);
      timer = setTimeout(() => { setHoje(diaLocalISO()); agendar(); }, amanha.getTime() - agora.getTime() + FOLGA_VIRADA_MS);
    };
    const aoVoltar = () => { if (document.visibilityState === 'visible') setHoje(diaLocalISO()); };
    agendar();
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', aoVoltar);
    };
  }, []);
  return hoje;
}
