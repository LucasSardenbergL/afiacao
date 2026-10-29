// Trilha server-side da `process-nfe` — um evento por passo em `nfe_recebimento_manual_trilha`
// (migration 20261021175441, append-only, só o service_role escreve). Sem import remoto.
//
// Difere do `_shared/registro-execucao.ts` (fail-OPEN, observabilidade de ação global) num ponto
// deliberado: aqui a trilha é a condição da escrita no ERP. `registrar` devolve se gravou, e o
// fluxo trata dois tipos de evento de forma diferente:
//  - INTENÇÃO (antes de cada escrita no Omie): sem gravar, a escrita NÃO acontece — nenhuma entrada
//    de estoque fica sem registro de quem, qual NF e quanto;
//  - RESULTADO (depois da escrita): a escrita já aconteceu, então a falha da trilha não desfaz
//    nada; o fluxo segue e a resposta avisa que a trilha ficou incompleta.
// `registrar` nunca lança: o retorno é o contrato.
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

export type PassoTrilha =
  | "inicio" | "nf_localizada" | "consulta" | "quantidades"
  | "alterar_recebimento" | "alterar_etapa" | "concluir_recebimento" | "fim";

export type ResultadoTrilha = "ok" | "aviso" | "erro" | "indeterminado" | "recusado" | "intencao" | "pulado";

export type Conta = "oben" | "colacor" | "afiacao";

export interface EventoTrilha {
  passo: PassoTrilha;
  resultado: ResultadoTrilha;
  detalhe?: Record<string, unknown>;
}

/** Estrutural mínimo do supabase-js (service_role) — só o que a trilha usa. */
export interface DbTrilha {
  from(tabela: "nfe_recebimento_manual_trilha"): {
    insert(linha: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }>;
  };
}

export interface Trilha {
  readonly execucaoId: string;
  /** Identidade da NF no Omie, conhecida a partir do passo 1; vai em todo evento seguinte. */
  fixarNf(nIdReceb: number | null, chave: string | null): void;
  registrar(e: EventoTrilha): Promise<boolean>;
}

export function criarTrilha(
  db: DbTrilha,
  base: { execucaoId: string; executadoPor: string; conta: Conta; nfNumero: string; versao: string },
): Trilha {
  let nIdReceb: number | null = null;
  let chave: string | null = null;
  return {
    execucaoId: base.execucaoId,
    fixarNf(id, ch) {
      nIdReceb = id;
      chave = ch;
    },
    async registrar(e) {
      try {
        const { error } = await db.from("nfe_recebimento_manual_trilha").insert({
          execucao_id: base.execucaoId,
          executado_por: base.executadoPor,
          conta: base.conta,
          nf_numero: base.nfNumero,
          n_id_receb: nIdReceb,
          chave_nfe: chave,
          passo: e.passo,
          resultado: e.resultado,
          detalhe: e.detalhe ?? {},
          versao: base.versao,
        });
        if (error) {
          console.error(`[process-nfe] trilha não gravou ${e.passo}/${e.resultado}:`, error.message ?? "erro sem mensagem");
          return false;
        }
        return true;
      } catch (err) {
        console.error(`[process-nfe] trilha lançou em ${e.passo}/${e.resultado}:`, mensagemDeErro(err) ?? "erro sem mensagem");
        return false;
      }
    },
  };
}
