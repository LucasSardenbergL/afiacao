// Documento de cliente (CPF/CNPJ) no FRONT — os três usos que mutilavam CNPJ alfanumérico
// (docs/historico/radar-cnpj-alfanumerico-escritores.md, follow-up 2). Tudo deriva de
// `normalizarDocumento` (espelho de `_shared/cnpj-alfanumerico.ts`): numérico é byte-idêntico ao
// `.replace(/\D/g, '')` de sempre; alfanumérico VÁLIDO preserva as letras; alfanumérico inválido cai
// nos dígitos como hoje (não se fabrica documento). Este arquivo NÃO é espelho da edge — só o
// `cnpj-alfanumerico.ts` é, e ele fica intocado.
import { normalizarDocumento } from './cnpj-alfanumerico';

/**
 * Chave para casar `profiles.document` (hooks de pedido). Era `replace(/\D/g,'')` + `length >= 11`;
 * a conta de DÍGITOS barrava o alfanumérico (12.ABC.345/01DE-35 tem 9 dígitos). Normalizado, o
 * alfanumérico válido tem 14 chars → passa pelo mesmo `>= 11`; o inválido vira dígitos e cai como antes.
 */
export function chaveDocumentoParaBusca(doc: unknown): string | null {
  const chave = normalizarDocumento(doc);
  return chave.length >= 11 ? chave : null;
}

/**
 * Profile.tsx: `undefined` = campo NÃO editado → não entra no update (o que a edge preservou fica);
 * editado → normalizado, ou `null` quando esvaziado (era `editDocument?.replace(/\D/g,'') || null`).
 */
export function documentoEditadoParaGravar(
  editado: string,
  original: string | null | undefined,
): string | null | undefined {
  if (editado === (original ?? '')) return undefined;
  return normalizarDocumento(editado) || null;
}

/** Rótulo "Razão Social"/"Nome Fantasia" do signup — era `replace(/\D/g,'').length > 11`. */
export function ehDocumentoPessoaJuridica(doc: string): boolean {
  return normalizarDocumento(doc).length > 11;
}
