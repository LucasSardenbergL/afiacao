/**
 * dados.ts — monta os itens do backtest do Jev a partir das linhas exportadas (puro, sem I/O).
 *
 * Três fatos de prod (psql-ro, 2026-09-27) moldam este módulo — ver docs/historico/jev-backtest-ptbr.md:
 *   (a) `omie_product_spec_links` tem ZERO linhas (nenhum vínculo boletim→SKU jamais gravado) ⇒
 *       não há ouro humano; o gabarito de (a) é PRATA: a regra que o próprio domínio aceita para
 *       autoconfirmação (`refinarCandidatos`: base exata E não-ambígua). Dela derivam dois testes
 *       SINTÉTICOS, rotulados como tal: negativo (a família certa sai ⇒ resposta certa "nenhum")
 *       e mascarado (códigos ocultos ⇒ só o texto decide). Sem família exata ⇒ resíduo sem gabarito.
 *   (b) promoção: os 13 `manual_confirmado` têm a descrição do fornecedor SOBRESCRITA pela do SKU ⇒
 *       vazamento total; fica fora do teste (não há builder aqui de propósito).
 *   (c) DRE: as 36 linhas de `fin_categoria_dre_mapping` são o SEED da migration (`_default`, mesmo
 *       instante) ⇒ gabarito `seed`, exploratório.
 *
 * A unidade de (a) é a FÓRMULA (código-base), não o SKU: 1 boletim → N embalagens × contas, e uma
 * Choice por SKU faria respostas igualmente certas competirem pela massa de probabilidade.
 */
import { baseDoCodigo, refinarCandidatos, type SkuCandidato } from '@/lib/knowledge-base/code-normalize';

export const NENHUM = 'nenhum';
export const NENHUMA = 'nenhuma';

export interface Opcao {
  chave: string;
  descricao: string | null;
}

export type TipoGabarito =
  | 'prata'
  | 'sintetico_negativo'
  | 'negativo_cruzado'
  | 'prata_mascarada'
  | 'seed'
  | 'sem_gabarito';
export type Dominio = 'boletim_sku' | 'categoria_dre';

export interface ItemBacktest {
  id: string;
  dominio: Dominio;
  /** Chave de agrupamento para a partição dev/teste (irmãos nunca ficam dos dois lados). */
  grupo: string;
  tipoGabarito: TipoGabarito;
  state: unknown;
  instrucoes: string;
  /** Ordem ORIGINAL (a "direta"); a última opção é sempre "nenhum"/"nenhuma". */
  opcoes: Opcao[];
  /** Chaves aceitas como certas; null = sem gabarito (só cobertura). */
  gabarito: string[] | null;
  /** Escolha do baseline determinístico; null = abstém. */
  baseline: string | null;
}

// ─── (a) boletim → produto ──────────────────────────────────────────────────────────────────

export interface Familia {
  /** 'B:<bases ordenadas unidas por +>' quando a descrição tem código; senão 'D:<descrição>'. */
  grupoChave: string;
  bases: string[];
  membros: SkuCandidato[];
  /** A família É a fórmula do boletim: exatamente UMA base, igual à do boletim. */
  exata: boolean;
}

const normalizarDescricao = (s: string) => s.normalize('NFKC').toUpperCase().replace(/\s+/g, ' ').trim();

export function agruparFamilias(codigoBoletim: string, candidatos: readonly SkuCandidato[]): Familia[] {
  const alvo = baseDoCodigo(codigoBoletim);
  const porChave = new Map<string, Familia>();
  for (const r of refinarCandidatos(codigoBoletim, [...candidatos])) {
    const bases = [...new Set(r.codigosNaDescricao.map(baseDoCodigo))].sort();
    const grupoChave = bases.length > 0 ? `B:${bases.join('+')}` : `D:${normalizarDescricao(r.descricao)}`;
    let f = porChave.get(grupoChave);
    if (!f) {
      f = { grupoChave, bases, membros: [], exata: alvo !== '' && bases.length === 1 && bases[0] === alvo };
      porChave.set(grupoChave, f);
    }
    f.membros.push({ account: r.account, omie_codigo_produto: r.omie_codigo_produto, codigo: r.codigo, descricao: r.descricao });
  }
  return [...porChave.values()];
}

const CODIGO_TOKEN_RE = /\b[A-Z]{2,4}\d{0,2}\.\d{3,4}(?:\.\d{2,4})?(?:[A-Z]{1,3}\d?)?\b/g;
const CODIGO_ESPACO_RE = /\b(?:TEH|TE|TM|TY)\d{0,2} \d{3,4}\.\d{2,4}(?:[A-Z]{1,3}\d?)?\b/g;
const NUMERO_LONGO_RE = /\d{3,}/g;
const MASCARA = '[cód]';

const escaparRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Oculta códigos de produto (com/sem sufixo, variante com espaço) e qualquer número de 3+ dígitos. */
export function mascararCodigos(texto: string, extras: readonly string[] = []): string {
  let t = texto.replace(CODIGO_ESPACO_RE, MASCARA).replace(CODIGO_TOKEN_RE, MASCARA);
  for (const e of extras.filter((x) => x.trim() !== '').sort((x, y) => y.length - x.length)) {
    t = t.replace(new RegExp(escaparRegex(e), 'gi'), MASCARA);
  }
  return t.replace(NUMERO_LONGO_RE, MASCARA);
}

const INSTRUCOES_BOLETIM =
  'O `boletim` é a ficha técnica de UM produto de um fornecedor de tintas e vernizes. Qual opção do catálogo é ' +
  'esse MESMO produto (a mesma fórmula)? Embalagens diferentes do mesmo produto (galão, quarto, litro) contam como ' +
  'o mesmo produto. Catalisadores, diluentes e outros produtos apenas citados no boletim NÃO são o produto. ' +
  'Se nenhuma opção for o produto do boletim, escolha "nenhum".';

const DESC_NENHUM =
  'Nenhuma das opções é o produto do boletim: é outro produto, outra cor ou versão, um catalisador, um diluente ' +
  'ou um item não relacionado.';

const LIMITE_TEXTO = 20_000;

export interface SpecExportada {
  spec_id: string;
  product_code: string;
  product_name: string | null;
  doc_title: string | null;
  doc_texto: string;
}

