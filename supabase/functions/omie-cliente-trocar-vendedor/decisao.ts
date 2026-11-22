// Decisões PURAS da troca de vendedor no cadastro do cliente no Omie (sem rede, sem banco).
//
// O que pode ser alvo e o que pode ser origem é CONSTANTE revisada no PR, nunca entrada do request: o request só
// escolhe o lote, a conta, o tamanho do bloco e (no canário) os códigos de cliente. Assim um body errado não troca
// o vendedor de ninguém para um código arbitrário.

export type Conta = "oben" | "colacor" | "colacor_sc";
const CONTAS: readonly Conta[] = ["oben", "colacor", "colacor_sc"];
export type Lote = "saida_vendedora" | "orfaos" | "reparo_entidades";
type Modo = "dry_run" | "aplicar" | "verificar";
export type Dono = "REGINA" | "LUCAS";

/** Código de vendedor de cada pessoa em cada conta (omie_vendedor_map + ListarVendedores, conferidos em 2026-11-20). */
export const VENDEDOR: Record<Dono, Record<Conta, number>> = {
  REGINA: { oben: 8689670842, colacor: 4231477068, colacor_sc: 3545068880 },
  LUCAS: { oben: 8689670832, colacor: 3710549101, colacor_sc: 3545069574 },
};

/** Lote `saida_vendedora`: os 6 códigos da Tatyana (saiu em 2026-11) → o código da Regina na MESMA conta. */
export const ORIGEM_SAIDA: Record<Conta, readonly number[]> = {
  oben: [8689670840],
  colacor: [4231476928],
  colacor_sc: [3545068889, 3545068960, 3545068923, 3545068907],
};

/**
 * Lote `reparo_entidades` (v1.6): os cadastros que a v1.3/v1.4/v1.5 regravaram com entidade DUPLA (`&amp;amp;`,
 * `&amp;apos;`) — medido por ConsultarCliente de leitura em 2026-11-22. O vendedor deles JÁ é a Regina; o reparo
 * reenvia o texto decodificado duas vezes e o Omie, que codifica a entrada, volta a gravar o original. Lista FECHADA.
 */
/**
 * Prova do original (Codex v1.6 P1): o `hash_antes` do recibo da escrita que causou o dano — o cadastro ANTES dele.
 * O reparo só escreve se o lido com uma camada de entidade a menos reproduzir EXATAMENTE esse hash; senão recusa.
 * `recorte`: a v1.5 calculava o hash com `&amp;`→`&` em razão/fantasia/observações (a do canário 393823340).
 * Medido em 2026-11-22: nos 4 cadastros colacor lidos, a camada a menos BATE com o hash; o lido atual não.
 */
export type ProvaReparo = { hash: string; recorte: "literal" | "v1.5-amp" };
export const REPARO_ENTIDADES: Record<Conta, Readonly<Record<number, ProvaReparo>>> = {
  oben: { 8689681515: { hash: "0c77cac367b625a5f805fb2f020be630df0a741a871f4c6c9c27622ef017787c", recorte: "literal" } },
  colacor: {
    393821747: { hash: "992268030567c60ad63406e5ed5ce4c2b70d7aa11323a26971eeab1a9c6b7ed7", recorte: "literal" },
    393821802: { hash: "5d24dc34391272d57c6e56c1d3a131138e8d26d939a6910fe8d42093c96500c8", recorte: "literal" },
    393822107: { hash: "f5fb07a6b95e24edebfeec6240a55a292ba3ee6d425c4eaa7fe0d0848a2457ab", recorte: "literal" },
    393823340: { hash: "2e96dd12f27d0985addcf599a67fe128f55156650cf69985b6254de58991908b", recorte: "v1.5-amp" },
  },
  colacor_sc: {
    3545069324: { hash: "2b53f53ac65ffe9f55cb03a63e580151f3db718fb49e52e442622820ecb11b7e", recorte: "literal" },
    3545069485: { hash: "1febd1ca0d3aba3857d187e7ca07e62052158f0f4fd94a0f573fa40d2c6116e7", recorte: "literal" },
  },
};

