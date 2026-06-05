let lensActive = false;
export function setLensActive(v: boolean): void { lensActive = v; }
export function isLensActive(): boolean { return lensActive; }

export class LensReadOnlyError extends Error {
  constructor(public readonly op: string) {
    super(`Ação "${op}" indisponível na lente (somente leitura). Saia da lente para editar.`);
    this.name = 'LensReadOnlyError';
  }
}

const BLOCKED_QUERY = new Set(['insert', 'update', 'upsert', 'delete']);
const BLOCKED_STORAGE = new Set(['upload', 'remove', 'move', 'copy', 'createSignedUploadUrl', 'uploadToSignedUrl']);

function guardMethods<T extends object>(obj: T, blocked: Set<string>): T {
  return new Proxy(obj, {
    get(targetObj, prop, receiver) {
      const orig = Reflect.get(targetObj, prop, receiver);
      if (typeof prop === 'string' && blocked.has(prop) && typeof orig === 'function') {
        return (...args: unknown[]) => {
          if (lensActive) throw new LensReadOnlyError(prop);
          return (orig as (...a: unknown[]) => unknown).apply(targetObj, args);
        };
      }
      return orig;
    },
  });
}

/**
 * Envolve o supabase client para bloquear mutações PostgREST e de storage enquanto
 * a lente está ativa. NÃO é barreira de segurança (o servidor ainda autoriza o
 * master) — torna o "somente leitura" verdade no cliente. RPCs passam (a própria
 * lente usa RPCs de leitura); RPCs mutantes raras são guardadas explicitamente na
 * Fase 2 quando a auditoria as identifica.
 *
 * Retorna `T` (mesmo tipo do client original) para que o chamador acesse os métodos
 * de query builder (insert/select/etc.) com a tipagem correta. O Proxy intercepta
 * em runtime; para o TypeScript a API pública é idêntica ao client passado.
 *
 * Restrição de constraint: `from` e `storage.from` devem retornar um objeto
 * (não `void` ou primitivo), e seus parâmetros devem ser compatíveis com o chamador.
 * O Proxy preserva ambas as propriedades sem alterar os tipos de retorno.
 */
export function createLensGuardedClient<
  QB extends object,
  BK extends object,
  T extends { from: (...a: never[]) => QB; storage: { from: (...a: never[]) => BK } }
>(client: T): T {
  return new Proxy(client, {
    get(targetObj, prop, receiver) {
      if (prop === 'from') {
        return (...args: unknown[]) =>
          guardMethods(
            (targetObj.from as (...a: unknown[]) => QB)(...args),
            BLOCKED_QUERY
          );
      }
      if (prop === 'storage') {
        const storage = Reflect.get(targetObj, prop, receiver) as unknown as { from: (...a: unknown[]) => BK };
        return new Proxy(storage, {
          get(sObj, sProp, sRecv) {
            if (sProp === 'from') {
              return (...args: unknown[]) =>
                guardMethods(
                  (sObj.from as (...a: unknown[]) => BK)(...args),
                  BLOCKED_STORAGE
                );
            }
            return Reflect.get(sObj, sProp, sRecv);
          },
        });
      }
      return Reflect.get(targetObj, prop, receiver);
    },
  }) as T;
}
