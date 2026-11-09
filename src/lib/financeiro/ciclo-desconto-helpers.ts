import { perfilCliente, type ResumoCliente } from '@/lib/financeiro/ciclo-cliente-helpers';

/**
 * Desconto por pontualidade (Frente B, PR3): o custo do dinheiro vem do BANCO
 * (`fin_funding_inputs.custo_capital_mensal`, decisão do founder: Oben ≈ 2,5% a.m.), não da URL.
 * Ausente ⇒ `null` e o painel não calcula (ausente ≠ zero). Regra do teto em
 * `descontoMaximo` (`ciclo-cliente-helpers.ts`): d = 1 − (1+c)^(−N/30), N = antecipação de CENÁRIO.
 */

export type CustoCapitalRow = Record<string, unknown>;

export type CustoCapital = { company: string; custoMensal: number | null; fonte: string | null; em: string | null };

function numFinito(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && x.trim() !== '') { const n = Number(x); return Number.isFinite(n) ? n : null; }
  return null;
}

/** Normaliza a linha da RPC `fin_ciclo_custo_capital`. Valor fora de (0, 0,2] ⇒ null (inválido não é custo). */
export function normalizarCustoCapital(row: CustoCapitalRow): CustoCapital | null {
  const company = typeof row.company === 'string' ? row.company : null;
  if (!company) return null;
  const c = numFinito(row.custo_capital_mensal);
  return {
    company,
    custoMensal: c !== null && c > 0 && c <= 0.2 ? c : null,
    fonte: typeof row.custo_capital_fonte === 'string' ? row.custo_capital_fonte : null,
    em: typeof row.custo_capital_em === 'string' ? row.custo_capital_em : null,
  };
}

/**
 * Custo anual efetivo de "x% de desconto por N dias de antecipação", visto por quem CONCEDE:
 * recebe (1−d) hoje em vez de 1 daqui a N dias ⇒ taxa do período = 1/(1−d) − 1; anualiza por 365/N.
 * 1% por 7 dias ⇒ (1/0,99)^(365/7) − 1 ≈ 68,9% a.a. (não 1,01^(365/7) − 1 ≈ 68,0% — achado Codex).
 */
export function custoAnualDoDesconto(d: number, dias: number): number | null {
  if (!Number.isFinite(d) || d <= 0 || d >= 1 || !Number.isFinite(dias) || dias <= 0) return null;
  return Math.pow(1 / (1 - d), 365 / dias) - 1;
}

export type Elegibilidade =
  | { elegivel: true; motivo: 'atrasa' | 'pontual' | 'vencido' }
  | { elegivel: false; motivo: 'ja_antecipa' | 'sem_historico' };

/**
 * Para quem o desconto por antecipação faz sentido (decisão do founder: só onde ANTECIPA caixa de fato;
 * nunca subsidiar quem já paga antes). Perfis (achado Codex de desenho #14): quem já antecipa
 * (`folga` nas duas leituras) é inelegível; `pontual`/`atraso`/`misto` são elegíveis (há dias a ganhar);
 * sem histórico e sem vencido ⇒ sem dado, não se afirma nada. Vencido em aberto torna elegível por si.
 */
export function elegibilidadeDesconto(r: ResumoCliente): Elegibilidade {
  if ((r.nVencidas ?? 0) > 0 && (r.saldoVencido ?? 0) > 0) return { elegivel: true, motivo: 'vencido' };
  const { perfil, perfilQtd, perfilValor } = perfilCliente(r);
  if (perfil === 'sem_dado') return { elegivel: false, motivo: 'sem_historico' };
  if (perfilQtd === 'folga' && perfilValor === 'folga') return { elegivel: false, motivo: 'ja_antecipa' };
  if (perfil === 'pontual') return { elegivel: true, motivo: 'pontual' };
  return { elegivel: true, motivo: 'atrasa' };
}
