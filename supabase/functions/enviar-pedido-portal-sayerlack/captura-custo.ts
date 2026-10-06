// Captura de custo do portal Sayerlack — funções PURAS (Deno scope; nada aqui roda no Browserless,
// exceto `extrairAddJson`, interpolado no bundle do browser via `${extrairAddJson.toString()}` — por isso
// ela é autocontida: sem referência a outra função do módulo, sem crase, sem `${`).
//
// ⚠️ ESPELHO: o bloco entre os marcadores `>>> ESPELHO(captura-custo)` é copiado VERBATIM em
// src/lib/reposicao/sayerlack-scraping-pedido.ts (Deno não importa de src/). O vitest
// src/lib/reposicao/__tests__/sayerlack-scraping-pedido.test.ts compara os dois blocos byte a byte.
//
// Semântica provada em prod:
//   POST /order-creation/form/add → data.itens[{item, value}] + data.value (2026-09-05, #2443 ↔ portal 2126906).
//   `value` do ITEM = Preço UN de TABELA por embalagem (antes do desconto por embalagem e da taxa −2%) — nunca custo.
//   `data.value`   = total COBRADO pelo portal: Σ round2(Preço Venda) + Σ IPI por item (2026-10-05, backtest de 29
//                    pedidos, ≤ R$ 0,02 com 13 alíquotas por NCM — a "divergência aberta" do #2459 era o IPI:
//                    362,97 × 3,25% = 11,80 → 374,77).
//   `Preço Venda` da datatable = TOTAL DA LINHA, sem IPI (#2459: 142,2554 × 3 × (1 − 14,9488%) = 362,9698).
//
// Cadeia de prova (Codex 2026-09-05 + spec docs/superpowers/specs/2026-10-05-preco-exato-po-sayerlack-design.md):
//   pedido local ↔ JSON ↔ DOM são o MESMO conjunto de SKUs (sem extra, ausência ou duplicata);
//   Qtd UN lida no DOM == quantidade que a edge DIGITOU (prova da quantidade aceita);
//   Preço UN lido no DOM == `value` do JSON do mesmo SKU (prova de que a coluna é a que se pensa);
//   todo item tem alíquota de IPI conhecida (NCM do cadastro × ipi_aliquota_ncm; ausente ≠ zero);
//   1 e N itens ⇒ Σ round2(Preço Venda) + Σ IPI == data.value dentro da tolerância do arredondamento.
//   Qualquer elo faltando ⇒ total_linha = valor_ipi = null em TODAS (ausente ≠ zero).

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

/**
 * Linha consolidada. `total_linha` = valor da MERCADORIA (Preço Venda do DOM, sem IPI) e `valor_ipi` = IPI do item,
 * os dois só quando a cadeia de prova fechou; null é TERMINAL (nunca cai em parser de texto).
 */
export interface LinhaPortal { sku_portal: string; prz_ent_raw: string; total_linha: number | null; valor_ipi: number | null; }
export interface ItemPedido {
  item_id: number; sku_codigo_omie: string; sku_descricao: string | null;
  sku_portal: string | null; qtde_final: number;
}
interface Casado { item: ItemPedido; prz_ent: number | null; total_linha: number | null; valor_ipi: number | null; }
export interface ResultadoMatch { casados: Casado[]; naoCasados: ItemPedido[]; ambiguos: ItemPedido[]; }

function normPortal(s: string | null): string { return (s ?? '').trim().toUpperCase(); }
function finitoOuNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

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
    casados.push({ item: its[0], prz_ent: parseDiasPrzEnt(lns[0].prz_ent_raw), total_linha: finitoOuNull(lns[0].total_linha), valor_ipi: finitoOuNull(lns[0].valor_ipi) });
  }
  return { casados, naoCasados, ambiguos };
}

/** O que vai à RPC por item: a mercadoria e o IPI PROVADOS + o eco da qtde_final. Os preços (÷ qtde) a RPC deriva. */
export interface CustoUpdate { item_id: number; qtde_final: number; valor_mercadoria: number; valor_ipi: number; }
/** @public — exportado pelo espelho (os testes o consomem). */
export function round2(n: number): number { return Math.round((n + Number.EPSILON) * 100) / 100; }

