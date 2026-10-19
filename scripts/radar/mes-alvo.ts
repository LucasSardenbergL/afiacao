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
 *   • NUNCA regride: mês < o lote mais NOVO conhecido (qualquer status — os chunks escrevem `ultimo_lote`
 *     direto, então até um lote `error` já pode ter foto mais nova no acervo) é descartado. `--forcar`
 *     só releva o `complete` do PRÓPRIO mês pedido, nunca a regressão. O `status` da edge devolve os 3
 *     lotes mais novos: o mais novo de todos está sempre lá, então a régua não depende do histórico inteiro;
 *   • QUALQUER lote `running` iniciado há < 8 h = outra carga em andamento (ex.: local) → NADA é escolhido
 *     (dois escritores em meses diferentes disputam o mesmo `ultimo_lote`);
 *   • mês indisponível na RFB = TODAS as bases responderam 404 ao HEAD em Cnaes.zip; timeout/5xx/429 em
 *     qualquer base sem nenhum 200 → erro (transporte não vira "não publicado");
 *   • só sonda os meses que passaram pelas guardas, do mais antigo para o mais novo, parando no 1º disponível.
 */
import { appendFileSync } from "node:fs";
import { mensagemDeErro } from "../../src/lib/erro-mensagem";
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

/** O que a sonda de UM mês concluiu a partir das respostas de cada base (pura, testável). */
export type RespostaSonda = { tipo: "http"; status: number } | { tipo: "erro"; detalhe: string };
export const concluirSonda = (mes: string, respostas: RespostaSonda[]): Disponibilidade => {
  if (respostas.some((r) => r.tipo === "http" && r.status === 200)) return "disponivel";
  const ruins = respostas.filter((r) => !(r.tipo === "http" && r.status === 404));
  if (ruins.length > 0) {
    const d = ruins.map((r) => (r.tipo === "http" ? `HTTP ${r.status}` : r.detalhe)).join("; ");
    throw new Error(`sonda da RFB para ${mes} sem resposta conclusiva (${d}) — transporte não é "não publicado"`);
  }
  return "indisponivel";
};

const loteVivo = (l: Lote, agora: Date): boolean =>
  l.status === "running" && !!l.iniciado_em && agora.getTime() - new Date(l.iniciado_em).getTime() < HORAS_LOTE_VIVO * 3_600_000;

/** Decisão (testável): recebe o status dos lotes e uma sonda preguiçosa, chamada só para quem passou pelas guardas. */
export const escolherMes = async (p: {
  candidatos: string[];
  disponivel: (mes: string) => Promise<Disponibilidade> | Disponibilidade;
  lotes: Lote[];
  forcar: boolean;
  agora: Date;
}): Promise<Decisao> => {
  const motivos: string[] = [];
  const vivo = p.lotes.find((l) => loteVivo(l, p.agora));
  if (vivo) {
    motivos.push(`${vivo.mes_referencia}: lote running iniciado há < ${HORAS_LOTE_VIVO} h (outra carga em andamento) — nenhum mês é escolhido`);
    return { mes: null, motivos };
  }
  const conhecidos = p.lotes.map((l) => l.mes_referencia).sort();
  const maisNovoConhecido = conhecidos.at(-1) ?? null;
  for (const mes of [...p.candidatos].sort()) {
    const lote = p.lotes.find((l) => l.mes_referencia === mes);
    if (maisNovoConhecido && mes < maisNovoConhecido) { motivos.push(`${mes}: regressão (lote mais novo conhecido é ${maisNovoConhecido})`); continue; }
    if (lote?.status === "complete" && !p.forcar) { motivos.push(`${mes}: já complete`); continue; }
    if ((await p.disponivel(mes)) === "indisponivel") { motivos.push(`${mes}: ainda não publicado pela RFB`); continue; }
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
    const respostas: RespostaSonda[] = [];
    for (const base of basesCandidatas(mes)) {
      try {
        const r = await fetch(`${base}/${ARQUIVO_SONDA}`, { method: "HEAD", headers: authorizationDe(base), signal: AbortSignal.timeout(30_000) });
        respostas.push({ tipo: "http", status: r.status });
        if (r.status === 200) break;
      } catch (e) {
        respostas.push({ tipo: "erro", detalhe: `${base} → ${mensagemDeErro(e) ?? "falha de rede sem mensagem"}` });
      }
    }
    const d = concluirSonda(mes, respostas); // lança em transporte ruim sem nenhum 200
    console.log(`   sonda ${mes}: ${d}`);
    return d;
  };

  const r = await fetch(INGEST_URL, {
    method: "POST", headers: { "Content-Type": "application/json", "x-cron-secret": SECRET },
    body: JSON.stringify({ action: "status" }), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) { console.error(`radar-ingest status falhou: HTTP ${r.status} ${await r.text()}`); process.exit(1); }
  const lotes = (((await r.json()) as { lotes?: Lote[] }).lotes ?? []);
  console.log(`lotes conhecidos: ${lotes.map((l) => `${l.mes_referencia}=${l.status}`).join(", ") || "nenhum"}`);

  const candidatos = mesPedido && mesPedido !== "true" ? [mesPedido] : candidatosDe(agora);
  // A sonda é preguiçosa: só os meses que passaram pelas guardas, parando no 1º disponível.
  const decisao = await escolherMes({ candidatos, disponivel: sondar, lotes, forcar, agora });
  for (const m of decisao.motivos) console.log(`   ${m}`);
  const linha = `mes=${decisao.mes ?? ""}`;
  console.log(decisao.mes ? `🎯 ${linha}` : `🏁 nada a fazer (${linha})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${linha}\n`);
}
