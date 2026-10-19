// Helpers PUROS das ações EM LOTE da tela /radar (cadastro em massa no Omie, descarte,
// tarefa, exportação). Sem I/O e sem React — o runner recebe a função de efeito por
// parâmetro. Testados em __tests__/lote.test.ts.
//
// Decisões (consult Codex de desenho, 2026-10-18):
// - Orquestração NO CLIENTE, reaproveitando a edge `criar_cliente` (anti-dup pelo CNPJ,
//   chave de integração determinística) e a RPC `radar_registrar_cadastro_omie`
//   (idempotente). Zero migration, zero deploy de edge.
// - Continua nos erros: a falha de um lead nunca derruba o lote; cada resultado é por
//   item e o usuário vê a lista de falhas com retry SÓ delas.
// - Teto por lote (TETO_LOTE) e concorrência baixa (CONCORRENCIA_LOTE): o Omie tem
//   rate-limit e a edge já faz retry com backoff; paralelismo alto só transforma
//   backoff em fila de timeouts.
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { formatarCnpj, formatarCnae, formatarCep } from './ui-helpers';

/** Máximo de leads por lote. Acima disso o resto fica de fora e a UI DIZ quantos. */
export const TETO_LOTE = 100;
/** Quantos cadastros Omie em voo ao mesmo tempo. */
export const CONCORRENCIA_LOTE = 1;

export type ResultadoItem<T, R> =
  | { item: T; status: 'ok'; valor: R }
  | { item: T; status: 'falha'; erro: string }
  | { item: T; status: 'cancelado' };

export interface OpcoesLote {
  concorrencia: number;
  /** Chamado após CADA item concluído (ok ou falha): (feitos, total). */
  onProgresso?: (feitos: number, total: number) => void;
  /** Abortar: itens ainda não iniciados saem como 'cancelado' (os em voo terminam). */
  signal?: AbortSignal;
  /**
   * Erro que PARA o lote (ex.: rate-limit persistente do Omie — insistir só alonga o
   * bloqueio). O item que lançou sai como 'falha'; os não iniciados, 'cancelado'.
   */
  pararEm?: (erro: unknown) => boolean;
}

const mensagemDe = (e: unknown): string => mensagemDeErro(e) ?? 'erro desconhecido';

/**
 * Executa `fn` sobre cada item com até `concorrencia` promessas em voo. O resultado
 * mantém a ORDEM de entrada (não a de conclusão) e NUNCA rejeita: erro vira
 * `{status:'falha', erro}` por item.
 */
export async function executarEmLote<T, R>(
  itens: readonly T[],
  fn: (item: T) => Promise<R>,
  opcoes: OpcoesLote,
): Promise<ResultadoItem<T, R>[]> {
  const total = itens.length;
  const resultados: ResultadoItem<T, R>[] = new Array(total);
  let proximo = 0;
  let feitos = 0;
  let parado = false;

  async function trabalhador(): Promise<void> {
    while (proximo < total) {
      const idx = proximo++;
      const item = itens[idx];
      if (parado || opcoes.signal?.aborted) {
        resultados[idx] = { item, status: 'cancelado' };
        continue;
      }
      try {
        const valor = await fn(item);
        resultados[idx] = { item, status: 'ok', valor };
      } catch (e) {
        resultados[idx] = { item, status: 'falha', erro: mensagemDe(e) };
        if (opcoes.pararEm?.(e)) parado = true;
      }
      feitos++;
      opcoes.onProgresso?.(feitos, total);
    }
  }

  const n = Math.max(1, Math.min(opcoes.concorrencia, total || 1));
  await Promise.all(Array.from({ length: n }, () => trabalhador()));
  return resultados;
}

export interface ResumoLote {
  total: number;
  ok: number;
  criados: number;
  ja_existiam: number;
  falhas: number;
  cancelados: number;
}

/** Agrega o lote. `jaExistia` classifica um `ok` como reconciliado (já estava no Omie). */
export function resumirLote<T, R>(
  resultados: readonly ResultadoItem<T, R>[],
  jaExistia: (valor: R) => boolean,
): ResumoLote {
  const r: ResumoLote = { total: resultados.length, ok: 0, criados: 0, ja_existiam: 0, falhas: 0, cancelados: 0 };
  for (const x of resultados) {
    if (x.status === 'ok') {
      r.ok++;
      if (jaExistia(x.valor)) r.ja_existiam++;
      else r.criados++;
    } else if (x.status === 'falha') r.falhas++;
    else r.cancelados++;
  }
  return r;
}

/** Corta a seleção no teto e devolve quantos ficaram de fora — a UI mostra o número. */
export function limitarSelecao<T>(ids: readonly T[], teto: number = TETO_LOTE): { dentro: T[]; fora: number } {
  return { dentro: ids.slice(0, teto), fora: Math.max(0, ids.length - teto) };
}

// ── Exportação CSV dos selecionados (o app não envia nada; o usuário baixa) ────────────

/** Subconjunto de `radar_empresas` que o CSV usa — estrutural, pra aceitar a Row inteira. */
export interface EmpresaCsv {
  cnpj: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  telefone1: string | null;
  telefone2: string | null;
  email: string | null;
  municipio_nome: string | null;
  uf: string | null;
  cnae_principal: string;
  cnae_descricao: string | null;
  data_abertura: string | null;
  porte: string | null;
  capital_social: number | null;
  prospeccao_status: string;
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  cep: string | null;
}

/** Célula de texto: `;`/aspas/quebra escapados e fórmula (`= + - @`) neutralizada. */
function celula(t: string | null | undefined): string {
  const s = t ?? '';
  const seguro = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[;"\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

const num2 = (n: number) => n.toFixed(2).replace('.', ',');

const CSV_CABECALHO =
  'cnpj;razao_social;nome_fantasia;telefone1;telefone2;email;municipio;uf;cnae;cnae_descricao;data_abertura;porte;capital_social;status;logradouro;numero;bairro;cep';

/** CSV `;` (Excel pt-BR). Null → célula vazia: ausente ≠ zero. */
export function csvEmpresas(empresas: readonly EmpresaCsv[]): string {
  const corpo = empresas.map((e) =>
    [
      celula(formatarCnpj(e.cnpj)),
      celula(e.razao_social),
      celula(e.nome_fantasia),
      celula(e.telefone1),
      celula(e.telefone2),
      celula(e.email),
      celula(e.municipio_nome),
      celula(e.uf),
      celula(formatarCnae(e.cnae_principal)), // pontuado = texto no Excel (zero à esquerda preservado)
      celula(e.cnae_descricao),
      celula(e.data_abertura),
      celula(e.porte),
      e.capital_social == null || !Number.isFinite(e.capital_social) ? '' : num2(e.capital_social),
      celula(e.prospeccao_status),
      celula(e.logradouro),
      celula(e.numero),
      celula(e.bairro),
      celula(formatarCep(e.cep)),
    ].join(';'),
  );
  return [CSV_CABECALHO, ...corpo].join('\n');
}
