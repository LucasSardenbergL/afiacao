// catalogo-staging_test.ts — lista FECHADA de colunas na linha de staging da rota /catalogs.
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// Money-path: `created_at` e `id` do staging decidem o "mais recente" da promoção e da purga. Um
// item que os escolhesse prendia dado forjado no catálogo para sempre. E, na outra ponta, o
// conserto não pode mudar NADA do que o conector real manda: a equivalência com o algoritmo antigo
// é testada sobre as formas medidas na PROD (2026-11-17, 846.914 itens).
import {
  detalheDaRecusaDeCatalogo,
  type EntidadeComLinhaDeCatalogo,
  ENTIDADES_COM_LINHA_DE_CATALOGO,
  mensagemDaRecusaDeCatalogo,
  montarLinhasDeCatalogo,
  STAGING_DO_CATALOGO,
  TETO_CAMPOS_NO_LOG,
  TETO_NOME_DE_CAMPO,
} from "./catalogo-staging.ts";
import { ENTIDADES_CATALOGO } from "./catalogo-vazio.ts";

const CTX = { runId: "run-do-servidor", account: "oben", storeCode: "M01" };
const DO_SERVIDOR = ["sync_run_id", "account", "store_code", "raw_data", "staging_status"];
const DE_CONTROLE = [...DO_SERVIDOR, "id", "created_at", "matched_id"];

/** JSON com as chaves ordenadas em toda profundidade: compara conteúdo, não ordem de inserção. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) o[k] = (val as Record<string, unknown>)[k];
      return o;
    }
    return val;
  });
}

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (canon(atual) !== canon(esperado)) {
    throw new Error(`${msg}: esperado ${canon(esperado)}, veio ${canon(atual)}`);
  }
}

function assertTrue(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Linhas iguais em CONTEÚDO e em CONJUNTO DE CHAVES. Chave com valor undefined some do JSON, mas o
 *  supabase-js monta `columns=` pelas chaves do objeto: ela viraria coluna explícita no insert. */
function assertMesmasLinhas(atual: Record<string, unknown>[], esperado: Record<string, unknown>[], msg: string) {
  assertEq(atual, esperado, msg);
  assertEq(atual.map((l) => Object.keys(l).sort()), esperado.map((l) => Object.keys(l).sort()), `${msg} (chaves)`);
}

/** O algoritmo ANTIGO da rota (index.ts da v1.3), copiado: referência da equivalência. */
function linhaAntiga(entidade: EntidadeComLinhaDeCatalogo, item: Record<string, unknown>): Record<string, unknown> {
  const keyField = STAGING_DO_CATALOGO[entidade].chave;
  const entityKey = (item[keyField] as string | undefined) || (item.id as string | undefined) || "";
  const row: Record<string, unknown> = {
    sync_run_id: CTX.runId,
    account: CTX.account,
    store_code: CTX.storeCode,
    raw_data: item,
    staging_status: "pending",
  };
  for (const [k, v] of Object.entries(item)) {
    if (k in row) continue;
    row[k] = v;
  }
  row[keyField] = entityKey;
  if (item.descricao) row.descricao = item.descricao;
  if (item.volume_ml !== undefined) row.volume_ml = item.volume_ml;
  if (item.preco_litro !== undefined) row.preco_litro = item.preco_litro;
  if (item.custo !== undefined) row.custo = item.custo;
  if (item.id_base) row.id_base = item.id_base;
  if (item.id_embalagem) row.id_embalagem = item.id_embalagem;
  return row;
}

/** As formas que o conector manda de verdade (um conjunto de chaves por entidade, medido na PROD). */
const FORMAS_REAIS: Record<EntidadeComLinhaDeCatalogo, Record<string, unknown>> = {
  produtos: { cod_produto: "FO10.6554", descricao: "POLIURETANO FOSCO" },
  bases: { id_base_sayersystem: "BS", descricao: "BASE BS" },
  embalagens: { id_embalagem_sayersystem: "QT", descricao: "QUARTO", volume_ml: 900 },
  skus: { cod_produto: "FO10.6554", id_base: "BS", id_embalagem: "QT" },
  corantes: { id_corante_sayersystem: "AX", descricao: "AMARELO OXIDO", volume_ml: 1000 },
};

