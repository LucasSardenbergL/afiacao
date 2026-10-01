// Núcleo PURO da importação de UMA NF-e pela chave de acesso (botão "Importar NF-e" de
// /recebimento). Separado do index.ts para ser testado no runtime real (chave_test.ts).
//
// Por que existe: o botão chamava `omie-nfe-webhook`, que exige o `x-webhook-secret` do Omie —
// o browser não tem (nem deve ter) esse segredo, então era 401 sempre; e mesmo autenticado, com
// só a chave aquela edge gravaria um cabeçalho vazio, porque ela não consulta o Omie. Aqui a
// chave vira um `ConsultarRecebimento({ cChaveNFe })` na conta do armazém escolhido.
import { classificarFaultstring, redigirSegredo } from "../_shared/omie-falha.ts";

interface CabecPorChave {
  nIdReceb?: number | string;
  cChaveNFe?: string | null;
  cChaveNfe?: string | null;
}

interface DetalhePorChave {
  cabec?: CabecPorChave;
  infoCadastro?: { cCancelada?: string; cRecebido?: string };
}

/** A chave de acesso em 44 dígitos, ou `null`. Só espaço é tolerado — letra não é chave. */
export function normalizarChaveAcesso(bruta: unknown): string | null {
  if (typeof bruta !== "string") return null;
  const semEspaco = bruta.replace(/\s/g, "");
  return /^\d{44}$/.test(semEspaco) ? semEspaco : null;
}

export type DesfechoConsulta =
  | { tipo: "ok"; detalhe: DetalhePorChave }
  | { tipo: "aguardar"; segundos: number | null; mensagem: string }
  | { tipo: "recusada"; mensagem: string }
  | { tipo: "erro"; mensagem: string };

function comoRegistro(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Lê a resposta do `ConsultarRecebimento` por chave. O Omie devolve falha como `faultstring`,
 * às vezes com HTTP 200, às vezes 500 — por isso o corpo decide antes do status.
 *
 * - Falha transitória (consumo redundante, "aguarde", requisição do mesmo método em curso) →
 *   `aguardar`: a chamada IDÊNTICA repetida em ~60s é recusada pelo Omie, e retentar dentro da
 *   edge seria segurar o request do operador; quem decide quando tentar de novo é ele.
 * - Qualquer outra falha → `recusada`, com o texto do próprio Omie. Não se tenta reconhecer
 *   "não encontrada" pelo classificador compartilhado: ele lê "chave de acesso" como erro de
 *   CREDENCIAL, e a NF-e também tem "chave de acesso".
 * - O texto sai SEMPRE por `redigirSegredo`: a falha de credencial do Omie ecoa a app_key, e
 *   esta resposta vai para o browser.
 */
export function classificarConsultaPorChave(httpStatus: number, corpo: unknown): DesfechoConsulta {
  const reg = comoRegistro(corpo);
  const fault = reg && typeof reg.faultstring === "string" && reg.faultstring.trim() ? reg.faultstring : null;
  if (fault) {
    const mensagem = redigirSegredo(fault);
    if (classificarFaultstring(fault) === "transitorio") {
      const m = /aguarde\s+(\d+)\s*segundo/i.exec(fault);
      return { tipo: "aguardar", segundos: m ? Number(m[1]) : null, mensagem };
    }
    return { tipo: "recusada", mensagem };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return { tipo: "erro", mensagem: `o Omie respondeu HTTP ${httpStatus} sem faultstring` };
  }
  if (!reg || !comoRegistro(reg.cabec)) {
    return { tipo: "erro", mensagem: "a resposta do Omie veio sem o cabeçalho do recebimento" };
  }
  return { tipo: "ok", detalhe: reg as DetalhePorChave };
}

export type AvaliacaoDetalhe =
  | { tipo: "importavel"; nIdReceb: number }
  | {
    tipo: "recusada";
    status: "chave_divergente" | "cancelada" | "ja_recebida_no_omie" | "sem_id_recebimento";
    mensagem: string;
  };

/**
 * O que o detalhe permite. Espelha a política do import por cron: NF-e cancelada ou JÁ recebida
 * no Omie (`cRecebido=S`) não nasce 'pendente' no app — a entrada foi feita lá, e importá-la
 * criaria uma pendência fantasma no painel de conferência.
 */
export function avaliarDetalhePorChave(detalhe: DetalhePorChave, chave: string): AvaliacaoDetalhe {
  const cabec = detalhe.cabec ?? {};
  const chaveOmie = String(cabec.cChaveNFe ?? cabec.cChaveNfe ?? "").replace(/\D/g, "");
  if (chaveOmie !== chave) {
    return {
      tipo: "recusada",
      status: "chave_divergente",
      mensagem: `o Omie devolveu outra NF-e (chave ${chaveOmie || "ausente"}) — nada foi gravado`,
    };
  }
  if (detalhe.infoCadastro?.cCancelada === "S") {
    return { tipo: "recusada", status: "cancelada", mensagem: "a NF-e está cancelada no Omie" };
  }
  if (detalhe.infoCadastro?.cRecebido === "S") {
    return {
      tipo: "recusada",
      status: "ja_recebida_no_omie",
      mensagem: "a NF-e já foi recebida no Omie — não há conferência a fazer no app",
    };
  }
  // Sinal money-path (a efetivação consulta o recebimento por ele): só número. Ausente/ilegível
  // recusa — um nIdReceb fabricado apontaria a efetivação para o recebimento ERRADO.
  const bruto = cabec.nIdReceb;
  const nIdReceb = typeof bruto === "number" && Number.isInteger(bruto) && bruto > 0
    ? bruto
    : typeof bruto === "string" && /^\d+$/.test(bruto) ? Number(bruto) : null;
  if (nIdReceb === null) {
    return {
      tipo: "recusada",
      status: "sem_id_recebimento",
      mensagem: "o Omie não devolveu o id do recebimento (nIdReceb) — nada foi gravado",
    };
  }
  return { tipo: "importavel", nIdReceb };
}
