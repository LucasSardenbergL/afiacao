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
// O que a sonda é, e o que ela não é:
//  - é uma ESCRITA sujeita à RLS, não uma leitura: onde houver trigger de `updated_at` ele anda, e
//    se a resposta se perde depois do commit a edge responde 503 com esse efeito já feito;
//  - prova que ESTE usuário pode dar UPDATE NESTA linha como ela está, NO INÍCIO do trabalho;
//  - NÃO prova regra por VALOR de coluna (um WITH CHECK que dependa do valor novo): as escritas
//    seguintes da edge saem por service-role. Nas duas tabelas de hoje não há regra assim.
//
// ⚠️ O filtro `id=eq.<id>` e o corpo `{ id }` são o MESMO valor, de propósito. Sem o filtro, o corpo
// regravaria a PK de outra linha do chamador (provado: sabotagem `sonda_sem_filtro` da prova PG17).
// Por isso o id é validado como uuid antes de ir para a URL, a tabela vem de lista fechada (nunca
// do body) e o teste casa a URL inteira.
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

/** Só para teste: encurta o teto e a espera. As edges não passam isto. */
export interface OpcoesDaSondaDeDono {
  tetoMs?: number;
  esperaMs?: number;
}

/** Marca de cada ramo de recusa — é o que o teste casa (status + code), nunca "veio um erro". */
export const DONO_ID_INVALIDO = "DONO_ID_INVALIDO";
export const DONO_SEM_JWT = "DONO_SEM_JWT";
export const DONO_SEM_PERMISSAO = "DONO_SEM_PERMISSAO";
export const DONO_GATE_INDISPONIVEL = "DONO_GATE_INDISPONIVEL";

// Nomes de topo EXCLUSIVOS deste módulo, de propósito: o gate `canaria:bump` resolve `_shared/` por
// símbolo em TEXTO, e um nome genérico aqui entraria na superfície da canária de outra edge que
// cite a mesma palavra (aconteceu com a `identidade_probe` da `omie-vendas-sync`).
const FORMA_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TETO_DA_SONDA_DE_DONO_MS = 10_000;
/** Uma repetição, e só em falha transitória: a sonda não muda valor, então repetir é inócuo. */
const TENTATIVAS_DA_SONDA_DE_DONO = 2;
const ESPERA_ENTRE_SONDAS_DE_DONO_MS = 300;

function recusaDoGateDeDono(status: number, code: string, error: string): DonoResult {
  return {
    ok: false,
    response: new Response(JSON.stringify({ error, code }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    }),
  };
}

/** O que UMA tentativa de sonda conclui. `transitorio` decide se vale repetir. */
type VereditoDaSondaDeDono =
  | { tipo: "pode" }
  | { tipo: "nao_pode" }
  | { tipo: "sem_veredito"; motivo: string; transitorio: boolean };

/** O veredito já saiu do status: falha ao descartar o corpo não pode virar exceção do gate. */
async function descartarCorpoDaSondaDeDono(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // corpo já consumido, travado ou com erro de stream — nada a fazer
  }
}

async function sondarDonoUmaVez(
  url: string,
  anonKey: string,
  authHeader: string,
  alvo: string,
  tetoMs: number,
): Promise<VereditoDaSondaDeDono> {
  // O teto cobre a requisição INTEIRA, inclusive a leitura do corpo: um PostgREST que manda os
  // headers e não termina o corpo não pode pendurar a edge. A corrida contra `estourou` vale mesmo
  // se a implementação de fetch não propagar o abort ao stream.
  const controle = new AbortController();
  const estourou = new Promise<never>((_, rejeitar) => {
    controle.signal.addEventListener(
      "abort",
      () => rejeitar(new DOMException("teto da sonda de dono", "TimeoutError")),
      { once: true },
    );
  });
  estourou.catch(() => {});
  const relogio = setTimeout(() => controle.abort(), tetoMs);
  try {
    const res = await Promise.race([
      fetch(url, {
        method: "PATCH",
        headers: {
          // apikey ANON + Authorization do chamador: o PostgREST roda como `authenticated`, sob a
          // RLS. A service-role NUNCA entra aqui — com ela a sonda diria "pode" para qualquer um.
          apikey: anonKey,
          Authorization: authHeader,
          "Content-Type": "application/json",
          // O schema explícito, como o supabase-js manda: sem ele vale o 1º schema exposto.
          "Content-Profile": "public",
          Prefer: "return=representation",
        },
        body: JSON.stringify({ id: alvo }),
        signal: controle.signal,
      }),
      estourou,
    ]);

    // 403 do PostgREST = o banco disse não (42501: privilégio ou WITH CHECK).
    if (res.status === 403) {
      await descartarCorpoDaSondaDeDono(res);
      return { tipo: "nao_pode" };
    }
    if (!res.ok) {
      await descartarCorpoDaSondaDeDono(res);
      return { tipo: "sem_veredito", motivo: `HTTP ${res.status}`, transitorio: res.status >= 500 || res.status === 429 };
    }

    let linhas: unknown;
    try {
      linhas = await Promise.race([res.json(), estourou]);
    } catch {
      await descartarCorpoDaSondaDeDono(res);
      return { tipo: "sem_veredito", motivo: "corpo ilegível ou incompleto", transitorio: true };
    }
    if (!Array.isArray(linhas)) {
      return { tipo: "sem_veredito", motivo: "resposta não é lista", transitorio: false };
    }
    // Zero linha: a RLS filtrou (não é o dono) ou o registro não existe — a sonda não distingue.
    if (linhas.length === 0) return { tipo: "nao_pode" };
    const devolvido = (linhas[0] as { id?: unknown } | null)?.id;
    if (linhas.length !== 1 || typeof devolvido !== "string" || devolvido.toLowerCase() !== alvo) {
      return { tipo: "sem_veredito", motivo: "linha inesperada", transitorio: false };
    }
    return { tipo: "pode" };
  } catch (err) {
    return { tipo: "sem_veredito", motivo: err instanceof Error ? err.name : "erro", transitorio: true };
  } finally {
    clearTimeout(relogio);
  }
}

