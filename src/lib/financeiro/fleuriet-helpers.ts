// Modelo de Fleuriet/Braga — cobertura estrutural do giro. Helper puro (vitest),
// espelhável no edge. Regra-mãe do módulo: NUNCA fabrica número — ausente = null +
// motivo/confiança. Classificação é as-of o balancete (NCG casado por data, ±7d).
// Spec: docs/superpowers/specs/2026-07-01-fleuriet-cobertura-giro-cockpit-design.md

export type Sinal = '+' | '-' | '~0' | null;
export type StatusCobertura =
  | 'coberta' | 'descoberta' | 'operacao_financia_giro'
  | 'fronteira' | 'inconsistente' | 'indisponivel';
export type TipoFleuriet = 'I' | 'II' | 'III' | 'IV' | 'V' | 'VI' | null;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// CDG estrutural = (PL + PNC) − ANC. Qualquer componente ausente/não-finito → null.
export function calcularCDG(i: { anc: number | null; pnc: number | null; pl: number | null }): number | null {
  const { anc, pnc, pl } = i;
  if (anc == null || pnc == null || pl == null) return null;
  if (!Number.isFinite(anc) || !Number.isFinite(pnc) || !Number.isFinite(pl)) return null;
  return round2((pl + pnc) - anc);
}

// Banda de materialidade: max(1% da receita líquida mensal, R$500 absoluto). Evita
// que ruído perto de zero troque de Tipo. Receita ausente/inválida → piso R$500.
export function materialidade(i: { receita_liquida_mensal: number | null }): number {
  const R = i.receita_liquida_mensal;
  if (R == null || !Number.isFinite(R) || R <= 0) return 500;
  return Math.max(0.01 * R, 500);
}

// Sinal com banda: |x| ≤ m → '~0' (fronteira). null/não-finito → null (ausência, não 0).
export function sinalComBanda(x: number | null, m: number): Sinal {
  if (x == null || !Number.isFinite(x)) return null;
  if (x > m) return '+';
  if (x < -m) return '-';
  return '~0';
}

// Matriz de Braga por sinais (CDG, NCG, T). As combinações '+--' e '-++' são impossíveis
// por identidade T=CDG−NCG (na v1 T é derivado, então nunca ocorrem via valores reais — a
// guarda existe para o dia em que T for medido independente).
export function tipoPorSinais(s: { cdg: Sinal; ncg: Sinal; t: Sinal }): {
  tipo: TipoFleuriet; rotulo: string | null; inconsistente: boolean;
} {
  const key = `${s.cdg ?? '?'}${s.ncg ?? '?'}${s.t ?? '?'}`;
  switch (key) {
    case '+-+': return { tipo: 'I', rotulo: 'Excelente', inconsistente: false };
    case '+++': return { tipo: 'II', rotulo: 'Sólida', inconsistente: false };
    case '++-': return { tipo: 'III', rotulo: 'Insatisfatória', inconsistente: false };
    case '-+-': return { tipo: 'IV', rotulo: 'Péssima', inconsistente: false };
    case '---': return { tipo: 'V', rotulo: 'Muito ruim', inconsistente: false };
    case '--+': return { tipo: 'VI', rotulo: 'Alto risco', inconsistente: false };
    case '+--': return { tipo: null, rotulo: null, inconsistente: true };
    case '-++': return { tipo: null, rotulo: null, inconsistente: true };
    default:    return { tipo: null, rotulo: null, inconsistente: false };
  }
}

export type ClassificacaoFleuriet = {
  status: StatusCobertura;
  tipo: TipoFleuriet;
  rotulo: string | null;
  cdg: number | null;
  ncg: number | null;
  gap: number | null;          // CDG − NCG (o "T"; caveat: NCG é gerencial, não contábil)
  cobertura: number | null;    // CDG/NCG quando NCG > materialidade; senão null
  sinais: { cdg: Sinal; ncg: Sinal; t: Sinal };
  motivos: string[];
};

export function classificarFleuriet(i: { cdg: number | null; ncg: number | null; materialidade: number }): ClassificacaoFleuriet {
  const { cdg, ncg, materialidade: m } = i;
  const vazio = {
    cdg, ncg, gap: null as number | null, cobertura: null as number | null,
    sinais: { cdg: null as Sinal, ncg: null as Sinal, t: null as Sinal },
    tipo: null as TipoFleuriet, rotulo: null as string | null,
  };

  if (cdg == null || ncg == null) {
    const motivos: string[] = [];
    if (cdg == null) motivos.push('Balanço não informado — CDG indisponível.');
    if (ncg == null) motivos.push('NCG indisponível na data do balanço.');
    return { ...vazio, status: 'indisponivel', motivos };
  }

  const gap = round2(cdg - ncg);
  const sinais = { cdg: sinalComBanda(cdg, m), ncg: sinalComBanda(ncg, m), t: sinalComBanda(gap, m) };
  const cobertura = ncg > m ? round2(cdg / ncg) : null;

  if (sinais.cdg === '~0' || sinais.ncg === '~0' || sinais.t === '~0') {
    return {
      ...vazio, gap, cobertura, sinais, status: 'fronteira',
      motivos: ['Componente próximo de zero (banda de materialidade) — sem classificação de Tipo.'],
    };
  }

  const { tipo, rotulo, inconsistente } = tipoPorSinais(sinais);
  if (inconsistente) {
    return {
      ...vazio, gap, cobertura, sinais, status: 'inconsistente',
      motivos: ['Combinação de sinais impossível por identidade — revisar inputs do balanço.'],
    };
  }

  const status: StatusCobertura = sinais.ncg === '-' ? 'operacao_financia_giro' : (gap >= 0 ? 'coberta' : 'descoberta');
  return { ...vazio, gap, cobertura, sinais, tipo, rotulo, status, motivos: [] };
}

