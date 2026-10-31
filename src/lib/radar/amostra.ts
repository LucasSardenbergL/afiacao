// Amostra de controle do Radar na fila (docs/historico/radar-amostra-na-fila.md).
//
// A coorte `radar_coorte_controle` congela, no mesmo instante, o topo (score ≥ 70) e uma amostra fora dele (40–69).
// A comparação de conversão topo × amostra só mede algo se a amostra for CONTATADA — e ela nunca aparece no topo
// da fila por score. Regra de exploração: 1 lead da amostra a cada PASSO_AMOSTRA posições, com selo "amostra".
//
// O que esconde e o que NÃO esconde a amostra:
// - NÃO escondem: região padrão (MG e vizinhos), "só sugeridos", "só inéditos", modo de ataque, "com telefone",
//   "incluir sem contato" — são recortes de RANKING da fila, e a amostra existe justamente para fugir do ranking.
//   Os 4 sorteados de PA/RS (fora de `regiao='atuacao'`) aparecem por isso.
// - Escondem: o que o vendedor DIGITOU ou escolheu para achar algo (busca, UF, município, CNAE, status). Um lead de
//   outro estado no meio de "UF = SP" seria ruído, não exploração.
// - Só entra na fila quem está pendente (a contatar, não cliente). Quem foi contatado, descartado ou virou cliente
//   SAI da fila e NÃO é substituído: a coorte é congelada e o denominador é o sorteio inteiro (o resumo conta).
import { isSearchablePostgrestTerm } from '@/lib/postgrest';
import { digitosCnae, UFS_ATUACAO } from '@/lib/radar/ui-helpers';

export const PASSO_AMOSTRA = 10;
/** O PostgREST corta em 1.000 linhas em silêncio, `.rpc()` inclusive: chegar ao teto é ERRO, nunca "acabou". */
export const TETO_LEITURA_AMOSTRA = 1000;

export interface SorteadoAmostra {
  sorteio: string;
  cnpj: string;
  posicao: number;
}

function forma(fonte: string, esperado: string): never {
  throw new Error(`${fonte}: resposta fora da forma ${esperado}`);
}

/** Resposta de `radar_amostra_vigente()`: lista de `{sorteio, grupo='amostra', cnpj, posicao}` de UM sorteio. */
export function lerAmostraVigente(data: unknown, fonte: string): SorteadoAmostra[] {
  if (!Array.isArray(data)) forma(fonte, 'lista');
  if (data.length >= TETO_LEITURA_AMOSTRA) {
    throw new Error(`${fonte}: ${data.length} linhas — no teto da leitura; a amostra pode estar cortada`);
  }
  const out: SorteadoAmostra[] = [];
  for (const l of data as unknown[]) {
    if (typeof l !== 'object' || l === null) forma(fonte, '{sorteio, grupo, cnpj, posicao}');
    const { sorteio, grupo, cnpj, posicao } = l as Record<string, unknown>;
    if (typeof sorteio !== 'string' || grupo !== 'amostra' || typeof cnpj !== 'string' || cnpj === ''
      || typeof posicao !== 'number' || !Number.isInteger(posicao) || posicao < 1) {
      forma(fonte, '{sorteio, grupo: "amostra", cnpj, posicao ≥ 1}');
    }
    out.push({ sorteio, cnpj, posicao });
  }
  if (new Set(out.map((s) => s.sorteio)).size > 1) throw new Error(`${fonte}: mais de um sorteio na resposta`);
  return out.sort((a, b) => a.posicao - b.posicao);
}

interface LeadAmostra {
  cnpj: string;
  uf: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  municipio_nome: string | null;
  cnae_principal: string | null;
  prospeccao_status: string;
  ja_cliente: boolean;
}

/** Pendente = ainda a contatar e não cliente: o único estado que ocupa um lugar de exploração na fila. */
export function pendenteNaAmostra(e: Pick<LeadAmostra, 'prospeccao_status' | 'ja_cliente'>): boolean {
  return e.prospeccao_status === 'a_contatar' && !e.ja_cliente;
}

