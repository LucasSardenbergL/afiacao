// Extrai o código do fornecedor Sayerlack embutido na DESCRIÇÃO do produto Omie.
//
// Descoberta (founder): o código do portal Sayerlack/Renner está SEMPRE dentro da
// descrição do produto no Omie (ex.: "BASE FUNDO ACAB PU TRANSP WFOT.6529QT" →
// código WFOT.6529QT). Esse código é exatamente o `sku_portal` que a automação digita
// na busca do portal. Logo, o de-para é EXTRAÍVEL deterministicamente — não é matching
// por similaridade nem scraping.
//
// Formato do código: PREFIXO(2-4 letras + 0-2 dígitos) "." NUM1(3-4 díg) ["." NUM2(2-4 díg)]?
// SUFIXO(1-3 letras + dígito opcional). O ".dígitos" é o discriminador — palavras normais
// da descrição (BASE, PU, GOLF30) não têm essa estrutura. O código aparece no FIM (maioria)
// ou no COMEÇO (concentrados: "WP12.3900QT CONCENTRADO PRETO").
//
// ⚠️ money-path (de-para errado = PO errado no fornecedor) — decisões do codex:
//  • 0 matches → revisão; 1 → seguro; >1 → revisão OBRIGATÓRIA (nunca escolher "o melhor").
//  • o SUFIXO (QT/GL/LT/L5/CGL/BH/BB) é embalagem/variante — NÃO assumir que é a unidade
//    comercial do Omie nem derivar fator_conversao dele.
//  • validar sempre contra o gabarito (mapeamentos já feitos na mão) antes de auto-aplicar.

// Token do código: começa em fronteira de palavra, letras+díg opcionais, .díg, [.díg]?, sufixo.
const CODIGO_RE = /\b[A-Z]{2,4}\d{0,2}\.\d{3,4}(?:\.\d{2,4})?[A-Z]{1,3}\d?\b/g;

// Variante separador-ESPAÇO: os TINGIDORES trazem o código com ESPAÇO no lugar do 1º ponto
// na descrição Omie ("TEH 3505.211FG") em vez do formato pontuado ("TEH.3505.211FG").
// extrairCodigosSayerlack normaliza a saída (espaço→ponto) — o gabarito provou que o
// sku_portal correto é PONTUADO (formato que o portal busca).
// DUPLAMENTE ESTREITA (money-path — catch do codex 2026-05-30):
//   (a) EXIGE a 2ª parte pontuada (\.\d{2,4}) → rejeita "PU 6611A" (sem 2ª parte);
//   (b) o PREFIXO é restrito à família de tingidor/mordente/acquacolor (TEH|TE|TM|TY) → sem
//       isso, "PU 6611.22BH" ou "COR RAL 9010.20BR" (palavra comum + núm.núm) virariam
//       de-para inventado (PO errado). Só o ponto colado ao prefixo é sinal forte de código;
//       o espaço é ambíguo, então o prefixo precisa ser de uma família conhecida.
// TEH antes de TE na alternância (match guloso do prefixo mais longo).
const CODIGO_ESPACO_RE = /\b(?:TEH|TE|TM|TY)\d{0,2} \d{3,4}\.\d{2,4}[A-Z]{1,3}\d?\b/g;

// O sufixo = trecho final de letras (+ 1 dígito opcional, ex L5) do código.
const SUFIXO_RE = /([A-Z]{1,3}\d?)$/;

const PARSER_VERSION = 2; // v2: + variante separador-espaço (tingidores), saída normalizada pra ponto
export { PARSER_VERSION };

function norm(s: string | null | undefined): string {
  return (s ?? '').normalize('NFKC').trim().toUpperCase();
}

/** Todos os códigos Sayerlack distintos encontrados na descrição (ordem de aparição).
 *  Casa o formato pontuado e a variante separador-espaço (esta normalizada espaço→ponto). */
export function extrairCodigosSayerlack(descricao: string | null | undefined): string[] {
  if (!descricao) return [];
  const d = norm(descricao);
  const pontuados = d.match(CODIGO_RE) ?? [];
  const espacados = (d.match(CODIGO_ESPACO_RE) ?? []).map((m) => m.replace(' ', '.'));
  return [...new Set([...pontuados, ...espacados])];
}

/** O sufixo/embalagem do código (ex.: "QT", "GL", "L5", "CGL"). NÃO é unidade comercial. */
export function sufixoSayerlack(codigo: string): string {
  return norm(codigo).match(SUFIXO_RE)?.[1] ?? '';
}

/**
 * Produto FRACIONADO (descrição termina em 450ML/405ML): no Omie é o item-pai (QT)
 * transformado em unidades menores — só VENDIDO, nunca COMPRADO pelo portal Sayerlack.
 * Espelha a exclusão da RPC gerar_pedidos_sugeridos_ciclo (NOT ILIKE '%450ML'/'%405ML'),
 * pra tirar esses fantasmas históricos da validação de mapeamento.
 */
export function ehProdutoFracionado(descricao: string | null | undefined): boolean {
  const d = norm(descricao);
  return d.endsWith('450ML') || d.endsWith('405ML');
}

