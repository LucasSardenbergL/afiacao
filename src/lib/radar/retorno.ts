/**
 * Radar, pacote G1 — data de retorno do "em conversa" (migration 20261111100000).
 *
 * O servidor é quem manda: aceita de HOJE (BRT) a hoje+60 (RD008 fora disso) e, sem data, usa hoje+7 em dia útil.
 * Aqui só a sugestão e a faixa para a ficha não mandar o que vai ser recusado. Datas são dia civil 'YYYY-MM-DD' no
 * fuso de São Paulo — nunca `new Date('YYYY-MM-DD')`, que é meia-noite UTC e cai no dia ANTERIOR em BRT.
 */

export const RETORNO_MAX_DIAS = 60;
const RETORNO_PADRAO_DIAS = 7;

const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Hoje no fuso de São Paulo, 'YYYY-MM-DD'. */
export function hojeBRT(agora: Date = new Date()): string {
  // en-CA formata como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(agora);
}

function paraUTC(dia: string): Date {
  const m = RE_DIA.exec(dia);
  if (!m) throw new Error(`dia fora do formato YYYY-MM-DD: ${dia}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function deUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function somarDias(dia: string, n: number): string {
  const d = paraUTC(dia);
  d.setUTCDate(d.getUTCDate() + n);
  return deUTC(d);
}

/** Sábado e domingo vão para a segunda — a mesma regra de `private.radar_dia_util`. */
export function diaUtil(dia: string): string {
  const dow = paraUTC(dia).getUTCDay(); // 0 = domingo, 6 = sábado
  if (dow === 6) return somarDias(dia, 2);
  if (dow === 0) return somarDias(dia, 1);
  return dia;
}

/** A sugestão que vem marcada: a mesma data que o servidor usaria sem data. */
export function retornoPadrao(hoje: string): string {
  return diaUtil(somarDias(hoje, RETORNO_PADRAO_DIAS));
}

export interface OpcaoRetorno { rotulo: string; dia: string; padrao: boolean }

/** Chips do passo "Quando retomar?". "Hoje" existe: o cliente pode ter pedido "liga hoje à tarde". */
export function opcoesRetorno(hoje: string): OpcaoRetorno[] {
  const padrao = retornoPadrao(hoje);
  return [
    { rotulo: 'Hoje', dia: hoje, padrao: false },
    { rotulo: 'Amanhã', dia: somarDias(hoje, 1), padrao: false },
    { rotulo: 'Em 3 dias', dia: diaUtil(somarDias(hoje, 3)), padrao: false },
    { rotulo: 'Em 1 semana', dia: padrao, padrao: true },
    { rotulo: 'Em 2 semanas', dia: diaUtil(somarDias(hoje, 14)), padrao: false },
  ];
}

/** Dentro da faixa que o servidor aceita? (comparação de string vale: o formato é fixo). */
export function retornoValido(dia: string, hoje: string): boolean {
  if (!RE_DIA.test(dia)) return false;
  return dia >= hoje && dia <= somarDias(hoje, RETORNO_MAX_DIAS);
}

/** 'YYYY-MM-DD' → 'dd/mm' sem passar por Date (sem deslocamento de fuso). */
export function diaMesData(dia: string): string {
  const m = RE_DIA.exec(dia);
  return m ? `${m[3]}/${m[2]}` : dia;
}

/** Dias entre hoje e o retorno (negativo = atrasado). */
export function diasAte(dia: string, hoje: string): number {
  return Math.round((paraUTC(dia).getTime() - paraUTC(hoje).getTime()) / 86_400_000);
}
