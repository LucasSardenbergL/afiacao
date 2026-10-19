#!/usr/bin/env bun
/**
 * Escolhe o MÊS-ALVO da carga do Radar (GitHub Action `radar-carga-mensal`, que SONDA toda semana e
 * CARREGA no máximo um mês por rodada).
 *
 * Uso: bun scripts/radar/mes-alvo.ts [--mes YYYY-MM] [--forcar] [--agora <ISO>]
 * Env: RADAR_INGEST_URL + RADAR_CRON_SECRET (consulta `{action:'status'}` da edge radar-ingest).
 * Saída: linha `mes=YYYY-MM` (ou `mes=` = nada a fazer) no stdout E em $GITHUB_OUTPUT quando existe.
 * Exit: 0 = decidiu (com ou sem mês); 1 = não conseguiu decidir (sonda/status com erro — NUNCA vira
 *       "nada a fazer" verde: 429/5xx/timeout é ausência de dado, não ausência de mês).
 *
 * Regras (parecer Codex de desenho, 2026-10-18 — P0 "regressão de mês" e P1 "pula mês em silêncio"):
 *   • candidatos = janela de 3 meses [M-2, M-1, M] (horário de Brasília), do MAIS ANTIGO para o mais novo:
 *     publicação atrasada ou rodada perdida não faz um mês sumir — ele entra na próxima semana;
 *   • NUNCA regride: mês ≤ último lote `complete` é descartado (sobrescreveria `ultimo_lote` com foto
 *     mais velha). `--forcar` só releva o `complete` do PRÓPRIO mês pedido, nunca a regressão;
 *   • lote `running` iniciado há < 8 h = outra carga em andamento (ex.: local) → não escolhe;
 *   • mês indisponível na RFB (HEAD 404 em Cnaes.zip) → pula; qualquer outro status ≠ 200 → erro.
 */
import { appendFileSync } from "node:fs";
import { ARQUIVO_SONDA, authorizationDe, basesCandidatas } from "./rfb";

export type StatusLote = "running" | "complete" | "error";
export interface Lote { mes_referencia: string; status: StatusLote; iniciado_em: string | null }
export type Disponibilidade = "disponivel" | "indisponivel";

const MES_RE = /^\d{4}-\d{2}$/;
const HORAS_LOTE_VIVO = 8;

/** Mês civil de `agora` em Brasília, deslocado `delta` meses (negativo = passado). */
export const mesBr = (agora: Date, delta = 0): string => {
  const sp = new Date(agora.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const d = new Date(Date.UTC(sp.getFullYear(), sp.getMonth() + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/** Janela [M-2, M-1, M], do mais antigo para o mais novo. */
export const candidatosDe = (agora: Date): string[] => [mesBr(agora, -2), mesBr(agora, -1), mesBr(agora, 0)];

export interface Decisao { mes: string | null; motivos: string[] }

/** Decisão PURA (testável): recebe o que a sonda e o status devolveram. */
export const escolherMes = (p: {
  candidatos: string[];
  disponivel: (mes: string) => Disponibilidade;
  lotes: Lote[];
  forcar: boolean;
  agora: Date;
}): Decisao => {
  const motivos: string[] = [];
  const completos = p.lotes.filter((l) => l.status === "complete").map((l) => l.mes_referencia);
  const ultimoCompleto = completos.length ? completos.sort().at(-1)! : null;
  for (const mes of [...p.candidatos].sort()) {
    const lote = p.lotes.find((l) => l.mes_referencia === mes);
    if (ultimoCompleto && mes < ultimoCompleto) { motivos.push(`${mes}: regressão (último lote complete é ${ultimoCompleto})`); continue; }
    if (lote?.status === "complete" && !p.forcar) { motivos.push(`${mes}: já complete`); continue; }
    if (lote?.status === "running" && lote.iniciado_em
        && p.agora.getTime() - new Date(lote.iniciado_em).getTime() < HORAS_LOTE_VIVO * 3_600_000) {
      motivos.push(`${mes}: lote running iniciado há < ${HORAS_LOTE_VIVO} h (outra carga em andamento?)`); continue;
    }
    if (p.disponivel(mes) === "indisponivel") { motivos.push(`${mes}: ainda não publicado pela RFB`); continue; }
    return { mes, motivos };
  }
  return { mes: null, motivos };
};

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true"));
  }
  const agora = args.get("agora") ? new Date(args.get("agora")!) : new Date();
  const forcar = args.get("forcar") === "true";
  const mesPedido = (args.get("mes") ?? "").trim();
  if (mesPedido && mesPedido !== "true" && !MES_RE.test(mesPedido)) { console.error(`--mes inválido: ${mesPedido}`); process.exit(1); }
  const INGEST_URL = process.env.RADAR_INGEST_URL ?? "";
  const SECRET = process.env.RADAR_CRON_SECRET ?? "";
  if (!INGEST_URL || !SECRET) { console.error("RADAR_INGEST_URL e RADAR_CRON_SECRET obrigatórios"); process.exit(1); }

  const sondar = async (mes: string): Promise<Disponibilidade> => {
    let ultimo = "";
    for (const base of basesCandidatas(mes)) {
      try {
        const r = await fetch(`${base}/${ARQUIVO_SONDA}`, { method: "HEAD", headers: authorizationDe(base), signal: AbortSignal.timeout(30_000) });
        if (r.status === 200) return "disponivel";
        ultimo = `${base} → HTTP ${r.status}`;
        if (r.status !== 404) throw new Error(`sonda da RFB respondeu ${r.status} para ${mes} (${base}) — não é "indisponível", é erro`);
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("sonda da RFB")) throw e;
        ultimo = `${base} → ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    console.log(`   ${mes}: indisponível (${ultimo})`);
    return "indisponivel";
  };

  const r = await fetch(INGEST_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": SECRET },
    body: JSON.stringify({ action: "status" }), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) { console.error(`radar-ingest status falhou: HTTP ${r.status} ${await r.text()}`); process.exit(1); }
  const lotes = (((await r.json()) as { lotes?: Lote[] }).lotes ?? []);
  console.log(`lotes conhecidos: ${lotes.map((l) => `${l.mes_referencia}=${l.status}`).join(", ") || "nenhum"}`);

  const candidatos = mesPedido && mesPedido !== "true" ? [mesPedido] : candidatosDe(agora);
  // Sonda só os meses que a regra ainda não descartou (uma função pura decide; a sonda é preguiçosa).
  const cache = new Map<string, Disponibilidade>();
  const disponivelAsync = async (mes: string) => { if (!cache.has(mes)) cache.set(mes, await sondar(mes)); return cache.get(mes)!; };
  // Pré-sonda sequencial (a decisão pura é síncrona): candidatos em ordem, parando no 1º escolhível.
  for (const mes of [...candidatos].sort()) await disponivelAsync(mes);
  const decisao = escolherMes({ candidatos, disponivel: (m) => cache.get(m) ?? "indisponivel", lotes, forcar, agora });
  for (const m of decisao.motivos) console.log(`   ${m}`);
  const linha = `mes=${decisao.mes ?? ""}`;
  console.log(decisao.mes ? `🎯 ${linha}` : `🏁 nada a fazer (${linha})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${linha}\n`);
}
