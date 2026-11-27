// Decisões puras da edge `desligar-funcionario` (testadas em `decisao_test.ts`, sem rede).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ban "indefinido": o Auth exige duração; 100 anos. Reversível pelo admin API (`ban_duration: "none"`). */
export const BAN_DURACAO = "876000h";

export type PedidoDesligamento = { userId: string; novoDono: string | null; motivo: string };

/** Valida o corpo. Devolve o pedido ou a mensagem de erro (400). */
export function lerPedido(body: Record<string, unknown>): PedidoDesligamento | { erro: string } {
  const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!UUID.test(userId)) return { erro: "Informe user_id (uuid) do funcionário." };
  const bruto = body.novo_dono_user_id;
  let novoDono: string | null = null;
  if (bruto !== undefined && bruto !== null && bruto !== "") {
    if (typeof bruto !== "string" || !UUID.test(bruto.trim())) {
      return { erro: "novo_dono_user_id precisa ser um uuid." };
    }
    novoDono = bruto.trim();
  }
  const motivo = typeof body.motivo === "string" ? body.motivo.trim() : "";
  if (motivo.length < 3 || motivo.length > 500) return { erro: "Escreva o motivo (3 a 500 caracteres)." };
  return { userId, novoDono, motivo };
}

/** SQLSTATE da RPC → HTTP. O que não é recusa conhecida é 500 (nunca vira sucesso). */
export function httpDoErroRpc(code: string | undefined): number {
  switch (code) {
    case "42501": return 403;   // não-master, a si mesmo
    case "22023":               // não é equipe, sem novo dono, novo dono inválido, motivo
    case "22004": return 400;
    case "55P03":               // rebuild de carteira em andamento
    case "55000": return 409;   // estado do rebuild ausente
    default: return 500;
  }
}

export type RespostaRpc = { status: "desligado" | "ja_desligado"; desligamento_id: string | null };

/** Lê a resposta da RPC; forma inesperada = null (a edge responde 500, não inventa sucesso). */
export function lerRespostaRpc(data: unknown): RespostaRpc | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.status !== "desligado" && d.status !== "ja_desligado") return null;
  const id = typeof d.desligamento_id === "string" && UUID.test(d.desligamento_id) ? d.desligamento_id : null;
  if (d.status === "desligado" && !id) return null;
  return { status: d.status, desligamento_id: id };
}