export function derivarCustos(res: ResultadoMatch): { updates: CustoUpdate[]; pulados: { sku_codigo_omie: string; motivo: string }[] } {
  const updates: CustoUpdate[] = [];
  const pulados: { sku_codigo_omie: string; motivo: string }[] = [];
  for (const c of res.casados) {
    const merc = c.total_linha; const ipi = c.valor_ipi; const qtde = c.item.qtde_final;
    if (merc == null || !Number.isFinite(merc) || !(merc > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'total_invalido' }); continue; }
    if (ipi == null || !Number.isFinite(ipi) || ipi < 0) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'ipi_invalido' }); continue; }
    if (!Number.isFinite(qtde) || !(qtde > 0)) { pulados.push({ sku_codigo_omie: c.item.sku_codigo_omie, motivo: 'qtde_invalida' }); continue; }
    // Todo item vai, sempre: a decomposição precisa nascer em cada um (o pulo 'sem_mudanca' saiu em 2026-10-05).
    // A RPC deriva os preços em numeric sobre a qtde_final da LINHA — e recusa se este eco divergir dela.
    updates.push({ item_id: c.item.item_id, qtde_final: qtde, valor_mercadoria: merc, valor_ipi: ipi });
  }
  return { updates, pulados };
}

// ---- Fontes: JSON do "Efetivar" (POST /order-creation/form/add) e DOM do #datatable_itens ----

/** Linha crua raspada do `#datatable_itens` (header-matching no browser; células pt-BR). */
export interface LinhaDom {
  sku_portal: string; prz_ent_raw: string;
  qtd_un_raw?: string; preco_venda_raw?: string; preco_un_raw?: string; desconto_raw?: string;
}
/** JSON do portal ao efetivar: `value` do item é preço de TABELA por embalagem; `value` do pedido é o total cobrado. */
export interface AddJsonPortal { itens: { item: string; value: number }[]; value: number | null; ordernum?: number | null; }
/**
 * O que a edge DIGITOU no portal para cada item (sku + quantidade em unidade do PORTAL, já com fator_conversao) e o
 * IPI do NCM do item, lido de `sayerlack_ipi_itens` (a mesma função com que a RPC confere). `aliquota_ipi_pct` null =
 * NCM ausente ou fora de `ipi_aliquota_ncm` — ausente ≠ zero, nunca vira 0%.
 */
export interface ItemEsperado { sku_portal: string; qtde_portal: number; ncm: string | null; aliquota_ipi_pct: number | null; }

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

type FonteCaptura = 'dom_checksum' | 'nenhuma';
type MotivoCaptura =
  | 'sem_json' | 'total_json_invalido' | 'sku_ambiguo' | 'json_diverge_do_pedido'
  | 'dom_incompleto' | 'qtd_diverge' | 'preco_un_diverge'
  | 'ipi_leitura_falhou' | 'ipi_ncm_desconhecido' | 'checksum_divergente';
export interface Consolidacao {
  linhas: LinhaPortal[];
  fonte: FonteCaptura;
  motivo: MotivoCaptura | null;
  /** Total cobrado pelo portal PROVADO (= data.value) — só quando fonte ≠ 'nenhuma'. */
  total_pedido: number | null;
  /** NCMs dos itens sem alíquota (motivo 'ipi_ncm_desconhecido'): o que falta cadastrar em `ipi_aliquota_ncm`. */
  ncm_sem_aliquota: string[];
  checksum: {
    soma_dom: number | null; ipi_modelado: number | null; total_modelado: number | null;
    total_json: number | null; delta_abs: number | null; delta_rel: number | null; tolerancia_abs: number | null;
  };
}

/**
 * Centavos INTEIROS de um valor exibido com até 4 casas (o Preço Venda do portal), meio centavo para cima — o mesmo
 * que `round(numeric, 2)` do Postgres para valor positivo. null = não é valor de mercadoria (≤ 0, NaN, Infinity).
 */
export function centavosDaMercadoria(v: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) return null;
  const dezMilesimos = Math.round(v * 10000); // o DOM exibe 4 casas: v·10⁴ é inteiro a menos de ruído binário
  return Number.isSafeInteger(dezMilesimos) ? Math.floor((dezMilesimos + 50) / 100) : null;
}
/** Alíquota (%) em centésimos de ponto (3,25 → 325). null fora de [0, 100) ou com mais de 2 casas (a tabela proíbe). */
export function centesimosDaAliquota(pct: number | null): number | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct >= 100) return null;
  const c = Math.round(pct * 100);
  return Math.abs(pct * 100 - c) < 1e-6 ? c : null;
}
/**
 * IPI do item em centavos = round(linha × alíquota ÷ 100), meio centavo para cima, só em INTEIROS. Em ponto
 * flutuante, `round2(round2(pv) × alíq)` erra 1 centavo na fronteira de meio centavo (R$ 65,00 × 6,5% = 4,225 dá 4,22;
 * o Postgres dá 4,23 — 76 fronteiras entre R$ 0,01 e R$ 2.000 nas 3 alíquotas medidas), e a RPC, que recalcula em
 * numeric e exige igualdade, recusaria o pedido.
 */
