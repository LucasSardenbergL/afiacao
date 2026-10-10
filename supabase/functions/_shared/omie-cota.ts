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
// Fail-open: se o banco não responde, a chamada segue como era antes (a trava reduz colisão; não
// é condição de correção de dado). Sem I/O próprio — o cliente vem de quem chama.

/** Métodos coordenados pela trava. Só o que tem mais de um consumidor em cron. */
export const METODOS_COORDENADOS: ReadonlySet<string> = new Set(["ListarPedidos"]);

export function metodoCoordenado(metodo: string): boolean {
  return METODOS_COORDENADOS.has(metodo);
}

/** Lease de quem chama. Cobre o timeout de uma chamada ao Omie com folga; renovável pelo mesmo token. */
export const LEASE_PADRAO_S = 90;
/** "Bloqueada por consumo indevido" sem prazo legível: o Omie documenta ~30 min. */
export const BLOQUEIO_INDEVIDO_PADRAO_S = 30 * 60;
/** Margem somada ao "Aguarde N segundos" — relógio do Omie × o nosso. */
export const MARGEM_AGUARDE_S = 2;

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
  /** O banco não respondeu — fail-open: quem chama segue para o Omie. */
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

export async function pedirVez(
  db: ClienteCota,
  conta: Conta,
  metodo: string,
  token: string,
  leaseSegundos = LEASE_PADRAO_S,
): Promise<Vez> {
  try {
    const { data, error } = await db.rpc("omie_cota_tentar", {
      p_conta: conta,
      p_metodo: metodo,
      p_token: token,
      p_lease_segundos: leaseSegundos,
    });
    if (error) return { tipo: "sem_trava", erro: error.message };
    return lerVez(data);
  } catch (e) {
    return { tipo: "sem_trava", erro: e instanceof Error ? e.message : String(e) };
  }
}

/** Devolve a vez. Nunca lança: o lease vence sozinho. */
export async function devolverVez(db: ClienteCota, conta: Conta, metodo: string, token: string): Promise<void> {
  try {
    const { error } = await db.rpc("omie_cota_liberar", { p_conta: conta, p_metodo: metodo, p_token: token });
    if (error) console.warn(`[omie-cota][${conta}] liberar ${metodo} falhou: ${error.message}`);
  } catch (e) {
    console.warn(`[omie-cota][${conta}] liberar ${metodo} falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Registra o "aguarde" do Omie para todas as edges. Nunca lança. Só faults com prazo. */
export async function registrarFault(
  db: ClienteCota,
  conta: Conta,
  metodo: string,
  fault: FaultCota,
  texto: string,
): Promise<void> {
  if (fault.tipo === "concorrente") return;
  try {
    const { error } = await db.rpc("omie_cota_registrar_fault", {
      p_conta: conta,
      p_metodo: metodo,
      p_bloqueio_segundos: Math.max(1, Math.ceil(fault.segundos)),
      p_fault: texto.slice(0, 300),
    });
    if (error) console.warn(`[omie-cota][${conta}] registrar fault ${metodo} falhou: ${error.message}`);
  } catch (e) {
    console.warn(`[omie-cota][${conta}] registrar fault ${metodo} falhou: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Erro de "não é a sua vez" — quem chama trata como o rate-limit persistente que já tratava. */
export class CotaOmieIndisponivel extends Error {
  constructor(
    readonly conta: Conta,
    readonly metodo: string,
    readonly motivo: "bloqueado" | "ocupado",
    readonly ate: string | null,
  ) {
    super(`OMIE_COTA (${conta}): ${metodo} ${motivo} até ${ate ?? "?"} — chamada não feita`);
    this.name = "CotaOmieIndisponivel";
  }
}

/** Quanto esperar por uma vez negada antes de pedir de novo (ms), ou null = desistir agora. */
export function esperaAte(ate: string | null, agoraMs: number, tetoMs: number): number | null {
  const fim = ate ? Date.parse(ate) : NaN;
  const ms = Number.isFinite(fim) ? Math.max(250, fim - agoraMs + 250) : 2_000;
  return ms <= tetoMs ? ms : null;
}

/**
 * Pede a vez, esperando só prazo curto (≤ `tetoEsperaMs`). Devolve o token se conseguiu a vez,
 * `null` se o banco não respondeu (fail-open) — ou lança `CotaOmieIndisponivel`.
 */
export async function obterVez(
  db: ClienteCota,
  conta: Conta,
  metodo: string,
  opts: { tetoEsperaMs?: number; tentativas?: number; esperar?: (ms: number) => Promise<void>; agora?: () => number } = {},
): Promise<string | null> {
  const token = crypto.randomUUID();
  const tentativas = opts.tentativas ?? 3;
  const tetoEsperaMs = opts.tetoEsperaMs ?? 20_000;
  const esperar = opts.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const agora = opts.agora ?? (() => Date.now());
  for (let i = 0; ; i++) {
    const vez = await pedirVez(db, conta, metodo, token);
    if (vez.tipo === "livre") return token;
    if (vez.tipo === "sem_trava") {
      console.warn(`[omie-cota][${conta}] ${metodo} sem trava (fail-open): ${vez.erro}`);
      return null;
    }
    // Prazo curto (o "aguarde 5 s" do REDUNDANT, ou outra edge no meio de UMA chamada) cabe na
    // invocação: espera o prazo INTEIRO e pede de novo. Prazo longo: desiste sem chamar.
    const ms = esperaAte(vez.ate, agora(), tetoEsperaMs);
    if (ms === null || i + 1 >= tentativas) throw new CotaOmieIndisponivel(conta, metodo, vez.tipo, vez.ate);
    await esperar(ms);
  }
}

/**
 * Executa UMA chamada ao Omie com a vez: pede (com espera curta), roda `chamar`, devolve a vez —
 * também quando `chamar` lança. Se o texto devolvido por `faultDe` for de trava, registra o prazo
 * para todas as edges. Método não coordenado: só roda `chamar`.
 */
export async function comVezOmie<T>(
  db: ClienteCota | null,
  conta: Conta,
  metodo: string,
  chamar: () => Promise<T>,
  faultDe: (r: T) => string | null,
  opts: Parameters<typeof obterVez>[3] = {},
): Promise<T> {
  if (!db || !metodoCoordenado(metodo)) return await chamar();
  const token = await obterVez(db, conta, metodo, opts);
  try {
    const r = await chamar();
    const texto = faultDe(r);
    const fault = texto ? classificarFaultCota(texto) : null;
    if (fault && texto) await registrarFault(db, conta, metodo, fault, texto);
    return r;
  } catch (e) {
    const texto = e instanceof Error ? e.message : String(e);
    const fault = classificarFaultCota(texto);
    if (fault) await registrarFault(db, conta, metodo, fault, texto);
    throw e;
  } finally {
    if (token) await devolverVez(db, conta, metodo, token);
  }
}

/**
 * Cliente service_role da trava, criado uma vez por isolate a partir do env. `null` = sem env
 * (teste local): a chamada segue sem trava, como antes da Fase 0.2. `criar` = o `createClient`
 * da edge (o _shared não importa o supabase-js).
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
