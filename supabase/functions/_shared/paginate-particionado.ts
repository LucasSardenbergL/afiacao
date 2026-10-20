// Keyset PARTICIONADO por faixa de uuid — irmão de `fetchAllKeyset` (./paginate.ts).
//
// Mora em arquivo PRÓPRIO, e não em `paginate.ts`, de propósito: `paginate.ts` e
// `leitura-critica.ts` estão no fecho de ~29 edges, e o `fonte` da sonda é o hash do fecho
// transitivo. Acrescentar aqui algo que só a `fin-cashflow-engine` usa mudaria o `fonte` das 29
// e o ledger pediria 28 deploys sem nenhuma delas mudar de comportamento (o fan-out de
// `docs/historico/deploy-redundante-ledger-e-cron-de-sonda.md` §1.2). Pelo mesmo motivo as
// violações daqui reusam códigos JÁ permitidos em `leitura-critica.ts` — o modo exato vai em
// `cause` (ver as guardas abaixo).
import { FalhaLeituraCritica, type ErroPostgrest } from "./leitura-critica.ts";
import { fetchAllKeyset } from "./paginate.ts";

/** Uuid na forma que o Postgres SERIALIZA (minúsculo, hífens fixos) — a única em que a ordem de
 *  string do JS coincide com a ordem do tipo `uuid` (memcmp dos 16 bytes). */
const UUID_CANONICO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 8 faixas de mesmo tamanho no espaço do uuid: [-∞,2…), [2…,4…), …, [e…,+∞). */
export const LIMITES_UUID_8: readonly string[] = ['2', '4', '6', '8', 'a', 'c', 'e']
  .map((h) => `${h}0000000-0000-0000-0000-000000000000`);

/** Executa `fn` respeitando um teto de requisições em voo. */
export type Limitador = <R>(fn: () => PromiseLike<R>) => Promise<R>;

/**
 * Semáforo FIFO de requisições em voo. Um por INVOCAÇÃO, compartilhado entre as leituras
 * particionadas dela: o teto que importa é o da invocação inteira (CR + CP juntas), não o de cada
 * tabela — o cron do snapshot dispara os 3 cenários de uma empresa no mesmo minuto, e o esgotamento
 * do pool do PostgREST volta como 503/504 que a edge transforma em 500 (challenge Codex do v1.7).
 */
export function criarLimitador(teto: number): Limitador {
  if (!Number.isInteger(teto) || teto < 1) throw new Error(`teto de concorrência inválido: ${teto}`);
  let emVoo = 0;
  const fila: Array<() => void> = [];
  const liberar = () => {
    emVoo--;
    const proximo = fila.shift();
    if (proximo) proximo();
  };
  return <R>(fn: () => PromiseLike<R>) =>
    new Promise<R>((resolve, reject) => {
      const rodar = () => {
        emVoo++;
        let p: PromiseLike<R>;
        try {
          p = fn();
        } catch (e) {
          liberar();
          reject(e);
          return;
        }
        Promise.resolve(p).then(
          (v) => { liberar(); resolve(v); },
          (e) => { liberar(); reject(e); },
        );
      };
      if (emVoo < teto) rodar();
      else fila.push(rodar);
    });
}

/** Faixa `[de, ate)` por VALOR da chave; `null` = sem limite naquela ponta. */
export interface FaixaUuid {
  de: string | null;
  ate: string | null;
}

/**
 * Keyset PARTICIONADO por faixa de uuid — `fetchAllKeyset` em N faixas CONCORRENTES.
 *
 * Por quê: `fetchAll` paga uma ida e volta por página EM SEQUÊNCIA, e a latência é da rede e
 * da serialização, não do SQL. Medido em prod (2026-10-20, `fin-cashflow-engine` v1.6): colacor
 * 19–22 s para 29.219 títulos de CR (31 páginas a ~0,6 s), e cada página custava ~50 ms no banco
 * por causa do OFFSET. Aqui as faixas correm em paralelo (≈ páginas/N idas em série) e cada página
 * é um index scan na pkey a partir do cursor (~2 ms medido, sem OFFSET).
 *
 * Por que faixa por VALOR, e não N páginas de OFFSET concorrentes: o uuid v4 cai em QUALQUER
 * posição, então um INSERT do sync durante a leitura desloca o offset e uma linha é lida duas
 * vezes ou pulada — o offset sequencial já tinha esse defeito, o paralelo só mudaria a janela.
 * A faixa por valor não se desloca, e dentro dela o keyset não pula nem repete. Não é snapshot
 * transacional (ninguém nesta leitura é); é a garantia de `fetchAllKeyset` estendida a N faixas.
 *
 * CONTRATO do `build`: aplicar `.gte(chave, faixa.de)` se `de !== null`, `.lt(chave, faixa.ate)`
 * se `ate !== null`, `.gt(chave, cursor)` se `cursor !== null`, `.order(chave)` ASCENDENTE e
 * `.limit(limite)`. A saída é a concatenação das faixas em ordem — ordem global ascendente da
 * chave, a mesma do `.order('id').range()` que este helper substitui.
 *
 * Fail-closed, as três guardas que tornam o contrato verificável e não só documentado:
 *   - chave fora do uuid canônico → `KEYSET_FORA_DE_ORDEM` (com maiúscula ou sem hífen a
 *     ordem de string do JS deixa de ser a do Postgres, e o cursor pularia linhas);
 *   - linha fora da sua faixa → `KEYSET_PAGINA_SOBREPOSTA` (o filtro de faixa esquecido devolveria
 *     cada linha N vezes, e o somatório do caixa sairia N vezes maior com cara de leitura válida);
 *   - qualquer faixa que falhe (erro, malformada, violação do keyset) rejeita a leitura INTEIRA:
 *     acumulado parcial de 7 de 8 faixas é a truncagem silenciosa com outro formato.
 */
