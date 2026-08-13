// Núcleo PURO da sonda de contrato do Omie (fatia 1 do receipt-first ledger).
//
// Premissa de desenho: "nome de endpoint não é contrato". Estas funções não assumem a forma do
// payload — elas a MEDEM. Um método que não existe vira `fault` (dado), não exceção; um campo
// ausente vira `null` marcado, não zero; a lista de itens é LOCALIZADA, não pressuposta.
//
// Puro de propósito: `test:edges` roda com --no-remote, então nada aqui pode importar rede.

// ── Desfecho de uma chamada ao Omie ────────────────────────────────────────────────────────

export type Desfecho =
  | { tipo: "ok"; json: Record<string, unknown> }
  | {
    tipo: "fault";
    faultcode: string | null;
    faultstring: string;
    json: Record<string, unknown>;
  }
  | { tipo: "http_erro"; status: number; corpo: string }
  | { tipo: "nao_json"; status: number; corpo: string };

const CORPO_MAX = 400;

/**
 * Classifica a resposta crua do Omie.
 *
 * Regras herdadas de incidentes do repo:
 *  - `faultstring` SEM `faultcode` também é fault (senão vira "página vazia" → zeros no pendente);
 *  - HTTP não-ok COM faultstring é fault de negócio (o Omie usa 500 para "não existem registros");
 *  - corpo ilegível é `nao_json` e NUNCA colapsa em objeto vazio ("não consegui ler" ≠ "não existe");
 *  - JSON válido que não é objeto (array/escalar) também é `nao_json`: não dá para ler faultstring
 *    dele, então tratá-lo como sucesso seria assumir contrato — fail-closed.
 */
export function classificarResposta(status: number, texto: string): Desfecho {
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto);
  } catch {
    return { tipo: "nao_json", status, corpo: texto.slice(0, CORPO_MAX) };
  }
  if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) {
    return { tipo: "nao_json", status, corpo: texto.slice(0, CORPO_MAX) };
  }
  const json = bruto as Record<string, unknown>;

  const faultstring = typeof json.faultstring === "string" ? json.faultstring : null;
  if (faultstring) {
    return {
      tipo: "fault",
      faultcode: typeof json.faultcode === "string" ? json.faultcode : null,
      faultstring,
      json,
    };
  }
  if (status < 200 || status >= 300) {
    return { tipo: "http_erro", status, corpo: texto.slice(0, CORPO_MAX) };
  }
  return { tipo: "ok", json };
}

// ── Inventário de chaves ───────────────────────────────────────────────────────────────────

const PROFUNDIDADE_PADRAO = 6;
const ELEMENTOS_AMOSTRADOS = 25;

/**
 * Devolve os caminhos de chave de um payload, ordenados e sem repetição.
 *
 * Arrays colapsam em `campo[]` e as chaves dos elementos são UNIDAS — um campo presente em
 * apenas alguns itens não pode desaparecer do inventário. Array vazio e `null` registram o
 * caminho mesmo assim: "existe e está vazio" ≠ "não existe", e essa diferença é o achado.
 */
export function caminhosDeChave(
  valor: unknown,
  opts: { profundidadeMax?: number } = {},
): string[] {
  const profundidadeMax = opts.profundidadeMax ?? PROFUNDIDADE_PADRAO;
  const achados = new Set<string>();

  function anda(v: unknown, prefixo: string, nivel: number): void {
    if (Array.isArray(v)) {
      const base = `${prefixo}[]`;
      if (v.length === 0 || nivel >= profundidadeMax) {
        achados.add(base);
        return;
      }
      for (const el of v.slice(0, ELEMENTOS_AMOSTRADOS)) anda(el, base, nivel);
      return;
    }
    if (typeof v === "object" && v !== null) {
      const chaves = Object.keys(v as Record<string, unknown>);
      if (chaves.length === 0 || nivel >= profundidadeMax) {
        if (prefixo) achados.add(prefixo);
        return;
      }
      for (const k of chaves) {
        const caminho = prefixo ? `${prefixo}.${k}` : k;
        anda((v as Record<string, unknown>)[k], caminho, nivel + 1);
      }
      return;
    }
    if (prefixo) achados.add(prefixo);
  }

  anda(valor, "", 0);
  return [...achados].sort();
}

export function diffCaminhos(
  a: readonly string[],
  b: readonly string[],
): { soEmA: string[]; soEmB: string[]; comuns: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    soEmA: [...sa].filter((k) => !sb.has(k)).sort(),
    soEmB: [...sb].filter((k) => !sa.has(k)).sort(),
    comuns: [...sa].filter((k) => sb.has(k)).sort(),
  };
}

// ── Localização da lista de itens ──────────────────────────────────────────────────────────

/** Marcadores de "isto é um item de compra/recebimento" — identidade de produto ou quantidade. */
const CHAVES_DE_ITEM = [
  "nCodProd",
  "nIdProduto",
  "cCodigoProduto",
  "nCodItem",
  "nQtde",
  "nQtdeNFe",
  "nQtdeRecebida",
];

/**
 * Encontra a lista de itens dentro de um payload SEM assumir onde ela mora — o ponto da sonda é
 * justamente que o nome do campo no `ConsultarPedCompra`/`ConsultarRecebimento` não é conhecido.
 * Havendo mais de uma candidata, devolve a MAIOR (a lista de itens é a densa; parcelas e
 * departamentos são curtas).
 */
