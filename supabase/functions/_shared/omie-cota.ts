// Trava compartilhada por (conta, método) do Omie — o lado das edges.
// Banco: supabase/migrations/20261010204708_omie_cota_metodo.sql (prova: db/test-omie-cota-metodo.sh)
// Spec: docs/superpowers/specs/2026-10-10-picking-v2-design.md §3.6.1 (Fase 0.2)
//
// O Omie trava o MÉTODO por app_key. Quatro edges chamam `ListarPedidos` (vendas-sync,
// sync-reprocess, omie-desconto-backfill, picking-fila-omie), cada uma no seu cron. Antes daqui,
// cada uma decidia sozinha — e o vendas-sync re-tentava o REDUNDANT com espera limitada a 15 s
// mesmo quando o Omie pedia mais, o que renova a trava e escala para "bloqueada por consumo
// indevido" (~30 min). Agora: pede a vez no banco, respeita o "aguarde" que QUALQUER edge
// registrou, e registra o seu.
//
// FAIL-CLOSED (revisão Codex, 2026-10-10): sem resposta da trava, a chamada coordenada NÃO é feita
// — lança `CotaOmieIndisponivel` e o consumidor adia, como já adia um rate-limit. Fail-open
// desligaria a proteção calado justamente quando ela não funciona (RPC ausente, grant errado).
// Toda RPC da trava tem prazo próprio: banco pendurado não pendura a edge.
// Só o que é coordenado passa por aqui: os outros métodos seguem exatamente como eram.
import { mensagemDeErro } from "./erro-mensagem.ts";

/** Métodos coordenados pela trava. Só leitura com mais de um consumidor em cron — nada de escrita. */
const METODOS_COORDENADOS: ReadonlySet<string> = new Set(["ListarPedidos"]);

export function metodoCoordenado(metodo: string): boolean {
  return METODOS_COORDENADOS.has(metodo);
}

/**
 * Timeout da chamada coordenada ao Omie. O lease (abaixo) é maior: abortar o fetch não prova que o
 * Omie parou de processar, então quem estoura o timeout NÃO devolve a vez — o lease vence sozinho.
 */
const TIMEOUT_CHAMADA_COORDENADA_MS = 80_000;
/** Lease de quem chama: timeout da chamada + folga para o Omie terminar o que já recebeu. */
const LEASE_PADRAO_S = 150;
/** Prazo de cada RPC da trava. */
const PRAZO_RPC_MS = 5_000;
/** "Bloqueada por consumo indevido" sem prazo legível: o Omie documenta ~30 min. */
const BLOQUEIO_INDEVIDO_PADRAO_S = 30 * 60;
/** Margem somada ao "Aguarde N segundos" — relógio do Omie × o nosso. */
const MARGEM_AGUARDE_S = 2;

export type FaultCota =
  /** "Consumo redundante detectado. Aguarde N segundos (REDUNDANT)". */
  | { tipo: "redundante"; segundos: number }
  /** "API bloqueada por consumo indevido" — a escalada do REDUNDANT. */
  | { tipo: "bloqueio"; segundos: number }
  /** "Já existe uma requisição desse método" — concorrência, sem prazo do Omie. */
  | { tipo: "concorrente" };