Deno.test("as 5 formas reais do conector viram a MESMA linha do algoritmo antigo", () => {
  for (const e of ENTIDADES_COM_LINHA_DE_CATALOGO) {
    const item = FORMAS_REAIS[e];
    const m = montarLinhasDeCatalogo(e, [item], CTX);
    assertEq(m.recusados, 0, `${e}: nada recusado`);
    assertEq(m.recebidos, 1, `${e}: recebidos`);
    assertMesmasLinhas(m.linhas, [linhaAntiga(e, item)], `${e}: linha`);
  }
});

Deno.test("linha de corante, campo a campo (ouro)", () => {
  const item = { id_corante_sayersystem: "AX", descricao: "AMARELO OXIDO", volume_ml: 1000 };
  const m = montarLinhasDeCatalogo("corantes", [item], CTX);
  assertEq(m.linhas, [{
    sync_run_id: "run-do-servidor",
    account: "oben",
    store_code: "M01",
    raw_data: { id_corante_sayersystem: "AX", descricao: "AMARELO OXIDO", volume_ml: 1000 },
    staging_status: "pending",
    id_corante_sayersystem: "AX",
    descricao: "AMARELO OXIDO",
    volume_ml: 1000,
  }], "linha de corante");
  assertTrue(m.linhas[0].raw_data === item, "raw_data é o PRÓPRIO item, não uma cópia");
});

Deno.test("toda combinação de colunas permitidas, com null/0/'' no valor, é idêntica ao algoritmo antigo", () => {
  const VALORES: unknown[] = ["X", "", 0, null, 12.5, "0"];
  let casos = 0;
  for (const e of ENTIDADES_COM_LINHA_DE_CATALOGO) {
    const colunas = STAGING_DO_CATALOGO[e].colunas as readonly string[];
    for (let mascara = 0; mascara < (1 << colunas.length); mascara++) {
      for (let giro = 0; giro < VALORES.length; giro++) {
        const item: Record<string, unknown> = {};
        colunas.forEach((c, i) => {
          if (mascara & (1 << i)) item[c] = VALORES[(i + giro) % VALORES.length];
        });
        const m = montarLinhasDeCatalogo(e, [item], CTX);
        assertEq(m.recusados, 0, `${e} máscara ${mascara} giro ${giro}: recusou item honesto`);
        assertMesmasLinhas(m.linhas, [linhaAntiga(e, item)], `${e} máscara ${mascara} giro ${giro}`);
        casos++;
      }
    }
  }
  // 2 entidades de 2 colunas, 2 de 3 e 1 de 5: (4 + 4 + 8 + 8 + 32) × 6 valores.
  assertEq(casos, 336, "não-vacuidade: quantos casos rodaram");
});

Deno.test("O FURO: item com created_at no futuro é recusado e não vira linha", () => {
  const forjado = { id_corante_sayersystem: "AX", custo: 0.01, volume_ml: 1000, created_at: "2099-01-01T00:00:00Z" };
  const m = montarLinhasDeCatalogo("corantes", [forjado], CTX);
  assertEq(m.linhas, [], "nenhuma linha");
  assertEq(m.recusados, 1, "recusado");
  assertEq(m.camposFora, ["created_at"], "nome do campo fora");
  // contraprova: o MESMO item sem o campo entra, e a linha não tem created_at (o banco põe now()).
  const honesto = { id_corante_sayersystem: "AX", custo: 0.01, volume_ml: 1000 };
  const ok = montarLinhasDeCatalogo("corantes", [honesto], CTX);
  assertEq(ok.recusados, 0, "contraprova aceita");
  assertTrue(!("created_at" in ok.linhas[0]), "linha aceita não carrega created_at");
});

Deno.test("CADA coluna de controle, em CADA entidade, recusa o item", () => {
  let casos = 0;
  for (const e of ENTIDADES_COM_LINHA_DE_CATALOGO) {
    for (const c of DE_CONTROLE) {
      const item = { ...FORMAS_REAIS[e], [c]: c === "raw_data" ? { x: 1 } : "valor-do-atacante" };
      const m = montarLinhasDeCatalogo(e, [item], CTX);
      assertEq(m.linhas, [], `${e}.${c}: nenhuma linha`);
      assertEq(m.recusados, 1, `${e}.${c}: recusado`);
      assertEq(m.camposFora, [c], `${e}.${c}: campo nomeado`);
      casos++;
    }
  }
  assertEq(casos, 40, "não-vacuidade: 5 entidades × 8 colunas de controle");
});

