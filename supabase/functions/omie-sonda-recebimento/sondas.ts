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
  "nIdItPedido",
  "nQtde",
  "nQtdeNFe",
  "nQtdeRecebida",
];

/** Profundidade da busca DENTRO do elemento ao decidir se um array é de itens. */
const PROF_MARCADOR = 3;

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
      // Busca o marcador EM PROFUNDIDADE dentro do elemento: `itensRecebimento[]` guarda tudo
      // sob `itensCabec`/`itensAjustes`/`itensInfoAdic`, então olhar só o topo do elemento
      // devolvia "sem itens" num payload cheio deles (bug apontado pelo Codex).
      const pareceItem = objetos.length > 0 &&
        objetos.some((el) =>
          CHAVES_DE_ITEM.some((k) =>
            buscarValorProfundo(el, [k], { profundidadeMax: PROF_MARCADOR }) !== undefined
          )
        );
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

// ── Identificador nativo ───────────────────────────────────────────────────────────────────

/**
 * Normaliza um ID nativo do Omie, tratando ZERO como AUSÊNCIA.
 *
 * Este é o detalhe que decide a medição inteira (Codex): `nIdPedido: 0` é como o Omie diz "este
 * item não está associado a pedido nenhum". Se 0 virasse id válido, "sem vínculo" seria contado
 * como "vínculo com a PO 0" — um falso positivo exatamente no campo que a fatia 1 existe para
 * medir. Presença de NOME não é presença de VALOR.
 */
