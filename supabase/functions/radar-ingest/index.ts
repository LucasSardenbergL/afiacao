import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeCron, authorizeMaster } from "../_shared/auth.ts";
import { autorizarIngest } from "./gate.ts";
import { classificarSonda, EFEITO, erroSondaAmbigua, respostaSonda, VERSAO } from "./versao.ts";
import { motivoDescarte, type MotivoDescarte } from "./cnpj.ts";
import { validarLinhaSituacao, type LinhaSituacao, type MotivoDescarteSituacao } from "./situacao.ts";
import { codigoErroSocios, ehAcaoSocios, montarPedidoSocios } from "./socios.ts";
import { dedupPorCnpj, lerEsperado, lerMotivoFalha, montarLinhaStaging } from "./carga.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MES_RE = /^\d{4}-\d{2}$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // Gate: `x-cron-secret` OU master (JWT master ou Bearer service role) — os gates compartilhados (`gate.ts`).
  if (!(await autorizarIngest(req, { cron: authorizeCron, master: authorizeMaster }))) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "body inválido" }, 400); }
  // Sonda de versão (M-26; docs/agent/deploy.md): `{ probe: true }` responde a versão no ar sem tocar
  // banco — antes do client. O gate acima (`autorizarIngest`) já aceita `x-cron-secret`.
  const decisaoSonda = classificarSonda(body);
  if (decisaoSonda.tipo === "sonda") return json(respostaSonda(VERSAO), 200);
  if (decisaoSonda.tipo === "ambiguo") return json({ versao: VERSAO, error: erroSondaAmbigua(decisaoSonda.valor, EFEITO) }, 400);
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const action = String(body.action ?? "");
  const mes = String(body.mes ?? "");

  try {
    if (action === "begin_lote") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido (YYYY-MM)" }, 400);
      // Publicação atômica (migration 20261110130000): esvazia o staging e abre a carga em `recebendo`.
      // Re-run preserva iniciado_em, e um lote já `complete` CONTINUA complete — a foto vigente segue no ar.
      const { data, error } = await admin.rpc("radar_carga_iniciar", { p_lote: mes });
      if (error) throw error;
      return json({ ok: true, mes, ...(data as Record<string, unknown>) });
    }

    if (action === "chunk") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const linhas = (body.linhas ?? []) as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0) return json({ error: "linhas vazio" }, 400);
      if (linhas.length > 1000) return json({ error: "máx 1000 linhas/chunk" }, 400);
      // Descarte POR MOTIVO (CNPJ alfanumérico RFB jul/2026 — formato, DV, CNAE): a contagem volta
      // no JSON para o chamador registrar; antes era só um console.warn que ninguém lia e uma
      // empresa nova com letra sumia em silêncio.
      const descartadas_por_motivo: Record<MotivoDescarte, number> = { cnpj_formato: 0, cnpj_dv: 0, cnae: 0 };
      const validas: Record<string, unknown>[] = [];
      for (const l of linhas) {
        const motivo = motivoDescarte(l.cnpj, l.cnae_principal);
        if (motivo) descartadas_por_motivo[motivo]++;
        else validas.push(l);
      }
      const descartadas = linhas.length - validas.length;
      if (descartadas > 0) {
        console.warn(`chunk ${mes}: ${descartadas} linhas descartadas`, descartadas_por_motivo);
      }
      if (validas.length === 0) return json({ ok: true, upserted: 0, descartadas, descartadas_por_motivo });
      // STAGING, não a tabela viva: a fila segue lendo a foto vigente inteira enquanto a carga chega, e uma
      // carga que morre no meio não tira ninguém dela. A RPC recusa lote fora de `recebendo` (validado,
      // publicado ou falhou) — chunk atrasado não muda o que a validação contou.
      const finalPayload = dedupPorCnpj(validas.map(montarLinhaStaging));
      const { data: gravadas, error } = await admin.rpc("radar_carga_receber", { p_lote: mes, p_linhas: finalPayload });
      if (error) throw error;
      if (gravadas !== finalPayload.length) throw new Error(`chunk ${mes}: staging gravou ${gravadas}, esperava ${finalPayload.length}`);
      // `upserted` é o que a carga soma e devolve no finalize como `esperado`: replay do mesmo chunk é
      // upsert por (lote, cnpj) no staging, então a soma das respostas bem-sucedidas = linhas distintas.
      return json({ ok: true, upserted: finalPayload.length, descartadas, descartadas_por_motivo,
        duplicadas_no_chunk: validas.length - finalPayload.length });
    }

    if (action === "chunk_municipios") {
      const linhas = (body.linhas ?? []) as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0 || linhas.length > 1000)
        return json({ error: "linhas inválido (1..1000)" }, 400);
      const payload = linhas
        .filter((l) => String(l.codigo ?? "").trim() && String(l.nome ?? "").trim())
        .map((l) => ({ codigo: String(l.codigo), nome: l.nome, uf: l.uf ?? "", lat: l.lat ?? null, lng: l.lng ?? null }));
      const { error } = await admin.from("radar_municipios").upsert(payload, { onConflict: "codigo" });
      if (error) throw error;
      return json({ ok: true, upserted: payload.length });
    }

    if (action === "cnpjs_conhecidos") {
      // Lista radar ∪ clientes (profiles ∪ omie_clientes_nao_vinculados, já normalizados) para a carga
      // extrair a situação cadastral de TODO CNPJ conhecido, em qualquer situação. Keyset: `apos` = último
      // CNPJ da página anterior; `proximo` null = acabou. A RPC capa em 50.000 por página.
      const apos = String(body.apos ?? "");
      const limite = Number(body.limite ?? 50000);
      if (!Number.isInteger(limite) || limite < 1 || limite > 50000) return json({ error: "limite inválido (1..50000)" }, 400);
      const { data, error } = await admin.rpc("radar_cnpjs_conhecidos", { p_apos: apos, p_limite: limite });
      if (error) throw error;
      const cnpjs = (data ?? []) as string[];
      return json({ ok: true, cnpjs, proximo: cnpjs.length === limite ? cnpjs[cnpjs.length - 1] : null });
    }

    if (action === "chunk_situacao") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const linhas = (body.linhas ?? []) as Record<string, unknown>[];
      if (!Array.isArray(linhas) || linhas.length === 0) return json({ error: "linhas vazio" }, 400);
      if (linhas.length > 1000) return json({ error: "máx 1000 linhas/chunk" }, 400);
      const descartadas_por_motivo: Record<MotivoDescarteSituacao, number> = { cnpj_formato: 0, cnpj_dv: 0, situacao: 0, data: 0 };
      const validas: LinhaSituacao[] = [];
      for (const l of linhas) {
        const r = validarLinhaSituacao(l);
        if (r.ok) validas.push(r.linha);
        else descartadas_por_motivo[r.motivo]++;
      }
      const descartadas = linhas.length - validas.length;
      if (descartadas > 0) console.warn(`chunk_situacao ${mes}: ${descartadas} linhas descartadas`, descartadas_por_motivo);
      if (validas.length === 0) return json({ ok: true, upserted: 0, descartadas, descartadas_por_motivo });
      // ⚠️ payload SEM alertado_em: o UPDATE do upsert não toca o dedupe do aviso ao gestor
      // (1 escritor: radar_aplicar_situacao; preservação por omissão, como no chunk).
      const observado_em = new Date().toISOString();
      const porCnpj = new Map(validas.map((l) => [l.cnpj, { ...l, lote: mes, observado_em }]));
      const finalPayload = [...porCnpj.values()];
      const { error } = await admin.from("radar_situacao_cadastral").upsert(finalPayload, { onConflict: "cnpj,lote" });
      if (error) throw error;
      return json({ ok: true, upserted: finalPayload.length, descartadas, descartadas_por_motivo,
        duplicadas_no_chunk: validas.length - finalPayload.length });
    }

    if (action === "finalize") {
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      // O finalize VALIDA, não publica: a contagem do staging tem de bater com o que a carga declara ter
      // entregue (soma do `upserted` dos chunks), sem queda > 15% contra a foto vigente. Validado → o job
      // radar-publicar-lote (≤ 15 min) troca a foto numa transação: upsert em radar_empresas, recruzar
      // ja_cliente, `complete` + finalizado_em. Publicar aqui cairia nos 8s do PostgREST (57014 no lote 2026-09).
      // A situação cadastral também é do job radar-aplicar-situacao-diario (06:05 UTC), pela pendência do
      // finalizado_em que a publicação grava.
      const esperado = lerEsperado(body.esperado);
      if (!esperado.ok) return json({ error: esperado.erro }, 400);
      const { data, error } = await admin.rpc("radar_carga_validar", {
        p_lote: mes, p_esperado: esperado.valor, p_aceitar_queda: body.aceitar_queda === true,
      });
      if (error) throw error;
      const v = data as { ok?: boolean; motivo?: string; recebidas?: number } | null;
      // Reprovado: a RPC já marcou a carga `falhou` (a foto vigente fica intacta). Fora do catch geral.
      if (!v?.ok) return json({ error: `lote ${mes} reprovado na validação: ${v?.motivo ?? "sem motivo"}`, validacao: v }, 422);
      return json({ ok: true, mes, recebidas: v.recebidas, publicacao: "cron", situacao_aplicacao: "cron" });
    }

    if (action === "publicar_concorrentes") {
      // Camada de concorrentes do mapa (revendas de tinta/verniz, agregadas por município): a RPC publica o
      // lote INTEIRO numa transação e reconcilia a soma das linhas com `estabelecimentos`. Erro tratado AQUI,
      // fora do catch geral: aquele marca o lote de leads como `error`, e a carga chama esta ação DEPOIS do
      // finalize — uma falha da camada não pode derrubar a foto vigente da fila.
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const { cnaes, linhas, estabelecimentos } = body;
      if (!Array.isArray(cnaes) || !Array.isArray(linhas) || typeof estabelecimentos !== "number") {
        return json({ error: "cnaes[], linhas[] e estabelecimentos (número) obrigatórios" }, 400);
      }
      try {
        const { data, error } = await admin.rpc("radar_concorrentes_publicar", {
          p_lote: mes, p_cnaes: cnaes, p_linhas: linhas, p_estabelecimentos: estabelecimentos,
        });
        if (error) throw error;
        return json({ ok: true, publicado: data });
      } catch (e) {
        const msg = e instanceof Error ? e.message : JSON.stringify(e);
        console.error(`radar-ingest publicar_concorrentes ${mes} falhou:`, msg);
        return json({ error: msg }, 500);
      }
    }

    if (ehAcaoSocios(action)) {
      // Sócios (QSA PF com CPF mascarado, passo 3 do "Radar sucessor"): o protocolo vive nas RPCs. Fronteira de
      // erro PRÓPRIA, fora do catch geral — ele ecoaria a mensagem do PostgREST (que pode trazer a linha, com a
      // máscara) e marcaria o lote da FILA como `error`; esta camada roda depois do finalize e não pode derrubá-la.
      const pedido = montarPedidoSocios(action, body);
      if (!pedido.ok) return json({ error: pedido.erro }, 400);
      // Nome LITERAL em cada ramo (não `admin.rpc(pedido.rpc, …)`): é o que o pré-flight de deploy enxerga.
      const chamada = pedido.rpc === "radar_socios_iniciar" ? admin.rpc("radar_socios_iniciar", pedido.args)
        : pedido.rpc === "radar_socios_receber" ? admin.rpc("radar_socios_receber", pedido.args)
        : pedido.rpc === "radar_socios_publicar" ? admin.rpc("radar_socios_publicar", pedido.args)
        : admin.rpc("radar_socios_limpar", pedido.args);
      const { data, error } = await chamada;
      if (error) {
        const codigo = codigoErroSocios(error);
        console.error(`radar-ingest ${action} falhou: ${codigo}`);
        return json({ error: codigo }, 500);
      }
      return json({ ok: true, resultado: data });
    }

    if (action === "falhar") {
      // A CARGA declara que desistiu do lote (esgotou as tentativas ou abortou). Só uma carga `recebendo` vira
      // `falhou` (e `error`, se o lote nunca foi publicado): lote validado/complete não é rebaixado — no-op.
      if (!MES_RE.test(mes)) return json({ error: "mes inválido" }, 400);
      const motivo = lerMotivoFalha(body.erro);
      if (!motivo.ok) return json({ error: motivo.erro }, 400);
      const { data, error } = await admin.rpc("radar_carga_falhar", { p_lote: mes, p_erro: motivo.motivo });
      if (error) throw error;
      return json({ ok: true, mes, marcada: data === true });
    }

    if (action === "status") {
      const { data, error } = await admin.from("radar_ingest_state")
        .select("*").order("mes_referencia", { ascending: false }).limit(3);
      if (error) throw error;
      return json({ ok: true, lotes: data });
    }

    return json({ error: `ação desconhecida: ${action}`, acoes: ["begin_lote", "chunk", "chunk_municipios", "cnpjs_conhecidos", "chunk_situacao", "finalize", "falhar", "publicar_concorrentes", "socios_iniciar", "chunk_socios", "publicar_socios", "limpar_socios", "status"] }, 400);
  } catch (e) {
    // Erros do PostgREST são objetos planos (não Error) — String(e) viraria
    // "[object Object]" e mascararia o diagnóstico (mordeu na 1ª carga real).
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    console.error(`radar-ingest ${action} falhou:`, msg);
    // NÃO marca a carga `falhou` aqui: todo erro desta edge é RECUPERÁVEL para o chamador (chunk é upsert por
    // (lote, cnpj); finalize repetido devolve o veredito gravado). Marcar aqui fazia um 5xx transitório num
    // chunk fechar o lote e a 2ª tentativa morrer em RCARGA_LOTE_FECHADO. Quem desiste declara: ação `falhar`.
    return json({ error: msg }, 500);
  }
});
