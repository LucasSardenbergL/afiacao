import {
  Confianca,
  TipoSinal,
  ReguaPrecoInput,
  ReguaPrecoResult,
  DISCLAIMERS_FIXOS,
} from './types';

/** Percentil R-7 (interpolação linear) — casa com percentile_cont. Filtra não-finitos; null se vazio ou p∉[0,1]. */
export function percentil(xs: number[], p: number): number | null {
  if (!(p >= 0 && p <= 1)) return null;
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length === 0) return null;
  if (s.length === 1) return s[0];
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? s[lo] : s[lo] + (idx - lo) * (s[hi] - s[lo]);
}

/** Preço mínimo p/ margem de contribuição >= 0: imposto incide sobre o preço. */
export function calcPisoMC(cmc: number | null, aliquotaVenda: number): number | null {
  if (cmc == null || !Number.isFinite(cmc) || cmc <= 0) return null;
  if (!(aliquotaVenda >= 0 && aliquotaVenda < 1)) return null;
  return cmc / (1 - aliquotaVenda);
}

/** Referência do próprio cliente: mediana nearest-rank (valor REALMENTE pago) dos preços recentes (já 180d pela RPC). */
export function calcAutoRef(precosCliente: number[]): { ref: number; confianca: Confianca } | null {
  const s = precosCliente.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const ref = s[Math.ceil(0.5 * s.length) - 1]; // nearest-rank p50 → sempre um valor real
  return { ref, confianca: s.length >= 3 ? 'media' : 'baixa' }; // 1 cliente = ruído de negociação, nunca 'alta'
}

/** Benchmark da carteira: p65 dos comparáveis + clientes efetivos (n_eff = 1/Σshare²). */
export function calcBenchmark(comparaveis: { preco: number; clienteId: string }[]): {
  pTarget: number | null;
  n: number;
  nEff: number;
  nClientes: number;
  confianca: Confianca;
} {
  const val = comparaveis.filter((c) => Number.isFinite(c.preco) && c.preco > 0);
  const n = val.length;
  if (n === 0) return { pTarget: null, n: 0, nEff: 0, nClientes: 0, confianca: 'oculto' };
  const counts = new Map<string, number>();
  for (const c of val) counts.set(c.clienteId, (counts.get(c.clienteId) ?? 0) + 1);
  let somaShare2 = 0;
  for (const c of counts.values()) {
    const sh = c / n;
    somaShare2 += sh * sh;
  }
  const nEff = 1 / somaShare2;
  const pTarget = percentil(
    val.map((c) => c.preco),
    0.65,
  );
  let confianca: Confianca;
  if (n >= 30 && nEff >= 8) confianca = 'alta';
  else if (n >= 15 && nEff >= 5) confianca = 'media';
  else if (n >= 8 && nEff >= 3) confianca = 'baixa'; // recibo, sem botão
  else confianca = 'oculto';
  return { pTarget, n, nEff, nClientes: counts.size, confianca };
}

const ORDEM: Confianca[] = ['oculto', 'baixa', 'media', 'alta'];
const maxConf = (a: Confianca, b: Confianca) => (ORDEM.indexOf(a) >= ORDEM.indexOf(b) ? a : b);
const capDe = (c: Confianca, caps: { alta: number; media: number }) =>
  c === 'alta' ? caps.alta : c === 'media' ? caps.media : 0;

