// Leitura de um pedido JÁ EXISTENTE no portal Sayerlack — funções PURAS (Deno scope; nada aqui roda no Browserless).
//
// Fontes (spike no Chrome do founder, 2026-10-14, pedido real 2140603):
//   Consulta Pedidos (/order-viewer) → linha da datatable: Estab · Pedido · Pedido Cliente · Cliente · Situação ·
//     Data Emissão · Data Entrega · Vlr Mercadoria · Vlr Total. Os CABEÇALHOS são campos de filtro (input com
//     placeholder), por isso o browser manda o texto do header como `innerText || placeholder`.
//     Vlr Total = total COBRADO (mercadoria + IPI): 4865,5600 + 316,26 = 5181,8200.
//   GET /order-creation/busca-itens-pedido/<nº> → {"success":true,"itens":[[...]]}, cada item um ARRAY posicional:
//     [0] seq · [1] sku portal · [3] UN · [4] cap. emb · [5] qtd fat (= cap × qtd UN) · [6] qtd UN (embalagens) ·
//     [8] preço UN de tabela · [11] % desconto ("14,9488") · [12] Preço Venda = TOTAL DA LINHA sem IPI · [13] descrição
//     (10 · DFA.4080LT · L · 18 · 288 · 16 · 357,5466 · 14,9488 · 4865,5584 · DILUENTE PU 4080A LT).
//
// A semântica posicional foi INFERIDA de uma amostra — então ela é PROVADA a cada leitura, não presumida
// (precisão > recall): qtd fat = cap × qtd UN; Preço Venda = Preço UN × qtd UN × (1 − desc); Σ Preço Venda = Vlr
// Mercadoria da consulta. Qualquer elo falhando ⇒ recusa com motivo, nada é importado. Se o portal reordenar colunas,
// a prova quebra em vez de importar número errado.

export interface LinhaConsultaRaw {
  [coluna: string]: string;
}

export interface CabecalhoPedidoPortal {
  protocolo: string;
  cliente: string;
  situacao: string;
  data_entrega: string; // ISO yyyy-mm-dd
  valor_mercadoria: number;
  valor_total: number;
}

export interface ItemPortalLido {
  seq: number;
  sku_portal: string;
  descricao: string;
  qtde_portal: number; // embalagens (Qtd UN)
  valor_mercadoria: number; // Preço Venda = total da linha sem IPI
}

export type MotivoLeitura =
  | "nao_encontrado"
  | "consulta_ambigua"
  | "consulta_incompleta"
  | "itens_ausentes"
  | "item_malformado"
  | "item_incoerente"
  | "mercadoria_diverge_da_consulta";

export type ResultadoLeitura =
  | { ok: true; cabecalho: CabecalhoPedidoPortal; itens: ItemPortalLido[] }
  | { ok: false; motivo: MotivoLeitura; detalhe: string };

/** "4.865,5600" / "4865,56" / "4865.5584" → número. null quando não há número limpo. */
export function numeroBR(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^-?[\d.,]+$/.test(s)) return null;
  const n = Number(s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s);
  return Number.isFinite(n) ? n : null;
}