/** O hash no recorte em que a prova foi gravada (a v1.5 normalizava `&amp;` em 4 campos de exibição). */
export async function hashNoRecorte(cad: Record<string, unknown>, recorte: ProvaReparo["recorte"]): Promise<string> {
  if (recorte === "literal") return hashCadastro(cad);
  const c: Record<string, unknown> = { ...cad };
  for (const k of ["razao_social", "nome_fantasia", "observacao", "obs_detalhadas"]) {
    if (typeof c[k] === "string") c[k] = (c[k] as string).replaceAll("&amp;", "&");
  }
  return hashCadastro(c);
}

/** Nome que o ListarVendedores tem de devolver para o código-alvo (guarda contra código trocado/reaproveitado). */
export const NOME_ESPERADO: Record<Dono, string> = { REGINA: "REGINA", LUCAS: "LUCAS" };

export const CONFIRMACAO_APLICAR = "TROCAR VENDEDOR NO OMIE";
const LIMITE_PADRAO = 15;
const LIMITE_MAX = 30;
const CANARIO_MAX = 10;

export interface Parametros {
  modo: Modo;
  lote: Lote;
  conta: Conta;
  limite: number;
  /** Paginação sem estado: só clientes com codigo_cliente_omie > apos. */
  apos: number;
  /** Canário: só estes clientes (ainda sujeitos à pré-condição do lote). */
  clientes: number[] | null;
  /** Lote `orfaos`: as escolhas do founder (customer_user_id → dono). */
  escolhas: { customer_user_id: string; dono: Dono }[] | null;
  /** Modo `verificar`: execução a reverificar. */
  execucao_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehInteiroPositivo = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function lerParametros(corpo: unknown): { ok: true; p: Parametros } | { ok: false; erro: string } {
  if (!corpo || typeof corpo !== "object" || Array.isArray(corpo)) return { ok: false, erro: "corpo deve ser objeto" };
  const c = corpo as Record<string, unknown>;
  const modo = c.modo;
  if (modo !== "dry_run" && modo !== "aplicar" && modo !== "verificar") {
    return { ok: false, erro: "modo deve ser dry_run | aplicar | verificar" };
  }
  if (modo === "aplicar" && c.confirmo !== CONFIRMACAO_APLICAR) {
    return { ok: false, erro: `aplicar exige confirmo: "${CONFIRMACAO_APLICAR}"` };
  }
  const lote = c.lote;
  if (lote !== "saida_vendedora" && lote !== "orfaos" && lote !== "reparo_entidades") {
    return { ok: false, erro: "lote deve ser saida_vendedora | orfaos | reparo_entidades" };
  }
  const conta = c.conta;
  if (typeof conta !== "string" || !(CONTAS as readonly string[]).includes(conta)) {
    return { ok: false, erro: "conta deve ser oben | colacor | colacor_sc" };
  }
  const limite = c.limite === undefined ? LIMITE_PADRAO : c.limite;
  if (!ehInteiroPositivo(limite) || limite > LIMITE_MAX) return { ok: false, erro: `limite deve ser inteiro 1..${LIMITE_MAX}` };
  const apos = c.apos === undefined ? 0 : c.apos;
  if (typeof apos !== "number" || !Number.isSafeInteger(apos) || apos < 0) return { ok: false, erro: "apos deve ser inteiro >= 0" };

  let clientes: number[] | null = null;
  if (c.clientes !== undefined) {
    if (!Array.isArray(c.clientes) || c.clientes.length === 0 || c.clientes.length > CANARIO_MAX || !c.clientes.every(ehInteiroPositivo)) {
      return { ok: false, erro: `clientes deve ser lista de 1..${CANARIO_MAX} codigo_cliente_omie` };
    }
    clientes = [...new Set(c.clientes as number[])];
  }

  let escolhas: Parametros["escolhas"] = null;
  if (lote === "orfaos" && modo !== "verificar") {
    if (!Array.isArray(c.escolhas) || c.escolhas.length === 0) return { ok: false, erro: "lote orfaos exige escolhas" };
    const vistos = new Set<string>();
    escolhas = [];
    for (const e of c.escolhas) {
      const r = (e ?? {}) as Record<string, unknown>;
      if (typeof r.customer_user_id !== "string" || !UUID.test(r.customer_user_id)) return { ok: false, erro: "escolha sem customer_user_id uuid" };
      if (r.dono !== "REGINA" && r.dono !== "LUCAS") return { ok: false, erro: "escolha com dono fora de REGINA | LUCAS" };
      const id = r.customer_user_id.toLowerCase();
      if (vistos.has(id)) return { ok: false, erro: `escolha duplicada: ${id}` };
      vistos.add(id);
      escolhas.push({ customer_user_id: id, dono: r.dono });
    }
  } else if (c.escolhas !== undefined) {
    return { ok: false, erro: "escolhas só vale no lote orfaos" };
  }

  let execucao_id: string | null = null;
  if (modo === "verificar") {
    if (typeof c.execucao_id !== "string" || !UUID.test(c.execucao_id)) return { ok: false, erro: "verificar exige execucao_id uuid" };
    execucao_id = c.execucao_id;
  }
  return { ok: true, p: { modo, lote, conta: conta as Conta, limite, apos, clientes, escolhas, execucao_id } };
}

/** Leitura do vendedor do cadastro: número, vazio (sem vendedor) ou ILEGÍVEL — ilegível nunca vira "vazio" (Codex P2). */
export type LeituraVendedor = number | null | "ilegivel";

/** `recomendacoes.codigo_vendedor`: ausente/null/0/"" = sem vendedor; inteiro > 0 ou string só de dígitos = código; o resto = ilegível. */
export function lerVendedor(cad: Record<string, unknown>): LeituraVendedor {
  const rec = cad.recomendacoes;
  if (rec === undefined || rec === null) return null;
  if (typeof rec !== "object" || Array.isArray(rec)) return "ilegivel";
  const v = (rec as Record<string, unknown>).codigo_vendedor;
  if (v === undefined || v === null || v === 0 || v === "" || v === "0") return null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : "ilegivel";
  if (typeof v === "string" && /^[0-9]+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) && n > 0 ? n : "ilegivel";
  }
  return "ilegivel";
}

