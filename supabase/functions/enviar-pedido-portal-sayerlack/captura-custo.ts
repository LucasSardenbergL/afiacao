// Captura de custo do portal Sayerlack — funções PURAS (Deno scope; nada aqui roda no Browserless,
// exceto `extrairAddJson`, interpolado no bundle do browser via `${extrairAddJson.toString()}` — por isso
// ela é autocontida: sem referência a outra função do módulo, sem crase, sem `${`).
//
// ⚠️ ESPELHO: o bloco entre os marcadores `>>> ESPELHO(captura-custo)` é copiado VERBATIM em
// src/lib/reposicao/sayerlack-scraping-pedido.ts (Deno não importa de src/). O vitest
// src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts compara os dois blocos byte a byte.
//
// Semântica provada em prod (2026-09-05, pedido #2443 ↔ portal 2126906; docs/historico/sayerlack-captura-custo-cega.md):
//   POST /order-creation/form/add → data.itens[{item, value}] + data.value.
//   `value` do ITEM = Preço UN de TABELA por embalagem (antes do desconto por embalagem e da taxa −2%).
//   `data.value`   = total do pedido cobrado pelo portal.
//   `Preço Venda` da datatable = TOTAL DA LINHA já multiplicado pela Qtd UN, NÃO preço por embalagem
//     (medido no pedido #2459 / portal 2126911: 142,2554 × 3 × (1 − 14,9488%) = 362,9698 = Preço Venda).
//
// Cadeia de prova (Codex, challenge 2026-09-05 — precisão > recall, nada parcial):
//   pedido local ↔ JSON ↔ DOM são o MESMO conjunto de SKUs (sem extra, ausência ou duplicata);
//   Qtd UN lida no DOM == quantidade que a edge DIGITOU no portal (prova da quantidade aceita);
//   Preço UN lido no DOM == `value` do JSON do mesmo SKU (prova de que a coluna é a que se pensa);
//   1 item  ⇒ total_linha = data.value ('json_total_unico');
//   N itens ⇒ Σ(Preço Venda) == data.value com tolerância ABSOLUTA derivada do arredondamento exibido
//             ('dom_checksum'). Qualquer elo faltando ⇒ total_linha = null em TODAS (ausente ≠ zero).
//
// ⚠️ DIVERGÊNCIA ABERTA (medida 2026-09-05, #2459): o portal cobrou `data.value` 374,77 enquanto a linha
//   exibia Preço Venda 362,9698 — R$ 11,80 a mais (3,2510%), de natureza NÃO identificada (IPI? encargo?
//   desconto aplicado ≠ exibido?). Enquanto ela existir, `dom_checksum` NÃO fecha e a captura multi-item
//   degrada para 'checksum_divergente' — fail-closed, de propósito. O resumo carrega `soma_dom`,
//   `total_json`, `delta_abs` e `delta_rel` justamente para MEDIR o padrão nos próximos envios.

// >>> ESPELHO(captura-custo) INICIO
export function parseBRL(s: string): number | null {
  if (typeof s !== 'string') return null;
  const limpo = s.replace(/[^\d,.-]/g, '').trim();
  if (!limpo) return null;
  const normal = limpo.replace(/\./g, '').replace(',', '.'); // pt-BR: ponto=milhar, vírgula=decimal
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

export function parseDiasPrzEnt(s: string): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/-?\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isInteger(n) ? n : null;
}

/** Linha consolidada. `total_linha` só é número quando a cadeia de prova fechou; null é TERMINAL (nunca cai em parser de texto). */
export interface LinhaPortal { sku_portal: string; prz_ent_raw: string; total_linha: number | null; }
export interface ItemPedido {
  item_id: number; sku_codigo_omie: string; sku_descricao: string | null;
  sku_portal: string | null; qtde_final: number; preco_atual: number;
}
interface Casado { item: ItemPedido; prz_ent: number | null; total_linha: number | null; }
export interface ResultadoMatch { casados: Casado[]; naoCasados: ItemPedido[]; ambiguos: ItemPedido[]; }

function normPortal(s: string | null): string { return (s ?? '').trim().toUpperCase(); }

