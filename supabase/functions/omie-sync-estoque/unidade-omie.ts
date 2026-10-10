// Unidade do "a caminho" que vem do PO — PURO, sem I/O (o `deno test --no-remote` executa este arquivo).
//
// O pendente gravado em sku_estoque_atual.estoque_pendente_entrada soma com o FÍSICO no motor, então tem de estar
// na unidade do estoque do Omie. Nos concentrados WP elas divergem (medido 2026-10-07/09, #2849): o estoque, o ponto
// e o máximo estão em LITROS; o PO (nQtde/nQtdeRec), em EMBALAGENS (QT = 0,81 L, GL = 3,24 L). O PO 1268 tinha
// quantidade 5 no WP01.3900QT = 5 QT = 4,05 L. Enquanto a linha do app está no em_transito (7 dias) o motor converte
// (em_transito × conv); quando sai da janela o PO passa a contar AQUI, e cru ele valia 2 onde eram 6,48 L (2 GL).
//
// A regra é a do `equiv` de gerar_pedidos_sugeridos_ciclo (migration 20261009194000), com UMA diferença: o fallback.
//   · grupo INTEIRO com unidades_omie_por_embalagem válida (> 0 e < 1e9) e u/fator igual entre os membros → conv = u;
//   · senão o motor usa o fator relativo no em_transito, mas o pendente do PO segue CRU (fator 1) — a conta de antes,
//     byte a byte, para todo SKU fora dos grupos cadastrados.
// O recorte das linhas é o MESMO do motor (empresa minúscula, ativo, fator_para_base > 0) — quem lê aplica o filtro.

export interface LinhaEquivalencia {
  grupo_id: unknown;
  sku_codigo_omie: unknown;
  fator_para_base: unknown;
  unidades_omie_por_embalagem: unknown;
}

export interface ConvPendente {
  /** sku → unidades Omie por embalagem do PO. SKU ausente = sem conversão (o pendente fica como o PO o conta). */
  conv: Map<string, number>;
  /** Linha que o banco tem mas este lado não sabe ler: o pendente do grupo dela não é publicável. */
  problemas: string[];
}

// O SQL compara min(u/f) = max(u/f) em numeric exato; aqui é double. Um empate exato em decimal pode diferir no
// último bit (0,3/3 ≠ 0,1 em double) — a tolerância relativa absorve isso. O caso inverso (desigual no SQL por menos
// de 1e-9 relativo) não acontece com cadastro de 2 casas decimais.
const TOLERANCIA_RELATIVA = 1e-9;

function numeroOuNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return NaN;
  const s = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function mesmaRazao(u1: number, f1: number, u2: number, f2: number): boolean {
  const a = u1 * f2, b = u2 * f1;
  return Math.abs(a - b) <= TOLERANCIA_RELATIVA * Math.max(Math.abs(a), Math.abs(b));
}

export function convPendentePorSku(linhas: readonly LinhaEquivalencia[]): ConvPendente {
  const problemas: string[] = [];
  const grupos = new Map<string, Array<{ sku: string; f: number; u: number | null }>>();
  for (const l of linhas) {
    const sku = String(l.sku_codigo_omie ?? "").trim();
    const f = numeroOuNull(l.fator_para_base);
    const u = numeroOuNull(l.unidades_omie_por_embalagem);
    // Valor que não se lê (NaN) ou linha sem chave: o motor leria um número que este lado não vê. Ler como "sem
    // cadastro" voltaria ao pendente cru justamente no grupo que o motor converte — a classe deste conserto.
    if (!sku || f === null || Number.isNaN(f) || Number.isNaN(u ?? 0)) {
      problemas.push(`equivalência ilegível (sku=${sku || "—"} fator=${String(l.fator_para_base)} u=${String(l.unidades_omie_por_embalagem)})`);
      continue;
    }
    if (!(f > 0)) continue; // fora do recorte do motor
    const chave = l.grupo_id === null || l.grupo_id === undefined ? "∅" : String(l.grupo_id);
    const g = grupos.get(chave) ?? [];
    g.push({ sku, f, u });
    grupos.set(chave, g);
  }
  const conv = new Map<string, number>();
  for (const membros of grupos.values()) {
    const todosValidos = membros.every((m) => m.u !== null && m.u > 0 && m.u < 1e9);
    if (!todosValidos) continue;
    const [p] = membros;
    if (!membros.every((m) => mesmaRazao(m.u as number, m.f, p.u as number, p.f))) continue;
    for (const m of membros) conv.set(m.sku, m.u as number);
  }
  return { conv, problemas };
}

/** Saldo do PO (embalagens) → unidades Omie. Sem conv devolve o MESMO número (byte a byte). */
export function saldoEmUnidadeOmie(saldo: number, conv: number | undefined): number {
  if (conv === undefined) return saldo;
  return Math.round(saldo * conv * 1e6) / 1e6;
}

/**
 * Par (nQtde, nQtdeRec) VÁLIDO do PO → o par que o acumulador do pendente soma. Com conv, o item passa a carregar o
 * saldo já em unidades Omie (recebido 0): o acumulador soma max(0, qtde − recebido) e chega ao MESMO número que a
 * contribuição da observação (saldoEmUnidadeOmie do mesmo saldo) — a soma por SKU das duas fecha sem tolerância.
 */
export function quantidadesEmUnidadeOmie(
  qtde: number,
  recebido: number,
  conv: number | undefined,
): { qtde: number; recebido: number } {
  if (conv === undefined) return { qtde, recebido };
  return { qtde: saldoEmUnidadeOmie(Math.max(0, qtde - recebido), conv), recebido: 0 };
}