/** Atalho para quem só compara com um alvo: ilegível vira null (nunca casa com alvo > 0). */
export function vendedorDoCadastro(cad: Record<string, unknown>): number | null {
  const v = lerVendedor(cad);
  return v === "ilegivel" ? null : v;
}

export type Veredito =
  | { tipo: "ja_certo" }
  | { tipo: "trocar" }
  | { tipo: "precondicao_falhou"; motivo: string };

/**
 * O que fazer com um cliente, dado o vendedor LIDO NO OMIE agora (não o do espelho).
 * saida_vendedora: só troca quem está num código de origem. orfaos: só troca quem está SEM vendedor.
 */
export function decidir(lote: Lote, conta: Conta, atual: LeituraVendedor, alvo: number): Veredito {
  if (atual === "ilegivel") return { tipo: "precondicao_falhou", motivo: "vendedor atual ilegível" };
  if (lote === "reparo_entidades" && atual === alvo) return { tipo: "trocar" };
  if (atual === alvo) return { tipo: "ja_certo" };
  if (lote === "reparo_entidades") {
    // O vendedor já foi trocado; aqui "trocar" = regravar o texto (o vendedor vai igual ao alvo). Fora da lista: não toca.
    return { tipo: "precondicao_falhou", motivo: `reparo só para quem já está no alvo; vendedor atual ${atual ?? "vazio"}` };
  }
  if (lote === "saida_vendedora") {
    if (atual !== null && ORIGEM_SAIDA[conta].includes(atual)) return { tipo: "trocar" };
    return { tipo: "precondicao_falhou", motivo: `vendedor atual ${atual ?? "vazio"} não é da vendedora que saiu` };
  }
  if (atual === null) return { tipo: "trocar" };
  return { tipo: "precondicao_falhou", motivo: `cliente já tem vendedor ${atual}` };
}

/**
 * Payload do AlterarCliente: o código do cliente + o objeto `recomendacoes` INTEIRO como estava, só com o vendedor
 * trocado — mandar `recomendacoes` parcial poderia zerar transportadora/boletos/parcelas. Nada mais vai (razão,
 * documento, endereço): o app não regrava dado fiscal (ver `_shared/razao-fiscal.ts`).
 */
