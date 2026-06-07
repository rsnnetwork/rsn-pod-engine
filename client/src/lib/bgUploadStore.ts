// IndexedDB persistence for the ONE custom background upload. blob: URLs die on
// refresh (RSN users refresh constantly mid-event), so the image bytes live in
// IDB and the persisted preference stores the CUSTOM_BG_URL sentinel; the engine
// rehydrates an object URL from here on boot.
const DB_NAME = 'rsn-bg';
const STORE = 'images';
const KEY = 'custom';

/** Sentinel used in the persisted preference for the user's custom upload. */
export const CUSTOM_BG_URL = 'idb://custom-bg';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveCustomBg(blob: Blob): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(blob, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadCustomBg(): Promise<Blob | null> {
  try {
    const db = await openDb();
    try {
      return await new Promise<Blob | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve((req.result as Blob) ?? null);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  } catch {
    return null; // private mode / quota — custom upload just won't survive refresh
  }
}