export function casarLinhasComItens(linhas: LinhaPortal[], itens: ItemPedido[]): ResultadoMatch {
  const casados: Casado[] = [];
  const naoCasados: ItemPedido[] = [];
  const ambiguos: ItemPedido[] = [];

  const itensPorSku = new Map<string, ItemPedido[]>();
  for (const it of itens) {
    const k = normPortal(it.sku_portal);
    if (!k) { naoCasados.push(it); continue; }
    const arr = itensPorSku.get(k) ?? [];
    arr.push(it); itensPorSku.set(k, arr);
  }
  const linhasPorSku = new Map<string, LinhaPortal[]>();
  for (const ln of linhas) {
    const k = normPortal(ln.sku_portal);
    if (!k) continue;
    const arr = linhasPorSku.get(k) ?? [];
    arr.push(ln); linhasPorSku.set(k, arr);
  }
  for (const [k, its] of itensPorSku) {
    const lns = linhasPorSku.get(k) ?? [];
    if (its.length > 1 || lns.length > 1) { ambiguos.push(...its); continue; }
    if (lns.length === 0) { naoCasados.push(its[0]); continue; }
    const t = lns[0].total_linha;
    casados.push({ item: its[0], prz_ent: parseDiasPrzEnt(lns[0].prz_ent_raw), total_linha: typeof t === 'number' && Number.isFinite(t) ? t : null });
  }
  return { casados, naoCasados, ambiguos };
}

export interface CustoUpdate { item_id: number; preco_unitario: number; valor_linha: number; }
function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function derivarCustos(res: ResultadoMatch): { updates: CustoUpdate[]; pulados: { sku_codigo_omie: string; motivo: string }[] } {
  const updates: CustoUpdate[] = [];
  const pulados: { sku_codigo_omie: string; motivo: string }[] = [];
  for (const c of res.casados) {
    const total = c.total_linha; const qtde = c.item.qtde_final;
    if (total == null || !Number.isFinite(total) || !(total > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'total_invalido' }); continue; }
    if (!Number.isFinite(qtde) || !(qtde > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'qtde_invalida' }); continue; }
    const unit = total / qtde;
    if (!Number.isFinite(unit) || !(unit > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'custo_invalido' }); continue; }
    if (round2(total) === round2(qtde * c.item.preco_atual)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'sem_mudanca' }); continue; }
    updates.push({ item_id: c.item.item_id, preco_unitario: unit, valor_linha: total }); // precisão cheia
  }
  return { updates, pulados };
}

// ---- Fontes: JSON do "Efetivar" (POST /order-creation/form/add) e DOM do #datatable_itens ----

/** Linha crua raspada do `#datatable_itens` (header-matching no browser; células pt-BR). */
export interface LinhaDom {
  sku_portal: string; prz_ent_raw: string;
  qtd_un_raw?: string; preco_venda_raw?: string; preco_un_raw?: string; desconto_raw?: string;
}
/** JSON do portal ao efetivar: `value` do item é preço de TABELA por embalagem; `value` do pedido é o total líquido. */
export interface AddJsonPortal { itens: { item: string; value: number }[]; value: number | null; ordernum?: number | null; }
/** O que a edge DIGITOU no portal para cada item (sku + quantidade em unidade do PORTAL, já com fator_conversao). */
export interface ItemEsperado { sku_portal: string; qtde_portal: number; }

/**
 * Extrai {itens, value, ordernum} do JSON parseado da resposta do form/add. AUTOCONTIDA (vai pro browser
 * via toString()). null quando não há `data.itens` válido — "salvo na sessão" (save-tab-preco-session)
 * e qualquer outro POST NÃO viram lista vazia disfarçada de captura.
 */
export function extrairAddJson(parsed: unknown): AddJsonPortal | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const data = (parsed as { data?: unknown }).data;
  if (!data || typeof data !== 'object') return null;
  const itensRaw = (data as { itens?: unknown }).itens;
  if (!Array.isArray(itensRaw) || itensRaw.length === 0) return null;
  // "153.203" / "1605.67" (JSON do portal) ou "1.605,67" (pt-BR): vírgula presente ⇒ ponto é milhar.
  const num = (v: unknown): number | null => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || v.trim() === '') return null;
    const s = v.trim();
    const n = Number(s.indexOf(',') !== -1 ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) ? n : null;
  };
  const itens: { item: string; value: number }[] = [];
  for (const it of itensRaw) {
    if (!it || typeof it !== 'object') return null;
    const item = String((it as { item?: unknown }).item ?? '').trim().toUpperCase();
    const value = num((it as { value?: unknown }).value);
    if (!item || value == null) return null;
    itens.push({ item, value });
  }
  const value = num((data as { value?: unknown }).value);
  const ordRaw = (data as { ordernum?: unknown }).ordernum;
  const ordernum = typeof ordRaw === 'number' && Number.isFinite(ordRaw) ? ordRaw : (typeof ordRaw === 'string' && /^\d+$/.test(ordRaw) ? Number(ordRaw) : null);
  return { itens, value, ordernum };
}

