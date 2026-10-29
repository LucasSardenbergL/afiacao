// Casamento CR↔CP intercompany — lógica PURA da `fin-ic-reconcile` (testes em casamento_test.ts).
//
// ── Por que existe ───────────────────────────────────────────────────────────────────────────
// A edge casava por `cnpj_cpf` do título, que é '' em 100% dos CR/CP (o Omie não devolve CNPJ em
// ListarContasReceber/Pagar) — `fin_ic_matches` ficava com 0 linhas e o DRE consolidado eliminava 0
// sem aviso. A contraparte só existe como CÓDIGO Omie do cadastro (cliente e fornecedor são o mesmo
// cadastro); o código → CNPJ vem do próprio Omie (`contrapartes.ts`). Diário:
// docs/historico/fin-ic-reconcile-contraparte-por-codigo.md.
//
// ── Regra (precisão > recall) ────────────────────────────────────────────────────────────────
// `auto_matched` é a ÚNICA coisa que a RPC `fin_consolidado_intercompany` elimina (junto com o
// `manual_matched` humano). Par só sai automático com:
//   - direção provada: CR da empresa A cuja contraparte é B, CP da empresa B cuja contraparte é A;
//   - os dois vivos (status não nulo e ≠ CANCELADO), com emissão, valor > 0;
//   - MESMO valor (numeric(…,2) chega como o mesmo double; a RPC exige igualdade exata);
//   - emissão a ≤ 5 dias;
//   - NF nos DOIS lados e a MESMA NF (zeros à esquerda de cada bloco não contam). Valor+data+
//     unicidade NÃO provam que é a mesma operação; NF ausente de um lado vira informativo;
//   - unicidade MÚTUA: o CR tem 1 candidato só E esse CP tem 1 candidato só. Ambíguo de qualquer
//     lado → `duplicidade_possivel`, nunca um par escolhido.
// Elegibilidade para ELIMINAR (mesmo mês, categoria que compôs receita/cmv, snapshot fiel) é da RPC:
// par real que ela reprova leva o mês a NULL ("eliminação pendente") — esconder o par deixaria o
// consolidado superestimado e calado.

const VALOR_TOLERANCIA_FROUXA = 0.05; // ±5%: só o informativo `divergencia_valor`
const DATA_TOLERANCIA_DIAS = 5;
const DATA_TOLERANCIA_FROUXA_DIAS = 30; // só o informativo `divergencia_data`

/**
 * Status que a edge APAGA e regrava a cada rodada — só os informativos, que a RPC ignora. O
 * `auto_matched` a edge grava e NUNCA apaga (ver `publicarMatches`); `manual_matched` e
 * `desconsiderado` são do humano.
 */
const STATUS_INFORMATIVOS = [
  "divergencia_valor",
  "divergencia_data",
  "sem_contrapartida",
  "duplicidade_possivel",
] as const;

export interface Titulo {
  id: string;
  company: string;
  /** `omie_codigo_cliente` (CR) / `omie_codigo_cliente_fornecedor` (CP). */
  codigo: number | null;
  valor: number;
  data_emissao: string | null;
  nf: string | null;
  status: string | null;
}

export interface LinhaMatch {
  empresa_origem: string;
  empresa_destino: string;
  cr_id?: string;
  cp_id?: string;
  valor_origem?: number;
  valor_destino?: number;
  diff_dias?: number | null;
  status: "auto_matched" | (typeof STATUS_INFORMATIVOS)[number];
  observacao?: string;
}

/** Chave do mapa de contraparte: o código é do cadastro DAQUELA empresa (cada Omie tem os seus). */
export function chaveContraparte(empresa: string, codigo: number): string {
  return `${empresa}:${codigo}`;
}

/**
 * NF por BLOCOS de dígitos, sem zeros à esquerda em cada bloco: `00023572` = `000023572`, mas
 * `23572/1` (série/parcela) ≠ `235721` — concatenar os blocos fabricaria identidade. Sem dígito,
 * ou só zeros → null (ausente, não "0").
 */