export type ResolucaoSayerlack =
  | { status: 'ok'; codigo: string; sufixo: string; candidatos: string[] }
  | { status: 'sem_codigo'; candidatos: [] }
  | { status: 'multiplos'; candidatos: string[] };

/**
 * Resolve o código Sayerlack de uma descrição, aplicando a regra money-path do codex:
 * exatamente 1 match = seguro; 0 ou >1 = precisa de humano.
 */
export function resolverSayerlack(descricao: string | null | undefined): ResolucaoSayerlack {
  const cods = extrairCodigosSayerlack(descricao);
  if (cods.length === 0) return { status: 'sem_codigo', candidatos: [] };
  if (cods.length > 1) return { status: 'multiplos', candidatos: cods };
  return { status: 'ok', codigo: cods[0], sufixo: sufixoSayerlack(cods[0]), candidatos: cods };
}

export type ComparacaoGabarito = {
  resultado: 'bate' | 'diverge' | 'sem_codigo' | 'multiplos';
  extraido: string | null;
};

/**
 * Compara o código extraído da descrição com o sku_portal JÁ salvo (gabarito).
 * É a primitiva do GATE de segurança: rodar contra todos os mapeamentos manuais; se
 * 'bate' em ~100%, está provado seguro auto-aplicar nos não-mapeados. 'diverge' →
 * revisão humana (typo manual / corte de display / portal busca diferente) — NUNCA
 * sobrescrever o mapa manual automaticamente.
 */
export function compararComGabarito(
  descricao: string | null | undefined,
  skuPortalSalvo: string | null | undefined,
): ComparacaoGabarito {
  const r = resolverSayerlack(descricao);
  if (r.status === 'sem_codigo') return { resultado: 'sem_codigo', extraido: null };
  if (r.status === 'multiplos') return { resultado: 'multiplos', extraido: null };
  return {
    resultado: norm(r.codigo) === norm(skuPortalSalvo) ? 'bate' : 'diverge',
    extraido: r.codigo,
  };
}

// ─── GATE: valida o parser contra o gabarito (mapeamentos já feitos na mão) ───

export interface GabaritoRow {
  sku_omie: string;
  sku_portal: string | null;
  descricao: string | null;
}

export interface GabaritoResult {
  batem: number;
  divergem: { sku_omie: string; salvo: string; extraido: string }[];
  naoValidavel: number; // sem código extraível na descrição (ou descrição ausente) — não dá pra aferir
  total: number;
}

/**
 * Roda o parser contra todos os mapeamentos existentes e mede a taxa de acerto.
 * codex: liberar auto-apply só com ~100% de `batem` (as `divergem` viram revisão).
 */
export function validarGabarito(rows: GabaritoRow[]): GabaritoResult {
  const res: GabaritoResult = { batem: 0, divergem: [], naoValidavel: 0, total: rows.length };
  for (const row of rows) {
    const c = compararComGabarito(row.descricao, row.sku_portal);
    if (c.resultado === 'bate') res.batem++;
    else if (c.resultado === 'diverge') {
      res.divergem.push({ sku_omie: row.sku_omie, salvo: norm(row.sku_portal), extraido: c.extraido ?? '' });
    } else {
      res.naoValidavel++; // sem_codigo ou multiplos → não dá pra validar automaticamente
    }
  }
  return res;
}

// ─── SUGESTÃO: deriva mapeamentos dos SKUs sem mapa (faltantes) ───

export interface FaltanteInput {
  sku_codigo_omie: string;
  sku_descricao: string | null;
}

export interface SugestaoSegura {
  sku_omie: string;
  descricao: string;
  sku_portal: string;
  sufixo: string;
}

export interface SugestoesResult {
  seguros: SugestaoSegura[]; // exatamente 1 código extraído → prontos pra gravar (após revisão)
  semCodigo: FaltanteInput[]; // 0 códigos → humano
  multiplos: { sku_omie: string; descricao: string; candidatos: string[] }[]; // >1 → humano (codex)
}

/**
 * Pra cada SKU sem mapeamento, extrai o código Sayerlack da descrição e classifica:
 * seguro (1 match) / sem_codigo (0) / multiplos (>1). Só os `seguros` viram candidatos
 * a auto-gravar; o resto é triagem humana.
 */
export function sugerirMapeamentos(faltantes: FaltanteInput[]): SugestoesResult {
  const res: SugestoesResult = { seguros: [], semCodigo: [], multiplos: [] };
  for (const f of faltantes) {
    const r = resolverSayerlack(f.sku_descricao);
    if (r.status === 'ok') {
      res.seguros.push({
        sku_omie: f.sku_codigo_omie,
        descricao: f.sku_descricao ?? '',
        sku_portal: r.codigo,
        sufixo: r.sufixo,
      });
    } else if (r.status === 'multiplos') {
      res.multiplos.push({ sku_omie: f.sku_codigo_omie, descricao: f.sku_descricao ?? '', candidatos: r.candidatos });
    } else {
      res.semCodigo.push(f);
    }
  }
  return res;
}
