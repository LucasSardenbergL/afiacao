// Classificador PURO da associação NF↔PO em SOMBRA (nada é escrito no Omie).
//
// Pedido do founder (2026-10-17): NF concluída → PO "encerrado" total se todos os itens foram faturados, parcial se
// faltou algum. A API do Omie não encerra PO; o total×parcial nativo é a ASSOCIAÇÃO item da NF ↔ item do PO
// (`recebimentonfe.AlterarRecebimento`, `ASSOCIAR-PEDIDO`) — completa → "Recebido", parcial → "Recebido
// Parcialmente". Decisões (2026-10-16): sombra antes de escrever · quantidade EXATA · órfã, contrato em 2+ POs e item
// sem par vão para fila humana. Desenho revisto pelo Codex (parecer 2026-10-16, gpt-6-astra max):
//   - o candidato de cada item é empresa + fornecedor + contrato DAQUELE item + produto — nunca a união da NF;
//   - contrato composto ("a/b") e contrato em 2+ POs ficam humanos;
//   - o saldo do item do PO é CONSERVADO no agregado (duas linhas de 6 não cabem num saldo de 10);
//   - quantidade igual ao saldo, em decimal exato — menor ou maior é ambígua;
//   - SKU com equivalência de embalagem (concentrados WP) é ambíguo: rótulo de unidade igual não prova grandeza igual;
//   - ausência nunca vira "N"/0: flag, quantidade ou unidade ilegível é motivo, e lista vazia não passa num every();
//   - estado da NF, vínculo existente e elegibilidade são eixos separados.
// O resultado é PROPOSTA auditável, não autorização: a escrita futura reconsulta NF e POs e recalcula.

export const VERSAO_CLASSIFICADOR = "assoc-sombra-v1";

export type EstadoNF = "pendente" | "concluida" | "cancelada" | "ilegivel";
export type Vinculo = "nenhum" | "parcial" | "completo";
export type Classe = "associavel" | "ambigua" | "orfa" | "ja_vinculada" | "fora_de_alcance";

export interface ItemPO {
  nCodItem: unknown;
  nCodProd: unknown;
  nQtde: unknown;
  nQtdeRec?: unknown;
  cUnidade?: unknown;
}

export interface PedidoDoContrato {
  omie_codigo_pedido: number;
  numero_pedido: string | null;
  fornecedor_codigo_omie: number | null;
  /** `raw_data.produtos_consulta` do PesquisarPedCompra; `undefined` = espelho sem o documento do PO. */
  itens: ItemPO[] | undefined;
}

export interface Par {
  nSequencia: number;
  nIdPedido: number;
  nIdItPedido: number;
  quantidade: number;
  unidade: string;
}

export interface PedidoCoberto {
  nIdPedido: number;
  numero_pedido: string | null;
  cobertura: "total" | "parcial";
}

export interface Classificacao {
  estado_nf: EstadoNF;
  vinculo: Vinculo;
  classe: Classe;
  motivos: string[];
  contratos: string[];
  pares: Par[];
  pedidos: PedidoCoberto[];
}

export interface EntradaClassificador {
  detalhe: unknown;
  fornecedor_codigo_omie: number | null;
  /** Todos os POs (de qualquer situação) de cada contrato citado pela NF, já filtrados por empresa. */
  pedidosPorContrato: ReadonlyMap<string, PedidoDoContrato[]>;
  /** SKUs com equivalência de embalagem ativa; `null` = não foi possível ler (tudo vira ambíguo). */
  skusComEquivalencia: ReadonlySet<string> | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : {});

/** Flag S/N estrita: ausente ou outro valor = `null` (desconhecido), nunca "N". */
function flag(v: unknown): "S" | "N" | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return s === "S" || s === "N" ? s : null;
}

