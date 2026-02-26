/* =====================================================
   ALARM PRO — app.js  (v3 — Background Notifications)
   ===================================================== */

'use strict';

// ─── SERVICE WORKER ──────────────────────────────────
let swRegistration = null;

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('/timer/sw.js', { scope: '/timer/' });
    console.log('[App] SW registered:', swRegistration.scope);

    // Listen for messages FROM the SW (e.g. ALARM_FIRED when tab is in background)
    navigator.serviceWorker.addEventListener('message', onSwMessage);

    // Start keepalive pings so SW stays alive
    startSwKeepalive();
  } catch (err) {
    console.warn('[App] SW registration failed:', err);
  }
}

function onSwMessage(event) {
  if (!event.data) return;

  if (event.data.type === 'ALARM_FIRED') {
    // SW detected alarm while page was in background → show in-app overlay too
    const alarm = event.data.alarm;
    if (!currentRinging) fireAlarm(alarm);
  }

  if (event.data.type === 'ALARM_ACTION') {
    const { action, alarm } = event.data;
    if (action === 'dismiss') dismissAlarm();
    if (action === 'snooze') dismissAlarm();
  }
}

// Ping our own SW every 20 seconds via a fetch to keep it alive
function startSwKeepalive() {
  setInterval(() => {
    fetch('/timer/sw-keepalive').catch(() => { });
  }, 20000);
}

// Send current alarm list to SW whenever it changes
function syncAlarmsToSW() {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  // Strip out the audioDataUrl (large Base64) to keep the message small
  // SW only needs time/days/enabled/id/name for scheduling
  const slim = alarms.map(({ audioDataUrl, ...rest }) => rest);
  navigator.serviceWorker.controller.postMessage({
    type: 'SYNC_ALARMS',
    alarms: slim,
  });
}

// ─── NOTIFICATION PERMISSION ─────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') {
    showToast('🔕 Notifikasi browser diblokir. Izinkan di pengaturan browser.');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    showToast('🔔 Notifikasi alarm diaktifkan!');
  } else {
    showToast('⚠️ Izin notifikasi ditolak — alarm hanya bunyi jika tab terbuka.');
  }
}

// Show a Web Notification directly from the page (when page is open but not focused)
function showWebNotification(alarm) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(`⏰ ${alarm.name || 'Alarm'} — ${alarm.time}`, {
      body: 'Klik untuk membuka AlarmPro',
      icon: '/timer/icon-192.png',
      tag: 'alarmpro-page-' + alarm.id,
      requireInteraction: true,
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (_) { }
}

// ─── CONSTANTS ───────────────────────────────────────
const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const DAY_SHORT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTH_NAMES = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const STORAGE_KEY = 'alarmpro_alarms_v2';
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// ─── STATE ───────────────────────────────────────────
let alarms = [];
let editingId = null;
let pendingAudioDataUrl = null;
let pendingAudioName = null;
let pendingAudioFile = null;
let pendingKeepExisting = false;

let activeAudioEl = null;
let beepCtx = null;
let beepInterval = null;
let currentRinging = null;   // alarm object currently ringing
let activeObjectUrl = null;

// Track which alarm+minute combos have already fired so we
// don't re-fire while the same minute is still ticking.
// Key: "alarmId|HH:MM"   Value: true
const firedKeys = {};
let lastCheckedMinute = null;

// ─── DOM ─────────────────────────────────────────────
const clockTimeEl = document.getElementById('clock-time');
const clockDateEl = document.getElementById('clock-date');
const alarmListRegularEl = document.getElementById('alarmListRegular');
const emptyStateRegularEl = document.getElementById('emptyStateRegular');
const alarmListPuasaEl = document.getElementById('alarmListPuasa');
const emptyStatePuasaEl = document.getElementById('emptyStatePuasa');

const btnAddAlarmRegular = document.getElementById('btnAddAlarmRegular');
const btnAddAlarmPuasa = document.getElementById('btnAddAlarmPuasa');
const modalOverlay = document.getElementById('modalOverlay');
const btnModalClose = document.getElementById('btnModalClose');
const btnCancel = document.getElementById('btnCancel');
const btnSave = document.getElementById('btnSave');
const modalTitle = document.getElementById('modalTitle');

const alarmNameEl = document.getElementById('alarmName');
const alarmTimeEl = document.getElementById('alarmTime');
const alarmRepeatEl = document.getElementById('alarmRepeat');
const alarmCategoryEl = document.getElementById('alarmCategory');
const dayBtns = document.querySelectorAll('.day-btn');

const uploadArea = document.getElementById('uploadArea');
const audioFileEl = document.getElementById('audioFile');
const uploadContent = document.getElementById('uploadContent');
const uploadPreview = document.getElementById('uploadPreview');
const previewName = document.getElementById('previewName');
const previewRemove = document.getElementById('previewRemove');

const ringingOverlay = document.getElementById('ringingOverlay');
const ringingTimeEl = document.getElementById('ringingTime');
const ringingLabelEl = document.getElementById('ringingLabel');
const btnDismiss = document.getElementById('btnDismiss');

// ─── HELPERS ─────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ─── PERSISTENCE ─────────────────────────────────────
function loadAlarms() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('loadAlarms error:', e);
    return [];
  }
}