export function ipiCentavos(linhaCentavos: number, aliquotaCentesimos: number): number {
  return Math.floor((linhaCentavos * aliquotaCentesimos + 5000) / 10000);
}
/**
 * Tolerância da prova `Σ round2(PV) + Σ IPI` × `data.value`: meio centavo do total (2 casas) mais, POR LINHA, o
 * arredondamento da linha a centavos (0,005), o do IPI do item (0,005) e o da exibição do Preço Venda em 4 casas
 * (0,00005 × (1 + alíquota), com folga até 100%). Depende do NÚMERO DE LINHAS, não das quantidades (Preço Venda já é
 * o total da linha). Medido no backtest de 29 pedidos (2026-10-05): pior delta R$ 0,02, com até 18 linhas.
 */
export function toleranciaChecksum(nLinhas: number): number {
  return 0.005 + nLinhas * 0.0101;
}
/** Preço UN do DOM (4 casas) vs `value` do JSON (até 4 casas). */
const TOL_PRECO_UN = 0.0001;

/**
 * Consolida DOM + JSON + o que a edge digitou + o IPI de cada item numa lista de LinhaPortal com mercadoria e IPI só
 * quando PROVADOS. Precisão > recall: qualquer elo faltando ⇒ 'nenhuma' + motivo, linhas sem custo (sku/prz seguem
 * úteis ao diagnóstico), e NENHUM item recebe custo — nunca mistura custo novo com custo antigo no mesmo pedido.
 */
export function consolidarLinhasPortal(dom: LinhaDom[], json: AddJsonPortal | null, esperados: ItemEsperado[], leituraIpi: 'ok' | 'falhou'): Consolidacao {
  const semChecksum: Consolidacao['checksum'] = {
    soma_dom: null, ipi_modelado: null, total_modelado: null, total_json: json?.value ?? null, delta_abs: null, delta_rel: null, tolerancia_abs: null,
  };
  const linhaSemCusto = (sku: string, prz: string): LinhaPortal => ({ sku_portal: sku, prz_ent_raw: prz, total_linha: null, valor_ipi: null });
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
    return { linhas: dom.map((d) => linhaSemCusto(normPortal(d.sku_portal), d.prz_ent_raw ?? '')), fonte: 'nenhuma', motivo: 'sem_json', total_pedido: null, ncm_sem_aliquota: [], checksum: semChecksum };
  }
  const skusJson = json.itens.map((i) => normPortal(i.item));
  const linhasSemCusto = skusJson.map((s) => linhaSemCusto(s, przDe(s)));
  const falha = (motivo: MotivoCaptura, checksum = semChecksum, ncmSemAliquota: string[] = []): Consolidacao =>
    ({ linhas: linhasSemCusto, fonte: 'nenhuma', motivo, total_pedido: null, ncm_sem_aliquota: ncmSemAliquota, checksum });

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

  // (3) IPI: a alíquota de cada item, do NCM do cadastro. Ausente ≠ zero — sem alíquota não existe custo provado.
  if (leituraIpi !== 'ok') return falha('ipi_leitura_falhou');
  const aliqPorSku = new Map<string, number | null>(esperados.map((e) => [normPortal(e.sku_portal), centesimosDaAliquota(e.aliquota_ipi_pct)]));
  const semAliquota = esperados.filter((e) => aliqPorSku.get(normPortal(e.sku_portal)) == null);
  if (semAliquota.length > 0) {
    return falha('ipi_ncm_desconhecido', semChecksum, [...new Set(semAliquota.map((e) => e.ncm ?? '(sem NCM)'))].sort());
  }

  // (4) Prova — para 1 e N itens: Σ round2(Preço Venda) + Σ IPI fecha com o total cobrado dentro da tolerância do
  // arredondamento. Preço Venda JÁ É o total da linha (sem IPI); o IPI é o que o portal soma por cima.
  const calc: { pv: number; linha: number; ipi: number }[] = [];
  for (const p of provadas) {
    const linha = p.precoVenda == null ? null : centavosDaMercadoria(p.precoVenda);
    if (linha == null) return falha('dom_incompleto');
    calc.push({ pv: p.precoVenda as number, linha, ipi: ipiCentavos(linha, aliqPorSku.get(p.sku) as number) });
  }
  const modelado = calc.reduce((s, l) => s + l.linha + l.ipi, 0);
  const deltaAbs = Math.abs(modelado - Math.round(json.value * 100)) / 100;
  const tolerancia = toleranciaChecksum(calc.length);
  const checksum: Consolidacao['checksum'] = {
    soma_dom: calc.reduce((s, l) => s + l.pv, 0),
    ipi_modelado: calc.reduce((s, l) => s + l.ipi, 0) / 100,
    total_modelado: modelado / 100,
    total_json: json.value, delta_abs: deltaAbs, delta_rel: deltaAbs / json.value, tolerancia_abs: tolerancia,
  };
  if (deltaAbs > tolerancia) return falha('checksum_divergente', checksum);
  return {
    linhas: skusJson.map((s, i) => ({ sku_portal: s, prz_ent_raw: przDe(s), total_linha: calc[i].pv, valor_ipi: calc[i].ipi / 100 })),
    fonte: 'dom_checksum', motivo: null, total_pedido: json.value, ncm_sem_aliquota: [], checksum,
  };
}