/** Decimal estrito em DEZ-MILÉSIMOS inteiros (o Omie usa até 4 casas; comparar por inteiro evita 0,1+0,2≠0,3). */
function emDezMilesimos(v: unknown): number | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === "string") s = v.trim();
  else return null;
  const m = /^(\d+)(?:\.(\d{1,4}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(4, "0");
  const n = Number(m[1]) * 10000 + Number(frac);
  return Number.isSafeInteger(n) ? n : null;
}

function idPositivo(v: unknown): number | null {
  const n = typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function texto(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function estadoDaNF(cabec: Obj): EstadoNF {
  const cancelada = flag(cabec.cCancelada);
  if (cancelada === "S") return "cancelada";
  const recebido = flag(cabec.cRecebido);
  if (cancelada === null || recebido === null) return "ilegivel";
  return recebido === "S" ? "concluida" : "pendente";
}

export function classificarAssociacao(e: EntradaClassificador): Classificacao {
  const d = obj(e.detalhe);
  const cabec = obj(d.cabec);
  const estado_nf = estadoDaNF(cabec);
  const motivos = new Set<string>();
  const contratos = new Set<string>();
  const pares: Par[] = [];
  const out = (vinculo: Vinculo, classe: Classe, pedidos: PedidoCoberto[] = []): Classificacao => ({
    estado_nf, vinculo, classe, motivos: [...motivos].sort(), contratos: [...contratos].sort(),
    pares: classe === "associavel" ? pares : [], pedidos: classe === "associavel" ? pedidos : [],
  });

  if (flag(cabec.cDevolvido) !== "N" || flag(cabec.cDevolvidoParc) !== "N") {
    motivos.add(flag(cabec.cDevolvido) === "S" || flag(cabec.cDevolvidoParc) === "S" ? "nf_devolvida" : "devolucao_ilegivel");
  }
  if (e.skusComEquivalencia === null) motivos.add("equivalencia_nao_lida");

  const itensBrutos = Array.isArray(d.itensRecebimento) ? d.itensRecebimento : null;
  if (!itensBrutos || itensBrutos.length === 0) {
    motivos.add("nf_sem_itens");
    return out("nenhum", "ambigua");
  }

  let ativos = 0, vinculados = 0, comContrato = 0;
  const sequencias = new Set<number>();
  // consumo agregado por item de PO: chave nIdPedido:nIdItPedido
  const consumo = new Map<string, { qtd: number; saldo: number; po: PedidoDoContrato }>();
  const posTocados = new Map<number, PedidoDoContrato>();

  for (const bruto of itensBrutos) {
    const it = obj(bruto);
    const cab = obj(it.itensCabec);
    const aj = obj(it.itensAjustes);
    const info = obj(it.itensInfoAdic);
    const ignorar = flag(cab.cIgnorarItem);
    if (ignorar === "S") continue;
    if (ignorar === null) motivos.add("item_ignorar_ilegivel");
    ativos++;

    if ((idPositivo(cab.nIdItPedido) ?? 0) > 0) vinculados++;
    const seq = idPositivo(cab.nSequencia);
    if (seq === null) { motivos.add("sequencia_ilegivel"); continue; }
    if (sequencias.has(seq)) motivos.add("sequencia_duplicada");
    sequencias.add(seq);

    if (flag(cab.cItemDevolvido) !== "N") motivos.add(flag(cab.cItemDevolvido) === "S" ? "item_devolvido" : "devolucao_ilegivel");
    if (flag(aj.cNaoGerarMovEstoque) !== "N") {
      motivos.add(flag(aj.cNaoGerarMovEstoque) === "S" ? "item_nao_movimenta_estoque" : "mov_estoque_ilegivel");
    }

    const contrato = texto(info.nNumPedCompra);
    if (contrato === null || contrato === "0") { motivos.add("item_sem_contrato"); continue; }
    comContrato++;
    contratos.add(contrato);
    if (contrato.includes("/")) { motivos.add("contrato_composto"); continue; }

    const produto = idPositivo(cab.nIdProduto);
    if (produto === null) { motivos.add("produto_ilegivel"); continue; }
    if (e.skusComEquivalencia?.has(String(produto))) motivos.add("sku_com_equivalencia_de_embalagem");

    const pos = (e.pedidosPorContrato.get(contrato) ?? [])
      .filter((p) => e.fornecedor_codigo_omie === null || p.fornecedor_codigo_omie === e.fornecedor_codigo_omie);
    if (e.fornecedor_codigo_omie === null) motivos.add("fornecedor_ilegivel");
    if (pos.length === 0) { motivos.add("contrato_sem_po"); continue; }
    if (pos.length > 1) { motivos.add("contrato_em_varios_pos"); continue; }
    const po = pos[0];
    if (!Array.isArray(po.itens) || po.itens.length === 0) { motivos.add("po_sem_itens"); continue; }

    const candidatos = po.itens.filter((i) => idPositivo(i.nCodProd) === produto);
    if (candidatos.length === 0) { motivos.add("item_sem_par"); continue; }
    if (candidatos.length > 1) { motivos.add("produto_repetido_no_po"); continue; }
    const alvo = candidatos[0];
    const idItem = idPositivo(alvo.nCodItem);
    const nQtde = emDezMilesimos(alvo.nQtde);
    // O Omie OMITE nQtdeRec quando nada foi recebido (mesma exceção do omie-sync-estoque); presente e torto = ilegível.
    const nQtdeRec = alvo.nQtdeRec === undefined ? 0 : emDezMilesimos(alvo.nQtdeRec);
    if (idItem === null || nQtde === null || nQtdeRec === null) { motivos.add("po_ilegivel"); continue; }

    const qtd = emDezMilesimos(aj.nQtdeRecebida);
    const unidNF = texto(aj.cUnidade)?.toUpperCase() ?? null;
    const unidPO = texto(alvo.cUnidade)?.toUpperCase() ?? null;
    if (qtd === null || qtd === 0) { motivos.add("quantidade_ilegivel"); continue; }
    if (unidNF === null || unidPO === null) { motivos.add("unidade_ilegivel"); continue; }
    if (unidNF !== unidPO) { motivos.add("unidade_divergente"); continue; }

    const chave = `${po.omie_codigo_pedido}:${idItem}`;
    const c = consumo.get(chave) ?? { qtd: 0, saldo: nQtde - nQtdeRec, po };
    c.qtd += qtd;
    consumo.set(chave, c);
    posTocados.set(po.omie_codigo_pedido, po);
    pares.push({ nSequencia: seq, nIdPedido: po.omie_codigo_pedido, nIdItPedido: idItem, quantidade: qtd / 10000, unidade: unidNF });
  }

  if (ativos === 0) { motivos.add("nf_sem_itens_ativos"); return out("nenhum", "ambigua"); }
  const vinculo: Vinculo = vinculados === 0 ? "nenhum" : vinculados === ativos ? "completo" : "parcial";
  if (vinculo !== "nenhum") motivos.add(vinculo === "completo" ? "ja_vinculada_no_omie" : "vinculo_parcial_no_omie");

  for (const c of consumo.values()) {
    if (c.saldo < 0) motivos.add("po_recebido_acima_do_pedido");
    else if (c.qtd !== c.saldo) motivos.add(c.qtd > c.saldo ? "excesso_sobre_saldo" : "quantidade_menor_que_saldo");
  }

  // Classe: estado da NF primeiro (só NF PENDENTE pode ser associada), depois vínculo, depois órfã/ambígua.
  if (estado_nf !== "pendente") {
    motivos.add(`nf_${estado_nf}`);
    return out(vinculo, "fora_de_alcance");
  }
  if (vinculo !== "nenhum") return out(vinculo, "ja_vinculada");
  if (comContrato === 0) return out(vinculo, "orfa");
  if (motivos.size > 0) return out(vinculo, "ambigua");

  // Cobertura por PO: TODOS os itens do PO legíveis; total = todo item fica com saldo 0 depois dos pares.
  const pedidos: PedidoCoberto[] = [];
  for (const po of posTocados.values()) {
    let total = true;
    for (const i of po.itens ?? []) {
      const idItem = idPositivo(i.nCodItem);
      const q = emDezMilesimos(i.nQtde);
      const r = i.nQtdeRec === undefined ? 0 : emDezMilesimos(i.nQtdeRec);
      if (idItem === null || q === null || r === null) { motivos.add("po_ilegivel"); continue; }
      const usado = consumo.get(`${po.omie_codigo_pedido}:${idItem}`)?.qtd ?? 0;
      if (q - r - usado !== 0) total = false;
    }
    pedidos.push({ nIdPedido: po.omie_codigo_pedido, numero_pedido: po.numero_pedido, cobertura: total ? "total" : "parcial" });
  }
  if (motivos.size > 0) return out(vinculo, "ambigua");
  pedidos.sort((a, b) => a.nIdPedido - b.nIdPedido);
  pares.sort((a, b) => a.nSequencia - b.nSequencia);
  return out(vinculo, "associavel", pedidos);
}