Deno.test("campo desconhecido e coluna de OUTRA entidade recusam o item", () => {
  const casos: [EntidadeComLinhaDeCatalogo, string][] = [
    ["produtos", "campo_novo"],
    ["produtos", "custo"],
    ["produtos", "volume_ml"],
    ["produtos", "id_base"],
    ["bases", "id_base"],
    ["bases", "cod_produto"],
    ["embalagens", "preco_litro"],
    ["skus", "descricao"],
    ["skus", "custo"],
    ["corantes", "cod_produto"],
    ["corantes", "custo_"],
  ];
  for (const [e, campo] of casos) {
    const m = montarLinhasDeCatalogo(e, [{ ...FORMAS_REAIS[e], [campo]: 1 }], CTX);
    assertEq([m.linhas.length, m.recusados, m.camposFora], [0, 1, [campo]], `${e}.${campo}`);
  }
});

Deno.test("lote misto: aceitos entram na ordem, recusados contam, recebidos é o total", () => {
  const itens = [
    { cod_produto: "A", descricao: "primeiro" },
    { cod_produto: "B", id: "11111111-1111-1111-1111-111111111111" },
    { cod_produto: "C" },
    null,
    { cod_produto: "D", descricao: "forjado", created_at: "2099-01-01" },
    { cod_produto: "E", descricao: "último" },
  ];
  const m = montarLinhasDeCatalogo("produtos", itens, CTX);
  assertEq(m.recebidos, 6, "recebidos");
  assertEq(m.linhas.map((l) => l.cod_produto), ["A", "C", "E"], "aceitos, na ordem");
  assertEq(m.recusados, 3, "recusados");
  assertEq(m.naoObjeto, 1, "não-objeto");
  assertEq(m.camposFora, ["created_at", "id"], "campos fora, ORDENADOS (chegaram como id, created_at)");
  assertEq(m.loteMalformado, false, "lote é lista");
});

Deno.test("__proto__, constructor e toString como chave própria recusam; linha aceita não muda de protótipo", () => {
  const poluido = JSON.parse('{"cod_produto":"A","__proto__":{"created_at":"2099-01-01","id":"x"}}');
  assertTrue(Object.prototype.hasOwnProperty.call(poluido, "__proto__"), "não-vacuidade: JSON.parse cria __proto__ próprio");
  const m = montarLinhasDeCatalogo("produtos", [poluido], CTX);
  assertEq([m.linhas.length, m.recusados, m.camposFora], [0, 1, ["__proto__"]], "__proto__");
  for (const k of ["constructor", "toString", "hasOwnProperty"]) {
    const r = montarLinhasDeCatalogo("produtos", [{ cod_produto: "A", [k]: "x" }], CTX);
    assertEq([r.linhas.length, r.recusados, r.camposFora], [0, 1, [k]], k);
  }
  const ok = montarLinhasDeCatalogo("produtos", [{ cod_produto: "A" }], CTX);
  assertTrue(Object.getPrototypeOf(ok.linhas[0]) === Object.prototype, "protótipo da linha é o de objeto comum");
});

Deno.test("item que não é objeto é recusado, sem estourar", () => {
  const m = montarLinhasDeCatalogo("bases", [null, 5, "texto", ["lista"], true, undefined], CTX);
  assertEq([m.recebidos, m.linhas.length, m.recusados, m.naoObjeto, m.camposFora], [6, 0, 6, 6, []], "não-objetos");
});

Deno.test("entidade ausente não é erro; valor que não é lista é lote malformado (1 erro)", () => {
  for (const ausente of [undefined, null]) {
    const m = montarLinhasDeCatalogo("skus", ausente, CTX);
    assertEq([m.recebidos, m.linhas.length, m.recusados, m.loteMalformado], [0, 0, 0, false], `ausente ${ausente}`);
  }
  assertEq(montarLinhasDeCatalogo("skus", [], CTX).recusados, 0, "lista vazia");
  for (const torto of [{ cod_produto: "A" }, "texto", 7, true, 0, ""]) {
    const m = montarLinhasDeCatalogo("skus", torto, CTX);
    assertEq([m.recebidos, m.linhas.length, m.recusados, m.loteMalformado], [0, 0, 1, true], `malformado ${canon(torto)}`);
  }
});