function saveAlarms() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(alarms));
    // Sync to SW after every save
    syncAlarmsToSW();
  } catch (e) {
    console.warn('saveAlarms error (quota?):', e);
    // If quota exceeded (large audio files), try saving without audio blobs
    const slim = alarms.map(a => ({ ...a, audioDataUrl: null, audioName: null }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
      showToast('⚠️ Audio disimpan tanpa file (storage penuh). Upload ulang setelah reload.', 'warn');
    } catch (e2) { console.error('saveAlarms fallback error:', e2); }
  }
}

// ─── LIVE CLOCK ──────────────────────────────────────
function updateClock() {
  const now = new Date();
  const hh = pad(now.getHours());
  const mm = pad(now.getMinutes());
  const ss = pad(now.getSeconds());
  const dayName = DAY_NAMES[now.getDay()];
  const month = MONTH_NAMES[now.getMonth()];

  clockTimeEl.textContent = `${hh}:${mm}:${ss}`;
  clockDateEl.textContent = `${dayName}, ${now.getDate()} ${month} ${now.getFullYear()}`;

  tickAlarms(now, hh, mm);
}

// ─── ALARM TICK ──────────────────────────────────────
function tickAlarms(now, hh, mm) {
  const currentMinute = `${hh}:${mm}`;
  const currentDay = now.getDay();
  const ss = now.getSeconds();

  // Purge old firedKeys when the minute rolls over
  if (currentMinute !== lastCheckedMinute) {
    lastCheckedMinute = currentMinute;
    for (const k in firedKeys) {
      if (!k.endsWith('|' + currentMinute)) delete firedKeys[k];
    }
  }

  // Only fire within the first 4 seconds of the minute (catches page-load edge case too)
  if (ss > 4) return;

  // Don't interrupt an already-ringing alarm
  if (currentRinging) return;

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;
    if (alarm.time !== currentMinute) continue;

    // Check day filter
    const hasDays = Array.isArray(alarm.days) && alarm.days.length > 0;
    if (hasDays && !alarm.days.includes(currentDay)) continue;

    const key = alarm.id + '|' + currentMinute;
    if (firedKeys[key]) continue;

    firedKeys[key] = true;
    fireAlarm(alarm);

    // One-shot: auto-disable after firing if no days selected
    if (!hasDays) {
      alarm.enabled = false;
      saveAlarms();
      renderAlarms();
    }
    break; // one alarm at a time
  }
}

// ─── FIRE / DISMISS ──────────────────────────────────
async function fireAlarm(alarm) {
  currentRinging = alarm;

  ringingTimeEl.textContent = alarm.time;
  ringingLabelEl.textContent = alarm.name || 'Alarm';
  ringingOverlay.classList.remove('hidden');

  // Also show OS notification (works even when tab is in another window)
  showWebNotification(alarm);

  stopCurrentAudio();

  // Find the full alarm with audioDataUrl (SW sends slim version without audio)
  const fullAlarm = alarms.find(a => a.id === alarm.id) || alarm;

  if (fullAlarm.audioDataUrl) {
    activeAudioEl = new Audio(fullAlarm.audioDataUrl);
    activeAudioEl.loop = false;
    activeAudioEl.volume = 1.0;
    activeAudioEl.addEventListener('ended', () => {
      if (currentRinging) dismissAlarm();
    }, { once: true });
    const playPromise = activeAudioEl.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => { playBeepFallback(); });
    }
  } else if (fullAlarm.audioKey) {
    try {
      const blob = await getAudioFromDB(fullAlarm.audioKey);
      if (blob) {
        activeObjectUrl = URL.createObjectURL(blob);
        activeAudioEl = new Audio(activeObjectUrl);
        activeAudioEl.loop = false;
        activeAudioEl.volume = 1.0;
        activeAudioEl.addEventListener('ended', () => {
          if (currentRinging) dismissAlarm();
        }, { once: true });
        const p = activeAudioEl.play();
        if (p !== undefined) { p.catch(() => { playBeepFallback(); }); }
      } else {
        playBeepFallback();
      }
    } catch (_) {
      playBeepFallback();
    }
  } else {
    playBeepFallback();
  }
}

