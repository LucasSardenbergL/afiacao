// Demanda empírica para o gate econômico (spec §5.2). Sem histórico diário de estoque em produção,
// o estoque é reconstruído para trás a partir do estoque de hoje (spec §7).

export type SerieDiaria = (number | null)[];

export interface AmostraDemanda {
  /** demanda acumulada de hoje até a chegada desta compra */
  ateChegada: number;
  /** demanda acumulada de hoje até a chegada da próxima oportunidade */
  total: number;
}

export function reconstruirEstoque(estoqueFinal: number, demanda: number[], recebimentos: number[]): number[] {
  const n = demanda.length;
  const fim = new Array<number>(n);
  fim[n - 1] = estoqueFinal;
  for (let t = n - 1; t > 0; t--) fim[t - 1] = fim[t] - (recebimentos[t] ?? 0) + demanda[t];
  return fim;
}

export function marcarCensura(demanda: number[], estoqueFimDia: number[]): SerieDiaria {
  return demanda.map((d, t) => (estoqueFimDia[t] <= 0 ? null : d));
}

const soma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function amostrasEmpiricas(serie: SerieDiaria, diasAteChegada: number, diasTotal: number): AmostraDemanda[] {
  const out: AmostraDemanda[] = [];
  for (let i = 0; i + diasTotal <= serie.length; i++) {
    const janela = serie.slice(i, i + diasTotal);
    if (janela.some((v) => v === null)) continue;
    const nums = janela as number[];
    out.push({ ateChegada: soma(nums.slice(0, diasAteChegada)), total: soma(nums) });
  }
  return out;
}

// Inversa da normal padrão (Acklam). Usada só para a comparação de estabilidade com o modelo do motor.
function inversaNormal(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pBaixo = 0.02425;
  if (p < pBaixo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pBaixo) {
    const q = p - 0.5;
    const r = q * q;
    return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/** Grade estratificada determinística (sem RNG): o mesmo input dá sempre a mesma amostra. */
export function amostrasGaussianas(media: number, sigma: number, diasAteChegada: number, diasTotal: number, n: number): AmostraDemanda[] {
  const out: AmostraDemanda[] = [];
  const resto = diasTotal - diasAteChegada;
  for (let i = 0; i < n; i++) {
    const u1 = (i + 0.5) / n;
    const u2 = (((i * 7919) % n) + 0.5) / n;
    const ate = Math.max(0, diasAteChegada * media + Math.sqrt(diasAteChegada) * sigma * inversaNormal(u1));
    const depois = Math.max(0, resto * media + Math.sqrt(resto) * sigma * inversaNormal(u2));
    out.push({ ateChegada: ate, total: ate + depois });
  }
  return out;
}

export function historicoSuficiente(serie: SerieDiaria, minOcorrencias: number): boolean {
  return serie.filter((v) => v !== null && v > 0).length >= minOcorrencias;
}