export function avaliarReguaPreco(input: ReguaPrecoInput): ReguaPrecoResult {
  const { precoAtual, cmc, cmcConfiavel, aliquotaVenda, precosCliente, comparaveis, caps } = input;
  const disclaimers = [...DISCLAIMERS_FIXOS];
  const recibos: string[] = [];
  const reasonCodes: string[] = [];
  const out = (e: Partial<ReguaPrecoResult>): ReguaPrecoResult => ({
    sinal: 'nenhum',
    confianca: 'oculto',
    precoReferencia: null,
    observedGapPct: null,
    suggestedGapPct: null,
    pisoMC: null,
    abaixoPiso: false,
    capLimitou: false,
    discordancia: false,
    recibos,
    disclaimers,
    reasonCodes,
    ...e,
  });

  if (!Number.isFinite(precoAtual) || precoAtual <= 0) {
    reasonCodes.push('preco_atual_invalido');
    return out({});
  }

  const pisoMC = calcPisoMC(cmc, aliquotaVenda);
  const abaixoPiso = pisoMC != null && precoAtual < pisoMC;

  if (abaixoPiso) {
    if (!cmcConfiavel) {
      reasonCodes.push('cmc_proxy');
      recibos.push('Possível MC negativa por custo ESTIMADO (proxy). Confira o custo real.');
      return out({ sinal: 'piso', confianca: 'baixa', pisoMC, abaixoPiso });
    }
    recibos.push(
      `Custo+imposto ≈ piso R$ ${pisoMC!.toFixed(2)}; seu preço R$ ${precoAtual.toFixed(2)} (MC negativa).`,
    );
    const gap = pisoMC! / precoAtual - 1;
    return out({
      sinal: 'piso',
      confianca: 'alta',
      precoReferencia: pisoMC,
      observedGapPct: gap,
      suggestedGapPct: gap,
      pisoMC,
      abaixoPiso,
    });
  }

  const auto = calcAutoRef(precosCliente);
  const bench = calcBenchmark(comparaveis);
  const benchValido = bench.pTarget != null && bench.confianca !== 'oculto';
  const evidenciaMax = maxConf(auto?.confianca ?? 'oculto', benchValido ? bench.confianca : 'oculto');
  const dir = (ref?: number | null) => (ref == null ? 'ausente' : ref > precoAtual ? 'acima' : 'abaixo');
  const dirAuto = dir(auto?.ref);
  const dirBench = dir(benchValido ? bench.pTarget : null);

  if ((dirAuto === 'acima' && dirBench === 'abaixo') || (dirAuto === 'abaixo' && dirBench === 'acima')) {
    reasonCodes.push('sinais_discordantes');
    recibos.push(
      `Cliente costuma pagar ~R$ ${auto!.ref.toFixed(2)}; carteira p65 R$ ${bench.pTarget!.toFixed(2)}.`,
    );
    return out({ sinal: 'nenhum', confianca: 'baixa', pisoMC, discordancia: true });
  }

  const tetos: { sinal: TipoSinal; ref: number; confianca: Confianca }[] = [];
  if (dirAuto === 'acima') tetos.push({ sinal: 'auto_ref', ref: auto!.ref, confianca: auto!.confianca });
  if (dirBench === 'acima') tetos.push({ sinal: 'benchmark', ref: bench.pTarget!, confianca: bench.confianca });

  if (tetos.length === 0) {
    reasonCodes.push('preco_acima_referencias');
    return out({ sinal: 'nenhum', confianca: evidenciaMax, pisoMC });
  }

  const teto = Math.min(...tetos.map((t) => t.ref));
  const copy = tetos.find((t) => t.sinal === 'auto_ref') ?? tetos[0]; // copy: auto_ref preferida; número: teto conservador
  const confianca = copy.confianca;
  const observedGapPct = teto / precoAtual - 1;
  const cap = capDe(confianca, caps);

  if (cap === 0) {
    reasonCodes.push('evidencia_fraca');
    recibos.push(
      copy.sinal === 'auto_ref'
        ? 'Este cliente já pagou mais (amostra pequena).'
        : 'Vendas comparáveis acima (evidência fraca).',
    );
    return out({ sinal: copy.sinal, confianca: 'baixa', pisoMC, observedGapPct });
  }

  const alvo = Math.min(teto, precoAtual * (1 + cap));
  const capLimitou = alvo < teto - 1e-9;
  recibos.push(
    copy.sinal === 'auto_ref'
      ? `Você já cobrou ~R$ ${copy.ref.toFixed(2)} deste cliente neste item.`
      : `Comparáveis recentes (mesmo porte) no p65: R$ ${bench.pTarget!.toFixed(2)}.`,
  );
  if (tetos.some((t) => t.sinal === 'benchmark'))
    disclaimers.push(`Base: ${bench.n} vendas, ${bench.nClientes} clientes, 180d, exclui este cliente.`);
  if (capLimitou)
    recibos.push(
      `Sugestão limitada ao cap +${(cap * 100).toFixed(0)}% (oportunidade observada +${(observedGapPct * 100).toFixed(0)}%).`,
    );

  return out({
    sinal: copy.sinal,
    confianca,
    precoReferencia: alvo,
    observedGapPct,
    suggestedGapPct: Math.max(0, alvo / precoAtual - 1),
    pisoMC,
    abaixoPiso: false,
    capLimitou,
  });
}