function dismissAlarm() {
  ringingOverlay.classList.add('hidden');
  stopCurrentAudio();
  currentRinging = null;
}

// Snooze di-nonaktifkan

// ─── AUDIO ───────────────────────────────────────────
function stopCurrentAudio() {
  if (activeAudioEl) {
    try { activeAudioEl.pause(); activeAudioEl.currentTime = 0; } catch (_) { }
    activeAudioEl = null;
  }
  if (activeObjectUrl) {
    try { URL.revokeObjectURL(activeObjectUrl); } catch (_) {}
    activeObjectUrl = null;
  }
  stopBeep();
}

function playBeepFallback() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  try {
    beepCtx = new Ctx();
  } catch (_) { return; }

  function beep() {
    if (!beepCtx) return;
    try {
      const osc = beepCtx.createOscillator();
      const gain = beepCtx.createGain();
      osc.connect(gain);
      gain.connect(beepCtx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(900, beepCtx.currentTime);
      gain.gain.setValueAtTime(0.4, beepCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, beepCtx.currentTime + 0.5);
      osc.start(beepCtx.currentTime);
      osc.stop(beepCtx.currentTime + 0.5);
    } catch (_) { }
  }

  beep();
  beepInterval = setInterval(beep, 800);
}

function stopBeep() {
  if (beepInterval) { clearInterval(beepInterval); beepInterval = null; }
  if (beepCtx) {
    try { beepCtx.close(); } catch (_) { }
    beepCtx = null;
  }
}

// ─── RENDER ──────────────────────────────────────────
function renderAlarms() {
  if (alarmListRegularEl) alarmListRegularEl.querySelectorAll('.alarm-card').forEach(c => c.remove());
  if (alarmListPuasaEl) alarmListPuasaEl.querySelectorAll('.alarm-card').forEach(c => c.remove());
  const regs = alarms.filter(a => (a.category || 'regular') !== 'puasa');
  const puas = alarms.filter(a => (a.category || 'regular') === 'puasa');
  if (emptyStateRegularEl) emptyStateRegularEl.style.display = regs.length === 0 ? '' : 'none';
  if (emptyStatePuasaEl) emptyStatePuasaEl.style.display = puas.length === 0 ? '' : 'none';
  regs.forEach(alarm => alarmListRegularEl && alarmListRegularEl.appendChild(buildCard(alarm)));
  puas.forEach(alarm => alarmListPuasaEl && alarmListPuasaEl.appendChild(buildCard(alarm)));
}

function buildCard(alarm) {
  const card = document.createElement('div');
  card.className = 'alarm-card' + (alarm.enabled ? '' : ' is-disabled');
  card.dataset.id = alarm.id;

  const hasDays = Array.isArray(alarm.days) && alarm.days.length > 0;
  const dayPills = hasDays
    ? alarm.days.map(d => `<span class="day-pill">${DAY_SHORT[d]}</span>`).join('')
    : '';

  const audioBadge = (alarm.audioDataUrl || alarm.audioKey)
    ? `<div class="alarm-audio-badge">🎵 ${escHtml(alarm.audioName || 'Audio custom')}</div>`
    : '';
  const onceBadge = !hasDays
    ? `<div class="alarm-once-badge">⚡ Sekali saja</div>` : '';

  card.innerHTML = `
    <div class="alarm-info">
      <div class="alarm-time-display">${escHtml(alarm.time)}</div>
      <div class="alarm-name">${escHtml(alarm.name || 'Alarm')}</div>
      ${hasDays ? `<div class="alarm-days">${dayPills}</div>` : ''}
      ${audioBadge}${onceBadge}
    </div>
    <div class="alarm-controls">
      <button class="btn-icon-action edit" title="Edit" id="editBtn_${alarm.id}">✏️</button>
      <button class="btn-icon-action delete" title="Hapus" id="delBtn_${alarm.id}">🗑️</button>
      <label class="toggle-switch" title="${alarm.enabled ? 'Aktif' : 'Nonaktif'}">
        <input type="checkbox" class="alarm-toggle" ${alarm.enabled ? 'checked' : ''} />
        <span class="toggle-slider"></span>
      </label>
    </div>
  `;

  card.querySelector('.alarm-toggle').addEventListener('change', e => {
    alarm.enabled = e.target.checked;
    card.classList.toggle('is-disabled', !alarm.enabled);
    saveAlarms();
  });
  card.querySelector(`#editBtn_${alarm.id}`).addEventListener('click', () => openEditModal(alarm.id));
  card.querySelector(`#delBtn_${alarm.id}`).addEventListener('click', async () => {
    const id = alarm.id;
    if (alarm.audioKey) { try { await deleteAudioFromDB(alarm.audioKey); } catch (_) {} }
    alarms = alarms.filter(a => a.id !== id);
    saveAlarms();
    renderAlarms();
    showToast('🗑️ Alarm dihapus');
  });

  return card;
}

