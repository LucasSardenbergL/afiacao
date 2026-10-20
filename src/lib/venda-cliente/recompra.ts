// Recompra por comprador × SKU × empresa — ORÁCULO puro do SQL `venda_recompra_em(p_data)` e
// `venda_situacao_em(p_data)` (migration `*_venda_cliente_recompra.sql`). Quem DECIDE em produção é o
// SQL; este arquivo existe para a paridade (db/test-venda-recompra.sh roda os dois sobre a mesma
// fixture `db/fixtures/venda-recompra.json`) e para documentar a regra num lugar legível.
//
// Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §7 Fase 1a/1b.
// Inspirado em `src/lib/whatsapp/cesta-recompra.ts`, SEM importar de lá (módulo congelado — importar
// seria vazamento de fronteira). Diferenças deliberadas: mediana pura (sem tendência), janela de 540
// dias, ≥ 3 dias distintos de pedido, preço ausente vira null (lá vira número).
//
// Regras (mudou aqui → mude o SQL, e a paridade acusa se esquecer):
// - só pedidos com data_pedido < hoje (nunca olhar o futuro) e ≥ hoje − 540 dias (inclusivo);
// - quantidade ≤ 0 é descartada (não há como dar preço unitário nem quantidade a sugerir);
// - agrupa por comprador × empresa × SKU; várias linhas no mesmo dia = 1 dia (quantidade somada);
// - n_pedidos = dias distintos de pedido; exige ≥ 3;
// - cadencia_dias = mediana dos intervalos entre dias distintos consecutivos;
// - qtd_sugerida = mediana da quantidade por dia de pedido;
// - ultimo_preco = preço líquido do último dia, médio ponderado pela quantidade das linhas COM preço;
//   null se nenhuma linha do dia tem preço (desconto não apurado ⇒ preço líquido desconhecido);
// - due_ratio = (hoje − ultima_compra) / cadencia_dias; atrasado ⇔ due_ratio ≥ 1,5
//   (comparado em inteiros: 2·dias ≥ 3·cadência, para SQL e TS não divergirem no arredondamento);
// - valor_esperado = qtd_sugerida × ultimo_preco, ou null.
// Situação do comprador (todas as empresas juntas):
// - sem_base: nenhum SKU qualificado e < 3 dias de pedido na vida (ou nenhuma compra);
// - perdido: hoje − última compra > max(3 × mediana das cadências dos SKUs, 365);
// - atrasado: algum SKU atrasado; senão em_dia.

export type Empresa = 'oben' | 'colacor' | 'colacor_sc';

export interface LinhaPedido {
  comprador_id: string;
  empresa: Empresa;
  omie_codigo_produto: number;
  quantidade: number;
  preco_unit_liquido: number | null;
  data_pedido: string; // YYYY-MM-DD
}

export interface RecompraSku {
  comprador_id: string;
  empresa: string;
  omie_codigo_produto: number;
  n_pedidos: number;
  cadencia_dias: number;
  qtd_sugerida: number;
  ultima_compra: string;
  ultimo_preco: number | null;
  due_ratio: number;
  atrasado: boolean;
  valor_esperado: number | null;
}

export type SituacaoComprador = 'em_dia' | 'atrasado' | 'perdido' | 'sem_base';

export const JANELA_DIAS = 540;
export const MIN_DIAS_PEDIDO = 3;
export const PERDIDO_MULT_CADENCIA = 3;
export const PERDIDO_PISO_DIAS = 365;

const DIA_MS = 86_400_000;

function diaNum(iso: string): number {
  return Math.round(Date.parse(`${iso}T00:00:00Z`) / DIA_MS);
}

export function diasEntre(de: string, ate: string): number {
  return diaNum(ate) - diaNum(de);
}

