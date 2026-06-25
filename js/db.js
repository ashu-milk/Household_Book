// db.js — IndexedDB を薄くラップしたデータ層
// transactions: { id, date(YYYY-MM-DD), type('card'|'cash'), cardName, category, subtype, payee, amount, memo, recurringId, createdAt }
// categories:   { id, name, order }
// cards:        { id, name, order }
// subtypes:     { id, name, order }  -- 「種別」(衣服・美容・歯科・ガソリン代 等)
// payees:       { id, name, order }  -- 「支払い先」(店名・病院名 等)
// recurring:    { id, name, amount, type('card'|'cash'), cardName, category, subtype, payee,
//                 payDay(1-31), startMonth(YYYY-MM), endDate(YYYY-MM-DD|''), createdAt }
//               -- 定期支払い(毎月定額で自動入力する固定費)の設定

const DB_NAME = 'kakeibo-db';
const DB_VERSION = 4;
let dbPromise = null;

const DEFAULT_CATEGORIES = [
  '食費', '日用品', '交通費', '娯楽', '衣服・美容',
  '医療', '住居・設備', '通信費', '教育', 'その他'
];

const DEFAULT_SUBTYPES = [
  '衣服', '美容', '歯科', '内科', '皮膚科', 'ガソリン代', '駐車場代'
];

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('transactions')) {
        const store = db.createObjectStore('transactions', { keyPath: 'id' });
        store.createIndex('date', 'date');
        store.createIndex('type', 'type');
        store.createIndex('category', 'category');
      }
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('cards')) {
        db.createObjectStore('cards', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('subtypes')) {
        db.createObjectStore('subtypes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('payees')) {
        db.createObjectStore('payees', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('recurring')) {
        db.createObjectStore('recurring', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const DB = {
  async init() {
    await openDB();
    const cats = await this.listCategories();
    if (cats.length === 0) {
      let order = 0;
      for (const name of DEFAULT_CATEGORIES) {
        await this.addCategory({ name, order: order++ });
      }
    }
    const subtypes = await this.listSubtypes();
    if (subtypes.length === 0) {
      let order = 0;
      for (const name of DEFAULT_SUBTYPES) {
        await this.addSubtype({ name, order: order++ });
      }
    }
  },

  // ---- transactions ----
  async addTransaction(data) {
    const store = await tx('transactions', 'readwrite');
    const record = {
      id: genId(),
      date: data.date,
      type: data.type,
      cardName: data.cardName || '',
      category: data.category,
      subtype: data.subtype || '',
      payee: data.payee || '',
      amount: Number(data.amount),
      memo: data.memo || '',
      recurringId: data.recurringId || '',
      createdAt: Date.now()
    };
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async updateTransaction(record) {
    const store = await tx('transactions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async deleteTransaction(id) {
    const store = await tx('transactions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async listTransactions() {
    const store = await tx('transactions', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => (a.date < b.date ? 1 : -1)));
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async clearTransactions() {
    const store = await tx('transactions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // ---- categories ----
  async addCategory(data) {
    const store = await tx('categories', 'readwrite');
    const record = { id: genId(), name: data.name, order: data.order ?? 999 };
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async updateCategory(record) {
    const store = await tx('categories', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async renameCategoryInTransactions(oldName, newName) {
    const store = await tx('transactions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result.filter(t => t.category === oldName);
        let remaining = all.length;
        if (remaining === 0) { resolve(); return; }
        all.forEach(t => {
          const putReq = store.put({ ...t, category: newName });
          putReq.onsuccess = () => { remaining--; if (remaining === 0) resolve(); };
          putReq.onerror = (e) => reject(e.target.error);
        });
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async deleteCategory(id) {
    const store = await tx('categories', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async listCategories() {
    const store = await tx('categories', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.order - b.order));
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // ---- cards (クレジットカードの管理) ----
  async addCard(data) {
    const store = await tx('cards', 'readwrite');
    const record = { id: genId(), name: data.name, order: data.order ?? 999 };
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async updateCard(record) {
    const store = await tx('cards', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async renameCardInTransactions(oldName, newName) {
    const store = await tx('transactions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result.filter(t => t.cardName === oldName);
        let remaining = all.length;
        if (remaining === 0) { resolve(); return; }
        all.forEach(t => {
          const putReq = store.put({ ...t, cardName: newName });
          putReq.onsuccess = () => { remaining--; if (remaining === 0) resolve(); };
          putReq.onerror = (e) => reject(e.target.error);
        });
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async deleteCard(id) {
    const store = await tx('cards', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async listCards() {
    const store = await tx('cards', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.order - b.order));
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // ---- subtypes (種別) ----
  async addSubtype(data) {
    const store = await tx('subtypes', 'readwrite');
    const record = { id: genId(), name: data.name, order: data.order ?? 999 };
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async updateSubtype(record) {
    const store = await tx('subtypes', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async renameSubtypeInTransactions(oldName, newName) {
    const store = await tx('transactions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result.filter(t => t.subtype === oldName);
        let remaining = all.length;
        if (remaining === 0) { resolve(); return; }
        all.forEach(t => {
          const putReq = store.put({ ...t, subtype: newName });
          putReq.onsuccess = () => { remaining--; if (remaining === 0) resolve(); };
          putReq.onerror = (e) => reject(e.target.error);
        });
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async deleteSubtype(id) {
    const store = await tx('subtypes', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async listSubtypes() {
    const store = await tx('subtypes', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.order - b.order));
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // ---- payees (支払い先) ----
  async addPayee(data) {
    const store = await tx('payees', 'readwrite');
    const record = { id: genId(), name: data.name, order: data.order ?? 999 };
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async updatePayee(record) {
    const store = await tx('payees', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async renamePayeeInTransactions(oldName, newName) {
    const store = await tx('transactions', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result.filter(t => t.payee === oldName);
        let remaining = all.length;
        if (remaining === 0) { resolve(); return; }
        all.forEach(t => {
          const putReq = store.put({ ...t, payee: newName });
          putReq.onsuccess = () => { remaining--; if (remaining === 0) resolve(); };
          putReq.onerror = (e) => reject(e.target.error);
        });
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async deletePayee(id) {
    const store = await tx('payees', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async listPayees() {
    const store = await tx('payees', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.order - b.order));
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // ---- recurring (定期支払い: 毎月定額の自動入力設定) ----
  async addRecurring(data) {
    const store = await tx('recurring', 'readwrite');
    const record = {
      id: genId(),
      name: data.name,
      amount: Number(data.amount),
      type: data.type,
      cardName: data.cardName || '',
      category: data.category,
      subtype: data.subtype || '',
      payee: data.payee || '',
      payDay: Number(data.payDay),
      startMonth: data.startMonth,
      endDate: data.endDate || '',
      createdAt: Date.now()
    };
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async updateRecurring(record) {
    const store = await tx('recurring', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve(record);
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async deleteRecurring(id) {
    const store = await tx('recurring', 'readwrite');
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    });
  },

  async listRecurring() {
    const store = await tx('recurring', 'readonly');
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result.sort((a, b) => a.payDay - b.payDay));
      req.onerror = (e) => reject(e.target.error);
    });
  },

  // ---- bulk import/export ----
  async exportAll() {
    const [transactions, categories, cards, subtypes, payees, recurring] = await Promise.all([
      this.listTransactions(),
      this.listCategories(),
      this.listCards(),
      this.listSubtypes(),
      this.listPayees(),
      this.listRecurring()
    ]);
    return {
      schema: 'kakeibo-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      categories,
      cards,
      subtypes,
      payees,
      recurring,
      transactions
    };
  },

  async importAll(payload, mode = 'merge') {
    if (!payload || payload.schema !== 'kakeibo-export') {
      throw new Error('対応していないファイル形式です');
    }
    if (mode === 'replace') {
      await this.clearTransactions();
      const catStore = await tx('categories', 'readwrite');
      await new Promise((resolve, reject) => {
        const req = catStore.clear();
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
      const cardStore = await tx('cards', 'readwrite');
      await new Promise((resolve, reject) => {
        const req = cardStore.clear();
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
      const subtypeStore = await tx('subtypes', 'readwrite');
      await new Promise((resolve, reject) => {
        const req = subtypeStore.clear();
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
      const payeeStore = await tx('payees', 'readwrite');
      await new Promise((resolve, reject) => {
        const req = payeeStore.clear();
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
      const recurringStore = await tx('recurring', 'readwrite');
      await new Promise((resolve, reject) => {
        const req = recurringStore.clear();
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
    }

    const catStore = await tx('categories', 'readwrite');
    for (const cat of payload.categories || []) {
      await new Promise((resolve, reject) => {
        const req = catStore.put(cat);
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
    }

    const cardStore = await tx('cards', 'readwrite');
    for (const card of payload.cards || []) {
      await new Promise((resolve, reject) => {
        const req = cardStore.put(card);
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
    }

    const subtypeStore = await tx('subtypes', 'readwrite');
    for (const st of payload.subtypes || []) {
      await new Promise((resolve, reject) => {
        const req = subtypeStore.put(st);
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
    }

    const payeeStore = await tx('payees', 'readwrite');
    for (const p of payload.payees || []) {
      await new Promise((resolve, reject) => {
        const req = payeeStore.put(p);
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
    }

    const recurringStore = await tx('recurring', 'readwrite');
    for (const r of payload.recurring || []) {
      await new Promise((resolve, reject) => {
        const req = recurringStore.put(r);
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
    }

    const txStore = await tx('transactions', 'readwrite');
    for (const t of payload.transactions || []) {
      await new Promise((resolve, reject) => {
        const req = txStore.put(t);
        req.onsuccess = resolve;
        req.onerror = (e) => reject(e.target.error);
      });
    }

    return {
      importedTransactions: (payload.transactions || []).length,
      importedCategories: (payload.categories || []).length,
      importedCards: (payload.cards || []).length,
      importedSubtypes: (payload.subtypes || []).length,
      importedPayees: (payload.payees || []).length,
      importedRecurring: (payload.recurring || []).length
    };
  }
};
