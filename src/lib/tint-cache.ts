/**
 * Cache offline do catálogo tintométrico (scaffold para roadmap UX item #18).
 *
 * Wrapper minimalista sobre IndexedDB nativo (sem dependência de `idb` ou `dexie` para
 * manter a v1 leve). API estável o suficiente para uso pelas páginas; pode ser substituída
 * por wrapper mais robusto sem mudar callsites.
 *
 * O que esta v1 entrega:
 *  - Open/upgrade do DB com object stores `formulas`, `meta`
 *  - putAll/getAll por store
 *  - Versionamento via meta `last_synced_at`
 *  - Quota check via `navigator.storage.estimate()`
 *
 * O que NÃO está aqui (próximas iterações):
 *  - Sync incremental (precisa Edge function `tint-catalog-snapshot`)
 *  - Background sync via service worker
 *  - Compressão (catálogo de ~477k registros pode passar de 100MB)
 */

const DB_NAME = 'tint_catalog';
const DB_VERSION = 1;
const STORE_FORMULAS = 'formulas';
const STORE_META = 'meta';

export interface CachedFormula {
  id: string;
  cor_id: string;
  nome_cor: string;
  produto_id?: string;
  base_id?: string;
  volume_final_ml?: number;
  preco_final_sayersystem?: number;
  personalizada?: boolean;
  // ... outros campos serializados conforme schema do Supabase
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB não disponível neste ambiente'));
  }
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_FORMULAS)) {
        const store = db.createObjectStore(STORE_FORMULAS, { keyPath: 'id' });
        store.createIndex('cor_id', 'cor_id', { unique: false });
        store.createIndex('produto_id', 'produto_id', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function putFormulas(formulas: CachedFormula[]): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FORMULAS, STORE_META], 'readwrite');
    const store = tx.objectStore(STORE_FORMULAS);
    let count = 0;
    formulas.forEach((f) => {
      store.put(f);
      count++;
    });
    tx.objectStore(STORE_META).put({ key: 'last_synced_at', value: new Date().toISOString() });
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllFormulas(): Promise<CachedFormula[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_FORMULAS, 'readonly');
    const req = tx.objectStore(STORE_FORMULAS).getAll();
    req.onsuccess = () => resolve(req.result as CachedFormula[]);
    req.onerror = () => reject(req.error);
  });
}

export async function searchFormulasOffline(query: string, limit = 50): Promise<CachedFormula[]> {
  const all = await getAllFormulas();
  if (!query.trim()) return all.slice(0, limit);
  const q = query.toLowerCase();
  const matches = all.filter(
    (f) =>
      f.cor_id.toLowerCase().includes(q) ||
      (f.nome_cor && f.nome_cor.toLowerCase().includes(q)),
  );
  return matches.slice(0, limit);
}

export async function getLastSync(): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_META, 'readonly');
    const req = tx.objectStore(STORE_META).get('last_synced_at');
    req.onsuccess = () => resolve((req.result?.value as string | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

export async function clearCatalog(): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_FORMULAS, STORE_META], 'readwrite');
    tx.objectStore(STORE_FORMULAS).clear();
    tx.objectStore(STORE_META).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getStorageEstimate(): Promise<{ usageMB: number; quotaMB: number } | null> {
  if (typeof navigator === 'undefined' || !('storage' in navigator) || !navigator.storage.estimate) {
    return null;
  }
  const est = await navigator.storage.estimate();
  return {
    usageMB: est.usage ? est.usage / (1024 * 1024) : 0,
    quotaMB: est.quota ? est.quota / (1024 * 1024) : 0,
  };
}
