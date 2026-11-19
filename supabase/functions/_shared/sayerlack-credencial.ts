// Senha do portal Sayerlack para as 4 edges que logam nele (enviar-pedido, captura-precos,
// importar-pedido, varrer-pedidos). Fonte da verdade: Vault, via RPC `sayerlack_senha_portal_credencial`
// (migration 20261120130000). O env `SAYERLACK_PORTAL_PASS` é só BOOTSTRAP: vale enquanto o Vault não
// tem senha ativa, e só quando a RPC RESPONDEU dizendo isso.
//
// FAIL-CLOSED: erro na RPC, linha ausente ou rotação em curso ⇒ NÃO loga. Logar com senha velha
// durante uma rotação é o que gasta tentativas de login e pode bloquear a conta (Codex P1).

import { mensagemDeErro } from "./erro-mensagem.ts";

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { rpc: (fn: string, args?: Record<string, unknown>) => any };

export type Credencial =
  | { ok: true; senha: string; origem: "vault" | "env_bootstrap" }
  | { ok: false; erroTipo: "CREDENCIAL_BLOQUEADA" | "CREDENCIAL_INDISPONIVEL"; motivo: string };

interface LinhaCredencial {
  senha: string | null;
  origem: string | null;
  bloqueio: string | null;
}

/** Decisão pura (testável): resposta da RPC + env → credencial ou recusa. */
export function decidirCredencial(
  linha: LinhaCredencial | null | undefined,
  erroRpc: string | null,
  envPass: string | null | undefined,
): Credencial {
  if (erroRpc) {
    return { ok: false, erroTipo: "CREDENCIAL_INDISPONIVEL", motivo: "Nao consegui ler a senha do portal no Vault: " + erroRpc };
  }
  if (!linha) {
    return { ok: false, erroTipo: "CREDENCIAL_INDISPONIVEL", motivo: "A leitura da senha do portal voltou vazia" };
  }
  if (linha.bloqueio) {
    return {
      ok: false,
      erroTipo: "CREDENCIAL_BLOQUEADA",
      motivo: "Troca de senha do portal em curso (" + linha.bloqueio + "): nao vou logar ate ela fechar",
    };
  }
  if (linha.origem === "vault" && linha.senha) {
    return { ok: true, senha: linha.senha, origem: "vault" };
  }
  if (linha.origem === "env_bootstrap") {
    if (envPass) return { ok: true, senha: envPass, origem: "env_bootstrap" };
    return { ok: false, erroTipo: "CREDENCIAL_INDISPONIVEL", motivo: "Vault sem senha ativa e SAYERLACK_PORTAL_PASS ausente" };
  }
  return { ok: false, erroTipo: "CREDENCIAL_INDISPONIVEL", motivo: "Resposta inesperada da credencial (origem " + String(linha.origem) + ")" };
}

export async function obterSenhaPortal(db: Db, envPass: string | null | undefined): Promise<Credencial> {
  try {
    const { data, error } = await db.rpc("sayerlack_senha_portal_credencial");
    const linha = Array.isArray(data) ? (data[0] as LinhaCredencial | undefined) : (data as LinhaCredencial | null);
    return decidirCredencial(linha ?? null, error ? (mensagemDeErro(error) ?? "erro sem mensagem") : null, envPass);
  } catch (e) {
    return decidirCredencial(null, mensagemDeErro(e) ?? "erro sem mensagem", envPass);
  }
}

/**
 * Pedido DURÁVEL de rotação (linha `solicitada` no banco) + disparo best-effort da edge rotacionadora.
 * Se o disparo se perder, a linha fica: a próxima edge consumidora vê `rotacao_solicitada`, não loga, e
 * re-dispara (`redispararSeParada`). Nunca lança — quem chama está no caminho de erro de um pedido.
 */
export async function solicitarRotacaoSenha(
  db: Db,
  gatilho: string,
  cfg: { supabaseUrl: string | undefined; serviceKey: string | undefined },
): Promise<{ solicitada: boolean; motivo?: string }> {
  try {
    const { data, error } = await db.rpc("sayerlack_senha_portal_solicitar", { p_gatilho: gatilho.slice(0, 200) });
    if (error) return { solicitada: false, motivo: mensagemDeErro(error) ?? "erro sem mensagem" };
    // NULL = quarentena (troca recusada há < 6h): não dispara nada, o alerta humano segue valendo.
    if (data === null || data === undefined) return { solicitada: false, motivo: "quarentena_pos_falha" };
  } catch (e) {
    return { solicitada: false, motivo: mensagemDeErro(e) ?? "erro sem mensagem" };
  }
  await dispararRotacionador(cfg, gatilho);
  return { solicitada: true };
}

/** Bloqueio em rodada `solicitada`/`ambigua`: re-dispara o rotacionador (ele mesmo decide se age). */
export async function redispararSeParada(
  cred: Credencial,
  cfg: { supabaseUrl: string | undefined; serviceKey: string | undefined },
  gatilho: string,
): Promise<void> {
  if (cred.ok || cred.erroTipo !== "CREDENCIAL_BLOQUEADA") return;
  if (!/rotacao_(solicitada|ambigua)/.test(cred.motivo)) return;
  await dispararRotacionador(cfg, gatilho);
}

async function dispararRotacionador(
  cfg: { supabaseUrl: string | undefined; serviceKey: string | undefined },
  gatilho: string,
): Promise<void> {
  if (!cfg.supabaseUrl || !cfg.serviceKey) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3_000);
    // Só ENTREGA o pedido: a rotacionadora roda o trabalho em background e responde na hora.
    await fetch(`${cfg.supabaseUrl}/functions/v1/sayerlack-rotacionar-senha`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.serviceKey}` },
      body: JSON.stringify({ acao: "rotacionar", gatilho: gatilho.slice(0, 200) }),
      signal: ctrl.signal,
    }).catch(() => null);
    clearTimeout(t);
  } catch {
    // best-effort: a linha durável já existe
  }
}