export async function fetchAllParticionadoUuid<T>(
  build: (
    faixa: FaixaUuid,
    cursor: string | null,
    limite: number,
  ) => PromiseLike<{ data: T[] | null; error: ErroPostgrest | null }>,
  chave: (linha: T) => unknown,
  label: string,
  opts: { limitador?: Limitador; limites?: readonly string[] } = {},
): Promise<T[]> {
  const limites = opts.limites ?? LIMITES_UUID_8;
  // Sem limitador explícito, teto = nº de faixas (cada faixa já é serial por dentro).
  const limitador = opts.limitador ?? criarLimitador(limites.length + 1);
  // Limites são constante do CÓDIGO, nunca dado: limite fora de ordem criaria faixas que se
  // sobrepõem (duplicata) ou um buraco (linha perdida). Erro de programação → lança cedo.
  for (let i = 0; i < limites.length; i++) {
    if (!UUID_CANONICO.test(limites[i]) || (i > 0 && limites[i] <= limites[i - 1])) {
      throw new Error(`${label}: limites de partição inválidos (precisam ser uuid canônico, estritamente crescentes)`);
    }
  }
  const faixas: FaixaUuid[] = [null, ...limites].map((de, i) => ({ de, ate: limites[i] ?? null }));

  // Uma faixa falhou → as irmãs param de pedir página. `Promise.all` já rejeita na 1ª falha, mas
  // não cancela as outras, que seguiriam paginando contra um banco possivelmente já em apuros.
  // A interrupção LANÇA (nunca devolve `[]`): a rejeição dela é engolida pelo `Promise.all` já
  // rejeitado, e o caller vê só a falha original.
  let falhou = false;
  const interrompida = () =>
    new FalhaLeituraCritica(label, { code: 'REJEITADA', message: 'leitura interrompida: outra faixa falhou' });

  const partes = await Promise.all(faixas.map((faixa) =>
    fetchAllKeyset<T, string>(
      (cursor, limite) => {
        if (falhou) throw interrompida();
        return limitador(() => {
          if (falhou) throw interrompida();
          return build(faixa, cursor, limite);
        });
      },
      (linha) => {
        const k = chave(linha);
        // Ausente segue para a guarda de `fetchAllKeyset` (KEYSET_CHAVE_AUSENTE), que diz o conserto.
        if (k === null || k === undefined) return k as unknown as string;
        if (typeof k !== 'string' || !UUID_CANONICO.test(k)) {
          // Código `KEYSET_FORA_DE_ORDEM`: é o que a chave não canônica QUEBRA (a ordem de string
          // deixa de ser a do Postgres). O modo exato fica em `cause`.
          throw new FalhaLeituraCritica(label, {
            code: 'KEYSET_FORA_DE_ORDEM',
            message: `chave ${JSON.stringify(k)} não é uuid canônico minúsculo`,
          });
        }
        if ((faixa.de !== null && k < faixa.de) || (faixa.ate !== null && k >= faixa.ate)) {
          // Código `KEYSET_PAGINA_SOBREPOSTA`: a linha pertence a OUTRA faixa, que também a lê —
          // é a linha repetida entre páginas, e o conserto é o mesmo (o filtro do build). O modo
          // exato e o valor da chave (dado da LINHA) vão para `cause`, nunca para a mensagem.
          throw new FalhaLeituraCritica(label, {
            code: 'KEYSET_PAGINA_SOBREPOSTA',
            message: `chave ${k} fora da faixa [${faixa.de ?? '-∞'}, ${faixa.ate ?? '+∞'}) — o build precisa aplicar .gte(de)/.lt(ate)`,
          });
        }
        return k;
      },
      label,
    ).catch((e) => {
      falhou = true;
      throw e;
    })
  ));
  return partes.flat();
}