type FonteCaptura = 'json_total_unico' | 'dom_checksum' | 'nenhuma';
type MotivoCaptura =
  | 'sem_json' | 'total_json_invalido' | 'sku_ambiguo' | 'json_diverge_do_pedido'
  | 'dom_incompleto' | 'qtd_diverge' | 'preco_un_diverge' | 'checksum_divergente';
export interface Consolidacao {
  linhas: LinhaPortal[];
  fonte: FonteCaptura;
  motivo: MotivoCaptura | null;
  /** Total líquido do pedido PROVADO (= data.value) — só quando fonte ≠ 'nenhuma'. */
  total_pedido: number | null;
  checksum: { soma_dom: number | null; total_json: number | null; delta_abs: number | null; delta_rel: number | null; tolerancia_abs: number | null };
}

/**
 * Preço Venda é exibido com 4 casas e `data.value` com 2: ±0,005 do total mais ±0,00005 por linha.
 * Depende do NÚMERO DE LINHAS, não das quantidades — Preço Venda já é o total da linha, então a
 * quantidade não entra outra vez na conta (era o erro corrigido em 2026-09-05).
 */
export function toleranciaChecksum(nLinhas: number): number {
  return 0.005 + nLinhas * 0.00005;
}
/** Preço UN do DOM (4 casas) vs `value` do JSON (até 4 casas). */
const TOL_PRECO_UN = 0.0001;

/**
 * Consolida DOM + JSON + o que a edge digitou numa lista de LinhaPortal com `total_linha` só quando PROVADO.
 * Precisão > recall: qualquer elo faltando ⇒ 'nenhuma' + motivo, linhas com total_linha = null (sku/prz seguem
 * úteis ao diagnóstico), e NENHUM item recebe custo — nunca mistura custo novo com custo antigo no mesmo pedido.
 */
