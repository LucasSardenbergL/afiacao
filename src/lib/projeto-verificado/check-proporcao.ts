// Check de Proporção ("cesta"): a compra de um projeto contém os componentes do
// sistema Sayerlack na proporção técnica mínima? É a trava que transforma "o ledger
// só vê a cor" numa prova de SISTEMA (spec v2 §5). Doutrina "ausente ≠ zero":
// componente comprado fora da Colacor (`externo`) NÃO conta como documentado.
// Os VALORES de proporção vêm do discovery (D3); aqui só vive a lógica.

export type TipoComponente = 'acabamento' | 'fundo' | 'catalisador' | 'diluente';
export type ComponenteNaoAcabamento = Exclude<TipoComponente, 'acabamento'>;

/** Um item comprado e vinculado ao projeto. */
export interface ItemCesta {
  tipo: TipoComponente;
  litros: number;
  /** 'colacor' = vendido/dosado por nós (conta); 'externo' = comprado fora (não conta). */
  origem: 'colacor' | 'externo';
}

/** Requisito técnico do sistema: litros mínimos de cada componente por litro de acabamento. */
export interface RequisitoSistema {
  proporcaoMinima: Partial<Record<ComponenteNaoAcabamento, number>>;
}

export interface Faltante {
  tipo: TipoComponente;
  requeridoL: number;
  presenteL: number;
}

export interface ResultadoProporcao {
  litrosAcabamento: number;
  atende: boolean;
  faltantes: Faltante[];
  temComponenteExterno: boolean;
}

function somaColacor(cesta: ItemCesta[], tipo: TipoComponente): number {
  return cesta
    .filter((i) => i.tipo === tipo && i.origem === 'colacor')
    .reduce((acc, i) => acc + i.litros, 0);
}

export function avaliarProporcao(
  cesta: ItemCesta[],
  sistema: RequisitoSistema,
): ResultadoProporcao {
  const litrosAcabamento = somaColacor(cesta, 'acabamento');
  const temComponenteExterno = cesta.some((i) => i.origem === 'externo');

  // Sem acabamento Colacor não há o que documentar (ausente ≠ zero): não inventa faltantes.
  if (litrosAcabamento <= 0) {
    return { litrosAcabamento: 0, atende: false, faltantes: [], temComponenteExterno };
  }

  const faltantes: Faltante[] = [];
  for (const [tipo, fator] of Object.entries(sistema.proporcaoMinima) as Array<
    [ComponenteNaoAcabamento, number]
  >) {
    const requeridoL = litrosAcabamento * fator;
    const presenteL = somaColacor(cesta, tipo);
    if (presenteL < requeridoL) {
      faltantes.push({ tipo, requeridoL, presenteL });
    }
  }

  return { litrosAcabamento, atende: faltantes.length === 0, faltantes, temComponenteExterno };
}