/** O objeto `recomendacoes` como estava (sem PII: códigos e flags) — vai ao recibo para permitir desfazer. */
export function recomendacoesDe(cad: Record<string, unknown>): Record<string, unknown> | null {
  const rec = cad.recomendacoes;
  return rec && typeof rec === "object" && !Array.isArray(rec) ? { ...(rec as Record<string, unknown>) } : null;
}

/**
 * O AlterarCliente do Omie valida os campos OBRIGATÓRIOS da conta contra o PAYLOAD (não contra o cadastro gravado).
 * Medido nos canários de 2026-11-21, um campo por vez: sem endereço → "(Estado)"; só estado → "(Endereço, Número,
 * Bairro, Cidade, Estado e CEP)"; com o endereço → "É obrigatório o preenchimento do e-mail". Por isso o payload leva
 * TODOS os campos ESCALARES (texto/número/booleano) do cadastro EXATAMENTE como o ConsultarCliente devolveu, mais
 * `recomendacoes` com só o vendedor trocado. Listas e objetos (tags, caracteristicas, dadosBancarios,
 * enderecoEntrega, info…) NÃO vão: no Omie eles têm semântica de substituição — omitidos, ficam como estão.
 * O hash do cadastro inteiro na verificação prova que nada além do vendedor mudou.
 * Risco aceito (Codex v1.1 P2, forçado pelo Omie): edição concorrente de um desses campos na janela de ~1s entre o
 * Consultar e o Alterar seria desfeita sem o hash acusar.
 */
const CAMPOS_ENDERECO = ["endereco", "endereco_numero", "bairro", "cidade", "estado", "cep"] as const;

/** Campos do bloco de endereço ausentes/vazios no cadastro lido (vazio = o AlterarCliente vai recusar). */
export function enderecoFaltando(cad: Record<string, unknown>): string[] {
  return CAMPOS_ENDERECO.filter((k) => typeof cad[k] !== "string" || (cad[k] as string).trim() === "");
}

/** Escalares que são INSTRUÇÃO ao Omie (processar o endereço), não dado do cadastro — nunca reenviar (Codex v1.3 P2). */
const INSTRUCOES = new Set(["separar_endereco", "pesquisar_cep"]);

/** Listas/objetos preenchidos no cadastro (fora `info`/`recomendacoes`): o que o payload OMITE e o Omie deve preservar. */
export function blocosPreenchidos(cad: Record<string, unknown>): string[] {
  return Object.entries(cad)
    .filter(([k, v]) => k !== "info" && k !== "recomendacoes" && v !== null && typeof v === "object" &&
      (Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0))
    .map(([k]) => k).sort();
}

