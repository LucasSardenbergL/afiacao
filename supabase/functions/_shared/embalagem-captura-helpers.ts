// Helpers puros da captura mensal de preços Sayerlack (embalagem econômica, Fase 1).
// Spec: docs/superpowers/specs/2026-07-14-sayerlack-captura-preco-embalagem-design.md
//
// ⚠️ ESPELHADO VERBATIM em supabase/functions/_shared/embalagem-captura-helpers.ts
// (Deno não importa de src/). Paridade byte-a-byte garantida por
// __tests__/embalagem-captura-helpers.parity.test.ts — edite os DOIS juntos.
// Self-contained de propósito (zero imports): parseBRL é duplicado de
// sayerlack-scraping-pedido.ts para o arquivo inteiro ser a unidade de paridade.

export const TOLERANCIA_CROSSCHECK = 0.005; // 0,5% — Preço Venda × (Preço UN×(1−desc))
export const RUN_ATIVO_JANELA_MIN = 20; // lock: run 'running' mais novo que isso barra outro run

export function parseBRL(s: string): number | null {
  if (typeof s !== 'string') return null;
  const limpo = s.replace(/[^\d,.-]/g, '').trim();
  if (!limpo) return null;
  const normal = limpo.replace(/\./g, '').replace(',', '.'); // pt-BR: ponto=milhar, vírgula=decimal
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

// "% Desconto" do portal em pontos percentuais ("13,8678" → 13.8678).
// Range é validado na decisão (não aqui): parse cru, semântica separada.
export function parsePercentBR(s: string): number | null {
  return parseBRL(s);
}

// Identidade do item na linha em edição por TOKEN exato (não substring — Codex
// P1: "WP01.3900QTX" contém "WP01.3900QT" e passaria num indexOf). Tokeniza o
// texto da linha por qualquer separador fora de [A-Z0-9.], apara pontos das
// pontas e exige igualdade exata com o código esperado.
export function conferirCodigoNaLinha(textoLinha: string, esperado: string): boolean {
  const alvo = (esperado ?? '').trim().toUpperCase();
  if (!alvo) return false;
  const tokens = (textoLinha ?? '')
    .toUpperCase()
    .split(/[^A-Z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  return tokens.includes(alvo);
}

// O que o browser devolve por embalagem (células cruas da linha em edição).
export interface CapturaItemBruto {
  sku_portal: string;
  achado: boolean;
  motivo_nao_achado?: string | null;
  // Texto completo da linha em edição (innerText + values) — a identidade do
  // item é decidida AQUI por token exato (conferirCodigoNaLinha); quando
  // presente e não-vazio, VENCE o codigo_confere legado.
  texto_linha_raw?: string | null;
  // false = o browser (legado) julgou que a linha não contém o sku esperado →
  // fail-closed. undefined = não verificado (compat) → segue o fluxo normal.
  codigo_confere?: boolean | null;
  preco_venda_raw?: string | null; // "Preço Venda" = R$/embalagem LÍQUIDO (o número-alvo)
  preco_un_raw?: string | null; // "Preço UN" = R$/embalagem tabela (contraprova)
  desconto_raw?: string | null; // "% Desconto" por embalagem (contraprova)
}

export type ResultadoLeitura = 'ok' | 'nao_encontrado' | 'falha';
export type FonteLeitura = 'portal_capturado_ok' | 'portal_capturado_parcial';

export interface LeituraEmbalagem {
  sku_portal: string;
  resultado: ResultadoLeitura;
  preco: number | null; // null = não gravável (ausente ≠ zero: nunca 0 fabricado)
  fonte: FonteLeitura | null; // qualidade da LEITURA da linha (a do RUN vive no run-log)
  detalhe: string | null;
}

// Decide a qualidade da leitura de UMA embalagem. Prova money-path do spike-A:
// Preço Venda = Preço UN × (1 − desconto) fecha nas 2 embalagens → o cross-check
// distingue leitura inequívoca ('portal_capturado_ok') de degradada ('parcial').
export function decidirLeituraEmbalagem(item: CapturaItemBruto): LeituraEmbalagem {
  const sku = item.sku_portal;
  if (!item.achado) {
    return {
      sku_portal: sku,
      resultado: 'nao_encontrado',
      preco: null,
      fonte: null,
      detalhe: `item não localizado no portal (${item.motivo_nao_achado ?? 'sem_motivo'})`,
    };
  }
  const textoLinha = (item.texto_linha_raw ?? '').trim();
  const confere = textoLinha ? conferirCodigoNaLinha(textoLinha, sku) : item.codigo_confere !== false;
  if (!confere) {
    return {
      sku_portal: sku,
      resultado: 'falha',
      preco: null,
      fonte: null,
      detalhe: 'item selecionado na linha não confere com o sku_portal esperado — preço não gravado (precisão > recall)',
    };
  }
  const pv = parseBRL(item.preco_venda_raw ?? '');
  const pu = parseBRL(item.preco_un_raw ?? '');
  const desc = parsePercentBR(item.desconto_raw ?? '');
  const descValido = desc != null && desc >= 0 && desc < 100;
  const derivado = pu != null && pu > 0 && descValido ? pu * (1 - desc / 100) : null;

  if (pv != null && pv > 0) {
    if (derivado != null && derivado > 0) {
      const diff = Math.abs(pv - derivado) / derivado;
      if (diff <= TOLERANCIA_CROSSCHECK) {
        return { sku_portal: sku, resultado: 'ok', preco: pv, fonte: 'portal_capturado_ok', detalhe: null };
      }
      return {
        sku_portal: sku,
        resultado: 'ok',
        preco: pv,
        fonte: 'portal_capturado_parcial',
        detalhe: `cross-check divergente: Preço Venda ${pv} vs Preço UN×(1−desc) ${derivado.toFixed(4)} (${(diff * 100).toFixed(2)}%)`,
      };
    }
    return {
      sku_portal: sku,
      resultado: 'ok',
      preco: pv,
      fonte: 'portal_capturado_parcial',
      detalhe: 'cross-check indisponível (Preço UN/% Desconto ilegíveis) — preço-venda sem contraprova',
    };
  }
  if (derivado != null && derivado > 0) {
    return {
      sku_portal: sku,
      resultado: 'ok',
      preco: derivado,
      fonte: 'portal_capturado_parcial',
      detalhe: `preço-venda ilegível; derivado de Preço UN×(1−desc) = ${derivado.toFixed(4)}`,
    };
  }
  return {
    sku_portal: sku,
    resultado: 'falha',
    preco: null,
    fonte: null,
    detalhe: 'células de preço ilegíveis — nenhum preço gravado (ausente ≠ zero)',
  };
}

// Data civil de São Paulo (o "mês do run" é o mês do NEGÓCIO, não o de UTC).
export function diaSaoPaulo(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return '';
  }
}

export function mesSaoPaulo(iso: string): string {
  const dia = diaSaoPaulo(iso);
  return dia ? dia.slice(0, 7) : '';
}

export interface RunResumo {
  status: 'running' | 'ok' | 'parcial' | 'falha';
  iniciado_em: string;
}

export type DecisaoRun =
  | { executa: true }
  | { executa: false; motivo: 'run_ativo' | 'ja_ok_no_mes' | 'circuit_breaker_dia' };

// Guard idempotente do run (a edge consulta o run-log do mês e passa aqui):
// - lock: run 'running' recente barra QUALQUER disparo (running órfão > janela não barra);
// - cron: run 'ok' no mês (SP) → saída-cedo idempotente; run 'parcial' NÃO barra (auto-retry 11/12);
// - cron/reajuste: run 'falha' no mesmo dia (SP) → circuit-breaker (não re-martelar o portal hoje);
// - manual: staff decide — só o lock barra.
export function decidirExecucaoRun(
  runs: RunResumo[],
  agoraIso: string,
  disparo: 'cron' | 'manual' | 'reajuste',
): DecisaoRun {
  const agoraMs = Date.parse(agoraIso);
  const janelaMs = RUN_ATIVO_JANELA_MIN * 60_000;
  for (const r of runs) {
    if (r.status !== 'running') continue;
    const ini = Date.parse(r.iniciado_em);
    if (Number.isFinite(ini) && agoraMs - ini < janelaMs) return { executa: false, motivo: 'run_ativo' };
  }
  if (disparo === 'manual') return { executa: true };
  if (disparo === 'cron') {
    const mesAgora = mesSaoPaulo(agoraIso);
    if (mesAgora && runs.some((r) => r.status === 'ok' && mesSaoPaulo(r.iniciado_em) === mesAgora)) {
      return { executa: false, motivo: 'ja_ok_no_mes' };
    }
  }
  const diaAgora = diaSaoPaulo(agoraIso);
  if (diaAgora && runs.some((r) => r.status === 'falha' && diaSaoPaulo(r.iniciado_em) === diaAgora)) {
    return { executa: false, motivo: 'circuit_breaker_dia' };
  }
  return { executa: true };
}

export interface ResumoRun {
  status: 'ok' | 'parcial' | 'falha';
  total_ok: number;
  total_nao_encontrado: number;
  total_falha: number;
}

// Status do RUN: 'ok' = 100% das embalagens com leitura inequívoca; 'parcial' =
// gravou ≥1 preço mas não-100%-limpo (inativada/degradada — cron re-tenta no dia
// seguinte); 'falha' = nenhum preço gravado.
export function resumirRun(leituras: LeituraEmbalagem[]): ResumoRun {
  let total_ok = 0;
  let total_nao_encontrado = 0;
  let total_falha = 0;
  let limpas = 0;
  let gravaveis = 0;
  for (const l of leituras) {
    if (l.resultado === 'ok') {
      total_ok++;
      if (l.preco != null && l.preco > 0) gravaveis++;
      if (l.fonte === 'portal_capturado_ok') limpas++;
    } else if (l.resultado === 'nao_encontrado') {
      total_nao_encontrado++;
    } else {
      total_falha++;
    }
  }
  const status: ResumoRun['status'] =
    leituras.length > 0 && limpas === leituras.length ? 'ok' : gravaveis > 0 ? 'parcial' : 'falha';
  return { status, total_ok, total_nao_encontrado, total_falha };
}

export interface InsertPreco {
  empresa: string;
  sku_codigo_omie: string;
  fornecedor_nome: string;
  preco: number;
  moeda: string;
  preco_tipo: string;
  fonte: FonteLeitura;
  status: string;
  run_id: string;
  observacao: string | null;
  criado_por: string;
}

// Linha p/ sku_preco_fornecedor_capturado — ou null (linha sem preço NÃO existe
// nessa tabela; a ausência vive no run-log). Shape consistente com o
// PrecoEmbalagemDialog (o leitor useEmbalagemConsulta é o mesmo).
export function montarInsertPreco(
  l: LeituraEmbalagem,
  ctx: { empresa: string; skuCodigoOmie: string; runId: string },
): InsertPreco | null {
  if (l.resultado !== 'ok' || l.fonte == null) return null;
  if (!(typeof l.preco === 'number' && Number.isFinite(l.preco) && l.preco > 0)) return null;
  return {
    // case-trap: esta tabela usa 'oben' minúsculo (≠ sku_fornecedor_externo 'OBEN')
    empresa: ctx.empresa.toLowerCase(),
    sku_codigo_omie: ctx.skuCodigoOmie,
    fornecedor_nome: 'Sayerlack',
    preco: l.preco,
    moeda: 'BRL',
    preco_tipo: 'liquido',
    fonte: l.fonte,
    status: 'ok',
    run_id: ctx.runId,
    observacao: l.detalhe,
    criado_por: 'edge:sayerlack-captura-precos',
  };
}

// Gate duro de persistência (Codex P0): o preço OFICIAL só entra com o portal
// comprovadamente limpo — todo item processado cancelou a linha (prova
// positiva) E o browser reportou 0 linhas restantes no rascunho. Sem prova →
// não persiste (precisão > recall; o retry dos dias 11/12 cobre o recall).
export function podePersistirRun(
  itensProcessados: { cancelamento_ok?: boolean | null }[],
  linhasFinais: number | null | undefined,
): { pode: boolean; motivo: string | null } {
  if (linhasFinais !== 0) {
    return {
      pode: false,
      motivo: `estado do rascunho não comprovado limpo (linhas_finais=${linhasFinais ?? 'não reportado'}) — nenhum preço persistido`,
    };
  }
  const semProva = itensProcessados.filter((i) => i.cancelamento_ok !== true).length;
  if (semProva > 0) {
    return {
      pode: false,
      motivo: `cancelamento da linha não comprovado em ${semProva} item(ns) — nenhum preço persistido`,
    };
  }
  return { pode: true, motivo: null };
}

// Modo spike captura 1 grupo, determinístico: o grupo do menor sku_portal
// (WP01.3900* hoje — a referência conferível do spike-A).
export function escolherGrupoSpike(pares: { grupo_id: string; sku_portal: string }[]): string | null {
  if (pares.length === 0) return null;
  const ordenado = [...pares].sort((a, b) => a.sku_portal.localeCompare(b.sku_portal, 'en'));
  return ordenado[0].grupo_id;
}

export interface ClassificacaoRascunho {
  cancelaveis: boolean;
  desconhecidas: string[];
}

// Rascunho sujo ao abrir pedido novo: o portal re-hidrata a proposta "em
// digitação" do usuário da captura (visto em prod: proposta 341069 renascendo
// com WP01.3900QT — spike-B f33bc51d). Linha cujo texto contém um SKU do NOSSO
// mapa de captura é resíduo dos nossos próprios runs → seguro cancelar (a
// captura nunca grava/efetiva). Qualquer linha fora do mapa pode ser rascunho
// HUMANO → não é nosso papel apagar (abortar sem tocar).
// ⚠️ Esta função é interpolada via .toString() no código Browserless: precisa
// ser SELF-CONTAINED (sem referenciar símbolos externos) e sem template literal.
export function classificarLinhasRascunho(
  textosLinhas: string[],
  skusDoMapa: string[],
): ClassificacaoRascunho {
  const mapa = skusDoMapa
    .map(function (s) { return String(s || '').trim().toUpperCase(); })
    .filter(function (s) { return s.length > 0; });
  const desconhecidas: string[] = [];
  for (const texto of textosLinhas) {
    const t = String(texto || '').toUpperCase();
    const pertence = t.trim().length > 0 && mapa.some(function (sku) { return t.indexOf(sku) !== -1; });
    if (!pertence) desconhecidas.push(String(texto || '').trim().substring(0, 80));
  }
  return {
    cancelaveis: textosLinhas.length > 0 && desconhecidas.length === 0,
    desconhecidas,
  };
}