// ─── MODAL ───────────────────────────────────────────
function openAddModal(defaultCategory) {
  editingId = null;
  modalTitle.textContent = 'Tambah Alarm';
  alarmNameEl.value = '';
  alarmTimeEl.value = '';
  alarmRepeatEl.checked = true;
  dayBtns.forEach(b => b.classList.remove('selected'));
  if (alarmCategoryEl) alarmCategoryEl.value = defaultCategory || 'regular';
  pendingAudioFile = null;
  pendingKeepExisting = false;
  clearPendingAudio();
  modalOverlay.classList.remove('hidden');
  // Focus the time input after a small delay so modal is visible
  setTimeout(() => alarmTimeEl.focus(), 100);
}

function openEditModal(id) {
  const alarm = alarms.find(a => a.id === id);
  if (!alarm) return;
  editingId = id;
  modalTitle.textContent = 'Edit Alarm';
  alarmNameEl.value = alarm.name || '';
  alarmTimeEl.value = alarm.time || '';
  alarmRepeatEl.checked = alarm.repeat !== false;
  if (alarmCategoryEl) alarmCategoryEl.value = alarm.category || 'regular';
  dayBtns.forEach(b => {
    b.classList.toggle('selected', alarm.days && alarm.days.includes(parseInt(b.dataset.day)));
  });
  if (alarm.audioDataUrl || alarm.audioKey) {
    pendingAudioDataUrl = null;
    pendingAudioFile = null;
    pendingAudioName = alarm.audioName || 'audio';
    pendingKeepExisting = true;
    showAudioPreview(pendingAudioName);
  } else { clearPendingAudio(); }
  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  editingId = null;
}

function clearPendingAudio() {
  pendingAudioDataUrl = null;
  pendingAudioName = null;
  pendingAudioFile = null;
  pendingKeepExisting = false;
  audioFileEl.value = '';
  uploadContent.style.display = '';
  uploadPreview.classList.add('hidden');
}

function showAudioPreview(name) {
  previewName.textContent = name;
  uploadContent.style.display = 'none';
  uploadPreview.classList.remove('hidden');
}

// ─── SAVE ALARM ──────────────────────────────────────
btnSave.addEventListener('click', async () => {
  const time = alarmTimeEl.value.trim();
  if (!time) {
    alarmTimeEl.style.borderColor = '#ff5252';
    setTimeout(() => alarmTimeEl.style.borderColor = '', 2000);
    showToast('⚠️ Pilih waktu alarm terlebih dahulu!');
    alarmTimeEl.focus();
    return;
  }

  const selectedDays = [];
  dayBtns.forEach(b => {
    if (b.classList.contains('selected')) selectedDays.push(parseInt(b.dataset.day));
  });

  const newId = editingId || uid();
  let audioKey = null;
  let audioNameVal = null;
  if (pendingAudioFile) {
    try { await saveAudioToDB(newId, pendingAudioFile); audioKey = newId; audioNameVal = pendingAudioName; }
    catch (_) { showToast('❌ Gagal menyimpan audio'); return; }
  } else if (editingId) {
    const old = alarms.find(a => a.id === editingId);
    if (pendingKeepExisting && old) { audioKey = old.audioKey || null; audioNameVal = old.audioName || null; }
    else if (old && old.audioKey) { try { await deleteAudioFromDB(old.audioKey); } catch (_) {} }
  }

  const data = {
    id: newId,
    name: alarmNameEl.value.trim() || 'Alarm',
    time,
    days: selectedDays,
    category: (alarmCategoryEl && alarmCategoryEl.value) || 'regular',
    repeat: alarmRepeatEl.checked,
    enabled: true,
    audioKey,
    audioDataUrl: null,
    audioName: audioNameVal,
  };

  if (editingId) {
    const idx = alarms.findIndex(a => a.id === editingId);
    if (idx !== -1) alarms[idx] = data;
    else alarms.push(data);
    showToast('✅ Alarm diperbarui!');
  } else {
    alarms.push(data);
    showToast('✅ Alarm baru berhasil disimpan!');
  }

  saveAlarms();
  renderAlarms();
  closeModal();
});

