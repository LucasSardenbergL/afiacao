import { supabase } from '@/integrations/supabase/client';
import type { MotivoRecusaParse } from '@/lib/financeiro/extrato/nucleo';

/**
 * Serviço da tela /financeiro/extrato-bancario (F1 — extrato Itaú). Valores em CENTAVOS inteiros.
 * Ausente ≠ zero: o que o banco devolve NULL fica `null` aqui (nunca `Number(null)`/`?? 0`).
 * As tabelas banco_* ainda não estão em `types.ts` (a migration da F1 não foi aplicada): o cliente é
 * estreitado em UM ponto (`db`), com a forma mínima que este serviço usa.
 */

// ── Uniões ────────────────────────────────────────────────────────────────────────────────────
/** Fonte: CHECK de banco_extrato_arquivo.status (migration F1) + 'ja_importado' (retorno de banco_extrato_registrar). */
export const STATUS_ARQUIVO = ['aceito', 'pendente_revisao', 'recusado'] as const;
export type StatusArquivo = (typeof STATUS_ARQUIVO)[number];
export type StatusImport = StatusArquivo | 'ja_importado';

/** Fonte: `v_motivo := '...'` e `'motivo', '...'` (RETURN direto) no corpo de banco_extrato_registrar (migration F1). */
export const MOTIVOS_REGISTRO = [
  'conta_desconhecida',
  'identidade_incompleta',
  'conta_divergente',
  'periodo_inclui_dia_corrente',
  'gerado_em_no_futuro',
  'dia_nao_fechado_na_geracao',
  'linha_invalida',
  'nao_fecha',
  'formato_diferente',
  'sobreposicao_divergente',
  'sem_saldo_inicial',
  'descontinuidade_saldo',
] as const;
export type MotivoRegistro = (typeof MOTIVOS_REGISTRO)[number];

/** Fonte: `MotivoRecusaParse` (núcleo) — o que a edge devolve em `erro_parse` (422). */
export const MOTIVOS_PARSE = [
  'formato_desconhecido',
  'campo_ausente',
  'valor_invalido',
  'data_invalida',
  'lancamento_nao_efetivado',
] as const satisfies readonly MotivoRecusaParse[];
export type MotivoParse = (typeof MOTIVOS_PARSE)[number];
/** Compile-time: a lista acima cobre TODA a união do núcleo (se o núcleo ganhar motivo, quebra aqui). */
const _parseCompleto: MotivoRecusaParse extends MotivoParse ? true : never = true;
void _parseCompleto;

export type MotivoExtrato = MotivoRegistro | MotivoParse;

export function textoDoMotivo(m: MotivoExtrato): string {
  switch (m) {
    case 'conta_desconhecida':
      return 'Conta bancária desconhecida: não há conta cadastrada para este arquivo.';
    case 'identidade_incompleta':
      return 'O arquivo não traz banco, agência e conta completos.';
    case 'conta_divergente':
      return 'O arquivo é de outra conta bancária, não da conta escolhida.';
    case 'periodo_inclui_dia_corrente':
      return 'O período inclui o dia de hoje, que ainda não fechou. Baixe o extrato até ontem.';
    case 'gerado_em_no_futuro':
      return 'A data de geração do arquivo está no futuro. Confira o relógio e baixe de novo.';
    case 'dia_nao_fechado_na_geracao':
      return 'O arquivo foi gerado antes de o último dia fechar. Baixe de novo depois que o dia fechar.';
    case 'linha_invalida':
      return 'Há lançamento com valor ou data inválidos no arquivo.';
    case 'nao_fecha':
      return 'Os lançamentos não fecham com os saldos do arquivo.';
    case 'formato_diferente':
      return 'O formato difere do usado nesta conta. Fica pendente de revisão.';
    case 'sobreposicao_divergente':
      return 'O período se sobrepõe a um extrato já aceito e os lançamentos divergem. Fica pendente de revisão.';
    case 'sem_saldo_inicial':
      return 'Não há saldo anterior conhecido para encadear este extrato. Fica pendente de revisão.';
    case 'descontinuidade_saldo':
      return 'O saldo inicial não bate com o saldo final do extrato anterior. Fica pendente de revisão.';
    case 'formato_desconhecido':
      return 'Formato de arquivo não reconhecido (use OFX ou CNAB 240).';
    case 'campo_ausente':
      return 'Falta um campo obrigatório no arquivo.';
    case 'valor_invalido':
      return 'O arquivo tem um valor inválido.';
    case 'data_invalida':
      return 'O arquivo tem uma data inválida.';
    case 'lancamento_nao_efetivado':
      return 'O arquivo traz lançamento ainda não efetivado.';
    default: {
      const _nunca: never = m;
      return _nunca;
    }
  }
}

