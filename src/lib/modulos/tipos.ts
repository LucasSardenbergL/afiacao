// Tipos do manifesto de módulos (F1 da modularização).
// Spec: docs/superpowers/specs/2026-07-08-modularizacao-f1-manifesto-boletim-design.md
export type ModuloApp = {
  id: string;
  nome: string;
  kind: "negocio" | "plataforma";
  rotaPrefixos: string[];
  gates: string[];
  /** Globs de código (gramática restrita — ver padrao.ts). Ownership é EXCLUSIVO: 1 dono por arquivo. */
  codigo: string[];
  /** Globs dos arquivos de teste do módulo (para rodar isolado e p/ atribuição no boletim). */
  testes: string[];
  risco: { moneyPath: boolean; offlineFirst: boolean; authSensitive: boolean };
};

/** Dívida de classificação VISÍVEL e datada — nunca bucket silencioso. */
export type NaoClassificado = { path: string; motivo: string; desde: string };

export type ProblemaManifesto = {
  tipo:
    | "orfao"
    | "sobreposicao"
    | "glob-morto"
    | "nao-classificado-inexistente"
    | "nao-classificado-com-dono";
  detalhe: string;
};