function ehEscalar(v: unknown): boolean {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * O Omie CODIFICA a entrada de texto do AlterarCliente (estilo htmlspecialchars): `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`,
 * `"`→`&quot;`, `'`→`&apos;`. Medido em 2026-11-22 (ConsultarCliente de leitura): a v1.4/v1.5 reenviou "MOVEIS &amp; CIA"
 * como lido e o Omie gravou "MOVEIS &amp;amp; CIA"; uma observação "d&apos;água" virou "d&amp;apos;água". Por isso
 * (v1.6) o texto vai DECODIFICADO uma vez — o inverso exato — e o Omie regrava o original; o hash compara LITERAL.
 */
const CODIFICA: [string, string][] = [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&apos;"]];
const DECODIFICA: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

/** O que o Omie grava quando recebe `x`. */
export function codificarComoOmie(x: string): string {
  let r = x;
  for (const [de, para] of CODIFICA) r = r.replaceAll(de, para);
  return r;
}

/** Inverso de `codificarComoOmie`, numa passada, só as 5 entidades que o Omie produz (literal, caixa fixa). */
export function decodificarComoOmie(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => DECODIFICA[m]);
}

/** Campos em que o Omie foi VISTO codificando o `&` recebido (ConsultarCliente de leitura, 2026-11-22). */
const CAMPOS_AMP_MEDIDO = new Set(["razao_social", "nome_fantasia", "observacao"]);

/** Quantas vezes decodificar o texto lido antes de reenviar: 1 no fluxo normal; 2 no reparo (entidade dupla). */
const voltas = (reparo: boolean) => reparo ? 2 : 1;
function decodificarN(s: string, n: number): string {
  let r = s;
  for (let i = 0; i < n; i++) r = decodificarComoOmie(r);
  return r;
}

/** Texto a ENVIAR por campo escalar. */
function textoEnviado(s: string, reparo: boolean): string {
  return decodificarN(s, voltas(reparo));
}

/**
 * Cadastro que a releitura TEM de mostrar depois da escrita: no fluxo normal, o próprio lido; no reparo, os textos
 * escalares com UMA camada de entidade a menos (o original antes do dano). É o lado "antes" do hash da verificação.
 */
export function cadastroEsperado(cad: Record<string, unknown>, reparo: boolean): Record<string, unknown> {
  if (!reparo) return cad;
  const r: Record<string, unknown> = { ...cad };
  for (const [k, v] of Object.entries(cad)) if (typeof v === "string") r[k] = decodificarComoOmie(v);
  return r;
}

/**
 * Campos escalares de texto que o Omie regravaria DIFERENTE do esperado (ex.: `&` ou `'` crus, entidade fora das 5):
 * o chamador recusa sem escrever (pré-condição). Só nomes de campo — nunca o valor (dado pessoal).
 */
export function textosQueMudariam(cad: Record<string, unknown>, reparo: boolean): string[] {
  const esperado = cadastroEsperado(cad, reparo);
  return Object.entries(cad)
    .filter(([k, v]) => {
      if (typeof v !== "string" || v.trim() === "" || INSTRUCOES.has(k)) return false;
      const enviado = textoEnviado(v, reparo);
      // Só `&`→`&amp;` foi MEDIDO, e só nestes campos (Codex v1.6 P2 e r2 P1): enviar `<` `>` `"` `'`, ou `&` em
      // identificador/endereço/outro campo, dependeria de comportamento não medido do Omie → recusa sem escrever.
      if (/[<>"']/.test(enviado)) return true;
      if (enviado.includes("&") && !CAMPOS_AMP_MEDIDO.has(k)) return true;
      return codificarComoOmie(enviado) !== esperado[k];
    })
    .map(([k]) => k).sort();
}

/** Payload do AlterarCliente, ou `null` se o endereço lido está incompleto (o chamador recusa sem escrever). */
export function payloadAlterar(cad: Record<string, unknown>, alvo: number, reparo = false): Record<string, unknown> | null {
  const codigo = cad.codigo_cliente_omie;
  if (!ehInteiroPositivo(codigo)) throw new Error("cadastro sem codigo_cliente_omie");
  if (enderecoFaltando(cad).length > 0) return null;
  const rec = cad.recomendacoes && typeof cad.recomendacoes === "object" ? cad.recomendacoes as Record<string, unknown> : {};
  const p: Record<string, unknown> = {};
  // Texto VAZIO não vai (v1.4): o Omie valida o que recebe e recusa vazio em campo com domínio — medido no canário 4:
  // "tag [tipo_atividade] incorreto", "tag [bloqueado] deve ser 'S' ou 'N'". Omitido, o campo fica como está.
  for (const [k, v] of Object.entries(cad)) {
    if (!ehEscalar(v) || INSTRUCOES.has(k) || (typeof v === "string" && v.trim() === "")) continue;
    p[k] = typeof v === "string" ? textoEnviado(v, reparo) : v;
  }
  p.codigo_cliente_omie = codigo;
  p.recomendacoes = { ...rec, codigo_vendedor: alvo };
  return p;
}

function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonico(o[k])]));
  }
  return v;
}