export type SnapNcgData = { ncg: number | null; snapshot_at: string };

// Escolhe o snapshot com snapshot_at mais próximo de dataRef ('YYYY-MM-DD'). Fora de
// ±janelaDias → ncg null + fora_janela (não classifica com NCG de outra data). Ignora
// snapshots com ncg null. Mantém snapshot_at do mais próximo para exibir a defasagem.
export function escolherSnapshotNaData(i: { snapshots: SnapNcgData[]; dataRef: string; janelaDias?: number }): {
  ncg: number | null; snapshot_at: string | null; dias_delta: number | null; fora_janela: boolean;
} {
  const janela = i.janelaDias ?? 7;
  const refMs = Date.parse(i.dataRef + 'T00:00:00Z');
  let melhor: { ncg: number; snapshot_at: string; delta: number; abs: number } | null = null;
  for (const s of i.snapshots) {
    if (s.ncg == null || !Number.isFinite(s.ncg)) continue;
    const sMs = Date.parse(s.snapshot_at);
    if (!Number.isFinite(sMs)) continue;
    const delta = Math.round((sMs - refMs) / 86400000);
    const abs = Math.abs(delta);
    if (melhor == null || abs < melhor.abs) melhor = { ncg: s.ncg, snapshot_at: s.snapshot_at, delta, abs };
  }
  if (melhor == null) return { ncg: null, snapshot_at: null, dias_delta: null, fora_janela: true };
  const fora = melhor.abs > janela;
  return { ncg: fora ? null : melhor.ncg, snapshot_at: melhor.snapshot_at, dias_delta: melhor.delta, fora_janela: fora };
}

export type BalancoInput = { anc: number | null; pnc: number | null; pl: number | null; data_ref: string };
export type ClassificacaoFleurietEmpresa = ClassificacaoFleuriet & {
  data_balanco: string | null;
  data_ncg: string | null;
  idade_balanco_dias: number | null;
  confianca: 'alta' | 'media' | null;
};

// Monta a classificação por empresa: CDG do balanço + NCG casado por data + banda por
// receita. Balanço antigo (> limiar) rebaixa a confiança. Puro: hojeMs injetado.
export function classificarFleurietEmpresa(i: {
  balanco: BalancoInput | null;
  snapshots: SnapNcgData[];
  receita_liquida_mensal: number | null;
  hojeMs: number;
  janelaDias?: number;
  limiarBalancoStaleDias?: number;
}): ClassificacaoFleurietEmpresa {
  const limiarStale = i.limiarBalancoStaleDias ?? 180;
  if (i.balanco == null) {
    const base = classificarFleuriet({ cdg: null, ncg: null, materialidade: 0 });
    return {
      ...base, motivos: ['Balanço não informado — classificação estrutural indisponível.'],
      data_balanco: null, data_ncg: null, idade_balanco_dias: null, confianca: null,
    };
  }
  const cdg = calcularCDG(i.balanco);
  const snap = escolherSnapshotNaData({ snapshots: i.snapshots, dataRef: i.balanco.data_ref, janelaDias: i.janelaDias });
  const m = materialidade({ receita_liquida_mensal: i.receita_liquida_mensal });
  const base = classificarFleuriet({ cdg, ncg: snap.ncg, materialidade: m });

  const idade = Math.round((i.hojeMs - Date.parse(i.balanco.data_ref + 'T00:00:00Z')) / 86400000);
  const confianca: 'alta' | 'media' = idade > limiarStale ? 'media' : 'alta';
  const motivos = [...base.motivos];
  if (snap.fora_janela) motivos.push(`Sem NCG a ±${i.janelaDias ?? 7}d da data do balanço${snap.dias_delta != null ? ` (mais próximo: ${snap.dias_delta}d)` : ''}.`);
  if (confianca === 'media') motivos.push(`Balanço com ${idade} dias — confiança rebaixada.`);

  return { ...base, motivos, data_balanco: i.balanco.data_ref, data_ncg: snap.snapshot_at, idade_balanco_dias: idade, confianca };
}