/**
 * Staff só segue se a RLS deixa ESTE usuário alterar ESTE registro. Chame logo depois de validar o
 * body e ANTES de criar o cliente service-role: nenhuma leitura, escrita ou chamada paga vem antes.
 *
 *   const dono = await exigirDonoPelaRls(req, auth, "kb_documents", documentId);
 *   if (!dono.ok) return dono.response;
 */
export async function exigirDonoPelaRls(
  req: Request,
  principal: PrincipalDaEdge,
  tabela: TabelaComDono,
  id: unknown,
  opcoes: OpcoesDaSondaDeDono = {},
): Promise<DonoResult> {
  // Lista EXPLÍCITA de quem dispensa a sonda. `via !== "staff"` deixaria passar qualquer `via` que
  // o `AuthResult` venha a ganhar — um principal novo nasceria com acesso de servidor.
  if (principal.via === "cron" || principal.via === "service_role") return { ok: true, por: "servidor" };
  if (principal.via !== "staff") {
    console.error("[dono-pela-rls] principal desconhecido — gate fechado");
    return recusaDoGateDeDono(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  }

  if (typeof id !== "string" || !FORMA_DE_UUID.test(id)) {
    return recusaDoGateDeDono(400, DONO_ID_INVALIDO, "Identificador inválido: esperado um uuid.");
  }
  const alvo = id.toLowerCase();

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return recusaDoGateDeDono(401, DONO_SEM_JWT, "Não autorizado.");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    console.error("[dono-pela-rls] SUPABASE_URL ou SUPABASE_ANON_KEY ausente — gate fechado");
    return recusaDoGateDeDono(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
  }

  const url = `${supabaseUrl}/rest/v1/${tabela}?id=eq.${alvo}&select=id`;
  const tetoMs = opcoes.tetoMs ?? TETO_DA_SONDA_DE_DONO_MS;
  const esperaMs = opcoes.esperaMs ?? ESPERA_ENTRE_SONDAS_DE_DONO_MS;

  let veredito: VereditoDaSondaDeDono = { tipo: "sem_veredito", motivo: "não sondou", transitorio: false };
  for (let tentativa = 1; tentativa <= TENTATIVAS_DA_SONDA_DE_DONO; tentativa++) {
    veredito = await sondarDonoUmaVez(url, anonKey, authHeader, alvo, tetoMs);
    if (veredito.tipo !== "sem_veredito" || !veredito.transitorio) break;
    if (tentativa < TENTATIVAS_DA_SONDA_DE_DONO) {
      await new Promise((seguir) => setTimeout(seguir, esperaMs));
    }
  }

  if (veredito.tipo === "pode") return { ok: true, por: "rls" };
  if (veredito.tipo === "nao_pode") {
    // A resposta não distingue "não é o dono" de "não existe", para o id não virar oráculo.
    return recusaDoGateDeDono(403, DONO_SEM_PERMISSAO, "Sem permissão para alterar este registro.");
  }
  console.error(`[dono-pela-rls] sonda sem veredito em ${tabela}: ${veredito.motivo}`);
  return recusaDoGateDeDono(503, DONO_GATE_INDISPONIVEL, "Não foi possível conferir a permissão. Tente de novo.");
}