function mediana(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Dia {
  qtd: number;
  precoQtd: number; // Σ quantidade × preço das linhas com preço
  qtdComPreco: number;
}

export function calcularRecompra(linhas: LinhaPedido[], hoje: string): RecompraSku[] {
  const hojeN = diaNum(hoje);
  const grupos = new Map<string, { base: LinhaPedido; dias: Map<string, Dia> }>();

  for (const l of linhas) {
    const d = diaNum(l.data_pedido);
    if (d >= hojeN || d < hojeN - JANELA_DIAS) continue;
    if (!(l.quantidade > 0)) continue;
    const chave = `${l.comprador_id}|${l.empresa}|${l.omie_codigo_produto}`;
    let g = grupos.get(chave);
    if (!g) {
      g = { base: l, dias: new Map() };
      grupos.set(chave, g);
    }
    let dia = g.dias.get(l.data_pedido);
    if (!dia) {
      dia = { qtd: 0, precoQtd: 0, qtdComPreco: 0 };
      g.dias.set(l.data_pedido, dia);
    }
    dia.qtd += l.quantidade;
    if (l.preco_unit_liquido != null) {
      dia.precoQtd += l.quantidade * l.preco_unit_liquido;
      dia.qtdComPreco += l.quantidade;
    }
  }

  const out: RecompraSku[] = [];
  for (const { base, dias } of grupos.values()) {
    if (dias.size < MIN_DIAS_PEDIDO) continue;
    const datas = [...dias.keys()].sort();
    const intervalos = datas.slice(1).map((d, i) => diasEntre(datas[i], d));
    const cadencia = mediana(intervalos);
    const qtd = mediana(datas.map((d) => dias.get(d)!.qtd));
    const ultima = datas[datas.length - 1];
    const ultimoDia = dias.get(ultima)!;
    const ultimoPreco = ultimoDia.qtdComPreco > 0 ? ultimoDia.precoQtd / ultimoDia.qtdComPreco : null;
    const desde = hojeN - diaNum(ultima);
    out.push({
      comprador_id: base.comprador_id,
      empresa: base.empresa,
      omie_codigo_produto: base.omie_codigo_produto,
      n_pedidos: dias.size,
      cadencia_dias: cadencia,
      qtd_sugerida: qtd,
      ultima_compra: ultima,
      ultimo_preco: ultimoPreco,
      due_ratio: desde / cadencia,
      atrasado: 2 * desde >= 3 * cadencia,
      valor_esperado: ultimoPreco == null ? null : qtd * ultimoPreco,
    });
  }

  return out.sort(
    (a, b) =>
      a.comprador_id.localeCompare(b.comprador_id) ||
      a.empresa.localeCompare(b.empresa) ||
      a.omie_codigo_produto - b.omie_codigo_produto,
  );
}

/**
 * @param skus SKUs qualificados do comprador (todas as empresas), saída de `calcularRecompra`.
 * @param ultimaCompraQualquer última compra de QUALQUER item antes de `hoje` (histórico inteiro).
 * @param diasDePedido dias distintos de pedido antes de `hoje` (histórico inteiro, todas as empresas).
 */
export function situacaoComprador(
  skus: RecompraSku[],
  ultimaCompraQualquer: string | null,
  hoje: string,
  diasDePedido: number,
): SituacaoComprador {
  if (ultimaCompraQualquer == null) return 'sem_base';
  if (skus.length === 0 && diasDePedido < MIN_DIAS_PEDIDO) return 'sem_base';
  const cadencia = skus.length ? mediana(skus.map((s) => s.cadencia_dias)) : 0;
  const limiar = Math.max(PERDIDO_MULT_CADENCIA * cadencia, PERDIDO_PISO_DIAS);
  if (diasEntre(ultimaCompraQualquer, hoje) > limiar) return 'perdido';
  return skus.some((s) => s.atrasado) ? 'atrasado' : 'em_dia';
}

/** Σ valor_esperado dos SKUs atrasados. Nenhum atrasado → 0; atrasados todos sem preço → null. */
export function valorAtrasado(skus: RecompraSku[]): number | null {
  const atrasados = skus.filter((s) => s.atrasado);
  if (atrasados.length === 0) return 0;
  const comValor = atrasados.filter((s) => s.valor_esperado != null);
  if (comValor.length === 0) return null;
  return comValor.reduce((acc, s) => acc + (s.valor_esperado as number), 0);
}
