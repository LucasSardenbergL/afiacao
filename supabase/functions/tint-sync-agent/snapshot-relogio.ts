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
// O instante é calculado dos campos do texto, sem `Date.parse`: o parser do JavaScript aceita o
// que o Postgres recusa ("2026-02-30" vira 2 de março) e descarta o que passa do milissegundo.

/** Folga para relógio adiantado na origem. Passou disso, o snapshot é recusado (400). */
export const TOLERANCIA_FUTURO_MS = 10 * 60_000;

// RFC 3339 estrito, com fuso EXPLÍCITO: `T` e `Z` maiúsculos, fração de até 9 dígitos. É o que o
// conector manda (`time.RFC3339`). Sem fuso o instante é ambíguo.
const RE_RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

/** Maior deslocamento de fuso aceito (o Postgres recusa acima de 15h59). */
const MAX_HORAS_DE_FUSO = 15;

export type VeredictoRelogio = { ok: true } | { ok: false; erro: string };

/** Instante do texto, em milissegundos inteiros + o resto abaixo do milissegundo (em nanossegundos). */
export function instanteDoTexto(valor: string): { ms: number; restoNs: number } | null {
  const m = RE_RFC3339.exec(valor);
  if (!m) return null;
  const [ano, mes, dia, hora, min, seg] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);
  // O calendário é conferido por ida e volta: 30 de fevereiro, mês 13, 24:00:00 e segundo 60 não
  // voltam iguais. Ano abaixo de 100 também não (o `Date.UTC` o lê como 19xx).
  const base = new Date(Date.UTC(ano, mes - 1, dia, hora, min, seg));
  if (
    base.getUTCFullYear() !== ano || base.getUTCMonth() !== mes - 1 || base.getUTCDate() !== dia ||
    base.getUTCHours() !== hora || base.getUTCMinutes() !== min || base.getUTCSeconds() !== seg
  ) {
    return null;
  }
  let deslocamentoMs = 0;
  if (m[8] !== undefined) {
    const horas = Number(m[9]);
    const minutos = Number(m[10]);
    if (horas > MAX_HORAS_DE_FUSO || minutos > 59) return null;
    deslocamentoMs = (m[8] === "-" ? -1 : 1) * (horas * 60 + minutos) * 60_000;
  }
  const fracaoNs = m[7] === undefined ? 0 : Number(m[7].padEnd(9, "0"));
  return {
    // "+03:00" quer dizer que o relógio de parede está 3h À FRENTE do UTC: o instante é ANTES.
    ms: base.getTime() - deslocamentoMs + Math.floor(fracaoNs / 1_000_000),
    restoNs: fracaoNs % 1_000_000,
  };
}

/**
 * `valor` é o `generated_at` do body; `agoraMs` é o relógio do SERVIDOR (`Date.now()`).
 * Não normaliza nem devolve o instante: quem passa é gravado exatamente como veio.
 */
export function validarGeneratedAt(valor: unknown, agoraMs: number): VeredictoRelogio {
  if (typeof valor !== "string" || !RE_RFC3339.test(valor)) {
    return { ok: false, erro: "generated_at must be an RFC 3339 timestamp with timezone" };
  }
  const instante = instanteDoTexto(valor);
  if (instante === null) {
    return { ok: false, erro: "generated_at is not a valid instant" };
  }
  const limiteMs = agoraMs + TOLERANCIA_FUTURO_MS;
  // Fração abaixo do milissegundo conta: 1 ns além do limite é além do limite.
  if (instante.ms > limiteMs || (instante.ms === limiteMs && instante.restoNs > 0)) {
    return {
      ok: false,
      erro: `generated_at is in the future (server clock: ${new Date(agoraMs).toISOString()})`,
    };
  }
  return { ok: true };
}
