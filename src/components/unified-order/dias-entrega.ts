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