function chavesUnicas(brutas: string[]): string[] {
  const usadas = new Map<string, number>();
  return brutas.map((b) => {
    const base = b.length > 140 ? `${b.slice(0, 139)}…` : b;
    const n = (usadas.get(base) ?? 0) + 1;
    usadas.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function opcoesDasFamilias(fams: readonly Familia[], mascarar: (s: string) => string): Array<Opcao & { grupoChave: string }> {
  const chaves = chavesUnicas(fams.map((f) => mascarar(f.membros[0].descricao.replace(/\s+/g, ' ').trim())));
  const opcoes = fams.map((f, i) => {
    const descs = [...new Set(f.membros.map((m) => mascarar(m.descricao.replace(/\s+/g, ' ').trim())))];
    const resto = descs.length > 3 ? ` | … (+${descs.length - 3})` : '';
    return { chave: chaves[i], grupoChave: f.grupoChave, descricao: `Itens do catálogo: ${descs.slice(0, 3).join(' | ')}${resto}` };
  });
  if (opcoes.some((o) => o.chave === NENHUM)) throw new Error('uma família colidiu com a chave reservada "nenhum"');
  return opcoes;
}

const semGrupo = (o: Opcao & { grupoChave: string }): Opcao => ({ chave: o.chave, descricao: o.descricao });

function stateDoBoletim(spec: SpecExportada): { boletim: { titulo: string; produto: string; texto: string } } {
  const texto = spec.doc_texto.length > LIMITE_TEXTO ? spec.doc_texto.slice(0, LIMITE_TEXTO) : spec.doc_texto;
  return { boletim: { titulo: spec.doc_title ?? '', produto: spec.product_name ?? '', texto } };
}

/**
 * Até 3 itens por boletim: prata + negativo sintético + prata mascarada quando há família exata;
 * 1 item sem gabarito (resíduo) quando não há; nenhum quando a busca não trouxe candidato
 * (falha de RECUPERAÇÃO — contada à parte, não vai ao modelo).
 */
export function montarItensBoletim(spec: SpecExportada, candidatos: readonly SkuCandidato[]): ItemBacktest[] {
  if (candidatos.length === 0) return [];
  const familias = agruparFamilias(spec.product_code, candidatos);
  const grupo = `B:${baseDoCodigo(spec.product_code)}`;
  const state = stateDoBoletim(spec);
  const texto = state.boletim.texto;
  const nenhum: Opcao = { chave: NENHUM, descricao: DESC_NENHUM };
  const comum = { dominio: 'boletim_sku' as const, grupo, instrucoes: INSTRUCOES_BOLETIM };
  const identidade = (s: string) => s;

  const exata = familias.find((f) => f.exata);
  if (!exata) {
    return [{
      ...comum, id: `a:${spec.spec_id}:residuo`, tipoGabarito: 'sem_gabarito', state,
      opcoes: [...opcoesDasFamilias(familias, identidade).map(semGrupo), nenhum], gabarito: null, baseline: null,
    }];
  }

  const itens: ItemBacktest[] = [];
  const prata = opcoesDasFamilias(familias, identidade);
  const chaveExata = prata.find((o) => o.grupoChave === exata.grupoChave)!.chave;
  itens.push({
    ...comum, id: `a:${spec.spec_id}:prata`, tipoGabarito: 'prata', state,
    opcoes: [...prata.map(semGrupo), nenhum], gabarito: [chaveExata], baseline: chaveExata,
  });

  const distratores = familias.filter((f) => !f.exata);
  if (distratores.length > 0) {
    itens.push({
      ...comum, id: `a:${spec.spec_id}:negativo`, tipoGabarito: 'sintetico_negativo', state,
      opcoes: [...opcoesDasFamilias(distratores, identidade).map(semGrupo), nenhum], gabarito: [NENHUM], baseline: null,
    });
  }

  const extras = [spec.product_code, baseDoCodigo(spec.product_code)];
  const m = (s: string) => mascararCodigos(s, extras);
  const mascaradas = opcoesDasFamilias(familias, m);
  const chaveExataMascarada = mascaradas.find((o) => o.grupoChave === exata.grupoChave)!.chave;
  itens.push({
    ...comum, id: `a:${spec.spec_id}:mascarada`, tipoGabarito: 'prata_mascarada',
    state: { boletim: { titulo: m(spec.doc_title ?? ''), produto: m(spec.product_name ?? ''), texto: m(texto) } },
    opcoes: [...mascaradas.map(semGrupo), nenhum], gabarito: [chaveExataMascarada], baseline: null,
  });
  return itens;
}

/** Palavras do NOME do produto para medir vizinhança (sem números: o código não conta). */
const palavrasNome = (s: string | null) =>
  new Set(
    (s ?? '')
      .normalize('NFKC')
      .toUpperCase()
      .split(/[^A-Z0-9ÁÉÍÓÚÂÊÔÃÕÇ]+/)
      .filter((w) => w.length >= 2 && !/\d/.test(w)),
  );

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const uniao = a.size + b.size - inter;
  return uniao === 0 ? 0 : inter / uniao;
}

/**
 * Negativo CRUZADO (sintético): o boletim de A contra as famílias da ficha B de nome mais parecido
 * (base diferente), retirada qualquer família que contenha a base de A ⇒ a resposta certa é
 * "nenhum". Existe porque o negativo "tirar a família certa" só é possível quando a busca de A
 * trouxe distratores — e isso é raro no catálogo real. Empate de vizinhança: o 1º na ordem.
 */
export function montarNegativosCruzados(
  entradas: ReadonlyArray<{ spec: SpecExportada; candidatos: readonly SkuCandidato[] }>,
): ItemBacktest[] {
  const comExata = entradas
    .map((e) => ({
      spec: e.spec,
      base: baseDoCodigo(e.spec.product_code),
      nome: palavrasNome(e.spec.product_name),
      familias: agruparFamilias(e.spec.product_code, e.candidatos),
    }))
    .filter((e) => e.familias.some((f) => f.exata));
  const itens: ItemBacktest[] = [];
  for (const a of comExata) {
    let doador: (typeof comExata)[number] | null = null;
    let melhor = -1;
    for (const b of comExata) {
      if (b.base === a.base) continue;
      const sim = jaccard(a.nome, b.nome);
      if (sim > melhor) {
        melhor = sim;
        doador = b;
      }
    }
    if (!doador) continue;
    const distratores = doador.familias.filter((f) => !f.bases.includes(a.base));
    if (distratores.length === 0) continue;
    itens.push({
      id: `a:${a.spec.spec_id}:cruzado`,
      dominio: 'boletim_sku',
      grupo: `B:${a.base}`,
      tipoGabarito: 'negativo_cruzado',
      state: stateDoBoletim(a.spec),
      instrucoes: INSTRUCOES_BOLETIM,
      opcoes: [...opcoesDasFamilias(distratores, (s) => s).map(semGrupo), { chave: NENHUM, descricao: DESC_NENHUM }],
      gabarito: [NENHUM],
      baseline: null,
    });
  }
  return itens;
}

// ─── (c) categoria Omie → linha da DRE ──────────────────────────────────────────────────────

export type DreLinha =
  | 'receita_bruta' | 'deducoes' | 'cmv'
  | 'despesas_operacionais' | 'despesas_administrativas' | 'despesas_comerciais'
  | 'despesas_financeiras' | 'receitas_financeiras'
  | 'outras_receitas' | 'outras_despesas' | 'impostos';

/** As 11 linhas, na ordem do tipo `DreLinha` de supabase/functions/fin-suggest-mapping/index.ts. */
export const LINHAS_DRE: ReadonlyArray<{ chave: DreLinha; descricao: string }> = [
  { chave: 'receita_bruta', descricao: 'Receita bruta: venda de mercadorias, de produtos e prestação de serviços.' },
  { chave: 'deducoes', descricao: 'Deduções da receita: devoluções, cancelamentos e descontos incondicionais sobre vendas.' },
  { chave: 'cmv', descricao: 'Custo do que foi vendido: mercadorias, produtos e serviços vendidos; compras de mercadoria e matéria-prima.' },
  { chave: 'despesas_operacionais', descricao: 'Despesas operacionais gerais que não são administrativas nem comerciais.' },
  { chave: 'despesas_administrativas', descricao: 'Despesas administrativas: folha, encargos, aluguel, condomínio, água, luz, telefone, material de escritório, contabilidade, consultoria, TI.' },
  { chave: 'despesas_comerciais', descricao: 'Despesas comerciais: comissões de vendedores, fretes sobre vendas, marketing, publicidade, viagens de venda.' },
  { chave: 'despesas_financeiras', descricao: 'Despesas financeiras: juros pagos, tarifas bancárias, IOF, descontos concedidos.' },
  { chave: 'receitas_financeiras', descricao: 'Receitas financeiras: rendimentos de aplicações, juros recebidos, descontos obtidos.' },
  { chave: 'outras_receitas', descricao: 'Outras receitas não operacionais (ex.: venda de ativo imobilizado, recuperação de despesas).' },
  { chave: 'outras_despesas', descricao: 'Outras despesas não operacionais (ex.: multas, perdas, baixas de ativo).' },
  { chave: 'impostos', descricao: 'Tributos sobre faturamento e lucro: DAS/Simples Nacional, IRPJ, CSLL, PIS, COFINS, ICMS, ISS, IPI.' },
];

const DESC_NENHUMA =
  'Não entra na DRE: transferência entre contas, empréstimo recebido ou pago (principal), aporte ou retirada de ' +
  'sócio, compra de ativo imobilizado, adiantamentos.';

const INSTRUCOES_DRE =
  'A `categoria` é uma categoria do plano de contas financeiro de uma distribuidora (ERP Omie). Em qual linha da ' +
  'DRE (demonstração de resultado) entram os lançamentos dessa categoria? Se nenhuma linha se aplicar, escolha "nenhuma".';

/** Cópia fiel das 9 regex de supabase/functions/fin-suggest-mapping/index.ts (a edge é Deno, não importável). */
const KEYWORDS_DRE: ReadonlyArray<readonly [RegExp, DreLinha]> = [
  [/honor|advog|contador|consultor/i, 'despesas_administrativas'],
  [/aluguel|condom[íi]nio|iptu/i, 'despesas_administrativas'],
  [/sal[áa]rio|folha|enc(argo|argos)|inss|fgts/i, 'despesas_administrativas'],
  [/marketing|propaganda|publicidade|google ads|facebook|meta ads/i, 'despesas_comerciais'],
  [/frete|transporte|combust[íi]vel|pedágio/i, 'despesas_comerciais'],
  [/juros|tarifa banc[áa]ria|iof/i, 'despesas_financeiras'],
  [/rendimento|aplica[çc][ãa]o/i, 'receitas_financeiras'],
  [/icms|pis|cofins|iss|irpj|csll|simples nacional/i, 'impostos'],
  [/cmv|mercador|insumo|mat[ée]ria.prima/i, 'cmv'],
];

/** Baseline de (c): só as regex. O passo "mapa de outra empresa pelo código" da edge fica de fora
 *  de propósito — com o mapa inteiro em `_default`, ele devolveria o próprio seed (circular). */
export function baselineDre(nome: string): DreLinha | null {
  for (const [rx, linha] of KEYWORDS_DRE) if (rx.test(nome)) return linha;
  return null;
}

export interface CategoriaExportada {
  company: string;
  omie_codigo: string;
  descricao: string;
}

export function montarItemDre(cat: CategoriaExportada, seedLinha: DreLinha | null): ItemBacktest {
  return {
    id: `c:${cat.company}:${cat.omie_codigo}`,
    dominio: 'categoria_dre',
    grupo: `${cat.company}:${cat.omie_codigo}`,
    tipoGabarito: seedLinha ? 'seed' : 'sem_gabarito',
    state: { categoria: cat.descricao },
    instrucoes: INSTRUCOES_DRE,
    opcoes: [...LINHAS_DRE.map((l) => ({ chave: l.chave, descricao: l.descricao })), { chave: NENHUMA, descricao: DESC_NENHUMA }],
    gabarito: seedLinha ? [seedLinha] : null,
    baseline: baselineDre(cat.descricao),
  };
}

// ─── ordem e partição ───────────────────────────────────────────────────────────────────────

export function inverterOpcoes(opcoes: readonly Opcao[]): Opcao[] {
  return [...opcoes].reverse();
}

/** FNV-1a 32 bits sobre os bytes UTF-8. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Partição determinística pelo GRUPO: o limiar é escolhido em 'dev' e medido em 'teste'. */
export function particao(grupo: string): 'dev' | 'teste' {
  return fnv1a32(grupo) % 2 === 0 ? 'dev' : 'teste';
}