/** Motivo vindo de fora (string solta): texto conhecido, ou o próprio código se for desconhecido. */
export function textoDoMotivoDesconhecido(m: string | null): string | null {
  if (m === null) return null;
  const conhecidos: readonly string[] = [...MOTIVOS_REGISTRO, ...MOTIVOS_PARSE];
  return conhecidos.includes(m) ? textoDoMotivo(m as MotivoExtrato) : `Motivo não mapeado: ${m}`;
}

// ── Tipos ─────────────────────────────────────────────────────────────────────────────────────
export interface BancoConta {
  id: string;
  company: string;
  bancoCodigo: string;
  descricao: string | null;
}

export interface ArquivoExtrato {
  id: string;
  status: StatusArquivo;
  motivo: string | null;
  periodoInicio: string;
  periodoFim: string;
  qtdLinhasNovas: number;
  enviadoEm: string;
  conferidoEm: string | null;
}

/** Um registro por dia. `coberto=false` ⇒ valores `null` ("indisponível"), nunca 0. */
export interface ResumoDia {
  data: string;
  coberto: boolean;
  creditos: number | null;
  debitos: number | null;
  saldoFinal: number | null;
  /** Foto do saldo Omie do dia (Σ das contas Omie ligadas); `null` se faltar a foto de qualquer uma. Não depende de `coberto`. */
  saldoOmie: number | null;
}

export interface RespostaImport {
  status: StatusImport;
  arquivoId: string | null;
  motivo: string | null;
  detalhe: string | null;
  qtdLinhasNovas: number | null;
}

/** Erro do fluxo de envio, com a classe que a tela usa para escolher o texto. */
export class ErroEnvioExtrato extends Error {
  constructor(
    public readonly classe: 'parse' | 'interno' | 'acesso' | 'requisicao',
    mensagem: string,
    public readonly motivo: string | null = null,
  ) {
    super(mensagem);
    this.name = 'ErroEnvioExtrato';
  }
}

// ── Acesso ao banco (cliente sem tipos das tabelas banco_*) ───────────────────────────────────
interface Resultado<T> {
  data: T | null;
  error: { message: string } | null;
}
interface ConsultaSemTipo<T> extends PromiseLike<Resultado<T>> {
  select(cols: string): ConsultaSemTipo<T>;
  eq(col: string, v: string): ConsultaSemTipo<T>;
  order(col: string, o: { ascending: boolean }): ConsultaSemTipo<T>;
  limit(n: number): ConsultaSemTipo<T>;
}
interface ClienteSemTipo {
  from<T>(tabela: string): ConsultaSemTipo<T>;
  rpc<T>(fn: string, args: Record<string, unknown>): PromiseLike<Resultado<T>>;
}
const db = supabase as unknown as ClienteSemTipo;

/** Número do banco → número, ou `null` se ausente. Nunca `Number(null)`. */
function numOuNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function falha(contexto: string, e: { message: string }): never {
  throw new Error(`${contexto}: ${e.message}`);
}

const LIMITE_ARQUIVOS = 200;

export async function listarContasBancarias(): Promise<BancoConta[]> {
  const { data, error } = await db
    .from<{ id: string; company: string; banco_codigo: string; descricao: string | null }[]>('banco_conta')
    .select('id, company, banco_codigo, descricao')
    .eq('ativo', 'true')
    .order('company', { ascending: true })
    .limit(LIMITE_ARQUIVOS);
  if (error) falha('Falha ao listar contas bancárias', error);
  return (data ?? []).map((c) => ({
    id: c.id,
    company: c.company,
    bancoCodigo: c.banco_codigo,
    descricao: c.descricao,
  }));
}

export async function listarArquivos(bancoContaId: string): Promise<ArquivoExtrato[]> {
  const { data, error } = await db
    .from<
      {
        id: string;
        status: StatusArquivo;
        motivo: string | null;
        periodo_inicio: string;
        periodo_fim: string;
        qtd_linhas_novas: number;
        enviado_em: string;
        conferido_em: string | null;
      }[]
    >('banco_extrato_arquivo')
    .select('id, status, motivo, periodo_inicio, periodo_fim, qtd_linhas_novas, enviado_em, conferido_em')
    .eq('banco_conta_id', bancoContaId)
    .order('enviado_em', { ascending: false })
    .limit(LIMITE_ARQUIVOS);
  if (error) falha('Falha ao listar arquivos do extrato', error);
  return (data ?? []).map((a) => ({
    id: a.id,
    status: a.status,
    motivo: a.motivo,
    periodoInicio: a.periodo_inicio,
    periodoFim: a.periodo_fim,
    qtdLinhasNovas: a.qtd_linhas_novas,
    enviadoEm: a.enviado_em,
    conferidoEm: a.conferido_em,
  }));
}

