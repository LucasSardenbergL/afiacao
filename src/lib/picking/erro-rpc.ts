// Classificação do erro de uma RPC do picking v2 para a fila de leituras: transitório (tenta de
// novo com backoff — o UUID garante que não conta duas vezes) ou permanente (marca `falhou`).
import { mensagemDeErro } from "@/lib/erro-mensagem";
import { isNetworkError } from "@/hooks/useOfflineMutation";
import type { ResultadoEnvio } from "./scanner/fila";

/** SQLSTATEs que repetir não resolve (comando inválido, sem permissão, inexistente). */
const PERMANENTES = new Set(["22023", "42501", "P0002", "23505", "23503", "23514"]);

/** Erro de uma RPC → transitório (fila tenta de novo) ou permanente (marca `falhou`). */
export function classificarErro(err: unknown): ResultadoEnvio {
  const msg = mensagemDeErro(err) ?? "erro sem mensagem";
  if (isNetworkError(err)) return { tipo: "transitorio", erro: msg };
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  if (PERMANENTES.has(code)) return { tipo: "permanente", erro: `${code}: ${msg}` };
  // Timeout, lock, JWT vencido, 5xx: tenta de novo (o UUID garante que não conta duas vezes).
  return { tipo: "transitorio", erro: code ? `${code}: ${msg}` : msg };
}

