// Gate de DONO para edge que grava com service-role num registro escolhido pelo chamador.
//
// O furo que isto fecha (deep scan do Lovable Security, 2026-11-17, lote 5): `authorizeCronOrStaff`
// responde só "é staff". A edge seguia com service-role num id vindo do body, e service-role ignora
// a RLS — então o employee alcançava PELA EDGE o registro que a RLS lhe nega no PostgREST
// (`kb-ingest-document` virava o status de documento alheio; `extrair-sinais-ligacao` regravava a
// análise de ligação alheia).
//
// A regra NÃO é reescrita aqui. Quem decide é a policy de UPDATE da própria tabela, perguntada ao
// banco com o JWT do CHAMADOR: um UPDATE que regrava a PK com o MESMO valor, filtrado por essa PK.
// O Postgres aplica USING e WITH CHECK da policy de UPDATE (e a de SELECT, por causa do RETURNING);
// a linha só volta se o chamador pode alterá-la. Nenhum valor muda, e não há leitura seguida de
// escrita. Se a policy evoluir (ex.: gestor passa a poder escrever), a edge acompanha sem deploy.
// Prova executada do oráculo, com as policies de PROD: `db/test-seg-lote5-dono-pela-rls.sh` (PG17).
//
// O que a sonda prova, e o que não prova:
//  - prova que ESTE usuário pode dar UPDATE NESTA linha como ela está;
//  - NÃO prova regra por VALOR de coluna (um WITH CHECK que dependa do valor novo): as escritas
//    seguintes da edge saem por service-role. Nas duas tabelas de hoje não há regra assim.
//
// ⚠️ O filtro `id=eq.<id>` e o corpo `{ id }` são o MESMO valor, de propósito. Sem o filtro, o corpo
// regravaria a PK de outra linha. Por isso o id é validado como uuid antes de ir para a URL, a tabela
// vem de lista fechada (nunca do body) e o teste casa a URL inteira.
//
// cron e service_role não têm usuário e passam direto — como antes deste gate.

import { corsHeaders } from "./auth.ts";

/** Tabelas que este gate sabe sondar. Lista FECHADA: o nome vai para a URL e nunca vem do chamador. */
export type TabelaComDono = "kb_documents" | "farmer_calls";

/** O que o gate lê do `AuthResult` de `authorizeCronOrStaff`. */
export interface PrincipalDaEdge {
  via: "cron" | "service_role" | "staff";
}

export type DonoResult =
  | { ok: true; por: "servidor" | "rls" }
  | { ok: false; response: Response };

/** Marca de cada ramo de recusa — é o que o teste casa (status + code), nunca "veio um erro". */
export const DONO_ID_INVALIDO = "DONO_ID_INVALIDO";
export const DONO_SEM_JWT = "DONO_SEM_JWT";
export const DONO_SEM_PERMISSAO = "DONO_SEM_PERMISSAO";
export const DONO_GATE_INDISPONIVEL = "DONO_GATE_INDISPONIVEL";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TETO_DA_SONDA_MS = 10_000;

function recusa(status: number, code: string, error: string): DonoResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error, code }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }),
  };
}

/**
 * Staff só segue se a RLS deixa ESTE usuário alterar ESTE registro. Chame logo depois de validar o
 * body e ANTES de criar o cliente service-role: nenhuma leitura, escrita ou chamada paga vem antes.
 *
 *   const dono = await exigirDonoPelaRls(req, auth, "kb_documents", body.documentId);
 *   if (!dono.ok) return dono.response;
 */
export async function exigirDonoPelaRls(
  req: Request,
  principal: PrincipalDaEdge,
  tabela: TabelaComDono,
  id: unknown,
): Promise<DonoResult> {
  // Lista EXPLÍCITA de quem dispensa a sonda. `via !== "staff"` deixaria passar qualquer `via` que
  // o `AuthResult` venha a ganhar — um principal novo nasceria com acesso de servidor.
  if (principal.via === "cron" || principal.via === "service_role") return { ok: true, por: "servidor" };
  if (principal.via !== "staff") {
    console.error("[dono-pela-rls] principal desconhecido — gate fechado");
    return recusa(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  }

  if (typeof id !== "string" || !UUID.test(id)) {
    return recusa(400, DONO_ID_INVALIDO, "Identificador inválido: esperado um uuid.");
  }
  const alvo = id.toLowerCase();

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return recusa(401, DONO_SEM_JWT, "Não autorizado.");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    console.error("[dono-pela-rls] SUPABASE_URL ou SUPABASE_ANON_KEY ausente — gate fechado");
    return recusa(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  }

  let res: Response;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), TETO_DA_SONDA_MS);
  try {
    res = await fetch(`${supabaseUrl}/rest/v1/${tabela}?id=eq.${alvo}&select=id`, {
      method: "PATCH",
      headers: {
        // apikey ANON + Authorization do chamador: o PostgREST roda como `authenticated`, sob a RLS.
        // A service-role NUNCA entra aqui — com ela a sonda responderia "pode" para qualquer um.
        apikey: anonKey,
        Authorization: authHeader,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ id: alvo }),
      signal: controle.signal,
    });
  } catch (err) {
    console.error("[dono-pela-rls] sonda falhou:", err instanceof Error ? err.name : "erro");
    return recusa(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  } finally {
    clearTimeout(relogio);
  }

  // 403 do PostgREST = o banco disse não (42501: privilégio ou WITH CHECK).
  if (res.status === 403) {
    await res.body?.cancel();
    return recusa(403, DONO_SEM_PERMISSAO, "Sem permissão para alterar este registro.");
  }
  if (!res.ok) {
    await res.body?.cancel();
    console.error(`[dono-pela-rls] sonda devolveu HTTP ${res.status} em ${tabela}`);
    return recusa(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  }

  let linhas: unknown;
  try {
    linhas = await res.json();
  } catch {
    linhas = null;
  }
  if (!Array.isArray(linhas)) {
    console.error(`[dono-pela-rls] resposta da sonda não é lista em ${tabela}`);
    return recusa(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  }
  // Zero linha: a RLS filtrou (não é o dono) ou o registro não existe — a sonda não distingue, e a
  // resposta também não, para o id não virar oráculo de existência.
  if (linhas.length === 0) {
    return recusa(403, DONO_SEM_PERMISSAO, "Sem permissão para alterar este registro.");
  }
  const devolvido = (linhas[0] as { id?: unknown } | null)?.id;
  if (linhas.length !== 1 || typeof devolvido !== "string" || devolvido.toLowerCase() !== alvo) {
    console.error(`[dono-pela-rls] sonda devolveu linha inesperada em ${tabela}`);
    return recusa(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  }
  return { ok: true, por: "rls" };
}
