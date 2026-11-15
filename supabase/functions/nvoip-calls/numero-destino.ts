// Validação do número discado pelo `make_call` (scanner Lovable Security, lote 3).
//
// Decisão do founder: o número é LIVRE (a equipe liga para qualquer número por prospecção), então
// aqui não há allowlist de carteira. O que se valida é o FORMATO: só número brasileiro discável,
// devolvido no formato nacional (DDD + assinante, só dígitos), que é o que a Nvoip já recebia do
// front (`normalizeBrPhone`). Antes, a edge só arrancava os não-dígitos e repassava qualquer coisa:
// internacional, tarifado (0900/0300/0500), código curto.
//
// Aceita:
//   - celular: DDD + 9 + 8 dígitos (11 dígitos)
//   - fixo:    DDD + [2-5] + 7 dígitos (10 dígitos)
//   - 0800 + 7 dígitos (gratuito para quem liga)
// com prefixo opcional `+55`/`55` e zero de longa distância à frente. DDD é dois dígitos de 1 a 9.
// PURO e sem import remoto: `test:edges` roda com `--no-remote`.

export type NumeroDestino =
  | { ok: true; numero: string }
  | { ok: false; erro: string };

const ERRO =
  "Número inválido. Use um telefone brasileiro com DDD (ex.: 37999999999, (37) 3222-1234 ou 0800 123 4567).";

export function validarNumeroDestino(entrada: unknown): NumeroDestino {
  if (typeof entrada !== "string" && typeof entrada !== "number") return { ok: false, erro: ERRO };
  const bruto = String(entrada);
  if (bruto.length > 40) return { ok: false, erro: ERRO };
  // Só separadores comuns de telefone. Letra ou outro símbolo (ex.: `*`, `#`, `,` de DTMF/pausa)
  // é recusado em vez de arrancado em silêncio.
  if (!/^[\d\s()+.-]+$/.test(bruto)) return { ok: false, erro: ERRO };
  if (bruto.includes("+") && !/^\s*\+55/.test(bruto)) return { ok: false, erro: ERRO };

  let d = bruto.replace(/\D/g, "");
  if (/^0800\d{7}$/.test(d)) return { ok: true, numero: d };
  if (d.length > 11 && d.startsWith("55")) d = d.slice(2);
  // Zero de longa distância, com ou sem código de operadora (0 + XX + DDD + número).
  if (d.length === 11 + 1 && d.startsWith("0")) d = d.slice(1);
  else if (d.length === 10 + 1 && d.startsWith("0")) d = d.slice(1);
  else if ((d.length === 11 + 3 || d.length === 10 + 3) && d.startsWith("0")) d = d.slice(3);

  if (/^[1-9]{2}9\d{8}$/.test(d)) return { ok: true, numero: d };
  if (/^[1-9]{2}[2-5]\d{7}$/.test(d)) return { ok: true, numero: d };
  return { ok: false, erro: ERRO };
}
