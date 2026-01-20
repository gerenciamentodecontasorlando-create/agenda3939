/* Agenda AH - app.js
   Offline-first, IndexedDB, calendário + dia + anexos + livro-caixa + exportação PDF via impressão.
*/
(() => {
  'use strict';

  // ===== Helpers =====
  const $ = (id) => document.getElementById(id);
  const fmtBR = new Intl.DateTimeFormat('pt-BR', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const pad2 = (n) => String(n).padStart(2,'0');
  const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  const parseISODate = (s) => {
    const [y,m,d] = s.split('-').map(Number);
    return new Date(y, m-1, d);
  };
  const toast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._tm);
    toast._tm = setTimeout(() => t.classList.remove('show'), 1800);
  };

  // ===== Install prompt =====
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('btnInstall').style.display = '';
  });
  $('btnInstall').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('btnInstall').style.display = 'none';
  });

  // ===== Service Worker =====
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(()=>{}));
  }

  // ===== IndexedDB =====
  const DB_NAME = 'agenda_ah_db';
  const DB_VER  = 1;
  let db;

  function openDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('entries')) {
          const s = d.createObjectStore('entries', { keyPath: 'date' }); // date = YYYY-MM-DD
          s.createIndex('updatedAt', 'updatedAt', { unique:false });
        }
        if (!d.objectStoreNames.contains('attachments')) {
          const s = d.createObjectStore('attachments', { keyPath: 'id' });
          s.createIndex('entryDate', 'entryDate', { unique:false });
          s.createIndex('createdAt', 'createdAt', { unique:false });
        }
        if (!d.objectStoreNames.contains('cash')) {
          const s = d.createObjectStore('cash', { keyPath: 'id' });
          s.createIndex('entryDate', 'entryDate', { unique:false });
          s.createIndex('createdAt', 'createdAt', { unique:false });
        }
        if (!d.objectStoreNames.contains('meta')) {
          d.createObjectStore('meta', { keyPath: 'k' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(store, mode='readonly'){ return db.transaction(store, mode).objectStore(store); }
  function id(){ return crypto.randomUUID ? crypto.randomUUID() : (Date.now()+'_'+Math.random().toString(16).slice(2)); }

  const DB = {
    async getEntry(date){
      return new Promise((res) => {
        const r = tx('entries').get(date);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      });
    },
    async putEntry(entry){
      return new Promise((res, rej) => {
        const r = tx('entries','readwrite').put(entry);
        r.onsuccess = () => res(true);
        r.onerror = () => rej(r.error);
      });
    },
    async deleteEntry(date){
      return new Promise((res) => {
        const r = tx('entries','readwrite').delete(date);
        r.onsuccess = () => res(true);
        r.onerror = () => res(false);
      });
    },
    async listEntriesByMonth(y, m){ // m 0-based
      const start = new Date(y,m,1);
      const end = new Date(y,m+1,1);
      const startISO = toISODate(start);
      const endISO = toISODate(end);
      return new Promise((res) => {
        const out = [];
        const store = tx('entries');
        const req = store.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return res(out);
          const k = cur.key;
          if (k >= startISO && k < endISO) out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => res(out);
      });
    },
    async listAttachmentsByDate(date){
      return new Promise((res) => {
        const out = [];
        const idx = tx('attachments').index('entryDate');
        const req = idx.openCursor(IDBKeyRange.only(date));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return res(out);
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => res(out);
      });
    },
    async putAttachment(att){
      return new Promise((res, rej) => {
        const r = tx('attachments','readwrite').put(att);
        r.onsuccess = () => res(true);
        r.onerror = () => rej(r.error);
      });
    },
    async deleteAttachment(attId){
      return new Promise((res) => {
        const r = tx('attachments','readwrite').delete(attId);
        r.onsuccess = () => res(true);
        r.onerror = () => res(false);
      });
    },
    async listCashByDate(date){
      return new Promise((res) => {
        const out = [];
        const idx = tx('cash').index('entryDate');
        const req = idx.openCursor(IDBKeyRange.only(date));
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) return res(out.sort((a,b)=>a.createdAt-b.createdAt));
          out.push(cur.value);
          cur.continue();
        };
        req.onerror = () => res(out);
      });
    },
    async putCash(item){
      return new Promise((res, rej) => {
        const r = tx('cash','readwrite').put(item);
        r.onsuccess = () => res(true);
        r.onerror = () => rej(r.error);
      });
    },
    async deleteCash(idv){
      return new Promise((res) => {
        const r = tx('cash','readwrite').delete(idv);
        r.onsuccess = () => res(true);
        r.onerror = () => res(false);
      });
    },
    async exportAll(){
      const all = {};
      all.entries = await new Promise((res)=> {
        const out=[]; const req=tx('entries').openCursor();
        req.onsuccess=()=>{const c=req.result; if(!c)return res(out); out.push(c.value); c.continue();};
        req.onerror=()=>res(out);
      });
      all.attachments = await new Promise((res)=> {
        const out=[]; const req=tx('attachments').openCursor();
        req.onsuccess=()=>{const c=req.result; if(!c)return res(out); out.push(c.value); c.continue();};
        req.onerror=()=>res(out);
      });
      all.cash = await new Promise((res)=> {
        const out=[]; const req=tx('cash').openCursor();
        req.onsuccess=()=>{const c=req.result; if(!c)return res(out); out.push(c.value); c.continue();};
        req.onerror=()=>res(out);
      });

      // Converte blobs para base64 (para backup/restore)
      const blobToB64 = (blob) => new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(blob);
      });
      for (const a of all.attachments){
        if (a && a.blob) {
          a.blobDataUrl = await blobToB64(a.blob);
          delete a.blob;
        }
      }
      return all;
    },
    async importAll(payload){
      // Limpa e restaura (simples e direto)
      const clearStore = (name) => new Promise((res)=> {
        const r = tx(name,'readwrite').clear();
        r.onsuccess=()=>res(true); r.onerror=()=>res(false);
      });
      await clearStore('entries');
      await clearStore('attachments');
      await clearStore('cash');

      const dataUrlToBlob = async (dataUrl) => {
        const r = await fetch(dataUrl);
        return await r.blob();
      };

      for (const e of (payload.entries||[])) await DB.putEntry(e);
      for (const a of (payload.attachments||[])) {
        if (a.blobDataUrl){
          a.blob = await dataUrlToBlob(a.blobDataUrl);
          delete a.blobDataUrl;
        }
        await DB.putAttachment(a);
      }
      for (const c of (payload.cash||[])) await DB.putCash(c);
    }
  };

  // ===== State =====
  const state = {
    viewY: new Date().getFullYear(),
    viewM: new Date().getMonth(),
    selected: toISODate(new Date()),
    monthEntries: new Map(), // date -> entry
    saving: false
  };

  // ===== UI Building =====
  function setMonthTitle(){
    const d = new Date(state.viewY, state.viewM, 1);
    const t = new Intl.DateTimeFormat('pt-BR', { month:'long', year:'numeric' }).format(d);
    $('monthTitle').textContent = t.charAt(0).toUpperCase() + t.slice(1);
  }

  function dayMetaText(dateISO){
    const d = parseISODate(dateISO);
    return fmtBR.format(d);
  }

  function renderCalendar(){
    setMonthTitle();
    const cal = $('calendar');
    cal.innerHTML = '';
    const first = new Date(state.viewY, state.viewM, 1);
    const startDow = first.getDay(); // 0=dom
    const daysInMonth = new Date(state.viewY, state.viewM+1, 0).getDate();

    // previous month padding
    const prevDays = startDow;
    const prevLastDay = new Date(state.viewY, state.viewM, 0).getDate();

    const cells = [];
    for (let i=prevDays; i>0; i--){
      const day = prevLastDay - i + 1;
      const d = new Date(state.viewY, state.viewM-1, day);
      cells.push({ iso: toISODate(d), num: day, muted:true });
    }
    for (let day=1; day<=daysInMonth; day++){
      const d = new Date(state.viewY, state.viewM, day);
      cells.push({ iso: toISODate(d), num: day, muted:false });
    }
    // next month padding to complete weeks
    while (cells.length % 7 !== 0){
      const idx = cells.length - (prevDays + daysInMonth);
      const day = idx + 1;
      const d = new Date(state.viewY, state.viewM+1, day);
      cells.push({ iso: toISODate(d), num: day, muted:true });
    }

    for (const c of cells){
      const div = document.createElement('div');
      div.className = 'dayCell' + (c.muted ? ' muted':'') + (c.iso===state.selected ? ' selected':'');
      div.dataset.iso = c.iso;

      const num = document.createElement('div');
      num.className = 'dayNum';
      num.textContent = c.num;
      div.appendChild(num);

      // badges based on data presence
      const e = state.monthEntries.get(c.iso);
      const badges = document.createElement('div');
      badges.className = 'badges';

      const hasAnchor = e && e.anchor && e.anchor.trim().length>0;
      const hasTasks  = e && Array.isArray(e.tasks) && e.tasks.some(t => (t.text||'').trim().length>0);
      const hasNotes  = e && e.notes && e.notes.trim().length>0;
      const hasFiles  = e && Array.isArray(e.attachments) && e.attachments.length>0;

      if (hasAnchor) badges.appendChild(Object.assign(document.createElement('span'),{className:'badge red'}));
      if (hasTasks)  badges.appendChild(Object.assign(document.createElement('span'),{className:'badge yellow'}));
      if (hasNotes)  badges.appendChild(Object.assign(document.createElement('span'),{className:'badge blue'}));
      if (hasFiles)  badges.appendChild(Object.assign(document.createElement('span'),{className:'badge green'}));

      div.appendChild(badges);

      div.addEventListener('click', () => selectDate(c.iso));
      cal.appendChild(div);
    }
  }

  function renderTasks(tasks){
    const box = $('tasks');
    box.innerHTML = '';
    const list = Array.isArray(tasks) ? tasks : [];
    list.forEach((t, idx) => {
      const row = document.createElement('div');
      row.className = 'taskRow';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = !!t.done;
      chk.addEventListener('change', () => {
        list[idx].done = chk.checked;
        scheduleSave();
      });

      const txt = document.createElement('input');
      txt.className = 'taskText';
      txt.value = t.text || '';
      txt.placeholder = idx===0 ? 'Ex: ligar para X / resolver pendência Y' : 'Complemento';
      txt.addEventListener('input', () => {
        list[idx].text = txt.value;
        scheduleSave();
      });

      const del = document.createElement('button');
      del.className = 'trashBtn';
      del.textContent = '🗑';
      del.title = 'Remover';
      del.addEventListener('click', () => {
        list.splice(idx,1);
        renderTasks(list);
        scheduleSave();
      });

      row.appendChild(chk);
      row.appendChild(txt);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  async function renderAttachments(dateISO){
    const box = $('attachments');
    box.innerHTML = '';
    const atts = await DB.listAttachmentsByDate(dateISO);
    const entry = await DB.getEntry(dateISO);
    const linked = entry?.attachments || [];

    // keep only existing
    const ids = new Set(atts.map(a=>a.id));
    const filteredLinked = linked.filter(x => ids.has(x));
    if (entry && JSON.stringify(filteredLinked) !== JSON.stringify(linked)){
      entry.attachments = filteredLinked;
      await DB.putEntry(entry);
    }

    if (atts.length === 0){
      const empty = document.createElement('div');
      empty.className = 'fileInfo';
      empty.textContent = 'Sem arquivos neste dia ainda.';
      box.appendChild(empty);
      return;
    }

    for (const a of atts){
      const card = document.createElement('div');
      card.className = 'att';

      const top = document.createElement('div');
      top.className = 'attTop';

      const name = document.createElement('div');
      name.className = 'attName';
      name.textContent = a.name || 'arquivo';

      const meta = document.createElement('div');
      meta.className = 'attMeta';
      meta.textContent = (a.type||'') + ' • ' + new Date(a.createdAt||Date.now()).toLocaleString('pt-BR');

      top.appendChild(name);
      top.appendChild(meta);

      const thumb = document.createElement('div');
      thumb.className = 'attThumb';
      if ((a.type||'').startsWith('image/') && a.blob){
        const img = document.createElement('img');
        img.alt = a.name || 'imagem';
        img.src = URL.createObjectURL(a.blob);
        thumb.appendChild(img);
      } else {
        thumb.textContent = '📄 ' + (a.ext || (a.name||'').split('.').pop() || 'DOC').toUpperCase();
      }

      const actions = document.createElement('div');
      actions.className = 'attActions';

      const btnOpen = document.createElement('button');
      btnOpen.className = 'miniBtn';
      btnOpen.textContent = 'Abrir';
      btnOpen.addEventListener('click', () => openAttachment(a));

      const btnDel = document.createElement('button');
      btnDel.className = 'miniBtn';
      btnDel.textContent = 'Excluir';
      btnDel.addEventListener('click', async () => {
        await DB.deleteAttachment(a.id);
        // unlink
        const e = await DB.getEntry(dateISO);
        if (e){
          e.attachments = (e.attachments||[]).filter(x=>x!==a.id);
          e.updatedAt = Date.now();
          await DB.putEntry(e);
        }
        toast('Arquivo removido.');
        await refreshMonth();
        await renderAttachments(dateISO);
        await updateKPIs();
      });

      actions.appendChild(btnOpen);
      actions.appendChild(btnDel);

      card.appendChild(top);
      card.appendChild(thumb);
      card.appendChild(actions);
      box.appendChild(card);
    }
  }

  function openAttachment(a){
    if (!a?.blob){ toast('Arquivo indisponível.'); return; }
    const url = URL.createObjectURL(a.blob);
    const w = window.open(url, '_blank');
    if (!w) toast('Permita pop-ups para abrir o arquivo.');
    setTimeout(()=>URL.revokeObjectURL(url), 60_000);
  }

  async function renderCash(dateISO){
    const list = await DB.listCashByDate(dateISO);
    const box = $('cashList');
    box.innerHTML = '';
    if (!list.length){
      box.innerHTML = '<div class="fileInfo">Sem lançamentos neste dia.</div>';
      return;
    }
    for (const it of list){
      const row = document.createElement('div');
      row.className = 'cashItem';

      const L = document.createElement('div');
      L.className = 'cashL';

      const d = document.createElement('div');
      d.className = 'cashDate';
      d.textContent = new Date(it.createdAt).toLocaleString('pt-BR');

      const desc = document.createElement('div');
      desc.className = 'cashDesc';
      desc.textContent = it.desc || '(sem descrição)';

      L.appendChild(d);
      L.appendChild(desc);

      const R = document.createElement('div');
      R.className = 'cashR';

      if (it.inVal > 0){
        const p = document.createElement('div');
        p.className = 'pill in';
        p.textContent = `+ R$ ${it.inVal.toFixed(2).replace('.',',')}`;
        R.appendChild(p);
      }
      if (it.outVal > 0){
        const p = document.createElement('div');
        p.className = 'pill out';
        p.textContent = `- R$ ${it.outVal.toFixed(2).replace('.',',')}`;
        R.appendChild(p);
      }

      const del = document.createElement('button');
      del.className = 'trashBtn';
      del.textContent = '🗑';
      del.title = 'Excluir lançamento';
      del.addEventListener('click', async () => {
        await DB.deleteCash(it.id);
        toast('Lançamento removido.');
        await refreshMonth();
        await renderCash(dateISO);
      });

      R.appendChild(del);

      row.appendChild(L);
      row.appendChild(R);
      box.appendChild(row);
    }
  }

  function fillDayForm(entry){
    $('anchor').value = entry?.anchor || '';
    $('notes').value  = entry?.notes || '';
    $('tags').value   = (entry?.tags || []).join(', ');
    renderTasks(entry?.tasks || [
      { text:'', done:false },
      { text:'', done:false },
      { text:'', done:false },
    ]);
  }

  async function selectDate(dateISO){
    state.selected = dateISO;
    const d = parseISODate(dateISO);
    state.viewY = d.getFullYear();
    state.viewM = d.getMonth();

    $('dayTitle').textContent = fmtBR.format(d).replace(/^\w/, c=>c.toUpperCase());
    $('dayMeta').textContent = `Data: ${dateISO} • “Registro cria memória.”`;

    const entry = await DB.getEntry(dateISO);
    fillDayForm(entry);

    await renderAttachments(dateISO);
    await renderCash(dateISO);

    await refreshMonth();
  }

  // ===== Autosave =====
  let saveTimer = null;
  function scheduleSave(){
    $('saveStatus').textContent = 'Digitando… salvando em instantes.';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 450);
  }

  function normalizeTags(s){
    return (s||'')
      .split(',')
      .map(x=>x.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  function collectTasks(){
    const rows = Array.from(document.querySelectorAll('#tasks .taskRow'));
    const out = rows.map(r => {
      const chk = r.querySelector('input[type="checkbox"]');
      const txt = r.querySelector('input.taskText');
      return { done: !!chk?.checked, text: txt?.value || '' };
    }).filter(t => (t.text||'').trim().length>0 || t.done);
    return out;
  }

  async function saveNow(){
    if (state.saving) return;
    state.saving = true;

    const date = state.selected;
    const prev = await DB.getEntry(date);

    const entry = {
      date,
      anchor: $('anchor').value || '',
      tasks: collectTasks(),
      notes: $('notes').value || '',
      tags: normalizeTags($('tags').value),
      attachments: prev?.attachments || [],
      updatedAt: Date.now(),
      createdAt: prev?.createdAt || Date.now()
    };

    await DB.putEntry(entry);
    $('saveStatus').textContent = 'Salvo ✅';
    state.saving = false;

    await refreshMonth();
    await updateKPIs();
  }

  // ===== Month refresh =====
  async function refreshMonth(){
    const list = await DB.listEntriesByMonth(state.viewY, state.viewM);
    state.monthEntries.clear();
    for (const e of list) state.monthEntries.set(e.date, e);
    renderCalendar();
  }

  // ===== KPIs =====
  async function updateKPIs(){
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()-6);
    const startISO = toISODate(start);
    const endISO = toISODate(new Date(today.getFullYear(), today.getMonth(), today.getDate()+1));

    const entries = await new Promise((res)=> {
      const out=[]; const req = tx('entries').openCursor();
      req.onsuccess=()=>{const c=req.result; if(!c)return res(out); out.push(c.value); c.continue();};
      req.onerror=()=>res(out);
    });

    const recent = entries.filter(e => e.date >= startISO && e.date < endISO);
    const anchors = recent.filter(e => (e.anchor||'').trim().length>0).length;
    const days = recent.filter(e => (e.anchor||'').trim() || (e.notes||'').trim() || (e.tasks||[]).length).length;

    $('kpiAnchors').textContent = anchors;
    $('kpiDays').textContent = days;

    const files = await new Promise((res)=> {
      let n=0; const req = tx('attachments').openCursor();
      req.onsuccess=()=>{const c=req.result; if(!c)return res(n); n++; c.continue();};
      req.onerror=()=>res(n);
    });
    $('kpiFiles').textContent = files;

    if (anchors===0) $('hintText').textContent = 'Dica: escreva uma Âncora de 1 linha. Amanhã você agradece.';
    else if (days<3) $('hintText').textContent = 'Boa! Agora mantém o “registro mínimo” por 3 dias seguidos.';
    else $('hintText').textContent = 'Você está construindo continuidade. O sistema está segurando a memória.';
  }

  // ===== Attachments handling =====
  $('fileInput').addEventListener('change', async (ev) => {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;

    const date = state.selected;
    let entry = await DB.getEntry(date);
    if (!entry){
      entry = { date, anchor:'', tasks:[], notes:'', tags:[], attachments:[], createdAt:Date.now(), updatedAt:Date.now() };
    }

    for (const f of files){
      const attId = id();
      const ext = (f.name||'').includes('.') ? f.name.split('.').pop() : '';
      const att = {
        id: attId,
        entryDate: date,
        name: f.name || 'arquivo',
        type: f.type || 'application/octet-stream',
        size: f.size || 0,
        ext,
        createdAt: Date.now(),
        blob: f
      };
      await DB.putAttachment(att);
      entry.attachments = entry.attachments || [];
      entry.attachments.push(attId);
    }

    entry.updatedAt = Date.now();
    await DB.putEntry(entry);
    toast('Arquivo(s) salvo(s) offline ✅');
    ev.target.value = '';

    await refreshMonth();
    await renderAttachments(date);
    await updateKPIs();
  });

  // ===== Cashbook =====
  function parseMoney(v){
    const s = (v||'').toString().trim().replace(/\./g,'').replace(',', '.');
    const n = Number(s);
    if (!isFinite(n) || n<0) return 0;
    return n;
  }
  $('btnAddCash').addEventListener('click', async () => {
    const date = state.selected;
    const inVal = parseMoney($('cashIn').value);
    const outVal = parseMoney($('cashOut').value);
    const desc = ($('cashDesc').value||'').trim();

    if (inVal<=0 && outVal<=0 && !desc){
      toast('Preencha pelo menos um campo.');
      return;
    }

    const item = { id:id(), entryDate:date, inVal, outVal, desc, createdAt:Date.now() };
    await DB.putCash(item);

    $('cashIn').value = '';
    $('cashOut').value = '';
    $('cashDesc').value = '';
    toast('Lançamento adicionado.');
    await renderCash(date);
  });

  // ===== Buttons =====
  $('btnAddTask').addEventListener('click', () => {
    const tasks = collectTasks();
    if (tasks.length >= 6) { toast('Já tem complementos suficientes. Mantém curto.'); return; }
    tasks.push({text:'', done:false});
    renderTasks(tasks);
    scheduleSave();
  });

  $('btnSaveNow').addEventListener('click', saveNow);
  $('anchor').addEventListener('input', scheduleSave);
  $('notes').addEventListener('input', scheduleSave);
  $('tags').addEventListener('input', scheduleSave);

  $('btnToday').addEventListener('click', () => selectDate(toISODate(new Date())));
  $('prevMonth').addEventListener('click', async () => {
    state.viewM -= 1;
    if (state.viewM < 0){ state.viewM=11; state.viewY -= 1; }
    await refreshMonth();
  });
  $('nextMonth').addEventListener('click', async () => {
    state.viewM += 1;
    if (state.viewM > 11){ state.viewM=0; state.viewY += 1; }
    await refreshMonth();
  });

  $('btnCloneYesterday').addEventListener('click', async () => {
    const d = parseISODate(state.selected);
    const y = new Date(d.getFullYear(), d.getMonth(), d.getDate()-1);
    const yISO = toISODate(y);
    const prev = await DB.getEntry(yISO);
    if (!prev){ toast('Ontem não tem registro.'); return; }
    $('anchor').value = prev.anchor || '';
    $('notes').value  = prev.notes || '';
    $('tags').value   = (prev.tags||[]).join(', ');
    renderTasks(prev.tasks || []);
    scheduleSave();
    toast('Copiado de ontem.');
  });

  $('btnClearDay').addEventListener('click', async () => {
    const date = state.selected;
    const atts = await DB.listAttachmentsByDate(date);
    for (const a of atts) await DB.deleteAttachment(a.id);

    const cash = await DB.listCashByDate(date);
    for (const c of cash) await DB.deleteCash(c.id);

    await DB.deleteEntry(date);

    fillDayForm(null);
    await renderAttachments(date);
    await renderCash(date);
    toast('Dia limpo.');
    await refreshMonth();
    await updateKPIs();
  });

  // ===== Backup / Restore =====
  $('btnBackup').addEventListener('click', async () => {
    const data = await DB.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agenda_ah_backup_${toISODate(new Date())}.json`;
    a.click();
    setTimeout(()=>URL.revokeObjectURL(url), 2000);
    toast('Backup baixado.');
  });

  $('importFile').addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try{
      const txt = await f.text();
      const payload = JSON.parse(txt);
      await DB.importAll(payload);
      toast('Importado ✅');
      await refreshMonth();
      await selectDate(state.selected);
      await updateKPIs();
    }catch(err){
      console.error(err);
      toast('Falhou: arquivo inválido.');
    }finally{
      ev.target.value = '';
    }
  });

  // ===== Export PDF (Print) =====
  $('btnExport').addEventListener('click', async () => {
    await saveNow();
    const range = await buildReportRange();
    const html = await buildReportHTML(range.startISO, range.endISOExclusive);
    openPrintWindow(html);
  });

  async function buildReportRange(){
    const start = new Date(state.viewY, state.viewM, 1);
    const end = new Date(state.viewY, state.viewM+1, 1);
    return { startISO: toISODate(start), endISOExclusive: toISODate(end) };
  }

  async function listEntriesInRange(startISO, endISO){
    const entries = await new Promise((res)=> {
      const out=[]; const req = tx('entries').openCursor();
      req.onsuccess=()=>{const c=req.result; if(!c)return res(out); out.push(c.value); c.continue();};
      req.onerror=()=>res(out);
    });
    return entries
      .filter(e => e.date >= startISO && e.date < endISO)
      .sort((a,b)=> a.date.localeCompare(b.date));
  }

  async function listAttachmentsInRange(startISO, endISO){
    const atts = await new Promise((res)=> {
      const out=[]; const req = tx('attachments').openCursor();
      req.onsuccess=()=>{const c=req.result; if(!c)return res(out); out.push(c.value); c.continue();};
      req.onerror=()=>res(out);
    });
    return atts
      .filter(a => a.entryDate >= startISO && a.entryDate < endISO)
      .sort((a,b)=> (a.entryDate.localeCompare(b.entryDate) || (a.createdAt-b.createdAt)));
  }

  async function listCashInRange(startISO, endISO){
    const items = await new Promise((res)=> {
      const out=[]; const req = tx('cash').openCursor();
      req.onsuccess=()=>{const c=req.result; if(!c)return res(out); out.push(c.value); c.continue();};
      req.onerror=()=>res(out);
    });
    return items
      .filter(x => x.entryDate >= startISO && x.entryDate < endISO)
      .sort((a,b)=> (a.entryDate.localeCompare(b.entryDate) || (a.createdAt-b.createdAt)));
  }

  function esc(s){ return (s||'').toString().replace(/[&<>"']/g, (m)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }

  async function buildReportHTML(startISO, endISO){
    const entries = await listEntriesInRange(startISO, endISO);
    const atts = await listAttachmentsInRange(startISO, endISO);
    const cash = await listCashInRange(startISO, endISO);

    const anchors = entries.filter(e => (e.anchor||'').trim().length>0).length;
    const activeDays = entries.filter(e => (e.anchor||'').trim() || (e.notes||'').trim() || (e.tasks||[]).length).length;

    const text = entries.map(e => `${e.anchor||''} ${e.notes||''}`).join(' ').toLowerCase();
    const words = (text.match(/[a-zà-ú0-9]{4,}/gi) || [])
      .filter(w => !['para','porque','sobre','com','como','isso','esse','essa','aqui','mais','muito','hoje','amanha','ontem','nao','tudo','cada','pois','onde','quando','tambem','fazer','feito'].includes(w));
    const freq = new Map();
    for (const w of words) freq.set(w, (freq.get(w)||0)+1);
    const top = [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).filter(x=>x[1]>=2);

    const attsByDate = new Map();
    for (const a of atts){
      if (!attsByDate.has(a.entryDate)) attsByDate.set(a.entryDate, []);
      attsByDate.get(a.entryDate).push(a);
    }
    const cashByDate = new Map();
    for (const c of cash){
      if (!cashByDate.has(c.entryDate)) cashByDate.set(c.entryDate, []);
      cashByDate.get(c.entryDate).push(c);
    }

    const dayBlocks = [];
    for (const e of entries){
      const tasks = (e.tasks||[]).slice(0,12);
      const dayAtts = attsByDate.get(e.date) || [];
      const dayCash = cashByDate.get(e.date) || [];

      const thumbs = [];
      for (const a of dayAtts.slice(0,12)){
        if ((a.type||'').startsWith('image/') && a.blob){
          const dataUrl = await blobToDataURL(a.blob);
          thumbs.push(`<div class="thumb"><img src="${dataUrl}" alt="${esc(a.name)}"/><div class="thumbCap">${esc(a.name)}</div></div>`);
        } else {
          thumbs.push(`<div class="thumb file"><div class="fileIcon">📄</div><div class="thumbCap">${esc(a.name)}</div></div>`);
        }
      }

      const cashHtml = dayCash.length ? `
        <div class="secTitle green">🟢 Livro-caixa</div>
        <table class="cash">
          <thead><tr><th>Hora</th><th>Descrição</th><th class="r">Entrada</th><th class="r">Saída</th></tr></thead>
          <tbody>
            ${dayCash.map(x=>{
              const t = new Date(x.createdAt).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
              const inv = x.inVal>0 ? `R$ ${x.inVal.toFixed(2).replace('.',',')}` : '';
              const outv = x.outVal>0 ? `R$ ${x.outVal.toFixed(2).replace('.',',')}` : '';
              return `<tr><td>${t}</td><td>${esc(x.desc||'')}</td><td class="r in">${inv}</td><td class="r out">${outv}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
      ` : '';

      dayBlocks.push(`
        <section class="page">
          <div class="pageBorder">
            <div class="dayHead">
              <div class="dayDate">${esc(e.date)}</div>
              <div class="dayNice">${esc(dayMetaText(e.date))}</div>
            </div>

            <div class="sec">
              <div class="secTitle red">🔴 Âncora</div>
              <div class="box">${esc(e.anchor||'')}</div>
            </div>

            <div class="sec">
              <div class="secTitle yellow">🟡 Complementos</div>
              <ul class="tasks">
                ${(tasks.length?tasks:[{text:'',done:false}]).map(t=>`<li class="${t.done?'done':''}">${esc(t.text||'')}</li>`).join('')}
              </ul>
            </div>

            <div class="sec">
              <div class="secTitle blue">🔵 Notas</div>
              <div class="box notes">${esc(e.notes||'').replace(/\n/g,'<br/>')}</div>
            </div>

            ${dayAtts.length ? `
              <div class="sec">
                <div class="secTitle green">🟢 Arquivos (miniaturas)</div>
                <div class="thumbGrid">${thumbs.join('')}</div>
              </div>
            ` : ''}

            ${cashHtml}

            ${(e.tags||[]).length ? `<div class="tags">Tags: ${(e.tags||[]).map(t=>`<span>#${esc(t)}</span>`).join(' ')}</div>` : ''}
          </div>
        </section>
      `);
    }

    const period = `${startISO} → ${new Date(parseISODate(endISO).getTime()-86400000).toISOString().slice(0,10)}`;
    const monthTitle = new Intl.DateTimeFormat('pt-BR', { month:'long', year:'numeric' })
      .format(parseISODate(startISO)).replace(/^\w/, c=>c.toUpperCase());

    const html = `
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Relatório - Agenda AH</title>
<style>
  :root{
    --ink:#101522;
    --mut:#5a6a85;
    --line:#dfe6f3;
    --red:#ff2e58;
    --yellow:#ffb703;
    --blue:#1e88ff;
    --green:#12b886;
    --bg:#ffffff;
  }
  *{box-sizing:border-box}
  body{margin:0; background:var(--bg); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:var(--ink)}
  @page{ size:A4; margin:12mm }
  .cover{
    border:2px solid var(--line);
    border-radius:16px;
    padding:16mm 14mm;
    min-height: 260mm;
    display:flex;
    flex-direction:column;
    justify-content:space-between;
  }
  .title{font-size:24px; font-weight:900}
  .sub{color:var(--mut); margin-top:6px}
  .kpis{display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:16px}
  .kpi{border:1px solid var(--line); border-radius:14px; padding:10px}
  .kpi .k{color:var(--mut); font-size:12px}
  .kpi .v{font-weight:900; font-size:20px; margin-top:6px}
  .chips{display:flex; flex-wrap:wrap; gap:8px; margin-top:14px}
  .chip{border:1px solid var(--line); border-radius:999px; padding:7px 10px; font-size:12px; color:var(--mut)}
  .chip b{color:var(--ink)}
  .keywords{margin-top:14px; color:var(--mut); font-size:12px}
  .keywords span{display:inline-block; border:1px solid var(--line); border-radius:999px; padding:6px 10px; margin:4px 6px 0 0}
  .page{page-break-after:always}
  .page:last-child{page-break-after:auto}
  .pageBorder{
    border:2px solid var(--line);
    border-radius:16px;
    padding:12mm 10mm;
    min-height: 260mm;
  }
  .dayHead{display:flex; align-items:baseline; justify-content:space-between; gap:10px; border-bottom:1px solid var(--line); padding-bottom:8px; margin-bottom:10px}
  .dayDate{font-weight:900}
  .dayNice{color:var(--mut); font-size:12px}
  .sec{margin-top:10px}
  .secTitle{font-weight:900; font-size:12px; letter-spacing:.2px; margin-bottom:6px}
  .secTitle.red{color:var(--red)}
  .secTitle.yellow{color:var(--yellow)}
  .secTitle.blue{color:var(--blue)}
  .secTitle.green{color:var(--green)}
  .box{
    border:1px solid var(--line);
    border-radius:12px;
    padding:10px;
    min-height: 18mm;
  }
  .box.notes{min-height: 28mm}
  ul.tasks{margin:0; padding-left:18px; border:1px solid var(--line); border-radius:12px; padding-top:8px; padding-bottom:8px}
  ul.tasks li{margin:4px 0}
  ul.tasks li.done{text-decoration:line-through; color:var(--mut)}
  .thumbGrid{display:grid; grid-template-columns:repeat(4,1fr); gap:8px}
  .thumb{
    border:1px solid var(--line);
    border-radius:12px;
    overflow:hidden;
    height: 44mm;
    display:flex;
    flex-direction:column;
  }
  .thumb img{width:100%; height: 34mm; object-fit:cover}
  .thumbCap{padding:6px 8px; font-size:10px; color:var(--mut); white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
  .thumb.file{justify-content:center; align-items:center}
  .thumb.file .fileIcon{font-size:22px; margin-bottom:6px}
  table.cash{width:100%; border-collapse:separate; border-spacing:0; overflow:hidden; border-radius:12px; border:1px solid var(--line)}
  table.cash th, table.cash td{padding:8px; border-bottom:1px solid var(--line); font-size:11px}
  table.cash th{background:#f6f8fe; text-align:left}
  table.cash tr:last-child td{border-bottom:none}
  .r{text-align:right}
  .in{color:var(--green); font-weight:800}
  .out{color:var(--red); font-weight:800}
  .tags{margin-top:10px; color:var(--mut); font-size:12px}
  .tags span{display:inline-block; margin-right:8px}
</style>
</head>
<body>
  <section class="page">
    <div class="cover">
      <div>
        <div class="title">Relatório • Agenda AH</div>
        <div class="sub">${esc(monthTitle)} • Período ${esc(period)}</div>

        <div class="kpis">
          <div class="kpi"><div class="k">Âncoras registradas</div><div class="v">${anchors}</div></div>
          <div class="kpi"><div class="k">Dias com registro</div><div class="v">${activeDays}</div></div>
          <div class="kpi"><div class="k">Arquivos anexados</div><div class="v">${atts.length}</div></div>
        </div>

        <div class="chips">
          <div class="chip"><b>Regra de ouro:</b> escrevi → entra no relatório</div>
          <div class="chip"><b>Modo AH:</b> mínimo executável > perfeição</div>
          <div class="chip"><b>Foco:</b> 1 Âncora por dia</div>
        </div>

        <div class="keywords">
          <div style="font-weight:900; color:var(--ink); margin-bottom:6px">Pensamentos recorrentes (auto)</div>
          ${(top.length?top.map(([w,n])=>`<span>${esc(w)} • ${n}x</span>`).join(''):'<span>Sem repetição forte ainda — continue registrando.</span>')}
        </div>
      </div>

      <div class="sub">Gerado em ${new Date().toLocaleString('pt-BR')} • Salve como PDF na opção “Imprimir”.</div>
    </div>
  </section>

  ${dayBlocks.join('\n')}
</body>
</html>`;
    return html;
  }

  function blobToDataURL(blob){
    return new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.readAsDataURL(blob);
    });
  }

  function openPrintWindow(html){
    const w = window.open('', '_blank');
    if (!w){ toast('Permita pop-ups para exportar PDF.'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(()=> w.print(), 450);
  }

  // ===== Init =====
  async function init(){
    db = await openDB();
    await refreshMonth();
    await selectDate(state.selected);
    await updateKPIs();
  }

  init().catch((e)=> {
    console.error(e);
    toast('Erro ao iniciar. Recarregue a página.');
  });

})();