Deno.test("chave ausente ou falsy vira '' — como era", () => {
  for (const item of [{ descricao: "sem chave" }, { cod_produto: null }, { cod_produto: 0 }, { cod_produto: "" }]) {
    const m = montarLinhasDeCatalogo("produtos", [item], CTX);
    assertEq(m.linhas[0].cod_produto, "", `chave de ${canon(item)}`);
    assertMesmasLinhas(m.linhas, [linhaAntiga("produtos", item)], `igual ao antigo: ${canon(item)}`);
  }
});

Deno.test("PROPRIEDADE: nenhuma linha tem coluna fora das 5 do servidor + as da entidade; as do servidor vêm do contexto", () => {
  const VOCAB = [
    "cod_produto", "descricao", "id_base", "id_embalagem", "id_base_sayersystem", "id_embalagem_sayersystem",
    "id_corante_sayersystem", "volume_ml", "preco_litro", "custo", "id", "created_at", "matched_id",
    "sync_run_id", "account", "store_code", "raw_data", "staging_status", "qualquer", "__proto__",
  ];
  // gerador determinístico (LCG): o teste é reproduzível e não depende de Math.random.
  let semente = 20261117;
  const prox = () => (semente = (semente * 1103515245 + 12345) % 2147483648);
  let aceitos = 0, recusados = 0;
  for (const e of ENTIDADES_COM_LINHA_DE_CATALOGO) {
    const permitidas = new Set<string>([...DO_SERVIDOR, ...STAGING_DO_CATALOGO[e].colunas]);
    const daEntidade = new Set<string>(STAGING_DO_CATALOGO[e].colunas);
    for (let n = 0; n < 400; n++) {
      const item: Record<string, unknown> = Object.create(null);
      const quantas = prox() % 4;
      for (let i = 0; i <= quantas; i++) {
        const k = VOCAB[prox() % VOCAB.length];
        Object.defineProperty(item, k, { value: `v${prox() % 9}`, enumerable: true, writable: true, configurable: true });
      }
      const limpo = { ...item };   // objeto comum, com as mesmas chaves próprias
      const todasDaEntidade = Object.keys(limpo).every((k) => daEntidade.has(k));
      const m = montarLinhasDeCatalogo(e, [limpo], { runId: "R", account: "A", storeCode: "S" });
      assertEq(m.linhas.length, todasDaEntidade ? 1 : 0, `${e} #${n}: aceite ⇔ todas as chaves são da entidade (${canon(Object.keys(limpo))})`);
      for (const linha of m.linhas) {
        for (const k of Object.keys(linha)) assertTrue(permitidas.has(k), `${e} #${n}: coluna ${k} fora da lista`);
        assertEq([linha.sync_run_id, linha.account, linha.store_code, linha.staging_status], ["R", "A", "S", "pending"], `${e} #${n}: servidor`);
        assertTrue(linha.raw_data === limpo, `${e} #${n}: raw_data é o item`);
      }
      if (todasDaEntidade) aceitos++; else recusados++;
    }
  }
  assertTrue(aceitos >= 100 && recusados >= 100, `não-vacuidade: aceitos=${aceitos}, recusados=${recusados}`);
});

