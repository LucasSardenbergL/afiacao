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
// Inclui `update` (PUT em StorageFileApi.update) além de upload/remove/move/copy.
const BLOCKED_STORAGE = new Set(['upload', 'update', 'remove', 'move', 'copy', 'createSignedUploadUrl', 'uploadToSignedUrl']);

/**
 * Resultado "bloqueado": encadeável (qualquer método retorna a si mesmo) E thenable
 * (rejeita com LensReadOnlyError). Não lançamos síncrono de propósito: várias telas
 * de leitura disparam uma mutação no mount (ex.: snapshot via `.upsert(...).then(...)`)
 * e um throw síncrono escaparia do `.then/.catch`, quebrando a leitura. Assim,
 * `.insert().select().single()` encadeia e o `await`/`.then`/`.catch` trata a rejeição.
 * `Promise.reject` só é materializada quando há um consumidor (then/catch/finally),
 * evitando unhandledRejection em chamadas fire-and-forget.
 */
function blockedResult(op: string): unknown {
  const err = new LensReadOnlyError(op);
  const proxy: unknown = new Proxy({} as object, {
    get(_t, prop): unknown {
      if (prop === 'then') {
        return (onF?: ((v: unknown) => unknown) | null, onR?: ((e: unknown) => unknown) | null) =>
          Promise.reject(err).then(onF ?? undefined, onR ?? undefined);
      }
      if (prop === 'catch') {
        return (onR?: ((e: unknown) => unknown) | null) => Promise.reject(err).catch(onR ?? undefined);
      }
      if (prop === 'finally') {
        return (onFin?: (() => void) | null) => Promise.reject(err).finally(onFin ?? undefined);
      }
      // Qualquer método de encadeamento (.select, .eq, .single, .maybeSingle, ...)
      // permanece bloqueado e continua encadeável.
      return () => proxy;
    },
  });
  return proxy;
}

function guardMethods<T extends object>(obj: T, blocked: Set<string>): T {
  return new Proxy(obj, {
    get(targetObj, prop, receiver) {
      const orig = Reflect.get(targetObj, prop, receiver);
      if (typeof prop === 'string' && blocked.has(prop) && typeof orig === 'function') {
        return (...args: unknown[]) => {
          if (lensActive) return blockedResult(prop);
          return (orig as (...a: unknown[]) => unknown).apply(targetObj, args);
        };
      }
      return orig;
    },
  });
}

/**
 * Bloqueia `functions.invoke` na lente. Edge Functions costumam ter efeito externo
 * (enviam WhatsApp/e-mail, gravam com service_role) — escapariam do guard de
 * PostgREST/storage. Em modo lente, `invoke` é tratado como mutação por padrão
 * (conservador). Se uma function de LEITURA precisar rodar na lente, vira allowlist
 * explícita na auditoria (Fase 1.5).
 */
function guardFunctions(functions: unknown): unknown {
  if (!functions || typeof functions !== 'object') return functions;
  return new Proxy(functions as object, {
    get(fObj, fProp, fRecv) {
      if (fProp === 'invoke') {
        const orig = Reflect.get(fObj, fProp, fRecv);
        if (typeof orig === 'function') {
          return (...args: unknown[]) => {
            if (lensActive) return blockedResult('functions.invoke');
            return (orig as (...a: unknown[]) => unknown).apply(fObj, args);
          };
        }
      }
      return Reflect.get(fObj, fProp, fRecv);
    },
  });
}

/**
 * Envolve o supabase client para bloquear mutações enquanto a lente está ativa:
 * PostgREST (`from().insert/update/upsert/delete`), storage (upload/update/remove/...)
 * e `functions.invoke`. NÃO é barreira de segurança (o servidor ainda autoriza o
 * master) — torna o "somente leitura" verdade no cliente. `select`, `rpc`, `auth`,
 * realtime e `storage` de leitura passam.
 *
 * Retorna `T` (mesmo tipo do client) para preservar a tipagem da API pública.
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
          guardMethods((targetObj.from as (...a: unknown[]) => QB)(...args), BLOCKED_QUERY);
      }
      if (prop === 'storage') {
        const storage = Reflect.get(targetObj, prop, receiver) as unknown as { from: (...a: unknown[]) => BK };
        return new Proxy(storage, {
          get(sObj, sProp, sRecv) {
            if (sProp === 'from') {
              return (...args: unknown[]) =>
                guardMethods((sObj.from as (...a: unknown[]) => BK)(...args), BLOCKED_STORAGE);
            }
            return Reflect.get(sObj, sProp, sRecv);
          },
        });
      }
      if (prop === 'functions') {
        return guardFunctions(Reflect.get(targetObj, prop, receiver));
      }
      return Reflect.get(targetObj, prop, receiver);
    },
  }) as T;
}