// ─── FILE UPLOAD ─────────────────────────────────────
// Use a visible styled button + hidden file input to avoid click coverage issues
uploadArea.addEventListener('click', (e) => {
  // Only trigger if click is on the upload content area (not on the preview-remove button)
  if (e.target.closest('#previewRemove')) return;
  if (!uploadPreview.classList.contains('hidden')) return; // already have file selected
  audioFileEl.click();
});

audioFileEl.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) processAudioFile(file);
});

uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) processAudioFile(file);
});

previewRemove.addEventListener('click', e => {
  e.stopPropagation();
  clearPendingAudio();
});

function processAudioFile(file) {
  if (!file.type.startsWith('audio/')) { showToast('❌ File harus berupa audio (MP3, WAV, OGG, M4A)'); return; }
  if (file.size > MAX_FILE_BYTES) { showToast('❌ Ukuran file max 20MB'); return; }
  pendingAudioFile = file;
  pendingAudioDataUrl = null;
  pendingAudioName = file.name;
  pendingKeepExisting = false;
  showAudioPreview(file.name);
  showToast(`✅ Audio siap: ${file.name}`);
}

// ─── DAY BUTTONS ─────────────────────────────────────
dayBtns.forEach(btn => btn.addEventListener('click', () => btn.classList.toggle('selected')));

// ─── RINGING CONTROLS ────────────────────────────────
btnDismiss.addEventListener('click', dismissAlarm);

// ─── MODAL CONTROLS ──────────────────────────────────
if (btnAddAlarmRegular) btnAddAlarmRegular.addEventListener('click', () => openAddModal('regular'));
if (btnAddAlarmPuasa) btnAddAlarmPuasa.addEventListener('click', () => openAddModal('puasa'));
btnModalClose.addEventListener('click', closeModal);
btnCancel.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); dismissAlarm(); }
});

// ─── TOAST ───────────────────────────────────────────
function showToast(msg) {
  // Remove existing toasts
  document.querySelectorAll('.ag-toast').forEach(t => t.remove());

  const t = document.createElement('div');
  t.className = 'ag-toast';
  t.textContent = msg;
  t.style.cssText = `
    position:fixed;bottom:28px;right:28px;z-index:9999;
    background:#1a1d2e;border:1px solid rgba(108,99,255,0.35);
    color:#e8eaf6;padding:13px 22px;border-radius:14px;font-size:0.875rem;
    font-weight:500;box-shadow:0 8px 32px rgba(0,0,0,0.55);
    animation:agToastIn .25s ease;font-family:'Inter',sans-serif;
    max-width:320px;word-break:break-word;
  `;
  if (!document.getElementById('ag-toast-style')) {
    const s = document.createElement('style');
    s.id = 'ag-toast-style';
    s.textContent = `@keyframes agToastIn{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}`;
    document.head.appendChild(s);
  }
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350); }, 3000);
}

// ─── INIT ─────────────────────────────────────────────
alarms = loadAlarms().map(a => ({ ...a, category: a.category || 'regular' }));
renderAlarms();
updateClock();
setInterval(updateClock, 1000);

// Register Service Worker and request notification permission
registerSW();
requestNotificationPermission();

// Sync alarms to SW once the SW is ready/active
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.ready.then(() => {
    syncAlarmsToSW();
  });
}

function openAudioDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('alarmpro_audio', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveAudioToDB(key, file) {
  const db = await openAudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').put(file, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAudioFromDB(key) {
  const db = await openAudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readonly');
    const req = tx.objectStore('audio').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteAudioFromDB(key) {
  const db = await openAudioDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio', 'readwrite');
    tx.objectStore('audio').delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