export interface FiltrosExplicitos {
  busca: string;
  uf: string;
  municipio: string;
  cnae: string;
  status: string;
}

/** Os filtros que o vendedor DIGITOU/escolheu, no espelho do que a fila faz no servidor (ilike ≈ includes). */
export function casaFiltrosExplicitos(e: LeadAmostra, f: FiltrosExplicitos): boolean {
  const busca = f.busca.trim();
  if (isSearchablePostgrestTerm(busca)) {
    const b = busca.toLocaleLowerCase('pt-BR');
    const nomes = [e.razao_social, e.nome_fantasia].map((n) => (n ?? '').toLocaleLowerCase('pt-BR'));
    if (!nomes.some((n) => n.includes(b))) return false;
  }
  if (f.uf && e.uf !== f.uf) return false;
  const municipio = f.municipio.trim();
  if (isSearchablePostgrestTerm(municipio)
    && !(e.municipio_nome ?? '').toLocaleLowerCase('pt-BR').includes(municipio.toLocaleLowerCase('pt-BR'))) return false;
  const cnae = digitosCnae(f.cnae);
  if (cnae.length === 7 ? e.cnae_principal !== cnae : cnae !== '' && !(e.cnae_principal ?? '').startsWith(cnae)) return false;
  if (f.status && f.status !== 'a_contatar') return false;
  return true;
}

/**
 * Põe 1 lead da amostra a cada PASSO_AMOSTRA posições (10ª, 20ª, …), na ordem do sorteio. Estável por prefixo: ao
 * carregar a próxima página, o que já estava na tela não muda de lugar. Os sorteados são tirados da fila comum
 * (sem linha duplicada). `fim` = a fila comum acabou: a amostra que sobrou entra no fim, em vez de sumir.
 */
export function intercalarAmostra<T extends { cnpj: string }>(fila: T[], amostra: T[], fim: boolean): T[] {
  const daAmostra = new Set(amostra.map((e) => e.cnpj));
  const resto = fila.filter((e) => !daAmostra.has(e.cnpj));
  const out: T[] = [];
  let i = 0;
  let a = 0;
  while (i < resto.length) {
    if ((out.length + 1) % PASSO_AMOSTRA === 0 && a < amostra.length) out.push(amostra[a++]);
    else out.push(resto[i++]);
  }
  if (fim) while (a < amostra.length) out.push(amostra[a++]);
  return out;
}

export interface ItemAmostra<E> {
  posicao: number;
  cnpj: string;
  /** null = o sorteado não voltou na leitura de `radar_empresas` (a RLS ou a linha sumiu): conta como "sem dados". */
  empresa: E | null;
}

export interface ResumoAmostra {
  total: number;
  pendentes: number;
  contatados: number;
  descartados: number;
  jaClientes: number;
  semDados: number;
  /** Pendentes fora das UFs de atuação: aparecem na fila mesmo com a região padrão. */
  pendentesForaDaAtuacao: number;
  ufsForaDaAtuacao: string[];
}

/** Denominador = o sorteio inteiro. Ninguém some do resumo: quem saiu da fila aparece no motivo. */
export function resumirAmostra(itens: ItemAmostra<LeadAmostra>[]): ResumoAmostra {
  const atuacao = new Set<string>(UFS_ATUACAO);
  const r: ResumoAmostra = {
    total: itens.length, pendentes: 0, contatados: 0, descartados: 0, jaClientes: 0, semDados: 0,
    pendentesForaDaAtuacao: 0, ufsForaDaAtuacao: [],
  };
  const ufsFora = new Set<string>();
  for (const { empresa: e } of itens) {
    if (!e) r.semDados++;
    else if (pendenteNaAmostra(e)) {
      r.pendentes++;
      if (!e.uf || !atuacao.has(e.uf)) { r.pendentesForaDaAtuacao++; ufsFora.add(e.uf ?? '?'); }
    } else if (e.prospeccao_status === 'descartado') r.descartados++;
    else if (e.prospeccao_status === 'a_contatar') r.jaClientes++;
    else r.contatados++;
  }
  r.ufsForaDaAtuacao = [...ufsFora].sort();
  return r;
}
