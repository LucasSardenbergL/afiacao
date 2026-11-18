// snapshot-relogio.ts — o `generated_at` do /keys-snapshot não pode reservar o futuro.
// Puro, sem import remoto: roda sob `deno test --no-remote` (snapshot-relogio_test.ts).
// O index.ts importa daqui — NÃO reimplementar inline.
//
// Por que existe (scanner Lovable Security, lote 6 — 2026-11-17; achado do Codex no desenho):
// o `generated_at` vem do agente (é o relógio do PostgreSQL de ORIGEM, na loja) e a edge o gravava
// sem olhar. É por ele que o banco ordena os snapshots de chaves:
//   · `tint_apply_keys_snapshot` pula como "fora de ordem" todo snapshot com
//     `generated_at <= last_keys_snapshot_at` e, ao aplicar, grava o do snapshot como novo marco;
//   · `tint_promote_sync_run`, `tint_receita_versoes_capturar` e `tint_watchdog_fase5_check`
//     escolhem o snapshot de referência pelo maior `generated_at`.
// Um snapshot com `generated_at` em 2099 virava o marco para sempre: todo snapshot legítimo
// seguinte era pulado, mesmo depois de o token ser trocado. É o mesmo furo da cópia genérica do
// /catalogs (`created_at` escolhido pelo agente), por outra porta.
//
// A regra: o instante tem de ser legível, existir no calendário e não estar à frente do relógio
// do servidor além de uma tolerância.
//
// O que a tolerância garante, e o que não garante: ela limita o MARCO a 10 minutos à frente. Não
// limita a 10 minutos o tempo de recuperação. Se um snapshot adiantado dentro da folga for
// aplicado, o legítimo gerado logo depois é pulado, e o conector só gera outro quando muda a data
// (`shouldKeysSnapshot`): a sincronização das retiradas pode esperar o dia seguinte. Deixou de
// ser "para sempre"; não virou "dez minutos".
//
// Medido na PROD em 2026-11-17 (81 linhas, 27 snapshots em 30 dias): o `generated_at` está
// SEMPRE atrás do recebimento, entre 3min35s e 4min24s (é o tempo de gerar e enviar). Nenhum
// snapshot legítimo chegou adiantado.
//
// Quem lê o instante é o `instanteNs` de ./preparacoes.ts, o parser que esta edge já tinha:
// RFC 3339 estrito com fuso, data que existe no calendário, precisão de nanossegundo. Um segundo
// parser aqui teria regras próprias para a mesma pergunta. (`Date.parse` não serve: aceita o que
// o Postgres recusa — "2026-02-30" vira 2 de março — e descarta o que passa do milissegundo.)
import { instanteNs } from "./preparacoes.ts";

/** Folga para relógio adiantado na origem. Passou disso, o snapshot é recusado (400). */
export const TOLERANCIA_FUTURO_MS = 10 * 60_000;

// O Postgres recusa fuso acima de 15h59; o `instanteNs` aceita até 23h59. Sem isto, o texto
// passaria aqui e o banco responderia erro depois de a rota tentar gravar.
const RE_FUSO_FORA_DO_POSTGRES = /[+-](1[6-9]|2\d):\d{2}$/;

export type VeredictoRelogio = { ok: true } | { ok: false; erro: string };

/**
 * `valor` é o `generated_at` do body; `agoraMs` é o relógio do SERVIDOR (`Date.now()`).
 * Não normaliza nem devolve o instante: quem passa é gravado exatamente como veio.
 */
export function validarGeneratedAt(valor: unknown, agoraMs: number): VeredictoRelogio {
  const ns = instanteNs(valor);
  if (ns === null || RE_FUSO_FORA_DO_POSTGRES.test(valor as string)) {
    return { ok: false, erro: "generated_at must be an RFC 3339 timestamp with timezone" };
  }
  const limiteNs = BigInt(Math.floor(agoraMs) + TOLERANCIA_FUTURO_MS) * 1_000_000n;
  if (ns > limiteNs) {
    return {
      ok: false,
      erro: `generated_at is in the future (server clock: ${new Date(agoraMs).toISOString()})`,
    };
  }
  return { ok: true };
}