export function normalizarNf(nf: string | null | undefined): string | null {
  const blocos = (String(nf ?? "").match(/\d+/g) ?? []).map((b) => b.replace(/^0+/, "") || "0");
  return blocos.every((b) => b === "0") ? null : blocos.join("/");
}

function diasEntre(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
}

function vivo(t: Titulo): boolean {
  return t.status !== null && t.status !== "CANCELADO" && t.data_emissao !== null &&
    Number.isFinite(t.valor) && t.valor > 0;
}

/** Para o par AUTOMÁTICO: NF nos dois lados e igual. */
function mesmaNf(cr: Titulo, cp: Titulo): boolean {
  const a = normalizarNf(cr.nf);
  return a !== null && a === normalizarNf(cp.nf);
}

/** Para os informativos: NF diferente exclui; ausente de um lado ainda é candidato a conferir. */
function nfNaoConflita(cr: Titulo, cp: Titulo): boolean {
  const a = normalizarNf(cr.nf);
  const b = normalizarNf(cp.nf);
  return a === null || b === null || a === b;
}

interface Lado {
  t: Titulo;
  /** Empresa do grupo do outro lado (o CNPJ do cadastro, resolvido pelo Omie). */
  outra: string;
}

/**
 * Casa os títulos. `contraparte` mapeia `chaveContraparte(empresa, código)` → empresa do grupo.
 * `travados` = ids de CR/CP que já estão numa linha do humano OU num `auto_matched` já gravado: saem
 * do pool inteiro (nem candidato, nem `sem_contrapartida`). Senão o mesmo título apareceria em 2
 * linhas, o UNIQUE recusaria o insert e a RPC daria NULL.
 */
