// Resumos PUROS das respostas do Omie para o diagnóstico da Fase 0.1 do picking v2.
// Sem I/O — testados em diagnostico_test.ts (Deno, `--no-remote`).
//
// O que o diagnóstico precisa responder (spec §4, Fase 0.1):
//   1. quais etapas existem em cada conta (origem 10 e o destino que o founder vai criar);
//   2. a listagem `ListarPedidos{etapa:'10'}` traz `codigo_item` único por linha, `dAlt/hAlt`
//      e quantidades — e quanto disso é fracionário;
//   3. quanto do cadastro tem EAN preenchido.
// Ausente ≠ zero: campo que o Omie não mandou vira `null`/contagem separada, nunca 0 fabricado.

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function lista(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function numero(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export interface EtapaResumo {
  operacao: string | null;
  descricao_operacao: string | null;
  codigo: string | null;
  descricao: string | null;
  inativa: boolean | null;
}

/** `ListarEtapasFaturamento` → lista plana (operação × etapa). */
export function resumirEtapas(resp: unknown): EtapaResumo[] {
  const out: EtapaResumo[] = [];
  for (const cad of lista(obj(resp)?.cadastros)) {
    const c = obj(cad);
    if (!c) continue;
    for (const et of lista(c.etapas)) {
      const e = obj(et);
      if (!e) continue;
      const inativo = texto(e.cInativo);
      out.push({
        operacao: texto(c.cCodOperacao),
        descricao_operacao: texto(c.cDescOperacao),
        codigo: texto(e.cCodigo),
        descricao: texto(e.cDescricao) ?? texto(e.cDescrPadrao),
        inativa: inativo === "S" ? true : inativo === "N" ? false : null,
      });
    }
  }
  return out;
}

export interface PedidosResumo {
  total_de_registros: number | null;
  total_de_paginas: number | null;
  na_pagina: number;
  com_dalt: number;
  linhas: number;
  linhas_sem_codigo_item: number;
  pedidos_com_codigo_item_duplicado: number;
  linhas_sem_quantidade_valida: number;
  linhas_fracionarias: number;
  unidades: Record<string, number>;
  /** Chaves de `det[0].produto` do 1º pedido — mostra onde o EAN viria, se viesse. */
  chaves_produto_amostra: string[];
  amostra: Array<{ codigo_pedido: string | null; numero_pedido: string | null; etapa: string | null; dAlt: string | null; hAlt: string | null; linhas: number }>;
}

/** `ListarPedidos{etapa:'10'}` (1 página) → contrato que o picking v2 vai depender. */
export function resumirPedidos(resp: unknown): PedidosResumo {
  const r = obj(resp);
  const pedidos = lista(r?.pedido_venda_produto);
  const res: PedidosResumo = {
    total_de_registros: numero(r?.total_de_registros),
    total_de_paginas: numero(r?.total_de_paginas),
    na_pagina: pedidos.length,
    com_dalt: 0,
    linhas: 0,
    linhas_sem_codigo_item: 0,
    pedidos_com_codigo_item_duplicado: 0,
    linhas_sem_quantidade_valida: 0,
    linhas_fracionarias: 0,
    unidades: {},
    chaves_produto_amostra: [],
    amostra: [],
  };
  for (const p of pedidos) {
    const ped = obj(p);
    if (!ped) continue;
    const cab = obj(ped.cabecalho);
    const info = obj(ped.infoCadastro);
    const dAlt = texto(info?.dAlt);
    if (dAlt) res.com_dalt++;
    const det = lista(ped.det);
    const vistos = new Set<string>();
    let duplicado = false;
    for (const d of det) {
      const linha = obj(d);
      res.linhas++;
      const codItem = texto(obj(linha?.ide)?.codigo_item);
      if (codItem === null) res.linhas_sem_codigo_item++;
      else if (vistos.has(codItem)) duplicado = true;
      else vistos.add(codItem);
      const prod = obj(linha?.produto);
      if (res.chaves_produto_amostra.length === 0 && prod) res.chaves_produto_amostra = Object.keys(prod).sort();
      const q = numero(prod?.quantidade);
      if (q === null || q <= 0) res.linhas_sem_quantidade_valida++;
      else if (!Number.isInteger(q)) res.linhas_fracionarias++;
      const un = texto(prod?.unidade)?.toUpperCase() ?? "(ausente)";
      res.unidades[un] = (res.unidades[un] ?? 0) + 1;
    }
    if (duplicado) res.pedidos_com_codigo_item_duplicado++;
    if (res.amostra.length < 5) {
      res.amostra.push({
        codigo_pedido: texto(cab?.codigo_pedido),
        numero_pedido: texto(cab?.numero_pedido),
        etapa: texto(cab?.etapa),
        dAlt,
        hAlt: texto(info?.hAlt),
        linhas: det.length,
      });
    }
  }
  return res;
}

export interface ProdutosResumo {
  total_de_registros: number | null;
  na_pagina: number;
  com_ean: number;
  ean_tamanhos: Record<string, number>;
}

/** `ListarProdutos` (1 página) → cobertura de EAN na amostra. */
export function resumirProdutos(resp: unknown): ProdutosResumo {
  const r = obj(resp);
  const produtos = lista(r?.produto_servico_cadastro);
  const res: ProdutosResumo = {
    total_de_registros: numero(r?.total_de_registros),
    na_pagina: produtos.length,
    com_ean: 0,
    ean_tamanhos: {},
  };
  for (const p of produtos) {
    const ean = texto(obj(p)?.ean);
    if (ean === null) continue;
    res.com_ean++;
    const k = String(ean.length);
    res.ean_tamanhos[k] = (res.ean_tamanhos[k] ?? 0) + 1;
  }
  return res;
}
