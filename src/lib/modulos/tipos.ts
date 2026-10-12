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
  /**
   * Ciclo de vida (M-41). `congelado` = rota e navegação escondidas, código intacto, sem correção.
   * `arquivado` = só depois do fim do congelamento, se seguir sem uso. Ver congelamento.ts.
   */
  status: StatusModulo;
  /** Obrigatório quando `status !== "ativo"` — prazo e motivo, nunca congelamento sem fim. */
  congelamento?: Congelamento;
  /** Congelamento PARCIAL de um módulo ativo (ex.: picking dentro do estoque-recebimento). */
  rotasCongeladas?: Congelamento & { prefixos: string[] };
};

export type StatusModulo = "ativo" | "congelado" | "arquivado";

/** Datas ISO (AAAA-MM-DD). `ate` = `desde` + 90 dias (o gate confere). */
export type Congelamento = { desde: string; ate: string; motivo: string };

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