export async function resumoDia(bancoContaId: string, de: string, ate: string): Promise<ResumoDia[]> {
  const { data, error } = await db.rpc<
    {
      data: string;
      coberto: boolean;
      creditos_centavos: number | string | null;
      debitos_centavos: number | string | null;
      saldo_final_dia_centavos: number | string | null;
      saldo_omie_centavos: number | string | null;
    }[]
  >('banco_extrato_resumo_dia', { p_banco_conta_id: bancoContaId, p_de: de, p_ate: ate });
  if (error) falha('Falha ao carregar o resumo diário', error);
  return (data ?? []).map((r) => ({
    data: r.data,
    coberto: r.coberto === true,
    creditos: r.coberto === true ? numOuNull(r.creditos_centavos) : null,
    debitos: r.coberto === true ? numOuNull(r.debitos_centavos) : null,
    saldoFinal: r.coberto === true ? numOuNull(r.saldo_final_dia_centavos) : null,
    saldoOmie: numOuNull(r.saldo_omie_centavos),
  }));
}

export async function marcarConferido(arquivoId: string): Promise<void> {
  const { error } = await db.rpc<null>('banco_extrato_marcar_conferido', { p_arquivo_id: arquivoId });
  if (error) falha('Falha ao marcar como conferido', error);
}

// ── Envio ─────────────────────────────────────────────────────────────────────────────────────
function extensaoDe(nome: string): string {
  const i = nome.lastIndexOf('.');
  const ext = i >= 0 ? nome.slice(i + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin';
}

async function corpoDoErro(err: unknown): Promise<Record<string, unknown> | null> {
  const ctx = (err as { context?: unknown } | null)?.context;
  if (!ctx || typeof (ctx as Response).clone !== 'function') return null;
  try {
    const parsed: unknown = await (ctx as Response).clone().json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function statusHttp(err: unknown): number | null {
  const st = ((err as { context?: unknown } | null)?.context as { status?: unknown } | undefined)?.status;
  return typeof st === 'number' ? st : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Best-effort: nunca lança nem esconde o erro original que motivou a limpeza. */
async function removerObjetoOrfao(storagePath: string): Promise<void> {
  try {
    await supabase.storage.from('banco-extratos').remove([storagePath]);
  } catch {
    // órfão no bucket é aceitável; o erro que a tela mostra é o da edge
  }
}

/** Sobe o arquivo ao bucket (path `{conta}/{uuid}.{ext}`) e chama a edge. 422 → erro `parse`; 500 → `interno`. */
export async function enviarExtrato(file: File, conta: Pick<BancoConta, 'id'>): Promise<RespostaImport> {
  const storagePath = `${conta.id}/${crypto.randomUUID()}.${extensaoDe(file.name)}`;
  const up = await supabase.storage.from('banco-extratos').upload(storagePath, file, { upsert: false });
  if (up.error) throw new ErroEnvioExtrato('requisicao', `Falha ao enviar o arquivo: ${up.error.message}`);

  const { data, error } = await supabase.functions.invoke('banco-extrato-importar', {
    body: { storage_path: storagePath, banco_conta_id: conta.id },
  });
  if (error) {
    const corpo = await corpoDoErro(error);
    const st = statusHttp(error);
    const ep = corpo?.erro_parse;
    if (st === 422 && ep && typeof ep === 'object') {
      const m = str((ep as Record<string, unknown>).motivo);
      throw new ErroEnvioExtrato('parse', str((ep as Record<string, unknown>).detalhe) ?? 'Arquivo inválido', m);
    }
    // 400/401/403/404: a edge recusou ANTES de processar — o objeto recém-enviado fica órfão, tenta-se removê-lo.
    // 422/500 não removem: a edge pode ter registrado o arquivo e o objeto é a evidência.
    if (st === 400 || st === 401 || st === 403 || st === 404) await removerObjetoOrfao(storagePath);
    if (st === 401 || st === 403) {
      throw new ErroEnvioExtrato('acesso', 'Sem permissão para importar extrato bancário nesta conta.');
    }
    if (st === 400 || st === 404) {
      throw new ErroEnvioExtrato('requisicao', str(corpo?.erro) ?? 'Requisição inválida.');
    }
    // 500, erro de rede ou corpo ilegível: falha interna (não é "arquivo recusado").
    throw new ErroEnvioExtrato('interno', str(corpo?.erro) ?? error.message);
  }
  const r = (data ?? {}) as Record<string, unknown>;
  const status = str(r.status);
  if (status !== 'aceito' && status !== 'pendente_revisao' && status !== 'recusado' && status !== 'ja_importado') {
    throw new ErroEnvioExtrato('interno', 'Resposta da edge sem status reconhecido.');
  }
  return {
    status,
    arquivoId: str(r.arquivo_id),
    motivo: str(r.motivo),
    detalhe: str(r.detalhe),
    qtdLinhasNovas: numOuNull(r.qtd_linhas_novas),
  };
}