// ---- Sensor: captura com sucesso no portal e algum item SEM custo provado é sinal, não silêncio ----

// ---------------------------------------------------------------- RPC de escrita (tudo-ou-nada)
/**
 * A escrita do custo é UMA RPC transacional (`sayerlack_aplicar_custo_portal`, v3 em 20261006120000): CAS no banco,
 * o pedido INTEIRO no payload, IPI conferido contra `ipi_aliquota_ncm`, prova contra o total cobrado. Ela RECUSA com
 * SQLSTATE própria (classe CP) e faz ROLLBACK de tudo — a edge casa a MARCA do ramo, nunca "lançou algo". Código
 * desconhecido/ausente (inclusive o CP005, aposentado na v3) é `erro_rpc` (transiente, cega), nunca motivo fabricado.
 */
export type MotivoRpcCusto =
  | 'payload_invalido' | 'po_omie_existente' | 'pedido_nao_elegivel' | 'itens_divergentes'
  | 'aliquota_ipi_ausente' | 'prova_ipi_divergente' | 'erro_rpc';
const SQLSTATE_CUSTO_PORTAL: Readonly<Record<string, Exclude<MotivoRpcCusto, 'erro_rpc'>>> = {
  CP001: 'payload_invalido',
  CP002: 'po_omie_existente',
  CP003: 'pedido_nao_elegivel',
  CP004: 'itens_divergentes',
  CP006: 'aliquota_ipi_ausente',
  CP007: 'prova_ipi_divergente',
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
  /** NCMs sem alíquota em `ipi_aliquota_ncm` — a lista acionável do motivo 'ipi_ncm_desconhecido'. */
  ncm_sem_aliquota: string[];
  n_dom: number; n_json: number; n_itens: number;
  casados: number; nao_casados: number; ambiguos: number;
  planejados: number; atualizados: number; pulados: { sku_codigo_omie: string; motivo: string }[];
  /** true = envio bem-sucedido em que ≥1 item ficou sem custo provado/persistido (fora PO Omie já existente). */
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
  // Cega = algum item do pedido ficou SEM custo provado/persistido: fonte não provou, não casou, ficou ambíguo, foi
  // pulado (qualquer motivo), casou menos itens do que o pedido tem, a RPC recusou (≠ CP002) ou a escrita ficou
  // parcial. Com PO Omie já existente (memória OU banco) a captura não grava (idempotência, não silêncio).
  const cego = !p.jaTemOmie && !omieNoBanco && (
    p.cons.fonte === 'nenhuma' || naoCasados > 0 || ambiguos > 0 || p.pulados.length > 0 || erroRpc != null || escritaParcial || casados !== p.nItens
  );
  const motivo: ResumoCaptura['motivo'] = p.jaTemOmie || omieNoBanco ? 'ja_tem_omie'
    : erroRpc ? erroRpc.motivo
    : (escritaParcial ? 'escrita_parcial' : p.cons.motivo);
  return {
    fonte: p.cons.fonte, motivo, sqlstate_rpc: erroRpc?.sqlstate ?? null, checksum: p.cons.checksum,
    ncm_sem_aliquota: p.cons.ncm_sem_aliquota,
    n_dom: p.nDom, n_json: p.nJson, n_itens: p.nItens, casados, nao_casados: naoCasados, ambiguos,
    planejados: p.planejados, atualizados: p.atualizados, pulados: p.pulados, cego,
  };
}
// <<< ESPELHO(captura-custo) FIM