/** "26/10/2026" → "2026-10-26"; qualquer outra forma → null. */
export function dataBRparaISO(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, a] = m;
  // Data de CALENDÁRIO (não "hoje"): 31/02 rola para março no Date.UTC — os componentes de volta provam que existe.
  const dt = new Date(Date.UTC(Number(a), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(a) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return `${a}-${mo}-${d}`;
}

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Acha a coluna pelo nome do header (sem acento/caixa); "Vlr Mercadori" truncado no placeholder também casa. */
function coluna(linha: LinhaConsultaRaw, ...prefixos: string[]): string | null {
  for (const [k, v] of Object.entries(linha)) {
    const nk = norm(k);
    if (prefixos.some((p) => nk.startsWith(norm(p)))) return v;
  }
  return null;
}

/**
 * A linha da consulta que É o pedido. Filtramos por nº início = fim = protocolo, mas a prova é a coluna Pedido:
 * exatamente UMA linha com aquele número (proposta e pedido com o mesmo nº = ambíguo, recusa).
 */
export function lerCabecalho(linhas: LinhaConsultaRaw[], protocolo: string): { ok: true; cab: CabecalhoPedidoPortal } | { ok: false; motivo: MotivoLeitura; detalhe: string } {
  // "Pedido" EXATO: o prefixo casaria também "Pedido Clien[te]", o nº que o cliente digitou (pode ser outro).
  const doPedido = linhas.filter((l) => Object.entries(l).some(([k, v]) => norm(k) === "pedido" && v.trim() === protocolo));
  if (doPedido.length === 0) {
    return { ok: false, motivo: "nao_encontrado", detalhe: `Pedido ${protocolo} não aparece na Consulta Pedidos da OBEN (${linhas.length} linha(s) lida(s)).` };
  }
  if (doPedido.length > 1) {
    return { ok: false, motivo: "consulta_ambigua", detalhe: `${doPedido.length} linhas com o nº ${protocolo} na consulta.` };
  }
  const l = doPedido[0];
  const cliente = (coluna(l, "Cliente") ?? "").trim();
  const situacao = (coluna(l, "Situa") ?? "").trim();
  const dataEntrega = dataBRparaISO(coluna(l, "Data Entrega"));
  const vlrMerc = numeroBR(coluna(l, "Vlr Merc"));
  const vlrTotal = numeroBR(coluna(l, "Vlr Total"));
  const faltando = [
    !cliente && "Cliente",
    !dataEntrega && "Data Entrega",
    !(vlrMerc != null && vlrMerc > 0) && "Vlr Mercadoria",
    !(vlrTotal != null && vlrTotal > 0) && "Vlr Total",
  ].filter(Boolean);
  if (faltando.length > 0) {
    return { ok: false, motivo: "consulta_incompleta", detalhe: `Consulta sem ${faltando.join(", ")} legível(is) para o pedido ${protocolo}.` };
  }
  if (!/oben/i.test(cliente)) {
    return { ok: false, motivo: "consulta_incompleta", detalhe: `O pedido ${protocolo} é do cliente "${cliente}", não da OBEN.` };
  }
  return {
    ok: true,
    cab: { protocolo, cliente, situacao, data_entrega: dataEntrega as string, valor_mercadoria: vlrMerc as number, valor_total: vlrTotal as number },
  };
}

/** Tolerâncias: o portal exibe 4 casas e calcula o Preço Venda com o desconto de 4 casas. */
const TOL_LINHA = 0.02;

export function lerItens(resposta: unknown): { ok: true; itens: ItemPortalLido[] } | { ok: false; motivo: MotivoLeitura; detalhe: string } {
  const itensRaw = resposta && typeof resposta === "object" ? (resposta as { itens?: unknown }).itens : undefined;
  const sucesso = resposta && typeof resposta === "object" ? (resposta as { success?: unknown }).success : undefined;
  if (sucesso !== true || !Array.isArray(itensRaw) || itensRaw.length === 0) {
    return { ok: false, motivo: "itens_ausentes", detalhe: "O portal não devolveu os itens do pedido (busca-itens-pedido vazio ou sem success)." };
  }
  const itens: ItemPortalLido[] = [];
  for (const raw of itensRaw) {
    if (!Array.isArray(raw) || raw.length < 14) {
      return { ok: false, motivo: "item_malformado", detalhe: `Item do portal fora do formato conhecido: ${JSON.stringify(raw).slice(0, 160)}` };
    }
    const seq = numeroBR(raw[0]);
    const sku = typeof raw[1] === "string" ? raw[1].trim().toUpperCase() : "";
    const cap = numeroBR(raw[4]);
    const qtdFat = numeroBR(raw[5]);
    const qtdUn = numeroBR(raw[6]);
    const precoUn = numeroBR(raw[8]);
    const desc = numeroBR(raw[11]);
    const precoVenda = numeroBR(raw[12]);
    const descricao = typeof raw[13] === "string" ? raw[13].trim() : "";
    if (seq == null || !sku || cap == null || qtdFat == null || qtdUn == null || precoUn == null || desc == null || precoVenda == null) {
      return { ok: false, motivo: "item_malformado", detalhe: `Item ${sku || "(sem SKU)"} com campo ilegível: ${JSON.stringify(raw).slice(0, 160)}` };
    }
    if (!(qtdUn > 0) || !Number.isInteger(qtdUn) || !(precoVenda > 0) || !(precoUn > 0) || desc < 0 || desc >= 100) {
      return { ok: false, motivo: "item_malformado", detalhe: `Item ${sku}: quantidade/preço/desconto fora da faixa (qtd ${qtdUn}, venda ${precoVenda}, desc ${desc}).` };
    }
    // Prova da semântica posicional, por linha.
    if (Math.abs(cap * qtdUn - qtdFat) > 1e-6 * Math.max(1, qtdFat)) {
      return { ok: false, motivo: "item_incoerente", detalhe: `Item ${sku}: qtd fat ${qtdFat} ≠ cap ${cap} × qtd UN ${qtdUn} — formato do portal mudou?` };
    }
    const esperado = precoUn * qtdUn * (1 - desc / 100);
    if (Math.abs(esperado - precoVenda) > TOL_LINHA) {
      return { ok: false, motivo: "item_incoerente", detalhe: `Item ${sku}: Preço Venda ${precoVenda} ≠ ${precoUn} × ${qtdUn} × (1 − ${desc}%) = ${esperado.toFixed(4)}.` };
    }
    itens.push({ seq, sku_portal: sku, descricao, qtde_portal: qtdUn, valor_mercadoria: precoVenda });
  }
  return { ok: true, itens };
}

/** Consulta + itens ⇒ pedido lido, com a soma das linhas fechando com o Vlr Mercadoria da consulta. */
export function lerPedidoPortal(linhasConsulta: LinhaConsultaRaw[], respostaItens: unknown, protocolo: string): ResultadoLeitura {
  const cab = lerCabecalho(linhasConsulta, protocolo);
  if (!cab.ok) return cab;
  const it = lerItens(respostaItens);
  if (!it.ok) return it;
  const soma = it.itens.reduce((s, i) => s + i.valor_mercadoria, 0);
  // Vlr Mercadoria da consulta vem com 2 casas efetivas: meio centavo do total + meio por linha.
  const tol = 0.005 + 0.005 * it.itens.length;
  if (Math.abs(soma - cab.cab.valor_mercadoria) > tol) {
    return {
      ok: false,
      motivo: "mercadoria_diverge_da_consulta",
      detalhe: `Σ das linhas ${soma.toFixed(4)} ≠ Vlr Mercadoria da consulta ${cab.cab.valor_mercadoria.toFixed(4)} — algum item não foi lido.`,
    };
  }
  return { ok: true, cabecalho: cab.cab, itens: it.itens };
}

// ---- Mensagens da RPC de importação (SQLSTATE → texto para o operador). Desconhecida = erro genérico, nunca motivo fabricado.
const MENSAGEM_SQLSTATE: Readonly<Record<string, string>> = {
  IP001: "Dados do pedido inválidos para importar.",
  IP002: "Há item sem de-para no app (cadastre em Mapeamento de SKU e importe de novo).",
  IP003: "Quantidade do portal não vira quantidade inteira no Omie (confira o fator do de-para).",
  IP004: "O de-para aponta para um fornecedor que não é a Sayerlack.",
  IP005: "O mesmo SKU aparece duas vezes no pedido do portal.",
  CP006: "Item sem alíquota de IPI conhecida para o NCM (cadastre o NCM e importe de novo).",
  CP007: "O total com IPI calculado não bate com o Vlr Total do portal.",
  CP004: "Itens divergentes ao aplicar o custo.",
  CP002: "Este pedido já tem pedido de compra no Omie.",
  "42501": "Acesso negado.",
};

export function mensagemErroImportacao(code: string | null | undefined, message: string | null | undefined): string {
  const base = (code && MENSAGEM_SQLSTATE[code]) ?? "Falha ao gravar a importação.";
  return message ? `${base} Detalhe: ${message}` : base;
}