export function consolidarLinhasPortal(dom: LinhaDom[], json: AddJsonPortal | null, esperados: ItemEsperado[]): Consolidacao {
  const semChecksum: Consolidacao['checksum'] = { soma_dom: null, total_json: json?.value ?? null, delta_abs: null, delta_rel: null, tolerancia_abs: null };
  const linhaSemCusto = (sku: string, prz: string): LinhaPortal => ({ sku_portal: sku, prz_ent_raw: prz, total_linha: null });
  const domPorSku = new Map<string, LinhaDom[]>();
  for (const d of dom) {
    const k = normPortal(d.sku_portal);
    if (!k) continue;
    const arr = domPorSku.get(k) ?? [];
    arr.push(d); domPorSku.set(k, arr);
  }
  const przDe = (sku: string): string => {
    const ds = domPorSku.get(sku) ?? [];
    if (ds.length === 1) return ds[0].prz_ent_raw ?? '';
    if (ds.length === 0 && dom.length === 1 && esperados.length === 1) return dom[0].prz_ent_raw ?? ''; // única linha, sku não lido
    return '';
  };

  if (!json || json.itens.length === 0) {
    return { linhas: dom.map((d) => linhaSemCusto(normPortal(d.sku_portal), d.prz_ent_raw ?? '')), fonte: 'nenhuma', motivo: 'sem_json', total_pedido: null, checksum: semChecksum };
  }
  const skusJson = json.itens.map((i) => normPortal(i.item));
  const linhasSemCusto = skusJson.map((s) => linhaSemCusto(s, przDe(s)));
  const falha = (motivo: MotivoCaptura, checksum = semChecksum): Consolidacao =>
    ({ linhas: linhasSemCusto, fonte: 'nenhuma', motivo, total_pedido: null, checksum });

  // (1) JSON é um CONJUNTO (sem duplicata) e igual ao conjunto do pedido local.
  if (new Set(skusJson).size !== skusJson.length) return falha('sku_ambiguo');
  const skusEsperados = esperados.map((e) => normPortal(e.sku_portal));
  if (new Set(skusEsperados).size !== skusEsperados.length || skusEsperados.some((s) => !s)) return falha('json_diverge_do_pedido');
  if (skusEsperados.length !== skusJson.length || skusEsperados.some((s) => skusJson.indexOf(s) === -1)) return falha('json_diverge_do_pedido');
  if (json.value == null || !Number.isFinite(json.value) || !(json.value > 0)) return falha('total_json_invalido');

  // (2) DOM cobre cada SKU exatamente 1× e prova quantidade (== digitada) e coluna de preço (Preço UN == value).
  // Com 1 item o DOM pode não ter lido o sku (defeito histórico): a única linha gravada vale como a dele.
  const qtdPorSku = new Map<string, number>(esperados.map((e) => [normPortal(e.sku_portal), e.qtde_portal]));
  const valuePorSku = new Map<string, number>(json.itens.map((i) => [normPortal(i.item), i.value]));
  if (dom.length !== skusJson.length) return falha('dom_incompleto');
  const linhaDe = (sku: string): LinhaDom | null => {
    const ds = domPorSku.get(sku) ?? [];
    if (ds.length === 1) return ds[0];
    if (ds.length === 0 && skusJson.length === 1 && normPortal(dom[0].sku_portal) === '') return dom[0];
    return null;
  };
  const provadas: { sku: string; qtd: number; precoVenda: number | null }[] = [];
  for (const sku of skusJson) {
    const ds = domPorSku.get(sku) ?? [];
    if (ds.length > 1) return falha('sku_ambiguo');
    const d = linhaDe(sku);
    if (!d) return falha('dom_incompleto');
    const qtd = parseBRL(d.qtd_un_raw ?? '');
    if (qtd == null || !(qtd > 0)) return falha('dom_incompleto');
    const qtdEsperada = qtdPorSku.get(sku);
    if (qtdEsperada == null || !Number.isFinite(qtdEsperada) || Math.abs(qtd - qtdEsperada) > 1e-6) return falha('qtd_diverge');
    const precoUn = parseBRL(d.preco_un_raw ?? '');
    if (precoUn == null) return falha('dom_incompleto');
    if (Math.abs(precoUn - (valuePorSku.get(sku) ?? NaN)) > TOL_PRECO_UN) return falha('preco_un_diverge');
    provadas.push({ sku, qtd, precoVenda: parseBRL(d.preco_venda_raw ?? '') });
  }

  // (3) 1 item ⇒ o total líquido do pedido É o total da linha.
  if (skusJson.length === 1) {
    return {
      linhas: [{ sku_portal: skusJson[0], prz_ent_raw: przDe(skusJson[0]), total_linha: json.value }],
      fonte: 'json_total_unico', motivo: null, total_pedido: json.value, checksum: semChecksum,
    };
  }

  // (4) N itens ⇒ Σ(Preço Venda) fecha com o total, tolerância ABSOLUTA derivada do arredondamento exibido.
  // Preço Venda JÁ É o total da linha (Preço UN × Qtd UN × (1 − desconto)) — multiplicá-lo pela quantidade
  // de novo inflava a soma e fazia todo pedido multi-item cair em 'checksum_divergente'.
  if (provadas.some((p) => p.precoVenda == null || !(p.precoVenda > 0))) return falha('dom_incompleto');
  const totais = provadas.map((p) => p.precoVenda as number);
  if (totais.some((t) => !Number.isFinite(t))) return falha('dom_incompleto');
  const soma = totais.reduce((s, v) => s + v, 0);
  const tolerancia = toleranciaChecksum(provadas.length);
  const delta = Math.abs(soma - json.value);
  const checksum = { soma_dom: soma, total_json: json.value, delta_abs: delta, delta_rel: delta / json.value, tolerancia_abs: tolerancia };
  if (delta > tolerancia) return falha('checksum_divergente', checksum);
  return {
    linhas: skusJson.map((s, i) => ({ sku_portal: s, prz_ent_raw: przDe(s), total_linha: totais[i] })),
    fonte: 'dom_checksum', motivo: null, total_pedido: json.value, checksum,
  };
}

// ---- Sensor: captura com sucesso no portal e algum item SEM custo provado é sinal, não silêncio ----

// ---------------------------------------------------------------- RPC de escrita (tudo-ou-nada)
/**
 * A escrita do custo é UMA RPC transacional (`sayerlack_aplicar_custo_portal`, migration
 * 20260905090000): compare-and-set no banco (`omie_pedido_compra_numero IS NULL AND status_envio_portal =
 * 'sucesso_portal'` no próprio UPDATE), todos os itens num UPDATE só com ROW_COUNT == n, valor_total provado.
 * Ela RECUSA com SQLSTATE própria (classe CP) e faz ROLLBACK de tudo — a edge casa a MARCA do ramo, nunca
 * "lançou algo". Código desconhecido/ausente é `erro_rpc` (transiente, cega), nunca um motivo fabricado.
 */