export function casar(input: {
  crs: ReadonlyArray<Titulo>;
  cps: ReadonlyArray<Titulo>;
  contraparte: ReadonlyMap<string, string>;
  travados: ReadonlySet<string>;
}): LinhaMatch[] {
  const lado = (t: Titulo): Lado | null => {
    if (input.travados.has(t.id) || t.codigo === null || !vivo(t)) return null;
    const outra = input.contraparte.get(chaveContraparte(t.company, t.codigo));
    // Auto-cadastro (a empresa no próprio Omie) não é intercompany.
    if (outra === undefined || outra === t.company) return null;
    return { t, outra };
  };
  const crs = input.crs.map(lado).filter((x): x is Lado => x !== null);
  const cps = input.cps.map(lado).filter((x): x is Lado => x !== null);

  // Direção: CP da empresa B cuja contraparte é A ↔ CR da empresa A cuja contraparte é B.
  const cpsPorDirecao = new Map<string, Lado[]>();
  for (const p of cps) {
    const k = `${p.outra}>${p.t.company}`;
    const lista = cpsPorDirecao.get(k) ?? [];
    lista.push(p);
    cpsPorDirecao.set(k, lista);
  }
  const doMesmoPar = (r: Lado) => cpsPorDirecao.get(`${r.t.company}>${r.outra}`) ?? [];

  const estrito = (r: Lado, p: Lado) =>
    r.t.valor === p.t.valor &&
    diasEntre(r.t.data_emissao!, p.t.data_emissao!) <= DATA_TOLERANCIA_DIAS &&
    mesmaNf(r.t, p.t);

  const candidatosDoCr = new Map<string, Lado[]>();
  const candidatosDoCp = new Map<string, number>();
  for (const r of crs) {
    const c = doMesmoPar(r).filter((p) => estrito(r, p));
    candidatosDoCr.set(r.t.id, c);
    for (const p of c) candidatosDoCp.set(p.t.id, (candidatosDoCp.get(p.t.id) ?? 0) + 1);
  }

  const linhas: LinhaMatch[] = [];
  const cpUsado = new Set<string>();
  const crResolvido = new Set<string>();

  // 1) Pares estritos e mutuamente únicos.
  for (const r of crs) {
    const c = candidatosDoCr.get(r.t.id)!;
    if (c.length === 1 && candidatosDoCp.get(c[0].t.id) === 1) {
      const p = c[0];
      linhas.push({
        empresa_origem: r.t.company,
        empresa_destino: r.outra,
        cr_id: r.t.id,
        cp_id: p.t.id,
        valor_origem: r.t.valor,
        valor_destino: p.t.valor,
        diff_dias: diasEntre(r.t.data_emissao!, p.t.data_emissao!),
        status: "auto_matched",
      });
      cpUsado.add(p.t.id);
      crResolvido.add(r.t.id);
    } else if (c.length >= 1) {
      // Ambíguo: >1 CP para este CR, ou o único CP também serve a outro CR. Nenhum é escolhido.
      linhas.push({
        empresa_origem: r.t.company,
        empresa_destino: r.outra,
        cr_id: r.t.id,
        valor_origem: r.t.valor,
        status: "duplicidade_possivel",
        observacao: `${c.length} CP(s) candidato(s); algum serve a mais de um CR`,
      });
      for (const p of c) cpUsado.add(p.t.id);
      crResolvido.add(r.t.id);
    }
  }

  // 2) Informativos (a RPC ignora): só com candidato ÚNICO entre os CPs ainda livres.
  for (const r of crs) {
    if (crResolvido.has(r.t.id)) continue;
    const livres = doMesmoPar(r).filter((p) => !cpUsado.has(p.t.id) && nfNaoConflita(r.t, p.t));
    const dias = (p: Lado) => diasEntre(r.t.data_emissao!, p.t.data_emissao!);
    const frouxoValor = livres.filter((p) =>
      Math.abs(p.t.valor - r.t.valor) / r.t.valor <= VALOR_TOLERANCIA_FROUXA && dias(p) <= DATA_TOLERANCIA_DIAS
    );
    const frouxoData = livres.filter((p) =>
      p.t.valor === r.t.valor && dias(p) > DATA_TOLERANCIA_DIAS && dias(p) <= DATA_TOLERANCIA_FROUXA_DIAS
    );
    // Valor IGUAL a ≤ 5 dias aqui só sobra quando falta NF de um lado (com NF igual teria casado no
    // passo 1): é candidato a confirmar à mão, não divergência de valor.
    const unico = frouxoValor.length === 1
      ? frouxoValor[0].t.valor === r.t.valor
        ? { p: frouxoValor[0], status: "sem_contrapartida" as const, observacao: "candidato único com mesmo valor e data, mas sem NF de um dos lados — confirme manualmente" }
        : { p: frouxoValor[0], status: "divergencia_valor" as const }
      : frouxoData.length === 1
      ? { p: frouxoData[0], status: "divergencia_data" as const }
      : null;
    if (unico) {
      linhas.push({
        empresa_origem: r.t.company,
        empresa_destino: r.outra,
        cr_id: r.t.id,
        cp_id: unico.p.t.id,
        valor_origem: r.t.valor,
        valor_destino: unico.p.t.valor,
        diff_dias: dias(unico.p),
        status: unico.status,
        ...("observacao" in unico ? { observacao: unico.observacao } : {}),
      });
      cpUsado.add(unico.p.t.id);
    } else {
      linhas.push({
        empresa_origem: r.t.company,
        empresa_destino: r.outra,
        cr_id: r.t.id,
        valor_origem: r.t.valor,
        status: "sem_contrapartida",
      });
    }
  }

  // 3) CP intercompany que não entrou em nenhuma linha.
  for (const p of cps) {
    if (cpUsado.has(p.t.id)) continue;
    linhas.push({
      empresa_origem: p.outra,
      empresa_destino: p.t.company,
      cp_id: p.t.id,
      valor_destino: p.t.valor,
      status: "sem_contrapartida",
    });
  }

  return linhas;
}

/** Linha já gravada em `fin_ic_matches`, no que a rodada precisa. */
export interface MatchExistente {
  id: string;
  status: string;
  cr_id: string | null;
  cp_id: string | null;
  resolvido_em: string | null;
}

/**
 * O que a rodada faz com o que já está gravado. Informativo não resolvido → trocado (id para apagar).
 * Todo o resto — `auto_matched` (a edge nunca o apaga: é a evidência da RPC), linha do humano ou
 * resolvida — FICA e tira os títulos do pool.
 */