function segundosAguarde(fault: string): number | null {
  const m = fault.match(/aguarde\s+(\d+)\s*segundo/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function minutosAguarde(fault: string): number | null {
  const m = fault.match(/(\d+)\s*minuto/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Classifica uma `faultstring` do Omie quanto à trava. `null` = não é assunto da trava
 * (erro de dado, "não existem registros", SOAP etc.).
 */
export function classificarFaultCota(fault: string): FaultCota | null {
  const f = fault.toLowerCase();
  if (f.includes("consumo indevido") || f.includes("api bloqueada")) {
    const min = minutosAguarde(fault);
    const s = segundosAguarde(fault);
    const segundos = min !== null ? min * 60 : s !== null ? s : BLOQUEIO_INDEVIDO_PADRAO_S;
    return { tipo: "bloqueio", segundos: Math.min(segundos + MARGEM_AGUARDE_S, 7200) };
  }
  if (f.includes("consumo redundante") || fault.includes("REDUNDANT")) {
    // Sem prazo legível, o REDUNDANT é tratado pelo pior caso conhecido do Omie para não chamar
    // cedo — chamar cedo é exatamente o que escala para o bloqueio.
    const s = segundosAguarde(fault) ?? 60;
    return { tipo: "redundante", segundos: Math.min(s + MARGEM_AGUARDE_S, 7200) };
  }
  if (f.includes("já existe uma requisição desse método") || f.includes("ja existe uma requisicao desse metodo")) {
    return { tipo: "concorrente" };
  }
  return null;
}

/** O mínimo do cliente Supabase que a trava usa (injetável em teste). */
export interface ClienteCota {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export type Conta = "oben" | "colacor";

export type Vez =
  | { tipo: "livre" }
  | { tipo: "bloqueado"; ate: string | null }
  | { tipo: "ocupado"; ate: string | null }
  /** A trava não respondeu (erro, prazo, forma inesperada) — fail-closed: a chamada não é feita. */
  | { tipo: "sem_trava"; erro: string };

/** Lê a linha devolvida por `omie_cota_tentar` (RETURNS TABLE → array de 1). */
export function lerVez(data: unknown): Vez {
  const linha = Array.isArray(data) ? data[0] : data;
  if (linha === null || typeof linha !== "object") {
    return { tipo: "sem_trava", erro: "omie_cota_tentar devolveu resposta sem linha" };
  }
  const r = linha as Record<string, unknown>;
  const ate = typeof r.ate === "string" ? r.ate : null;
  if (r.ok === true && r.motivo === "livre") return { tipo: "livre" };
  if (r.ok === false && r.motivo === "bloqueado") return { tipo: "bloqueado", ate };
  if (r.ok === false && r.motivo === "ocupado") return { tipo: "ocupado", ate };
  return { tipo: "sem_trava", erro: `omie_cota_tentar devolveu forma inesperada: ${JSON.stringify(r).slice(0, 120)}` };
}

/**
 * RPC com prazo: banco pendurado vira erro em `prazoMs`, nunca uma espera sem fim. Recebe a
 * chamada JÁ montada (`() => db.rpc("<nome literal>", …)`): o pré-voo de deploy
 * (`scripts/edge-rpcs.ts`) só enxerga RPC de nome literal — `db.rpc(fn, args)` aqui deixava a lista
 * de dependências das 4 edges incompleta e o `pendencias:pacote` recusava a leva (exit 3).
 */
async function rpcComPrazo(
  fn: string,
  chamar: () => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  prazoMs: number,
): Promise<{ data: unknown; erro: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${fn} sem resposta em ${prazoMs} ms`)), prazoMs);
  });
  try {
    const { data, error } = await Promise.race([Promise.resolve(chamar()), prazo]);
    return { data, erro: error ? (mensagemDeErro(error) ?? `${fn} falhou sem mensagem`) : null };
  } catch (e) {
    return { data: null, erro: mensagemDeErro(e) ?? `${fn} falhou sem mensagem` };
  } finally {
    clearTimeout(timer);
  }
}

async function pedirVez(
  db: ClienteCota,
  conta: Conta,
  metodo: string,
  token: string,
  opts: { leaseSegundos?: number; prazoRpcMs?: number } = {},
): Promise<Vez> {
  const { data, erro } = await rpcComPrazo("omie_cota_tentar", () =>
    db.rpc("omie_cota_tentar", {
      p_conta: conta,
      p_metodo: metodo,
      p_token: token,
      p_lease_segundos: opts.leaseSegundos ?? LEASE_PADRAO_S,
    }), opts.prazoRpcMs ?? PRAZO_RPC_MS);
  if (erro) return { tipo: "sem_trava", erro };
  return lerVez(data);
}

/** Devolve a vez. Nunca lança: o lease vence sozinho. */
async function devolverVez(
  db: ClienteCota,
  conta: Conta,
  metodo: string,
  token: string,
  prazoRpcMs = PRAZO_RPC_MS,
): Promise<void> {
  const { erro } = await rpcComPrazo("omie_cota_liberar", () =>
    db.rpc("omie_cota_liberar", { p_conta: conta, p_metodo: metodo, p_token: token }), prazoRpcMs);
  if (erro) console.warn(`[omie-cota][${conta}] liberar ${metodo} falhou (o lease vence sozinho): ${erro}`);
}

/**
 * Registra o "aguarde" do Omie para todas as edges. Nunca lança. Só faults com prazo.
 * Devolve se o prazo ficou CONFIRMADO no banco (fault sem prazo = nada a registrar = true).
 */
async function registrarFault(
  db: ClienteCota,
  conta: Conta,
  metodo: string,
  fault: FaultCota,
  texto: string,
  prazoRpcMs = PRAZO_RPC_MS,
): Promise<boolean> {
  if (fault.tipo === "concorrente") return true;
  const { erro } = await rpcComPrazo("omie_cota_registrar_fault", () =>
    db.rpc("omie_cota_registrar_fault", {
      p_conta: conta,
      p_metodo: metodo,
      p_bloqueio_segundos: Math.max(1, Math.ceil(fault.segundos)),
      p_fault: texto.slice(0, 300),
    }), prazoRpcMs);
  if (erro) {
    console.warn(`[omie-cota][${conta}] registrar fault ${metodo} falhou (a vez fica retida até o lease vencer): ${erro}`);
    return false;
  }
  return true;
}

/** "Não é a sua vez" — a chamada NÃO foi feita. Quem chama trata como o rate-limit que já tratava. */
export class CotaOmieIndisponivel extends Error {
  constructor(
    readonly conta: Conta,
    readonly metodo: string,
    readonly motivo: "bloqueado" | "ocupado" | "sem_trava",
    readonly ate: string | null,
    detalhe?: string,
  ) {
    super(
      `OMIE_COTA (${conta}): ${metodo} ${motivo}${ate ? ` até ${ate}` : ""}${detalhe ? ` (${detalhe})` : ""} — chamada não feita`,
    );
    this.name = "CotaOmieIndisponivel";
  }
}

/** Quanto esperar por uma vez negada antes de pedir de novo (ms), ou null = desistir agora. */
export function esperaAte(ate: string | null, agoraMs: number, tetoMs: number): number | null {
  const fim = ate ? Date.parse(ate) : NaN;
  const ms = Number.isFinite(fim) ? Math.max(250, fim - agoraMs + 250) : 2_000;
  return ms <= tetoMs ? ms : null;
}

export interface OpcoesVez {
  tetoEsperaMs?: number;
  tentativas?: number;
  prazoRpcMs?: number;
  esperar?: (ms: number) => Promise<void>;
  agora?: () => number;
}

/**
 * Pede a vez, esperando só prazo curto (≤ `tetoEsperaMs`). Devolve o token, ou lança
 * `CotaOmieIndisponivel` (vez negada, prazo longo, ou trava sem resposta — fail-closed).
 */
export async function obterVez(db: ClienteCota, conta: Conta, metodo: string, opts: OpcoesVez = {}): Promise<string> {
  const token = crypto.randomUUID();
  const tentativas = opts.tentativas ?? 3;
  const tetoEsperaMs = opts.tetoEsperaMs ?? 20_000;
  const esperar = opts.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const agora = opts.agora ?? (() => Date.now());
  for (let i = 0; ; i++) {
    const vez = await pedirVez(db, conta, metodo, token, { prazoRpcMs: opts.prazoRpcMs });
    if (vez.tipo === "livre") return token;
    if (vez.tipo === "sem_trava") throw new CotaOmieIndisponivel(conta, metodo, "sem_trava", null, vez.erro);
    // Prazo curto (o "aguarde 5 s" do REDUNDANT, ou outra edge no meio de UMA chamada) cabe na
    // invocação: espera o prazo INTEIRO e pede de novo. Prazo longo: desiste sem chamar.
    const ms = esperaAte(vez.ate, agora(), tetoEsperaMs);
    if (ms === null || i + 1 >= tentativas) throw new CotaOmieIndisponivel(conta, metodo, vez.tipo, vez.ate);
    await esperar(ms);
  }
}

/** O fetch abortou por prazo: o Omie pode seguir processando — não devolver a vez. */
function estourouPrazo(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
}

/**
 * Executa UMA chamada ao Omie com a vez: pede (com espera curta), roda `chamar`, devolve a vez —
 * também quando `chamar` lança, EXCETO por timeout ou "aguarde" não registrado (aí o lease vence
 * sozinho). Se o texto de
 * `faultDe` (ou do erro lançado) for de trava, registra o prazo para todas as edges.
 * Método não coordenado ou `db` null (sem env, teste local): só roda `chamar`.
 */
export async function comVezOmie<T>(
  db: ClienteCota | null,
  conta: Conta,
  metodo: string,
  chamar: () => Promise<T>,
  faultDe: (r: T) => string | null,
  opts: OpcoesVez = {},
): Promise<T> {
  if (!db || !metodoCoordenado(metodo)) return await chamar();
  const token = await obterVez(db, conta, metodo, opts);
  let devolver = true;
  // "Aguarde" do Omie que NÃO ficou registrado no banco: devolver a vez deixaria a próxima edge
  // chamar já — exatamente o que escala o REDUNDANT. A vez fica retida e o lease (150 s) faz as
  // vezes do prazo (revisão Codex, rodada 2).
  const registrar = async (texto: string | null) => {
    const fault = texto ? classificarFaultCota(texto) : null;
    if (fault && texto && !(await registrarFault(db, conta, metodo, fault, texto, opts.prazoRpcMs))) devolver = false;
  };
  try {
    const r = await chamar();
    await registrar(faultDe(r));
    return r;
  } catch (e) {
    if (estourouPrazo(e)) devolver = false;
    await registrar(mensagemDeErro(e));
    throw e;
  } finally {
    if (devolver) await devolverVez(db, conta, metodo, token, opts.prazoRpcMs);
  }
}

/** `signal` da chamada coordenada (timeout menor que o lease); `undefined` para as outras. */
export function sinalDaChamada(metodo: string): AbortSignal | undefined {
  return metodoCoordenado(metodo) ? AbortSignal.timeout(TIMEOUT_CHAMADA_COORDENADA_MS) : undefined;
}

/**
 * Cliente service_role da trava, criado uma vez por isolate a partir do env. `null` = sem env
 * (teste local): a chamada segue sem trava. `criar` = o `createClient` da edge (o _shared não
 * importa o supabase-js).
 */
export function clienteCotaDoAmbiente(
  criar: (url: string, chave: string) => ClienteCota,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): () => ClienteCota | null {
  let cache: ClienteCota | null | undefined;
  return () => {
    if (cache !== undefined) return cache;
    const url = env("SUPABASE_URL");
    const chave = env("SUPABASE_SERVICE_ROLE_KEY");
    cache = url && chave ? criar(url, chave) : null;
    return cache;
  };
}