export type MotivoRpcCusto = 'payload_invalido' | 'po_omie_existente' | 'pedido_nao_elegivel' | 'itens_divergentes' | 'erro_rpc';
const SQLSTATE_CUSTO_PORTAL: Readonly<Record<string, Exclude<MotivoRpcCusto, 'erro_rpc'>>> = {
  CP001: 'payload_invalido',
  CP002: 'po_omie_existente',
  CP003: 'pedido_nao_elegivel',
  CP004: 'itens_divergentes',
};
export function classificarErroRpcCusto(code: string | null | undefined): MotivoRpcCusto {
  if (typeof code !== 'string') return 'erro_rpc';
  return SQLSTATE_CUSTO_PORTAL[code] ?? 'erro_rpc';
}

export interface ResumoCaptura {
  fonte: FonteCaptura; motivo: MotivoCaptura | 'ja_tem_omie' | 'escrita_parcial' | MotivoRpcCusto | null;
  /** SQLSTATE devolvida pela RPC de escrita quando ela recusou (auditoria; null = não chamada ou ok). */
  sqlstate_rpc: string | null;
  checksum: Consolidacao['checksum'];
  n_dom: number; n_json: number; n_itens: number;
  casados: number; nao_casados: number; ambiguos: number;
  planejados: number; atualizados: number; pulados: { sku_codigo_omie: string; motivo: string }[];
  /** true = envio bem-sucedido em que ≥1 item ficou sem custo provado/persistido (excluindo 'sem_mudanca' e PO Omie já existente). */
  cego: boolean;
}

export function resumirCaptura(p: {
  cons: Consolidacao; match: ResultadoMatch | null; pulados: { sku_codigo_omie: string; motivo: string }[];
  planejados: number; atualizados: number; jaTemOmie: boolean; nDom: number; nJson: number; nItens: number;
  /** Recusa da RPC de escrita (classificada por SQLSTATE) — null quando não foi chamada ou gravou tudo. */
  erroRpc?: { motivo: MotivoRpcCusto; sqlstate: string | null } | null;
}): ResumoCaptura {
  const casados = p.match?.casados.length ?? 0;
  const naoCasados = p.match?.naoCasados.length ?? 0;
  const ambiguos = p.match?.ambiguos.length ?? 0;
  const erroRpc = p.erroRpc ?? null;
  // CP002 = o PO Omie passou a existir entre a leitura em memória e a escrita: a RPC recusou e NADA foi
  // gravado — é a mesma idempotência de `jaTemOmie`, só que provada no banco (não é cegueira).
  const omieNoBanco = erroRpc?.motivo === 'po_omie_existente';
  const escritaParcial = p.atualizados !== p.planejados;
  const puladoRuim = p.pulados.some((x) => x.motivo !== 'sem_mudanca');
  // Cega = algum item do pedido ficou SEM custo provado/persistido: fonte não provou, não casou, ficou ambíguo,
  // pulado por motivo ≠ 'sem_mudanca', casou menos itens do que o pedido tem, a RPC recusou (≠ CP002) ou a
  // escrita ficou parcial (com a RPC tudo-ou-nada `atualizados` ∈ {0, planejados}; o ramo fica como defesa).
  // Com PO Omie já existente (memória OU banco) a captura não grava (idempotência, não silêncio).
  const cego = !p.jaTemOmie && !omieNoBanco && (
    p.cons.fonte === 'nenhuma' || naoCasados > 0 || ambiguos > 0 || puladoRuim || erroRpc != null || escritaParcial || casados !== p.nItens
  );
  const motivo: ResumoCaptura['motivo'] = p.jaTemOmie || omieNoBanco ? 'ja_tem_omie'
    : erroRpc ? erroRpc.motivo
    : (escritaParcial ? 'escrita_parcial' : p.cons.motivo);
  return {
    fonte: p.cons.fonte, motivo, sqlstate_rpc: erroRpc?.sqlstate ?? null, checksum: p.cons.checksum,
    n_dom: p.nDom, n_json: p.nJson, n_itens: p.nItens, casados, nao_casados: naoCasados, ambiguos,
    planejados: p.planejados, atualizados: p.atualizados, pulados: p.pulados, cego,
  };
}
// <<< ESPELHO(captura-custo) FIM