Deno.test("recusa: nomes ordenados, sem repetição, com teto de quantidade e de tamanho; detalhe sem o item cru", () => {
  const muitos: Record<string, unknown>[] = [];
  for (let i = 0; i < 30; i++) muitos.push({ cod_produto: "A", [`campo_${String(i).padStart(2, "0")}`]: 1 });
  muitos.push({ cod_produto: "B", campo_00: 2 });   // repetido
  muitos.push({ cod_produto: "C", ["x".repeat(500)]: 3 });
  const m = montarLinhasDeCatalogo("produtos", muitos, CTX);
  assertEq(m.recusados, 32, "recusados");
  assertEq(m.camposFora.length, TETO_CAMPOS_NO_LOG, "teto de nomes");
  assertEq(m.camposFora.slice(0, 3), ["campo_00", "campo_01", "campo_02"], "ordenados, sem repetir");
  assertTrue(m.camposFora.every((c) => c.length <= TETO_NOME_DE_CAMPO), "teto de tamanho do nome");
  const semTeto = montarLinhasDeCatalogo("produtos", [{ cod_produto: "C", ["x".repeat(500)]: 3 }], CTX);
  assertEq(semTeto.camposFora, ["x".repeat(TETO_NOME_DE_CAMPO)], "nome longo é cortado");

  const um = montarLinhasDeCatalogo("corantes", [{ id_corante_sayersystem: "AX", created_at: "2099-01-01", segredo: "valor-que-não-pode-ir-ao-log" }, 7], CTX);
  assertEq(mensagemDaRecusaDeCatalogo(um), "2 item(ns) recusado(s): campo fora do contrato do catálogo (created_at, segredo); 1 item(ns) que não são objeto", "mensagem");
  const detalhe = detalheDaRecusaDeCatalogo("corantes", um);
  assertEq(detalhe, {
    motivo: "campo_fora_do_contrato",
    itens_recebidos: 2,
    itens_recusados: 2,
    itens_nao_objeto: 1,
    campos_fora: ["created_at", "segredo"],
    colunas_aceitas: ["id_corante_sayersystem", "descricao", "preco_litro", "custo", "volume_ml"],
  }, "detalhe");
  assertTrue(!canon(detalhe).includes("valor-que-não-pode-ir-ao-log"), "o VALOR do campo recusado não vai ao log");

  const torto = montarLinhasDeCatalogo("corantes", { id_corante_sayersystem: "AX" }, CTX);
  assertEq(mensagemDaRecusaDeCatalogo(torto), "lote recusado: a entidade não veio como lista", "mensagem do malformado");
  assertEq(detalheDaRecusaDeCatalogo("corantes", torto).motivo, "lote_nao_e_lista", "motivo do malformado");
});

Deno.test("a lista de colunas é a das tabelas da PROD (2026-11-17) — mudar exige mexer aqui", () => {
  assertEq(STAGING_DO_CATALOGO, {
    produtos: { tabela: "tint_staging_produtos", chave: "cod_produto", colunas: ["cod_produto", "descricao"] },
    bases: { tabela: "tint_staging_bases", chave: "id_base_sayersystem", colunas: ["id_base_sayersystem", "descricao"] },
    embalagens: { tabela: "tint_staging_embalagens", chave: "id_embalagem_sayersystem", colunas: ["id_embalagem_sayersystem", "descricao", "volume_ml"] },
    skus: { tabela: "tint_staging_skus", chave: "cod_produto", colunas: ["cod_produto", "id_base", "id_embalagem"] },
    corantes: { tabela: "tint_staging_corantes", chave: "id_corante_sayersystem", colunas: ["id_corante_sayersystem", "descricao", "preco_litro", "custo", "volume_ml"] },
  }, "contrato de colunas");
  for (const e of ENTIDADES_COM_LINHA_DE_CATALOGO) {
    const cfg = STAGING_DO_CATALOGO[e];
    assertTrue((cfg.colunas as readonly string[]).includes(cfg.chave), `${e}: a chave é coluna permitida`);
    for (const c of DE_CONTROLE) assertTrue(!(cfg.colunas as readonly string[]).includes(c), `${e}: ${c} nunca é coluna do item`);
  }
});

Deno.test("as entidades do builder + precos_base são as que a rota grava, na ordem de antes", () => {
  assertEq([...ENTIDADES_COM_LINHA_DE_CATALOGO], ["produtos", "bases", "embalagens", "skus", "corantes"], "ordem de gravação");
  assertEq([...ENTIDADES_COM_LINHA_DE_CATALOGO, "precos_base"].sort(), [...ENTIDADES_CATALOGO].sort(), "mesmo conjunto de catalogo-vazio.ts");
  assertEq(Object.keys(STAGING_DO_CATALOGO).sort(), [...ENTIDADES_COM_LINHA_DE_CATALOGO].sort(), "toda entidade tem configuração");
});
