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
//   - emissão a ≤ 5 dias; e, se os DOIS têm NF, a MESMA NF (zeros à esquerda não contam);
//   - unicidade MÚTUA: o CR tem 1 candidato só E esse CP tem 1 candidato só. Ambíguo de qualquer
//     lado → `duplicidade_possivel`, nunca um par escolhido.
// Elegibilidade para ELIMINAR (mesmo mês, categoria que compôs receita/cmv, snapshot fiel) é da RPC:
// par real que ela reprova leva o mês a NULL ("eliminação pendente") — esconder o par deixaria o
// consolidado superestimado e calado.

const VALOR_TOLERANCIA_FROUXA = 0.05; // ±5%: só o informativo `divergencia_valor`
const DATA_TOLERANCIA_DIAS = 5;
const DATA_TOLERANCIA_FROUXA_DIAS = 30; // só o informativo `divergencia_data`

/** Status que a edge apaga e regrava. Os demais (`manual_matched`, `desconsiderado`) são do humano. */
export const STATUS_AUTOMATICOS = [
  "auto_matched",
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
  status: (typeof STATUS_AUTOMATICOS)[number];
  observacao?: string;
}

/** Chave do mapa de contraparte: o código é do cadastro DAQUELA empresa (cada Omie tem os seus). */
export function chaveContraparte(empresa: string, codigo: number): string {
  return `${empresa}:${codigo}`;
}

/** NF só com dígitos e sem zeros à esquerda; vazia/sem dígito → null (ausente, não "0"). */
export function normalizarNf(nf: string | null | undefined): string | null {
  const d = String(nf ?? "").replace(/\D/g, "").replace(/^0+/, "");
  return d === "" ? null : d;
}

function diasEntre(a: string, b: string): number {
  return Math.abs(Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000));
}

function vivo(t: Titulo): boolean {
  return t.status !== null && t.status !== "CANCELADO" && t.data_emissao !== null &&
    Number.isFinite(t.valor) && t.valor > 0;
}

function nfCompativel(cr: Titulo, cp: Titulo): boolean {
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
 * `travados` = ids de CR/CP que já estão numa linha do humano: saem do pool inteiro (nem candidato,
 * nem `sem_contrapartida`), senão o mesmo título apareceria em 2 pares e a RPC daria NULL.
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
    nfCompativel(r.t, p.t);

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
    const livres = doMesmoPar(r).filter((p) => !cpUsado.has(p.t.id) && nfCompativel(r.t, p.t));
    const dias = (p: Lado) => diasEntre(r.t.data_emissao!, p.t.data_emissao!);
    const frouxoValor = livres.filter((p) =>
      Math.abs(p.t.valor - r.t.valor) / r.t.valor <= VALOR_TOLERANCIA_FROUXA && dias(p) <= DATA_TOLERANCIA_DIAS
    );
    const frouxoData = livres.filter((p) =>
      p.t.valor === r.t.valor && dias(p) > DATA_TOLERANCIA_DIAS && dias(p) <= DATA_TOLERANCIA_FROUXA_DIAS
    );
    const unico = frouxoValor.length === 1
      ? { p: frouxoValor[0], status: "divergencia_valor" as const }
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

export interface Escritor {
  inserir(linhas: LinhaMatch[]): PromiseLike<{ error: { message: string } | null }>;
  apagar(ids: string[]): PromiseLike<{ error: { message: string } | null }>;
}

export type DesfechoEscrita =
  | { ok: true; inseridas: number; apagadas: number }
  | { ok: false; etapa: "inserir" | "apagar"; erro: string };

const LOTE_APAGAR = 200; // ids por `.in()` — cabe na URL do PostgREST

/**
 * Troca as linhas automáticas SEM janela de "zero matches": INSERE as novas num statement só e
 * só então apaga as antigas (pelos ids lidos ANTES). Falha no insert → nada apagado (estado velho,
 * consistente). Falha no delete → antigas + novas convivem; o mesmo título em 2 pares leva a RPC a
 * NULL (fail-closed) até a próxima rodada. Nenhum caminho deixa a tabela vazia em silêncio.
 */
export async function substituirMatches(
  db: Escritor,
  novas: LinhaMatch[],
  idsAntigos: ReadonlyArray<string>,
): Promise<DesfechoEscrita> {
  if (novas.length > 0) {
    const { error } = await db.inserir(novas);
    if (error) return { ok: false, etapa: "inserir", erro: error.message };
  }
  for (let i = 0; i < idsAntigos.length; i += LOTE_APAGAR) {
    const { error } = await db.apagar(idsAntigos.slice(i, i + LOTE_APAGAR));
    if (error) return { ok: false, etapa: "apagar", erro: error.message };
  }
  return { ok: true, inseridas: novas.length, apagadas: idsAntigos.length };
}
