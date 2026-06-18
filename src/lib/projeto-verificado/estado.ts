// Escada de estados do Projeto Verificado (spec v2 §4). Substitui o "verde" único
// por estados nomeados pelo que CADA UM atesta — anti-sobrevenda. Função pura.
// Ordem (compra → execução → auditoria):
//   pendente_incompleto < cor_dosada_verificada < sistema_documentado
//   < evidencia_recebida < conformidade_assistida
// Exceções (não-ordinais): divergencia_encontrada (terminal), componente_externo_declarado.

export type EstadoProjeto =
  | 'pendente_incompleto'
  | 'cor_dosada_verificada'
  | 'sistema_documentado'
  | 'evidencia_recebida'
  | 'conformidade_assistida'
  | 'divergencia_encontrada'
  | 'componente_externo_declarado';

/** Fatos comprovados sobre o projeto (alimentados pela persistência + Check de Proporção). */
export interface FatosProjeto {
  /** Há ao menos uma dosagem Sayersystem/Colacor vinculada ao projeto. */
  corDosadaVinculada: boolean;
  /** Check de Proporção atende (ResultadoProporcao.atende). */
  proporcaoAtende: boolean;
  /** Algum componente foi comprado fora da Colacor (ResultadoProporcao.temComponenteExterno). */
  temComponenteExterno: boolean;
  /** Chegaram as fotos mínimas (lacre/etiqueta + lata aberta na peça). */
  evidenciasMinimasRecebidas: boolean;
  /** Passou por revisão humana / amostra-testemunha / auditoria. */
  revisaoHumanaConcluida: boolean;
  /** Há divergência registrada (contestação, lote incompatível, etc.). */
  divergencia: boolean;
}

export function calcularEstado(f: FatosProjeto): EstadoProjeto {
  if (f.divergencia) return 'divergencia_encontrada';
  if (!f.corDosadaVinculada) return 'pendente_incompleto';

  // Cor vinculada, mas comprou parte fora: reconhece a cor, não sobe a "sistema documentado".
  if (f.temComponenteExterno) return 'componente_externo_declarado';

  // Sem sistema documentado (proporção falha), nada de execução eleva o estado.
  if (!f.proporcaoAtende) return 'cor_dosada_verificada';

  if (f.revisaoHumanaConcluida) return 'conformidade_assistida';
  if (f.evidenciasMinimasRecebidas) return 'evidencia_recebida';
  return 'sistema_documentado';
}
