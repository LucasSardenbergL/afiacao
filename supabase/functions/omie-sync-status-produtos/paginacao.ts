// Paginação concorrente do ListarProdutos do Omie — módulo PURO (sem Deno.serve / sem client
// Supabase) para ser testável isoladamente (paginacao.test.ts). A edge injeta o `fetchPagina`
// real; o teste injeta um catálogo fake.
//
// POR QUÊ (money-path, incidente 2026-07-06): a versão anterior paginava em SÉRIE com 700ms de
// delay proativo entre páginas. O catálogo OBEN tem ~3,7k produtos (o Omie serve ~100/página →
// ~37 páginas), e o wall-clock (medido em prod: 95–148s) encostava no teto de 150s do edge
// runtime → IDLE_TIMEOUT intermitente. Aqui paginamos em POOL contínuo de concorrência fixa, SEM
// delay proativo (o freio é reativo a 429, no omieCall).
//
// FIM DE PAGINAÇÃO (Codex challenge 2026-07-06, P1 money-path): NÃO tratamos toda página vazia como
// fim. `total_de_paginas` do Omie SUB-reporta (nunca super) em lista grande — então é um PISO, não um
// teto. Regra: uma página vazia só é fim REAL se `pg > piso`; vazia ANTES do piso é anomalia (fault
// transiente / página malformada) → LANÇA (fail-closed). Sem isto, um glitch pararia a varredura cedo,
// os SKUs do tail virariam `nao_existe_omie` (ativo_no_omie=null) e — como null LIBERA no gate de
// compra — um SKU inativo real viraria comprável.

export interface OmieProduto {
  codigo_produto?: number;
  codigo?: string;
  descricao?: string;
  inativo?: string; // "S" | "N"
  estoque_minimo?: number;
  estoque_maximo?: number; // No Omie, "estoque_maximo" da listagem é normalmente o ponto de pedido
  dadosArmazenamento?: {
    estoque_minimo?: number;
    estoque_maximo?: number;
  };
}

// Uma página do ListarProdutos: os produtos + o total_de_paginas DECLARADO pelo Omie nessa resposta.
export interface PaginaOmie {
  produtos: OmieProduto[];
  totalPaginas: number; // total_de_paginas declarado (SUB-reporta → usado como PISO, não teto)
}

export interface ColetaResultado {
  produtos: OmieProduto[]; // apenas os produtos ALVO (filtrados por alvoSet), de-duplicados por código
  encontrados: Set<string>; // códigos alvo efetivamente vistos na listagem
  paginasProcessadas: number; // páginas NÃO-vazias buscadas (métrica). 0 = catálogo veio vazio (anômalo)
}

export interface ColetaOpts {
  concurrency: number;
  maxPaginas: number; // guard anti-loop
  maxDuracaoMs: number; // guard de tempo: aborta ANTES do kill do runtime (evita log órfão 'running')
}

// Varre ListarProdutos coletando só os produtos cujo código está em `alvoSet`.
//
// A página 1 é buscada SEQUENCIALMENTE primeiro: estabelece o PISO de páginas antes de qualquer
// worker julgar "vazia = fim" (senão uma corrida poderia ver uma página alta vazia antes de o piso
// existir e parar cedo). Depois, páginas 2..N em POOL contínuo de `concurrency` workers.
//
// Corretude do pool: `proxima++` é atômico (JS single-thread, sem await no meio) → cada worker pega
// uma página única e sequencial, nenhuma é pulada. Resolução fora de ordem não descarta páginas
// baixas já atribuídas.
//
// Lança em: página vazia antes do piso (anomalia), estouro de maxPaginas (loop), ou estouro de
// maxDuracaoMs (tempo). Todos fail-closed — o chamador trata como sync falha e re-tenta.
export async function coletarProdutosAlvo(
  fetchPagina: (pagina: number) => Promise<PaginaOmie>,
  alvoSet: ReadonlySet<string>,
  opts: ColetaOpts,
): Promise<ColetaResultado> {
  const inicio = Date.now();
  const { maxPaginas, maxDuracaoMs } = opts;
  const concurrency = Math.max(1, opts.concurrency);
  const produtos: OmieProduto[] = [];
  const encontrados = new Set<string>();
  let paginasProcessadas = 0;

  const coleta = (lista: OmieProduto[]) => {
    for (const p of lista) {
      const codStr = String(p.codigo_produto ?? "");
      if (!codStr || !alvoSet.has(codStr) || encontrados.has(codStr)) continue;
      encontrados.add(codStr);
      produtos.push(p);
    }
  };

  // Página 1 sequencial: estabelece o PISO. Página 1 vazia = catálogo vazio (o chamador decide se
  // isso é anômalo — ele só chama com alvos > 0, então paginasProcessadas=0 é o sinal).
  const p1 = await fetchPagina(1);
  if (p1.produtos.length === 0) {
    return { produtos, encontrados, paginasProcessadas: 0 };
  }
  paginasProcessadas = 1;
  coleta(p1.produtos);
  let piso = Math.max(1, p1.totalPaginas || 1);

  let proxima = 2;
  let fim = false;
  let estourou = false;

  const worker = async () => {
    while (!fim) {
      if (Date.now() - inicio > maxDuracaoMs) {
        throw new Error(
          `ListarProdutos excedeu ${maxDuracaoMs}ms sem terminar — abort antes do kill do runtime`,
        );
      }
      const pg = proxima++;
      if (pg > maxPaginas) {
        estourou = true;
        fim = true;
        return;
      }
      const { produtos: lista, totalPaginas } = await fetchPagina(pg);
      if (totalPaginas > piso) piso = totalPaginas;
      if (lista.length === 0) {
        if (pg <= piso) {
          // Vazia ANTES do piso declarado = anomalia (fault transiente / página malformada), NÃO fim
          // real. Fail-closed: abortar é mais seguro que marcar o tail como nao_existe (null libera).
          throw new Error(
            `ListarProdutos página ${pg} vazia antes do piso ${piso} — abort anti-parada-prematura`,
          );
        }
        fim = true; // vazia DEPOIS do piso = fim REAL
        return;
      }
      paginasProcessadas++;
      coleta(lista);
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } catch (e) {
    fim = true; // sinaliza os workers remanescentes a pararem no próximo tick (não ficam batendo no Omie)
    throw e;
  }

  if (estourou) {
    throw new Error(`ListarProdutos excedeu ${maxPaginas} páginas sem ver fim — abort anti-loop`);
  }
  return { produtos, encontrados, paginasProcessadas };
}
