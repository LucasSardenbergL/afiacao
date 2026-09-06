// O CONTADOR DE EFEITO — o instrumento do teste decisivo.
//
// "Zero efeito" só é uma afirmação sobre o mundo se o contador for capaz de ver o efeito quando ele
// acontece. Por isso todo veredito do runner vem PAREADO com um controle positivo: o mesmo bundle,
// com credencial que o autorize, tem de fazer o contador subir. Contador cego produz zero igualzinho.
export const contador = {
  efeitos: 0,
  fetches: 0,
  chamadas: [] as string[],
  fetchUrls: [] as string[],
};

export function zerar(): void {
  contador.efeitos = 0;
  contador.fetches = 0;
  contador.chamadas.length = 0;
  contador.fetchUrls.length = 0;
}

/**
 * Proxy que conta TODA chamada de método e todo `new` como efeito, e resolve `await` como uma
 * resposta PostgREST vazia — o bundle segue executando em vez de estourar na primeira linha, que é
 * o que faz o controle positivo alcançar o fundo do fluxo real.
 *
 * Criar o client NÃO conta (é configuração); `client.from("t").select()` conta 2, e é isso que
 * distingue "não tocou em nada" de "leu o banco".
 */
export function proxy(caminho: string): unknown {
  const alvo = function () {};
  return new Proxy(alvo, {
    get(_t, prop) {
      if (prop === "then") {
        return (res: (v: unknown) => void) => res({ data: [], error: null, count: 0, status: 200 });
      }
      if (prop === Symbol.toPrimitive || prop === "toString" || prop === "toJSON") {
        return () => caminho;
      }
      return proxy(`${caminho}.${String(prop)}`);
    },
    apply(_t, _this, _args) {
      contador.efeitos++;
      contador.chamadas.push(caminho);
      return proxy(`${caminho}()`);
    },
    construct(_t, _args) {
      contador.efeitos++;
      contador.chamadas.push(`new ${caminho}`);
      return proxy(`${caminho}#`) as object;
    },
  });
}
