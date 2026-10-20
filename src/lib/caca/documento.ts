/**
 * Utilitários de normalização de documento (CNPJ / CPF) da Caça.
 *
 * Desde 2026-10-20 (migration 20261020130000) a chave é a MESMA do resto do app: só-dígitos para
 * CPF/CNPJ numérico (byte-idêntico ao `.replace(/\D/g, '')` de antes) e, para CNPJ alfanumérico
 * RFB VÁLIDO, as 14 posições em maiúsculas — é o que `v_caca_*` produzem com `normalizar_documento()`.
 * Alfanumérico inválido cai nos dígitos, como sempre (não se fabrica documento).
 * Exemplos:
 *   "12.345.678/0001-90" → "12345678000190"
 *   "12.abc.345/01de-35" → "12ABC34501DE35"
 *   null / "" → ""
 *   "abc" → ""
 */
export { normalizarDocumento } from '@/lib/omie/cnpj-alfanumerico';