/** Texto canônico do cadastro SEM o vendedor e sem `info` (dAlt/hAlt/uAlt mudam a cada gravação). Vira hash; nunca é gravado. */
export function textoParaHash(cad: Record<string, unknown>): string {
  const { info: _info, ...resto } = cad;
  const rec = resto.recomendacoes && typeof resto.recomendacoes === "object"
    ? { ...(resto.recomendacoes as Record<string, unknown>) }
    : resto.recomendacoes;
  if (rec && typeof rec === "object") delete (rec as Record<string, unknown>).codigo_vendedor;
  // Sem `recomendacoes` e `recomendacoes: {}` (só com o vendedor, que saiu do texto) são o MESMO cadastro: um órfão
  // sem o objeto passa a ter `{codigo_vendedor}` depois da troca, e isso não pode virar falso 'divergente' (Codex P2).
  const vazio = rec === null || rec === undefined || (typeof rec === "object" && Object.keys(rec as object).length === 0);
  return JSON.stringify(canonico({ ...resto, recomendacoes: vazio ? undefined : rec }));
}

/**
 * Quais campos mudaram entre duas leituras, pelo MESMO recorte do hash (sem info/vendedor) — para o recibo DIZER o
 * que divergiu (v1.4: o canário 4 achou 'divergente' sem saber qual campo). Caminhos com valores curtos, no máx. 20.
 */
/** Campos de CONTROLE cujo valor pode aparecer no recibo (sem dado pessoal/bancário — Codex v1.4 P2). */
const CAMPOS_SEGUROS = new Set([
  "importado_api", "inativo", "bloqueado", "bloquear_faturamento", "bloquear_exclusao", "tipo_atividade", "estado",
  "cidade", "cidade_ibge", "codigo_pais", "pessoa_fisica", "exterior", "optante_simples_nacional", "contribuinte",
  "produtor_rural", "valor_limite_credito", "enviar_anexos", "tag",
]);

function valorSeguro(caminho: string): boolean {
  if (caminho.startsWith("recomendacoes.") || caminho.startsWith("tags.")) return true;
  return CAMPOS_SEGUROS.has(caminho.split(".").pop() ?? "");
}

export function camposDiferentes(antes: Record<string, unknown>, depois: Record<string, unknown>): string[] {
  const a = JSON.parse(textoParaHash(antes)) as unknown;
  const b = JSON.parse(textoParaHash(depois)) as unknown;
  const out: string[] = [];
  const curto = (v: unknown) => v === undefined ? "(ausente)" : JSON.stringify(v).slice(0, 60);
  const andar = (x: unknown, y: unknown, cam: string) => {
    if (out.length >= 20) return;
    const ox = x !== null && typeof x === "object", oy = y !== null && typeof y === "object";
    if (ox && oy && Array.isArray(x) === Array.isArray(y)) {
      const kx = x as Record<string, unknown>, ky = y as Record<string, unknown>;
      for (const k of [...new Set([...Object.keys(kx), ...Object.keys(ky)])].sort()) andar(kx[k], ky[k], cam ? `${cam}.${k}` : k);
      return;
    }
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const c = cam || "(raiz)";
    if (valorSeguro(c)) out.push(`${c}: ${curto(x)} → ${curto(y)}`);
    else out.push(`${c}: ${x === undefined ? "adicionado" : y === undefined ? "removido" : "alterado"}`);
  };
  andar(a, b, "");
  return out;
}

export async function hashCadastro(cad: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(textoParaHash(cad));
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** O vendedor-alvo existe, está ativo e tem o nome esperado na conta (ListarVendedores). Fail-closed. */
export function conferirAlvo(
  vendedores: { codigo?: unknown; nome?: unknown; inativo?: unknown }[],
  alvo: number,
  nomeEsperado: string,
): { ok: true } | { ok: false; erro: string } {
  const v = vendedores.find((x) => Number(x.codigo) === alvo);
  if (!v) return { ok: false, erro: `vendedor-alvo ${alvo} não existe na conta` };
  if (v.inativo !== "N") return { ok: false, erro: `vendedor-alvo ${alvo} está inativo` };
  const nome = typeof v.nome === "string" ? v.nome.trim().toUpperCase() : "";
  if (!nome.startsWith(nomeEsperado)) return { ok: false, erro: `vendedor-alvo ${alvo} tem nome inesperado` };
  return { ok: true };
}

/** O ConsultarCliente pré-escrita só pode ser repetido ≥60s depois (o Omie responde REDUNDANT antes disso). */
export const ESPERA_REDUNDANCIA_MS = 61_000;