export function idNativo(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0 ? String(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return null;
  // "0", "00", "000": zero escrito de qualquer jeito continua sendo ausência.
  if (/^0+$/.test(s)) return null;
  return s;
}

// ── Busca por nome, em profundidade ────────────────────────────────────────────────────────

/**
 * Procura o primeiro dos `nomes` em qualquer profundidade do objeto e devolve seu valor cru.
 *
 * Buscar por NOME em vez de por caminho fixo é deliberado: o item de recebimento aninha os campos
 * em `itensCabec` / `itensAjustes` / `itensInfoAdic` / `itensIde`, e hardcodar o caminho seria
 * assumir o contrato — o erro que esta sonda existe para não cometer. A ordem dos `nomes` é a
 * ordem de preferência (o Omie alterna grafias, ex.: `cChaveNFe` × `cChaveNfe`).
 */
export function buscarValorProfundo(
  obj: unknown,
  nomes: readonly string[],
  opts: { profundidadeMax?: number } = {},
): unknown {
  const profundidadeMax = opts.profundidadeMax ?? PROFUNDIDADE_PADRAO;
  for (const nome of nomes) {
    const achado = procurar(obj, nome, 0, profundidadeMax);
    if (achado !== undefined) return achado;
  }
  return undefined;
}

function procurar(v: unknown, nome: string, nivel: number, max: number): unknown {
  if (nivel > max || v === null || typeof v !== "object") return undefined;
  if (Array.isArray(v)) {
    for (const el of v.slice(0, ELEMENTOS_AMOSTRADOS)) {
      const r = procurar(el, nome, nivel + 1, max);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const reg = v as Record<string, unknown>;
  if (nome in reg) return reg[nome];
  for (const filho of Object.values(reg)) {
    const r = procurar(filho, nome, nivel + 1, max);
    if (r !== undefined) return r;
  }
  return undefined;
}

// ── Item de recebimento e a taxonomia de associação ────────────────────────────────────────

export interface ItemRecebimentoNormalizado {
  sequencia: string | null;
  idItemRecebimento: string | null;
  /** `nIdPedido` — o vínculo NATIVO com o pedido de compra. null quando o Omie manda 0. */
  idPedido: string | null;
  /** `nIdItPedido` — o vínculo NATIVO com o ITEM do pedido; é ele que o ledger precisa. */
  idItemPedido: string | null;
  /** `nNumPedCompra` — referência TEXTUAL vinda do XML do fornecedor, não vínculo nativo. */
  numPedidoTexto: string | null;
  numItemPedidoTexto: string | null;
  idProduto: string | null;
  codigoProduto: string | null;
  unidade: string | null;
  localEstoque: string | null;
  qtdeNfe: number | null;
  qtdeRecebida: number | null;
  /** `cNaoGerarMovEstoque`: se "S", houve recebimento fiscal SEM movimento de estoque. */
  naoGeraMovEstoque: string | null;
}

export function normalizarItemRecebimento(item: unknown): ItemRecebimentoNormalizado {
  const buscar = (nomes: readonly string[]) => buscarValorProfundo(item, nomes);
  return {
    sequencia: idNativo(buscar(["nSequencia"])),
    idItemRecebimento: idNativo(buscar(["nIdItem"])),
    idPedido: idNativo(buscar(["nIdPedido", "nIdPedidoExistente"])),
    idItemPedido: idNativo(buscar(["nIdItPedido", "nIdItPedidoExistente"])),
    numPedidoTexto: idNativo(buscar(["nNumPedCompra", "cNumPedCompra"])),
    numItemPedidoTexto: idNativo(buscar(["cNumItPedCompra", "nNumItPedCompra"])),
    idProduto: idNativo(buscar(["nIdProduto"])),
    codigoProduto: texto(buscar(["cCodigoProduto", "cCodigo"])),
    unidade: texto(buscar(["cUnidadeNfe", "cUnidade"])),
    localEstoque: idNativo(buscar(["codigo_local_estoque", "nCodLocalEstoque"])),
    qtdeNfe: parseQtdEstrito(buscar(["nQtdeNFe", "nQtde"])),
    qtdeRecebida: parseQtdEstrito(buscar(["nQtdeRecebida", "nQtdeReceb"])),
    naoGeraMovEstoque: texto(buscar(["cNaoGerarMovEstoque", "cNaoGerarMovEstoq"])),
  };
}

/**
 * Como este item de NF-e se liga (ou não) à PO alvo. É a resposta da fatia 1 por item.
 *
 * `native_exact` é o único estado que autorizaria, mais adiante, um desconto do "a caminho" —
 * e ainda assim só depois de amarrado a movimento de estoque postado. `xml_hint_only` é a
 * hipótese que o código do espelho torna provável: `omie-sync-nfes-recebidas` monta o vínculo
 * PO↔NF-e a partir de `nNumPedCompra`, uma referência textual do XML do fornecedor. Se for esse
 * o estado dominante, o `t4` do espelho é INFERÊNCIA NOSSA, não recebimento do Omie — e a
 * etapa-15 deixa de ser contradição.
 */
export type ClasseAssociacao =
  | "native_exact"
  | "native_other_po"
  | "native_sem_item"
  | "xml_hint_only"
  | "xml_hint_outra_po"
  | "product_only"
  | "unassociated";

export function classificarAssociacao(
  item: ItemRecebimentoNormalizado,
  alvo: { idPedido: string | null; numeroPedido: string | null },
): ClasseAssociacao {
  if (item.idPedido !== null) {
    if (alvo.idPedido !== null && item.idPedido !== alvo.idPedido) return "native_other_po";
    return item.idItemPedido !== null ? "native_exact" : "native_sem_item";
  }
  if (item.numPedidoTexto !== null) {
    if (alvo.numeroPedido !== null && item.numPedidoTexto !== alvo.numeroPedido) {
      return "xml_hint_outra_po";
    }
    return "xml_hint_only";
  }
  if (item.idProduto !== null || item.codigoProduto !== null) return "product_only";
  return "unassociated";
}

// ── Escolha da amostra ─────────────────────────────────────────────────────────────────────

/**
 * Escolhe POs de NOTAS distintas, cobrindo os dois extremos da consolidação.
 *
 * Sem isto, "as 3 POs mais recentes" pode selecionar três POs da MESMA nota (94% das POs alvo
 * dividem nota com outra) — a S2 rodaria uma vez só e a amostra não representaria nada. A ordem
 * alterna a nota que cobre MAIS POs (o caso dominante, onde a atribuição é ambígua) com a que
 * cobre menos (o caso raro de nota exclusiva), porque os dois lados decidem coisas diferentes
 * no ledger.
 */
export function escolherPorNotaDiversa<T extends { nid_receb: number | null }>(
  linhas: readonly T[],
  limite: number,
): T[] {
  const porNota = new Map<number, T[]>();
  for (const l of linhas) {
    if (l.nid_receb == null) continue;
    const g = porNota.get(l.nid_receb);
    if (g) g.push(l);
    else porNota.set(l.nid_receb, [l]);
  }
  // Grupos ordenados por quantidade de POs na nota (desc) — empate resolvido pelo id, para a
  // escolha ser determinística entre execuções.
  const grupos = [...porNota.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);

  const escolhidas: T[] = [];
  let inicio = 0;
  let fim = grupos.length - 1;
  let pegarDoInicio = true;
  while (escolhidas.length < limite && inicio <= fim) {
    const g = pegarDoInicio ? grupos[inicio++] : grupos[fim--];
    escolhidas.push(g[1][0]);
    pegarDoInicio = !pegarDoInicio;
  }
  return escolhidas;
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

// ── Destino: enum fechado, nunca dado de entrada ───────────────────────────────────────────

/**
 * Serviços do Omie que a sonda pode consultar. URLs HARDCODED, por segurança, não por estilo.
 *
 * A edge manda `app_key`/`app_secret` no CORPO de cada requisição. Se o destino viesse do corpo
 * da invocação — como vinha na primeira versão, via `candidatos_movimento[].endpoint` — quem
 * chamasse a sonda poderia apontá-la para um host próprio e receber a credencial do ERP de
 * produção. A allowlist de MÉTODO não fecha isso: ela restringe o verbo, não o destino.
 *
 * Por que não uma allowlist exata de pares (serviço, método), como o Codex sugeriu: descobrir
 * método ainda não catalogado é justamente o trabalho da S3. O par serviço-fechado + método
 * restrito a consulta preserva a descoberta sem deixar a credencial sair do host do Omie.
 */
const SERVICOS: Readonly<Record<string, string>> = {
  pedido_compra: "https://app.omie.com.br/api/v1/produtos/pedidocompra/",
  recebimento_nfe: "https://app.omie.com.br/api/v1/produtos/recebimentonfe/",
  estoque_consulta: "https://app.omie.com.br/api/v1/estoque/consulta/",
  estoque_resumo: "https://app.omie.com.br/api/v1/estoque/resumo/",
  estoque_movestoque: "https://app.omie.com.br/api/v1/estoque/movestoque/",
  estoque_ajuste: "https://app.omie.com.br/api/v1/estoque/ajuste/",
  estoque_local: "https://app.omie.com.br/api/v1/estoque/local/",
};

// Sem `export type Servico = keyof typeof SERVICOS`: o serviço chega como string do corpo da
// requisição e é validado em RUNTIME por `urlDoServico`. Um tipo estático aqui daria falsa
// segurança sobre um valor que o compilador nunca vê — e o knip acusaria o export morto.

export function servicosConhecidos(): string[] {
  return Object.keys(SERVICOS).sort();
}

/** URL do serviço, ou `null` para qualquer entrada que não seja uma chave EXATA do enum. */
export function urlDoServico(servico: string): string | null {
  if (typeof servico !== "string") return null;
  return Object.prototype.hasOwnProperty.call(SERVICOS, servico) ? SERVICOS[servico] : null;
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
