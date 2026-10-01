// O dDtPrevisao do IncluirPedCompra (disparar-pedidos-aprovados), no dia de NEGÓCIO (America/Sao_Paulo).
//
// POR QUE EXISTE — a classe (ii) do fuso, fase 3 (docs/historico/hoje-sp-typescript-e-data-ciclo.md).
// O `diasUteisFromHoje` do index.ts partia de `new Date()` e somava com `setDate()`/`getDay()`: no servidor
// (UTC), das 21:00 às 23:59 BRT o "hoje" dele já era AMANHÃ — o pedido aprovado à noite (aprovar = disparar
// na hora) ia ao Omie com a previsão um dia útil adiante. Aqui o hoje é o de SP e a soma é de CALENDÁRIO
// (UTC puro, sem fuso no meio). O ramo do portal (entrega confirmada + 2 dias úteis) já era calendário puro
// e segue igual. Lógica PURA (o instante é injetável); testes em previsao_test.ts.
import { hojeSP, paraDataOmie } from "../_shared/hoje-sp.ts";

const DIA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Soma `n` dias ÚTEIS (seg–sex; feriado não conta) a uma data `YYYY-MM-DD`. O laço é o do código velho:
 * `n` ≤ 0 devolve o próprio dia. Data malformada LANÇA.
 */
export function somarDiasUteis(dia: string, n: number): string {
  const m = DIA_ISO.exec(dia);
  if (!m) throw new RangeError(`somarDiasUteis: data inválida (${dia})`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  let adicionados = 0;
  while (adicionados < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay(); // 0=domingo, 6=sábado
    if (dow !== 0 && dow !== 6) adicionados++;
  }
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * O dDtPrevisao (DD/MM/AAAA): a entrega confirmada no portal (`YYYY-MM-DD`) + 2 dias úteis; sem ela,
 * HOJE em SP + o lead time logístico em dias úteis.
 */
export function dataPrevisaoOmie(e: { portalDataEntrega: unknown; ltDias: number; agora: Date }): string {
  const base = typeof e.portalDataEntrega === "string" && DIA_ISO.test(e.portalDataEntrega)
    ? somarDiasUteis(e.portalDataEntrega, 2)
    : somarDiasUteis(hojeSP(e.agora), e.ltDias);
  return paraDataOmie(base);
}