export function separarExistentes(existentes: ReadonlyArray<MatchExistente>): {
  travados: Set<string>;
  idsInformativos: string[];
  autoPreservados: number;
} {
  const informativos = new Set<string>(STATUS_INFORMATIVOS);
  const travados = new Set<string>();
  const idsInformativos: string[] = [];
  let autoPreservados = 0;
  for (const m of existentes) {
    if (informativos.has(m.status) && m.resolvido_em === null) {
      idsInformativos.push(m.id);
      continue;
    }
    if (m.status === "auto_matched" && m.resolvido_em === null) autoPreservados++;
    if (m.cr_id) travados.add(m.cr_id);
    if (m.cp_id) travados.add(m.cp_id);
  }
  return { travados, idsInformativos, autoPreservados };
}

export interface Escritor {
  inserir(linhas: LinhaMatch[]): PromiseLike<{ error: { message: string } | null }>;
  /** Apaga pelos ids SÓ as linhas que ainda são informativas e não resolvidas (filtro no DELETE). */
  apagarInformativos(ids: string[]): PromiseLike<{ error: { message: string } | null }>;
}

export type DesfechoEscrita =
  | { ok: true; inseridas: number; informativas_apagadas: number }
  | { ok: false; etapa: "inserir" | "apagar"; erro: string };

const LOTE_APAGAR = 200; // ids por `.in()` — cabe na URL do PostgREST

/**
 * Publica a rodada sem NUNCA apagar `auto_matched`:
 * - Par automático já gravado FICA, mesmo que os títulos mudem: é a evidência que leva a RPC a
 *   NULL ("eliminação pendente") quando o par perde elegibilidade. Apagá-lo zeraria a eliminação
 *   em silêncio. Quem desfaz um par é o humano (`desconsiderado`). O caller tira os títulos dele do
 *   pool (`travados`), então a rodada não o recria.
 * - Só os informativos (a RPC os ignora) são trocados: APAGA os antigos e depois INSERE. A ordem é
 *   imposta pelos índices UNIQUE em `cr_id` e `cp_id` (inserir antes colidiria com o próprio título).
 *   O DELETE refiltra status e `resolvido_em`, então linha que o humano mexeu depois da leitura
 *   sobrevive, e o insert que colidir com ela falha inteiro (500, nada novo gravado).
 * - Duas rodadas concorrentes: a 2ª colide nos UNIQUE e falha inteira, sem par duplicado.
 */
export async function publicarMatches(
  db: Escritor,
  novas: LinhaMatch[],
  idsInformativos: ReadonlyArray<string>,
): Promise<DesfechoEscrita> {
  for (let i = 0; i < idsInformativos.length; i += LOTE_APAGAR) {
    const { error } = await db.apagarInformativos(idsInformativos.slice(i, i + LOTE_APAGAR));
    if (error) return { ok: false, etapa: "apagar", erro: error.message };
  }
  if (novas.length > 0) {
    const { error } = await db.inserir(novas);
    if (error) return { ok: false, etapa: "inserir", erro: error.message };
  }
  return { ok: true, inseridas: novas.length, informativas_apagadas: idsInformativos.length };
}

type Resultado = PromiseLike<{ error: { message: string } | null }>;

/** O mínimo do builder do PostgREST que o escritor usa (o cliente real e o falso dos testes). */
export interface TabelaMatches {
  insert(linhas: LinhaMatch[]): Resultado;
  delete(): {
    in(coluna: string, valores: readonly string[]): {
      in(coluna: string, valores: readonly string[]): { is(coluna: string, valor: null): Resultado };
    };
  };
}

/**
 * Escritor sobre `fin_ic_matches`. O DELETE REFILTRA status informativo e `resolvido_em IS NULL`
 * no próprio statement: linha que o humano promoveu/desconsiderou/resolveu entre a leitura e o
 * delete não casa o filtro e sobrevive (o Postgres reavalia o WHERE na linha atual).
 */
export function escritorPostgrest(tabela: () => TabelaMatches): Escritor {
  return {
    inserir: (linhas) => tabela().insert(linhas),
    apagarInformativos: (ids) =>
      tabela().delete().in("id", ids).in("status", [...STATUS_INFORMATIVOS]).is("resolvido_em", null),
  };
}