export function localizarItens(
  payload: unknown,
  opts: { profundidadeMax?: number } = {},
): { caminho: string; itens: Record<string, unknown>[] } | null {
  const profundidadeMax = opts.profundidadeMax ?? PROFUNDIDADE_PADRAO;
  let melhor: { caminho: string; itens: Record<string, unknown>[] } | null = null;

  function anda(v: unknown, prefixo: string, nivel: number): void {
    if (nivel > profundidadeMax) return;
    if (Array.isArray(v)) {
      const objetos = v.filter(
        (el): el is Record<string, unknown> =>
          typeof el === "object" && el !== null && !Array.isArray(el),
      );
      const pareceItem = objetos.length > 0 &&
        objetos.some((el) => CHAVES_DE_ITEM.some((k) => k in el));
      if (pareceItem && prefixo && (melhor === null || objetos.length > melhor.itens.length)) {
        melhor = { caminho: prefixo, itens: objetos };
      }
      for (const el of v.slice(0, ELEMENTOS_AMOSTRADOS)) anda(el, prefixo, nivel + 1);
      return;
    }
    if (typeof v === "object" && v !== null) {
      for (const [k, filho] of Object.entries(v as Record<string, unknown>)) {
        anda(filho, prefixo ? `${prefixo}.${k}` : k, nivel + 1);
      }
    }
  }

  anda(payload, "", 0);
  return melhor;
}

// ── Normalização de item (ausente ≠ zero) ──────────────────────────────────────────────────

export interface ItemPONormalizado {
  codProduto: string | null;
  codItem: string | null;
  unidade: string | null;
  localEstoque: string | null;
  qtde: number | null;
  recebido: number | null;
  /** true SÓ quando a chave não veio no payload — distingue "Omie omitiu" de "veio torto". */
  recebidoAusente: boolean;
  /** valor cru de nQtdeRec, para o relatório mostrar o que o Omie realmente mandou. */
  recebidoBruto: unknown;
}

/**
 * Parse ESTRITO (espelho da política de `pendente-entrada-po.ts`): `Number()` mascara dado torto
 * — ""/null/false/[] viram 0, "0x10" vira 16. Aqui qualquer coisa fora de número decimal simples
 * vira `null`, e quem lê decide o que fazer com o desconhecido.
 */
function parseQtdEstrito(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

const CAMPOS_QTDE_RECEBIDA = ["nQtdeRec", "nQtdeRecebida", "nQtdeReceb"] as const;

export function normalizarItemPO(item: Record<string, unknown>): ItemPONormalizado {
  const campoRec = CAMPOS_QTDE_RECEBIDA.find((c) => c in item);
  const bruto = campoRec ? item[campoRec] : undefined;
  return {
    codProduto: texto(item.nCodProd ?? item.nIdProduto ?? item.cCodigoProduto),
    codItem: texto(item.nCodItem ?? item.nSequencia),
    unidade: texto(item.cUnidade ?? item.cUnidadeNfe),
    localEstoque: texto(item.codigo_local_estoque ?? item.nCodLocal),
    qtde: parseQtdEstrito(item.nQtde ?? item.nQtdeNFe),
    recebido: campoRec === undefined ? null : parseQtdEstrito(bruto),
    recebidoAusente: campoRec === undefined,
    recebidoBruto: bruto,
  };
}

// ── Etapa da PO ────────────────────────────────────────────────────────────────────────────

/**
 * Lê `cabecalho_consulta.cEtapa` de um `raw_data` de PO, sem confiar na forma do objeto.
 * Devolve `null` quando não dá para saber — quem chama decide, e "não sei" nunca vira "não é".
 */
export function etapaDaPO(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const cab = (raw as Record<string, unknown>).cabecalho_consulta;
  if (typeof cab !== "object" || cab === null) return null;
  const etapa = (cab as Record<string, unknown>).cEtapa;
  if (typeof etapa === "string") return etapa.trim() === "" ? null : etapa.trim();
  if (typeof etapa === "number") return String(etapa);
  return null;
}

// ── Trava de leitura ───────────────────────────────────────────────────────────────────────

/** Prefixos de método que o Omie usa para CONSULTA. Allowlist — tudo o mais é negado. */
const PREFIXOS_DE_LEITURA = ["Consultar", "Listar", "Pesquisar", "Obter"] as const;

/**
 * Verdadeiro só para métodos de CONSULTA do Omie.
 *
 * Esta é a trava que faz "a sonda é read-only ao ERP" ser uma propriedade verificável e não uma
 * promessa do comentário: os métodos candidatos podem vir no corpo da requisição (para iterar a
 * descoberta sem um novo deploy), e no MESMO endpoint de recebimento moram `AlterarRecebimento`
 * e `ConcluirRecebimento`, que mudam estado no ERP de produção. Allowlist por prefixo, ancorada
 * no início e case-sensitive: desconhecido é negado, não tolerado.
 */
export function ehMetodoDeLeitura(call: string): boolean {
  const m = call.trim();
  if (m === "" || m !== call) return false;
  return PREFIXOS_DE_LEITURA.some((p) => m.startsWith(p));
}

// ── Redação de segredo ─────────────────────────────────────────────────────────────────────

/**
 * Mascara credenciais antes que qualquer payload vire log, resposta HTTP ou colagem em PR.
 * A transcrição de sessão persiste em disco — segredo não pode transitar em texto plano.
 */
export function redigirSegredos(texto: string): string {
  return texto.replace(
    /("(?:app_key|app_secret)"\s*:\s*)"[^"]*"/gi,
    '$1"***"',
  );
}
