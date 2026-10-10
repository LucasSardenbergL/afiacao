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

// O SQL compara min(u/f) = max(u/f) em numeric EXATO. Aqui a coerência também é exata, em decimal (BigInt): uma
// tolerância aceitaria cadastro que o SQL recusa (Codex, adversarial da v1.9: GL u=3.240000001 → a edge converteria
// 2 GL em 6,48 e o motor, no fallback, contaria o trânsito como 8). O PostgREST entrega numeric como número JSON; o
// texto mais curto do double é o decimal do banco enquanto couber em 15 dígitos significativos — acima disso o valor
// pode ter perdido dígitos na ida e vira PROBLEMA (recusa), nunca palpite.
const DIGITOS_EXATOS = 15;

interface Decimal { n: bigint; e: number } // valor = n × 10^-e

function decimalOuNull(v: unknown): Decimal | null | "ilegivel" {
  if (v === null || v === undefined) return null;
  let texto: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "ilegivel";
    texto = String(v);
  } else if (typeof v === "string") texto = v.trim();
  else return "ilegivel";
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(texto);
  if (!m || (m[2] + (m[3] ?? "")) === "") return "ilegivel";
  const inteiro = m[2] || "0", frac = m[3] ?? "";
  const digitos = (inteiro + frac).replace(/^0+/, "").replace(/0+$/, "");
  if (typeof v === "number" && digitos.length > DIGITOS_EXATOS) return "ilegivel";
  const n = BigInt(m[1] + inteiro + frac);
  const e = frac.length - Number(m[4] ?? 0);
  return e >= 0 ? { n, e } : { n: n * 10n ** BigInt(-e), e: 0 };
}

const paraNumero = (d: Decimal): number => Number(d.n) / 10 ** d.e;

/** u1/f1 = u2/f2 ⇔ u1·f2 = u2·f1, exato. */
function mesmaRazao(u1: Decimal, f1: Decimal, u2: Decimal, f2: Decimal): boolean {
  const ladoA = u1.n * f2.n, eA = u1.e + f2.e;
  const ladoB = u2.n * f1.n, eB = u2.e + f1.e;
  const e = Math.max(eA, eB);
  return ladoA * 10n ** BigInt(e - eA) === ladoB * 10n ** BigInt(e - eB);
}

export function convPendentePorSku(linhas: readonly LinhaEquivalencia[]): ConvPendente {
  const problemas: string[] = [];
  const grupos = new Map<string, Array<{ sku: string; f: Decimal; u: Decimal | null }>>();
  for (const l of linhas) {
    const sku = String(l.sku_codigo_omie ?? "").trim();
    const f = decimalOuNull(l.fator_para_base);
    const u = decimalOuNull(l.unidades_omie_por_embalagem);
    // Valor que não se lê ou linha sem chave: o motor leria um número que este lado não vê. Ler como "sem
    // cadastro" voltaria ao pendente cru justamente no grupo que o motor converte — a classe deste conserto.
    if (!sku || f === null || f === "ilegivel" || u === "ilegivel") {
      problemas.push(`equivalência ilegível (sku=${sku || "—"} fator=${String(l.fator_para_base)} u=${String(l.unidades_omie_por_embalagem)})`);
      continue;
    }
    if (!(f.n > 0n)) continue; // fora do recorte do motor
    const chave = l.grupo_id === null || l.grupo_id === undefined ? "∅" : String(l.grupo_id);
    const g = grupos.get(chave) ?? [];
    g.push({ sku, f, u });
    grupos.set(chave, g);
  }
  const conv = new Map<string, number>();
  for (const membros of grupos.values()) {
    const todosValidos = membros.every((m) => m.u !== null && m.u.n > 0n && paraNumero(m.u) < 1e9);
    if (!todosValidos) continue;
    const [p] = membros;
    if (!membros.every((m) => mesmaRazao(m.u as Decimal, m.f, p.u as Decimal, p.f))) continue;
    for (const m of membros) conv.set(m.sku, paraNumero(m.u as Decimal));
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

/**
 * Motivo para RECUSAR o pendente do PO (C1: nada é gravado), ou null. Sem a equivalência lida — ou com linha
 * ilegível — não se sabe em que unidade o PO de um concentrado conta: publicar cru é o defeito que este módulo fecha.
 */
export function recusaPorUnidade(conv: ConvPendente | null, erroLeitura: string | null): string | null {
  if (conv === null) return `unidade do PO não lida (sku_embalagem_equivalencia: ${erroLeitura ?? "sem erro informado"})`;
  if (conv.problemas.length > 0) return `unidade do PO ilegível: ${conv.problemas.slice(0, 3).join(" | ")}`;
  return null;
}
