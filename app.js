/* ============================================================
   LakshmiNaraya — Expense Tracker
   app.js — Main Application Logic
   Vanilla JS, No Modules, Works with file:// protocol
   ============================================================ */

'use strict';

// ============================================================
// SECTION 1: CONSTANTS & STATE
// ============================================================

var STORAGE_URL_KEY  = 'lakshminaraya_sb_url';
var STORAGE_KEY_KEY  = 'lakshminaraya_sb_key';
var STORAGE_THEME    = 'lakshminaraya_theme';

var MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

var PAYMENT_MODES = {
  AxisBnk:  'Axis Bank',
  UnionBnk: 'Union Bank',
  MyZoneCC: 'MyZone CC',
  NeoCC:    'Neo CC',
  Cash:     'Cash'
};

// App starts tracking from Sep 2026. Default view = Sep 2026.
var TRACKING_START_YEAR  = 2026;
var TRACKING_START_MONTH = 9;
var FIXED_SALARY         = 43000;

// ============================================================
// LOCAL INDEXEDDB WRAPPER — offline-first data layer
// ============================================================

var LocalDB = {
  db: null,
  DB_NAME: 'LakshmiNaraya',
  DB_VERSION: 1,

  open: function() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(LocalDB.DB_NAME, LocalDB.DB_VERSION);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        ['categories','transactions','months','scheduled_items'].forEach(function(name) {
          if (!db.objectStoreNames.contains(name)) {
            var store = db.createObjectStore(name, { keyPath: 'id' });
            store.createIndex('user_id', 'user_id', { unique: false });
          }
        });
        if (!db.objectStoreNames.contains('user_settings')) {
          db.createObjectStore('user_settings', { keyPath: 'user_id' });
        }
        if (!db.objectStoreNames.contains('pending_sync')) {
          db.createObjectStore('pending_sync', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function(e) { LocalDB.db = e.target.result; resolve(); };
      req.onerror   = function(e) { console.warn('IndexedDB error:', e); resolve(); };
    });
  },

  getAll: function(storeName) {
    return new Promise(function(resolve) {
      if (!LocalDB.db) return resolve([]);
      try {
        var tx = LocalDB.db.transaction(storeName, 'readonly');
        var req = tx.objectStore(storeName).getAll();
        req.onsuccess = function() { resolve(req.result || []); };
        req.onerror   = function() { resolve([]); };
      } catch(e) { resolve([]); }
    });
  },

  putAll: function(storeName, rows) {
    return new Promise(function(resolve) {
      if (!LocalDB.db || !rows || !rows.length) return resolve();
      try {
        var tx = LocalDB.db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        rows.forEach(function(r) { store.put(r); });
        tx.oncomplete = resolve;
        tx.onerror    = function() { resolve(); };
      } catch(e) { resolve(); }
    });
  },

  put: function(storeName, row) {
    return LocalDB.putAll(storeName, [row]);
  },

  delete: function(storeName, id) {
    return new Promise(function(resolve) {
      if (!LocalDB.db) return resolve();
      try {
        var tx = LocalDB.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(id);
        tx.oncomplete = resolve;
        tx.onerror    = resolve;
      } catch(e) { resolve(); }
    });
  },

  clearStore: function(storeName) {
    return new Promise(function(resolve) {
      if (!LocalDB.db) return resolve();
      try {
        var tx = LocalDB.db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).clear();
        tx.oncomplete = resolve;
        tx.onerror    = resolve;
      } catch(e) { resolve(); }
    });
  },

  addPending: function(op) {
    return new Promise(function(resolve) {
      if (!LocalDB.db) return resolve();
      try {
        var tx = LocalDB.db.transaction('pending_sync', 'readwrite');
        tx.objectStore('pending_sync').add(op);
        tx.oncomplete = resolve;
        tx.onerror    = resolve;
      } catch(e) { resolve(); }
    });
  },

  getPending: function() {
    return LocalDB.getAll('pending_sync');
  },

  deletePending: function(id) {
    return LocalDB.delete('pending_sync', id);
  }
};

var state = {
  sb: null,
  user: null,
  currentMonth: 9,
  currentYear:  2026,
  settings: { salary: FIXED_SALARY, gemini_api_key: '', myzone_cc_bank: 'AxisBnk', neo_cc_bank: 'AxisBnk', show_spare_category: true },
  categories: [],
  transactions: [],
  scheduledItems: [],
  currentMonthRecord: null,
  charts: {},
  editingId: null,
  pendingSettleCC: null,
  aiSuggestions: [],
  pendingConfirm: null,
  currentSection: 'dashboard',
  carryForward: 0
};

var isOnline = navigator.onLine;
var syncInProgress = false;

// ============================================================
// SECTION 2: UTILITY FUNCTIONS
// ============================================================

function formatCurrency(amount) {
  if (amount === null || amount === undefined || isNaN(amount)) return '₹0';
  var n = parseFloat(amount);
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  var parts = dateStr.split('T')[0].split('-');
  if (parts.length < 3) return dateStr;
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate());
}

function pad2(n) { return n < 10 ? '0'+n : ''+n; }

function daysUntil(dateStr) {
  var today = new Date(); today.setHours(0,0,0,0);
  var d = new Date(dateStr); d.setHours(0,0,0,0);
  return Math.floor((d - today) / 86400000);
}

function getCategoryById(id) {
  return state.categories.find(function(c) { return c.id === id; }) || null;
}

function getCategoryName(id) {
  var cat = getCategoryById(id);
  return cat ? cat.icon + ' ' + cat.name : '—';
}

function getProgressClass(pct) {
  if (pct >= 100) return 'progress-red';
  if (pct >= 75)  return 'progress-yellow';
  return 'progress-green';
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(message, type) {
  type = type || 'success';
  var container = document.getElementById('toast-container');
  var toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  var icons = { success:'✅', error:'❌', info:'ℹ️', warning:'⚠️' };
  toast.innerHTML = '<span>' + (icons[type]||'') + '</span><span>' + escHtml(message) + '</span>';
  container.appendChild(toast);
  setTimeout(function() { toast.classList.add('show'); }, 10);
  setTimeout(function() {
    toast.classList.remove('show');
    setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
  }, 3500);
}

function showModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function hideModal(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function showLoading(text) {
  var ol = document.getElementById('loading-overlay');
  var lt = document.getElementById('loading-text');
  if (lt) lt.textContent = text || 'Loading...';
  if (ol) ol.classList.remove('hidden');
}

function hideLoading() {
  var ol = document.getElementById('loading-overlay');
  if (ol) ol.classList.add('hidden');
}

function confirmDelete(message, onConfirm) {
  var msg = document.getElementById('confirm-message');
  var btn = document.getElementById('confirm-ok-btn');
  if (msg) msg.textContent = message;
  if (btn) {
    btn.onclick = function() {
      hideModal('modal-confirm');
      onConfirm();
    };
  }
  showModal('modal-confirm');
}

function setElement(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function setElementText(id, text) {
  var el = document.getElementById(id);
  if (el) el.textContent = text;
}

function getVal(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function setVal(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val !== null && val !== undefined ? val : '';
}

function showErr(id) {
  var el = document.getElementById(id);
  if (el) el.classList.add('visible');
}

function clearErr(id) {
  var el = document.getElementById(id);
  if (el) el.classList.remove('visible');
}

// ============================================================
// SECTION 2b: ONLINE/OFFLINE STATE & SYNC
// ============================================================

function updateOnlineStatus(online) {
  isOnline = online;
  var banner = document.getElementById('offline-banner');
  if (banner) banner.classList.toggle('hidden', online);
  if (online && !syncInProgress) {
    flushPendingSync();
  }
}

window.addEventListener('online',  function() { updateOnlineStatus(true); });
window.addEventListener('offline', function() { updateOnlineStatus(false); });

async function flushPendingSync() {
  if (!state.sb || !state.user || syncInProgress) return;
  var pending = await LocalDB.getPending();
  if (!pending.length) return;

  syncInProgress = true;
  var synced = 0, failed = 0;

  for (var op of pending) {
    try {
      var res;
      if (op.action === 'insert') {
        res = await state.sb.from(op.table).insert(op.data);
      } else if (op.action === 'update') {
        res = await state.sb.from(op.table).update(op.data).eq('id', op.id);
      } else if (op.action === 'delete') {
        res = await state.sb.from(op.table).delete().eq('id', op.id);
      } else if (op.action === 'upsert') {
        res = await state.sb.from(op.table).upsert(op.data, { onConflict: op.conflict || 'id' });
      }
      if (res && !res.error) {
        await LocalDB.deletePending(op.id);
        synced++;
      } else {
        failed++;
      }
    } catch(e) {
      failed++;
    }
  }

  syncInProgress = false;
  if (synced > 0) showToast(synced + ' offline change(s) synced to cloud ☁️', 'info');
  if (failed > 0) showToast(failed + ' item(s) failed to sync. Will retry later.', 'warning');
}

// ============================================================
// SECTION 3: THEME
// ============================================================

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_THEME, theme);
  var btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function loadTheme() {
  var saved = localStorage.getItem(STORAGE_THEME) || 'dark';
  setTheme(saved);
}

// ============================================================
// SECTION 4: SUPABASE INIT & AUTH
// ============================================================

function getSupabaseConfig() {
  return {
    url: localStorage.getItem(STORAGE_URL_KEY) || '',
    key: localStorage.getItem(STORAGE_KEY_KEY) || ''
  };
}

function initSupabase() {
  var cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) return false;
  try {
    state.sb = supabase.createClient(cfg.url, cfg.key);
    return true;
  } catch(e) {
    console.error('Supabase init error:', e);
    return false;
  }
}

function showSupabaseConfig() {
  hideModal('modal-confirm');
  var cfg = getSupabaseConfig();
  setVal('cfg-url', cfg.url);
  setVal('cfg-key', cfg.key);
  document.getElementById('supabase-config').classList.remove('hidden');
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
}

function saveSupabaseConfig() {
  var url = getVal('cfg-url');
  var key = getVal('cfg-key');
  var valid = true;
  clearErr('cfg-url-err'); clearErr('cfg-key-err');
  if (!url || !url.includes('supabase.co')) { showErr('cfg-url-err'); valid = false; }
  if (!key || key.length < 20) { showErr('cfg-key-err'); valid = false; }
  if (!valid) return;
  localStorage.setItem(STORAGE_URL_KEY, url);
  localStorage.setItem(STORAGE_KEY_KEY, key);
  document.getElementById('supabase-config').classList.add('hidden');
  if (initSupabase()) {
    checkAuth();
  } else {
    showToast('Could not connect. Check credentials.', 'error');
  }
}

async function checkAuth() {
  if (!state.sb) {
    showSupabaseConfig();
    return;
  }
  showLoading('Checking session...');
  try {
    var result = await state.sb.auth.getSession();
    if (result.data && result.data.session && result.data.session.user) {
      state.user = result.data.session.user;
      await onLoginSuccess();
    } else {
      showLoginPage();
    }
  } catch(e) {
    console.error('Auth check error:', e);
    showLoginPage();
  } finally {
    hideLoading();
  }
}

function showLoginPage() {
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('supabase-config').classList.add('hidden');
}

async function doLogin() {
  var email = getVal('login-email');
  var pass  = getVal('login-password');
  var errEl = document.getElementById('login-error');
  var btn   = document.getElementById('login-btn');

  errEl.classList.add('hidden');
  if (!email || !pass) {
    errEl.textContent = 'Please enter email and password.';
    errEl.classList.remove('hidden');
    return;
  }

  btn.textContent = '⏳ Signing in...';
  btn.disabled = true;
  try {
    var result = await state.sb.auth.signInWithPassword({ email: email, password: pass });
    if (result.error) throw result.error;
    state.user = result.data.user;
    document.getElementById('login-page').classList.add('hidden');
    await onLoginSuccess();
  } catch(e) {
    errEl.textContent = e.message || 'Login failed. Check your credentials.';
    errEl.classList.remove('hidden');
  } finally {
    btn.textContent = '🔐 Sign In';
    btn.disabled = false;
  }
}

async function doLogout() {
  showLoading('Signing out...');
  try {
    await state.sb.auth.signOut();
  } catch(e) { /* ignore */ }
  state.user = null;
  state.settings = { salary:0, gemini_api_key:'', myzone_cc_bank:'AxisBnk', neo_cc_bank:'AxisBnk', show_spare_category:true };
  state.categories = [];
  state.transactions = [];
  hideLoading();
  document.getElementById('app').classList.add('hidden');
  showLoginPage();
}

async function onLoginSuccess() {
  showLoading('Loading your data...');
  try {
    document.getElementById('login-page').classList.add('hidden');
    document.getElementById('supabase-config').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    // Set sidebar email
    var emailEl = document.getElementById('sidebar-user-email');
    if (emailEl) emailEl.textContent = state.user.email || '';

    // Load settings
    await loadUserSettings();

    // Load categories
    await loadCategories();

    // Navigate to initial section
    var hash = window.location.hash.replace('#','') || 'dashboard';
    navigate(hash);
  } catch(e) {
    console.error('Login success error:', e);
    showToast('Error loading data: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// SECTION 5: ROUTER
// ============================================================

function navigate(section) {
  var sections = ['dashboard','transactions','categories','upcoming','analytics','settings'];
  if (sections.indexOf(section) < 0) section = 'dashboard';
  state.currentSection = section;

  // Update hash
  if (window.location.hash !== '#' + section) {
    history.replaceState(null, '', '#' + section);
  }

  // Toggle section visibility
  sections.forEach(function(s) {
    var el = document.getElementById('section-' + s);
    if (el) {
      if (s === section) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }
  });

  // Update nav active state
  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(function(el) {
    var sec = el.getAttribute('data-section');
    if (sec === section) el.classList.add('active');
    else el.classList.remove('active');
  });

  // Load section data
  if (section === 'dashboard')     loadDashboard();
  if (section === 'transactions')  loadTransactionsSection();
  if (section === 'categories')    loadCategoriesSection();
  if (section === 'upcoming')      loadUpcomingSection();
  if (section === 'analytics')     loadAnalytics();
  if (section === 'settings')      loadSettingsSection();
}

function toggleSidebar() {
  var sb = document.getElementById('sidebar');
  if (sb) sb.classList.toggle('mobile-open');
}

// ── Month/Year Picker ─────────────────────────────────────────
var pickerYear = 2026;

function toggleMonthPicker() {
  var popup = document.getElementById('month-picker-popup');
  if (!popup) return;
  if (!popup.classList.contains('hidden')) {
    popup.classList.add('hidden');
    return;
  }
  pickerYear = state.currentYear;
  renderMonthPicker();
  popup.classList.remove('hidden');
}

function renderMonthPicker() {
  document.getElementById('picker-year').textContent = pickerYear;
  var grid = document.getElementById('picker-months');
  if (!grid) return;
  grid.innerHTML = '';
  var today = new Date();
  for (var m = 1; m <= 12; m++) {
    var btn = document.createElement('button');
    btn.className = 'picker-month-btn';
    btn.textContent = SHORT_MONTHS[m - 1];
    // Disable months before tracking start
    var isBefore = pickerYear < TRACKING_START_YEAR ||
      (pickerYear === TRACKING_START_YEAR && m < TRACKING_START_MONTH);
    // Disable far-future months (beyond next 12 months)
    var maxYear = today.getFullYear() + 1;
    var isAfter = pickerYear > maxYear ||
      (pickerYear === maxYear && m > today.getMonth() + 1);
    if (isBefore || isAfter) {
      btn.classList.add('disabled');
    } else if (m === state.currentMonth && pickerYear === state.currentYear) {
      btn.classList.add('active');
    }
    (function(month) {
      btn.onclick = function() { jumpToMonth(pickerYear, month); };
    })(m);
    grid.appendChild(btn);
  }
}

function pickerChangeYear(delta) {
  pickerYear += delta;
  renderMonthPicker();
}

function jumpToMonth(year, month) {
  var popup = document.getElementById('month-picker-popup');
  if (popup) popup.classList.add('hidden');
  state.currentYear = year;
  state.currentMonth = month;
  var section = state.currentSection || 'dashboard';
  if (section === 'dashboard')    loadDashboard();
  if (section === 'transactions') loadTransactionsSection();
  if (section === 'categories')   loadCategoriesSection();
  if (section === 'analytics')    loadAnalytics();
}

// Close picker when clicking outside
document.addEventListener('click', function(e) {
  var popup = document.getElementById('month-picker-popup');
  if (!popup || popup.classList.contains('hidden')) return;
  var monthSel = document.getElementById('month-selector');
  if (monthSel && monthSel.contains(e.target)) return;
  popup.classList.add('hidden');
});

// ============================================================
// SECTION 6: USER SETTINGS
// ============================================================

async function loadUserSettings() {
  if (!state.user) return;
  try {
    var res = await state.sb.from('user_settings').select('*').eq('user_id', state.user.id).single();
    if (res.data) {
      state.settings = res.data;
      // Always enforce fixed salary
      if (parseFloat(state.settings.salary) !== FIXED_SALARY) {
        await state.sb.from('user_settings').update({ salary: FIXED_SALARY }).eq('user_id', state.user.id);
        state.settings.salary = FIXED_SALARY;
      }
    } else {
      // First-ever login — create settings with fixed salary
      var ins = await state.sb.from('user_settings').insert({
        user_id: state.user.id,
        salary: FIXED_SALARY,
        gemini_api_key: '',
        myzone_cc_bank: 'AxisBnk',
        neo_cc_bank: 'AxisBnk',
        show_spare_category: true
      }).select().single();
      if (ins.data) state.settings = ins.data;
      // Seed salary scheduled item on very first login
      await seedSalarySchedule();
    }
  } catch(e) {
    console.error('loadUserSettings error:', e);
  }
}

function lastWorkingDayOfMonth(year, month) {
  // month is 1-based
  var lastDay = new Date(year, month, 0); // last day of month
  var dow = lastDay.getDay(); // 0=Sun,6=Sat
  if (dow === 0) lastDay.setDate(lastDay.getDate() - 2); // Sun → Fri
  else if (dow === 6) lastDay.setDate(lastDay.getDate() - 1); // Sat → Fri
  return lastDay.getFullYear() + '-' + pad2(lastDay.getMonth()+1) + '-' + pad2(lastDay.getDate());
}

async function seedSalarySchedule() {
  if (!state.user) return;
  // Check if salary schedule already exists
  var check = await state.sb.from('scheduled_items')
    .select('id').eq('user_id', state.user.id)
    .ilike('name', '%salary%').limit(1);
  if (check.data && check.data.length > 0) return; // already exists

  var nextDate = lastWorkingDayOfMonth(TRACKING_START_YEAR, TRACKING_START_MONTH);
  try {
    await state.sb.from('scheduled_items').insert({
      user_id:      state.user.id,
      name:         'Monthly Salary Credit',
      amount:       FIXED_SALARY,
      type:         'credit',
      frequency:    'monthly',
      next_date:    nextDate,
      payment_mode: 'AxisBnk',
      is_active:    true,
      notes:        'Auto salary credit — last working day of every month'
    });
  } catch(e) {
    console.error('seedSalarySchedule error:', e);
  }
}

async function saveSettings(updates) {
  if (!state.user) return;
  try {
    var res = await state.sb.from('user_settings').upsert({
      user_id: state.user.id,
      ...updates
    }, { onConflict: 'user_id' }).select().single();
    if (res.data) state.settings = res.data;
    return true;
  } catch(e) {
    console.error('saveSettings error:', e);
    return false;
  }
}

// ============================================================
// SECTION 7: MONTHS (ensure current month record exists)
// ============================================================

async function ensureMonthRecord() {
  if (!state.user) return null;
  if (!isOnline) {
    var allMonths = await LocalDB.getAll('months');
    state.currentMonthRecord = allMonths.find(function(m) {
      return m.user_id === state.user.id && m.year === state.currentYear && m.month === state.currentMonth;
    }) || null;
    return state.currentMonthRecord;
  }
  try {
    var res = await state.sb.from('months')
      .select('*')
      .eq('user_id', state.user.id)
      .eq('year', state.currentYear)
      .eq('month', state.currentMonth)
      .single();

    if (res.data) {
      state.currentMonthRecord = res.data;
      await LocalDB.put('months', state.currentMonthRecord);
      return res.data;
    }

    // Create new month record
    var salary = state.settings ? parseFloat(state.settings.salary) || 0 : 0;
    var ins = await state.sb.from('months').insert({
      user_id: state.user.id,
      year: state.currentYear,
      month: state.currentMonth,
      salary: salary,
      myzone_cc_settled: false,
      neo_cc_settled: false
    }).select().single();

    if (ins.data) {
      state.currentMonthRecord = ins.data;
      await LocalDB.put('months', state.currentMonthRecord);
      return ins.data;
    }
    return null;
  } catch(e) {
    console.error('ensureMonthRecord error:', e);
    return null;
  }
}

// ============================================================
// SECTION 8: LOAD TRANSACTIONS
// ============================================================

async function fetchTransactions() {
  if (!state.user || !state.currentMonthRecord) return [];
  if (!isOnline) {
    var all = await LocalDB.getAll('transactions');
    state.transactions = all.filter(function(t) { return t.month_id === state.currentMonthRecord.id; })
                            .sort(function(a,b) { return b.date.localeCompare(a.date); });
    return state.transactions;
  }
  try {
    var res = await state.sb.from('transactions')
      .select('*').eq('month_id', state.currentMonthRecord.id)
      .order('date', { ascending: false }).order('created_at', { ascending: false });
    state.transactions = res.data || [];
    await LocalDB.putAll('transactions', state.transactions);
    return state.transactions;
  } catch(e) {
    console.error('fetchTransactions error:', e);
    var cached = await LocalDB.getAll('transactions');
    state.transactions = cached.filter(function(t) { return t.month_id === state.currentMonthRecord.id; });
    return state.transactions;
  }
}

// ============================================================
// SECTION 9: DASHBOARD
// ============================================================

async function computeCarryForward() {
  // Sum (credits - expenses) for all months BEFORE the current viewing month
  // starting from TRACKING_START (Sep 2026). Result stored in state.carryForward.
  state.carryForward = 0;
  if (!state.user || !isOnline) return;

  var cy = TRACKING_START_YEAR, cm = TRACKING_START_MONTH;
  var total = 0;

  while (cy < state.currentYear || (cy === state.currentYear && cm < state.currentMonth)) {
    try {
      var mRes = await state.sb.from('months').select('id')
        .eq('user_id', state.user.id).eq('year', cy).eq('month', cm).single();
      if (mRes.data) {
        var tRes = await state.sb.from('transactions')
          .select('amount,type,is_split,my_share').eq('month_id', mRes.data.id);
        var txns = tRes.data || [];
        var credits  = txns.filter(function(t) { return t.type === 'credit'; })
          .reduce(function(s,t) { return s + parseFloat(t.amount); }, 0);
        var expenses = txns.filter(function(t) { return t.type === 'expense' || t.type === 'split'; })
          .reduce(function(s,t) { return s + parseFloat(t.is_split ? (t.my_share||t.amount) : t.amount); }, 0);
        total += (credits - expenses);
      }
    } catch(e) { /* skip month on error */ }

    cm++;
    if (cm > 12) { cm = 1; cy++; }
    if (cy > state.currentYear + 1) break; // safety
  }

  state.carryForward = total;
}

async function loadDashboard() {
  await ensureMonthRecord();
  await fetchTransactions();
  await computeCarryForward();
  renderDashboard();
  updateUpcomingBadge();
}

function renderDashboard() {
  var txns = state.transactions;

  // Credits added this month (salary + any extra credits you entered)
  var totalCredits = txns
    .filter(function(t) { return t.type === 'credit'; })
    .reduce(function(s, t) { return s + parseFloat(t.amount); }, 0);

  // Carry-forward from all previous months (computed async before this call)
  var carryForward = state.carryForward || 0;

  var totalIncome  = totalCredits + carryForward;

  // Calculate expenses (expense + split = use my_share for budget impact)
  var totalExpense = txns
    .filter(function(t) { return t.type === 'expense' || t.type === 'split'; })
    .reduce(function(s, t) {
      var amt = t.is_split ? parseFloat(t.my_share || t.amount) : parseFloat(t.amount);
      return s + amt;
    }, 0);

  var remaining = totalIncome - totalExpense;
  var savingsPct = totalCredits > 0 ? Math.round((remaining / totalCredits) * 100) : 0;

  // Update summary cards
  setElementText('dash-income', formatCurrency(totalIncome));
  var incomeSub = formatCurrency(totalCredits) + ' this month';
  if (carryForward > 0) incomeSub += ' + ₹' + Math.round(carryForward).toLocaleString('en-IN') + ' carried forward';
  setElementText('dash-income-sub', incomeSub);
  setElementText('dash-spent', formatCurrency(totalExpense));
  setElementText('dash-remaining', formatCurrency(remaining));
  setElementText('dash-savings-pct', savingsPct + '%');

  // Axis Bank Balance = Remaining + unpaid CC dues (CC spend hasn't left the bank yet)
  var ccPendingForBank = calculateCCPending();
  var axisBankBalance = remaining + ccPendingForBank.myzone + ccPendingForBank.neo;
  var axisBankEl = document.getElementById('dash-axis-bank');
  if (axisBankEl) {
    axisBankEl.textContent = formatCurrency(axisBankBalance);
    axisBankEl.style.color = axisBankBalance >= 0 ? 'var(--accent-green-light)' : 'var(--accent-red)';
  }

  var el = document.getElementById('dash-savings-pct');
  if (el) el.style.color = savingsPct >= 20 ? 'var(--accent-green-light)' : savingsPct >= 10 ? 'var(--accent-yellow)' : 'var(--accent-red)';

  // Month header
  setElementText('month-label', MONTH_NAMES[state.currentMonth-1] + ' ' + state.currentYear);

  // CC pending
  var ccPending = calculateCCPending();
  var mzEl = document.getElementById('cc-myzone');
  var neEl = document.getElementById('cc-neo');
  var mzBtn = document.getElementById('settle-myzone-btn');
  var neBtn = document.getElementById('settle-neo-btn');

  if (mzEl) mzEl.textContent = state.currentMonthRecord && state.currentMonthRecord.myzone_cc_settled ? '✅ Settled' : formatCurrency(ccPending.myzone) + ' pending';
  if (neEl) neEl.textContent = state.currentMonthRecord && state.currentMonthRecord.neo_cc_settled ? '✅ Settled' : formatCurrency(ccPending.neo) + ' pending';
  if (mzBtn) mzBtn.disabled = !!(state.currentMonthRecord && state.currentMonthRecord.myzone_cc_settled);
  if (neBtn) neBtn.disabled = !!(state.currentMonthRecord && state.currentMonthRecord.neo_cc_settled);

  // Pending recoveries
  var pendingRecoveries = txns.filter(function(t) { return t.is_split && !t.split_recovered; });
  var pendingTotal = pendingRecoveries.reduce(function(s, t) { return s + parseFloat(t.others_share || 0); }, 0);
  var recBar = document.getElementById('pending-recoveries-bar');
  var recAmt = document.getElementById('pending-recoveries-amount');
  if (pendingTotal > 0) {
    if (recBar) recBar.classList.remove('hidden');
    if (recAmt) recAmt.textContent = formatCurrency(pendingTotal) + ' from ' + pendingRecoveries.length + ' split(s)';
  } else {
    if (recBar) recBar.classList.add('hidden');
  }

  // Alerts
  renderDashboardAlerts();

  // Category cards
  renderCategoryCards();

  // Recent transactions
  renderRecentTransactions();
}

function renderDashboardAlerts() {
  var today = new Date(); today.setHours(0,0,0,0);
  var in7 = new Date(today.getTime() + 7 * 86400000);
  var upcoming = state.scheduledItems ? state.scheduledItems.filter(function(item) {
    var d = new Date(item.next_date); d.setHours(0,0,0,0);
    return d >= today && d <= in7 && item.is_active;
  }) : [];

  var html = '';
  if (upcoming.length > 0) {
    html += '<div class="alert-row mb-3"><span>⚡</span><span style="font-size:13px;font-weight:600">Upcoming in 7 days:</span>';
    upcoming.slice(0, 3).forEach(function(item) {
      html += '<span class="badge badge-yellow">' + escHtml(item.name) + ' — ' + formatCurrency(item.amount) + '</span>';
    });
    if (upcoming.length > 3) html += '<span class="badge">+' + (upcoming.length-3) + ' more</span>';
    html += '<button class="btn btn-sm btn-secondary" onclick="navigate(\'upcoming\')" style="margin-left:auto">View →</button></div>';
  }
  setElement('dashboard-alerts', html);
}

function renderCategoryCards() {
  var txns = state.transactions;
  var cats = state.categories.filter(function(c) { return c.is_active; });
  cats.sort(function(a,b) { return (a.order_index||0) - (b.order_index||0); });

  if (cats.length === 0) {
    setElement('category-cards', '<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">🏷️</div><div class="empty-title">No categories yet</div><div class="empty-desc">Go to Categories to add your first budget category</div></div>');
    return;
  }

  var html = '';
  cats.forEach(function(cat) {
    var spent = txns
      .filter(function(t) {
        var isExpense = t.type === 'expense' || t.type === 'split';
        return isExpense && t.category_id === cat.id;
      })
      .reduce(function(s, t) {
        return s + parseFloat(t.is_split ? (t.my_share || t.amount) : t.amount);
      }, 0);

    var budget = parseFloat(cat.budget_amount) || 0;
    var pct = budget > 0 ? Math.min(Math.round((spent / budget) * 100), 100) : 0;
    var pctCls = getProgressClass(pct);

    html += '<div class="category-card" style="border-left:3px solid ' + escHtml(cat.color) + '">';
    html += '<div class="cat-header"><span class="cat-icon">' + escHtml(cat.icon) + '</span><span class="cat-name">' + escHtml(cat.name) + '</span></div>';
    html += '<div class="cat-amounts"><span class="cat-spent">' + formatCurrency(spent) + '</span><span style="color:var(--text-muted)"> / ' + formatCurrency(budget) + '</span></div>';
    html += '<div class="progress-bar-wrap"><div class="progress-bar-fill ' + pctCls + '" style="width:' + pct + '%"></div></div>';
    html += '<div style="font-size:11px;color:var(--text-secondary);margin-top:4px;display:flex;justify-content:space-between"><span>' + pct + '%</span><span>' + escHtml(cat.type) + '</span></div>';
    html += '</div>';
  });
  setElement('category-cards', html);
}

function renderRecentTransactions() {
  var txns = state.transactions.slice(0, 8);
  if (txns.length === 0) {
    setElement('recent-txn-body', '<tr><td colspan="6" class="text-center" style="padding:24px;color:var(--text-secondary)">No transactions this month</td></tr>');
    return;
  }
  var html = '';
  txns.forEach(function(t) {
    var sign = t.type === 'credit' ? '+' : '-';
    var amtColor = t.type === 'credit' ? 'var(--accent-green-light)' : 'var(--accent-red-light)';
    var displayAmt = t.is_split ? parseFloat(t.my_share || t.amount) : parseFloat(t.amount);
    html += '<tr>';
    html += '<td>' + formatDate(t.date) + '</td>';
    html += '<td>' + escHtml(t.description || '—') + '</td>';
    html += '<td class="col-hide-mobile">' + getCategoryName(t.category_id) + '</td>';
    html += '<td style="color:' + amtColor + ';font-weight:600">' + sign + formatCurrency(displayAmt) + '</td>';
    html += '<td class="col-hide-mobile">' + escHtml(PAYMENT_MODES[t.payment_mode] || t.payment_mode) + '</td>';
    html += '<td><span class="type-badge type-' + escHtml(t.type) + '">' + escHtml(t.type) + '</span></td>';
    html += '</tr>';
  });
  setElement('recent-txn-body', html);
}

// ============================================================
// SECTION 10: TRANSACTIONS SECTION
// ============================================================

async function loadTransactionsSection() {
  await ensureMonthRecord();
  await fetchTransactions();
  populateCategoryFilter();
  applyFilters();
  setElementText('month-label', MONTH_NAMES[state.currentMonth-1] + ' ' + state.currentYear);
}

function populateCategoryFilter() {
  var sel = document.getElementById('filter-category');
  if (!sel) return;
  var current = sel.value;
  sel.innerHTML = '<option value="">All Categories</option>';
  state.categories.forEach(function(c) {
    sel.innerHTML += '<option value="' + escHtml(c.id) + '">' + escHtml(c.icon + ' ' + c.name) + '</option>';
  });
  sel.value = current;
}

function applyFilters() {
  var type = getVal('filter-type');
  var catId = getVal('filter-category');
  var mode = getVal('filter-mode');
  var dateFrom = getVal('filter-date-from');
  var dateTo = getVal('filter-date-to');

  var filtered = state.transactions.filter(function(t) {
    if (type && t.type !== type) return false;
    if (catId && t.category_id !== catId) return false;
    if (mode && t.payment_mode !== mode) return false;
    if (dateFrom && t.date < dateFrom) return false;
    if (dateTo && t.date > dateTo) return false;
    return true;
  });

  renderTransactionsTable(filtered);
}

function clearFilters() {
  setVal('filter-type', '');
  setVal('filter-category', '');
  setVal('filter-mode', '');
  setVal('filter-date-from', '');
  setVal('filter-date-to', '');
  applyFilters();
}

function renderTransactionsTable(txns) {
  var totalExpense = 0, totalCredit = 0;
  txns.forEach(function(t) {
    var amt = t.is_split ? parseFloat(t.my_share || t.amount) : parseFloat(t.amount);
    if (t.type === 'credit') totalCredit += amt;
    else totalExpense += amt;
  });

  setElementText('txn-total-expense', formatCurrency(totalExpense));
  setElementText('txn-total-credit', formatCurrency(totalCredit));
  setElementText('txn-count', txns.length + ' transaction' + (txns.length !== 1 ? 's' : ''));

  if (txns.length === 0) {
    setElement('txn-table-body', '<tr><td colspan="7" class="text-center" style="padding:40px;color:var(--text-secondary)">No transactions match your filters</td></tr>');
    return;
  }

  var html = '';
  txns.forEach(function(t) {
    var sign = t.type === 'credit' ? '+' : '-';
    var amtColor = t.type === 'credit' ? 'var(--accent-green-light)' : 'var(--accent-red-light)';
    var displayAmt = t.is_split ? parseFloat(t.my_share || t.amount) : parseFloat(t.amount);
    var splitBadge = t.is_split ? ' <span class="badge" style="background:rgba(41,128,185,0.3);color:#5DADE2;font-size:10px">split</span>' : '';
    var recoveredBadge = t.is_split && t.split_recovered ? ' <span class="badge badge-green" style="font-size:10px">recovered</span>' : '';
    var creditSubBadge = t.type === 'credit' && t.credit_subtype ? ' <span class="badge badge-green" style="font-size:10px">' + escHtml(t.credit_subtype) + '</span>' : '';

    html += '<tr>';
    html += '<td style="white-space:nowrap">' + formatDate(t.date) + '</td>';
    html += '<td>' + escHtml(t.description || '—') + splitBadge + recoveredBadge + '</td>';
    html += '<td class="col-hide-mobile">' + getCategoryName(t.category_id) + '</td>';
    html += '<td style="color:' + amtColor + ';font-weight:600;white-space:nowrap">' + sign + formatCurrency(displayAmt) + creditSubBadge + '</td>';
    html += '<td class="col-hide-mobile">' + escHtml(PAYMENT_MODES[t.payment_mode] || t.payment_mode) + '</td>';
    html += '<td><span class="type-badge type-' + escHtml(t.type) + '">' + escHtml(t.type) + '</span></td>';
    html += '<td style="white-space:nowrap">';
    html += '<button class="btn btn-sm btn-secondary" onclick="openEditTransaction(\'' + t.id + '\')" style="margin-right:4px">✏️</button>';
    html += '<button class="btn btn-sm btn-danger" onclick="deleteTransaction(\'' + t.id + '\')">🗑️</button>';
    if (t.is_split && !t.split_recovered) {
      html += ' <button class="btn btn-sm btn-success" onclick="markRecoveryReceived(\'' + t.id + '\',' + parseFloat(t.others_share||0) + ')" title="Mark recovery received">🤝</button>';
    }
    html += '</td>';
    html += '</tr>';
  });
  setElement('txn-table-body', html);
}

// Add Transaction
function openAddTransaction() {
  state.editingId = null;
  document.getElementById('modal-txn-title').textContent = 'Add Transaction';
  setVal('txn-date', todayStr());
  setVal('txn-type', 'expense');
  setVal('txn-desc', '');
  setVal('txn-amount', '');
  setVal('txn-category', '');
  setVal('txn-mode', 'AxisBnk');
  setVal('txn-credit-subtype', 'salary');
  setVal('txn-my-share', '');
  setVal('txn-others-share', '');
  clearErr('txn-date-err'); clearErr('txn-amount-err');
  onTxnTypeChange();
  populateTxnCategorySelect();
  showModal('modal-transaction');
}

function openEditTransaction(id) {
  var t = state.transactions.find(function(x) { return x.id === id; });
  if (!t) return;
  state.editingId = id;
  document.getElementById('modal-txn-title').textContent = 'Edit Transaction';
  setVal('txn-date', t.date);
  setVal('txn-type', t.type);
  setVal('txn-desc', t.description);
  setVal('txn-amount', t.amount);
  setVal('txn-category', t.category_id || '');
  setVal('txn-mode', t.payment_mode || 'AxisBnk');
  setVal('txn-credit-subtype', t.credit_subtype || 'salary');
  setVal('txn-my-share', t.my_share || '');
  setVal('txn-others-share', t.others_share || '');
  clearErr('txn-date-err'); clearErr('txn-amount-err');
  onTxnTypeChange();
  populateTxnCategorySelect(t.category_id);
  showModal('modal-transaction');
}

function populateTxnCategorySelect(selectedId) {
  var sel = document.getElementById('txn-category');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- No Category --</option>';
  state.categories.forEach(function(c) {
    var opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.icon + ' ' + c.name;
    if (c.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function onTxnTypeChange() {
  var type = getVal('txn-type');
  var creditGroup = document.getElementById('txn-credit-subtype-group');
  var splitSection = document.getElementById('split-section');
  if (creditGroup) creditGroup.style.display = type === 'credit' ? 'block' : 'none';
  if (splitSection) splitSection.style.display = type === 'split' ? 'block' : 'none';
}

function onAmountInput() {
  var type = getVal('txn-type');
  if (type !== 'split') return;
  onMyShareInput();
}

function onMyShareInput() {
  var total = parseFloat(getVal('txn-amount')) || 0;
  var myShare = parseFloat(getVal('txn-my-share')) || 0;
  var others = Math.max(0, total - myShare);
  setVal('txn-others-share', others.toFixed(2));
}

async function saveTransaction() {
  var date = getVal('txn-date');
  var amount = parseFloat(getVal('txn-amount'));
  var type = getVal('txn-type');
  var desc = getVal('txn-desc');
  var catId = getVal('txn-category') || null;
  var mode = getVal('txn-mode');
  var creditSub = getVal('txn-credit-subtype');
  var myShare = parseFloat(getVal('txn-my-share')) || null;
  var othersShare = parseFloat(getVal('txn-others-share')) || null;

  var valid = true;
  clearErr('txn-date-err'); clearErr('txn-amount-err');
  if (!date) { showErr('txn-date-err'); valid = false; }
  if (!amount || amount <= 0) { showErr('txn-amount-err'); valid = false; }
  if (!valid) return;

  if (type === 'split' && !myShare) { myShare = amount; othersShare = 0; }

  await ensureMonthRecord();
  if (!state.currentMonthRecord) { showToast('Could not create month record', 'error'); return; }

  showLoading('Saving...');
  try {
    var payload = {
      user_id: state.user.id,
      month_id: state.currentMonthRecord.id,
      category_id: catId,
      amount: amount,
      type: type,
      payment_mode: mode,
      description: desc,
      date: date,
      is_split: type === 'split',
      my_share: type === 'split' ? myShare : null,
      others_share: type === 'split' ? othersShare : null,
      credit_subtype: type === 'credit' ? creditSub : ''
    };

    if (!isOnline) {
      var localId = state.editingId || ('local_' + Date.now());
      var localPayload = Object.assign({}, payload, { id: localId });
      await LocalDB.put('transactions', localPayload);
      state.transactions = (await LocalDB.getAll('transactions'))
        .filter(function(t) { return t.month_id === state.currentMonthRecord.id; });
      await LocalDB.addPending({
        action: state.editingId ? 'update' : 'insert',
        table: 'transactions',
        data: payload,
        id: state.editingId || null
      });
      showToast('Saved offline — will sync when connected ☁️', 'warning');
      hideModal('modal-transaction');
      if (state.currentSection === 'dashboard') renderDashboard();
      if (state.currentSection === 'transactions') { populateCategoryFilter(); applyFilters(); }
      hideLoading();
      return;
    }
    var res;
    if (state.editingId) {
      res = await state.sb.from('transactions').update(payload).eq('id', state.editingId);
    } else {
      res = await state.sb.from('transactions').insert(payload);
    }
    if (res.error) throw res.error;
    // Update local cache after successful save
    await fetchTransactions();
    await LocalDB.putAll('transactions', state.transactions);

    hideModal('modal-transaction');
    showToast(state.editingId ? 'Transaction updated!' : 'Transaction added!');
    if (state.currentSection === 'dashboard') renderDashboard();
    if (state.currentSection === 'transactions') { populateCategoryFilter(); applyFilters(); }
    if (state.currentSection === 'categories') renderCategoriesTable();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

async function deleteTransaction(id) {
  confirmDelete('Delete this transaction? This cannot be undone.', async function() {
    showLoading('Deleting...');
    try {
      var res = await state.sb.from('transactions').delete().eq('id', id);
      if (res.error) throw res.error;
      showToast('Transaction deleted');
      await fetchTransactions();
      if (state.currentSection === 'dashboard') renderDashboard();
      if (state.currentSection === 'transactions') { populateCategoryFilter(); applyFilters(); }
    } catch(e) {
      showToast('Error: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  });
}

async function markRecoveryReceived(txnId, othersShare) {
  showLoading('Marking recovery...');
  try {
    // Mark split as recovered
    await state.sb.from('transactions').update({ split_recovered: true }).eq('id', txnId);

    // Create credit transaction
    await state.sb.from('transactions').insert({
      user_id: state.user.id,
      month_id: state.currentMonthRecord.id,
      amount: othersShare,
      type: 'credit',
      credit_subtype: 'group_recovery',
      payment_mode: 'Cash',
      description: 'Group recovery received',
      date: todayStr(),
      is_split: false
    });

    showToast('Recovery marked! Credit transaction created.');
    await fetchTransactions();
    if (state.currentSection === 'dashboard') renderDashboard();
    if (state.currentSection === 'transactions') applyFilters();
    hideModal('modal-recoveries');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// SECTION 11: CC SETTLEMENT
// ============================================================

function calculateCCPending() {
  var txns = state.transactions;
  var mzPending = 0, nePending = 0;

  if (!state.currentMonthRecord || !state.currentMonthRecord.myzone_cc_settled) {
    // Expenses add to pending; credits (refunds/CRADJ) reduce it
    mzPending = txns
      .filter(function(t) { return t.payment_mode === 'MyZoneCC'; })
      .reduce(function(s, t) {
        var amt = parseFloat(t.amount);
        return t.type === 'credit' ? s - amt : s + amt;
      }, 0);
    mzPending = Math.max(0, mzPending); // can't go negative
  }

  if (!state.currentMonthRecord || !state.currentMonthRecord.neo_cc_settled) {
    nePending = txns
      .filter(function(t) { return t.payment_mode === 'NeoCC'; })
      .reduce(function(s, t) {
        var amt = parseFloat(t.amount);
        return t.type === 'credit' ? s - amt : s + amt;
      }, 0);
    nePending = Math.max(0, nePending);
  }

  return { myzone: mzPending, neo: nePending };
}

function openSettleCC(ccType) {
  state.pendingSettleCC = ccType;
  var ccPending = calculateCCPending();
  var amount = ccType === 'MyZoneCC' ? ccPending.myzone : ccPending.neo;
  var bankKey = ccType === 'MyZoneCC' ? state.settings.myzone_cc_bank : state.settings.neo_cc_bank;
  var bankName = PAYMENT_MODES[bankKey] || bankKey;
  var ccName = ccType === 'MyZoneCC' ? 'MyZone CC' : 'Neo CC';

  document.getElementById('modal-settle-cc-title').textContent = 'Settle ' + ccName;
  document.getElementById('settle-cc-content').innerHTML =
    '<div style="background:rgba(212,160,23,0.08);border:1px solid rgba(212,160,23,0.2);border-radius:8px;padding:16px;margin-bottom:12px">' +
    '<div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px">Total ' + escHtml(ccName) + ' spending this month:</div>' +
    '<div style="font-size:28px;font-weight:700;color:var(--accent-gold)">' + formatCurrency(amount) + '</div>' +
    '</div>' +
    '<p style="font-size:13px;color:var(--text-secondary);line-height:1.6">' +
    'This will mark ' + escHtml(ccName) + ' as settled for ' + escHtml(MONTH_NAMES[state.currentMonth-1]) + ' ' + state.currentYear + '.<br>' +
    'The amount will be noted as paid from <strong>' + escHtml(bankName) + '</strong>.<br>' +
    'No new transaction will be created — individual transactions already serve as the record.' +
    '</p>';

  showModal('modal-settle-cc');
}

async function confirmSettleCC() {
  if (!state.pendingSettleCC || !state.currentMonthRecord) return;
  showLoading('Settling CC...');
  try {
    var updates = {};
    if (state.pendingSettleCC === 'MyZoneCC') updates.myzone_cc_settled = true;
    else updates.neo_cc_settled = true;

    var res = await state.sb.from('months').update(updates).eq('id', state.currentMonthRecord.id);
    if (res.error) throw res.error;

    state.currentMonthRecord = { ...state.currentMonthRecord, ...updates };
    hideModal('modal-settle-cc');
    showToast('CC settled successfully! ✅');
    if (state.currentSection === 'dashboard') renderDashboard();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
    state.pendingSettleCC = null;
  }
}

// ============================================================
// SECTION 12: PENDING RECOVERIES MODAL
// ============================================================

function openRecoveriesModal() {
  var pending = state.transactions.filter(function(t) { return t.is_split && !t.split_recovered; });
  if (pending.length === 0) {
    setElement('recoveries-list', '<div class="empty-state"><div class="empty-icon">🎉</div><div class="empty-title">All cleared!</div></div>');
  } else {
    var html = '';
    pending.forEach(function(t) {
      html += '<div class="recovery-item">';
      html += '<div style="flex:1"><div style="font-size:13px;font-weight:600">' + escHtml(t.description || 'Split Payment') + '</div>';
      html += '<div style="font-size:11px;color:var(--text-secondary)">' + formatDate(t.date) + ' · Total: ' + formatCurrency(t.amount) + ' · Your share: ' + formatCurrency(t.my_share) + '</div></div>';
      html += '<div style="text-align:right"><div style="font-size:15px;font-weight:700;color:var(--accent-gold)">You are owed: ' + formatCurrency(t.others_share) + '</div>';
      html += '<button class="btn btn-sm btn-success mt-1" onclick="markRecoveryReceived(\'' + t.id + '\',' + parseFloat(t.others_share||0) + ')">✅ Received</button></div>';
      html += '</div>';
    });
    setElement('recoveries-list', html);
  }
  showModal('modal-recoveries');
}

// ============================================================
// SECTION 13: CATEGORIES
// ============================================================

async function loadCategories() {
  if (!state.user) return;
  if (!isOnline) {
    var all = await LocalDB.getAll('categories');
    state.categories = all.filter(function(c) { return c.user_id === state.user.id && c.is_active; })
                          .sort(function(a,b) { return (a.order_index||0)-(b.order_index||0); });
    return;
  }
  try {
    var res = await state.sb.from('categories')
      .select('*').eq('user_id', state.user.id).eq('is_active', true)
      .order('order_index', { ascending: true });
    state.categories = res.data || [];
    if (state.categories.length === 0) {
      await seedDefaultCategories();
    } else {
      await LocalDB.clearStore('categories');
      await LocalDB.putAll('categories', state.categories);
    }
  } catch(e) {
    console.error('loadCategories error:', e);
    var cached = await LocalDB.getAll('categories');
    state.categories = cached.filter(function(c) { return c.user_id === state.user.id && c.is_active; })
                             .sort(function(a,b) { return (a.order_index||0)-(b.order_index||0); });
  }
}

async function seedDefaultCategories() {
  if (!state.user) return;
  var salary = FIXED_SALARY;
  var base   = 43000;

  // Proportional to user salary; defaults match ₹43K split
  var templates = [
    { name:'Rent + Gym',               icon:'🏠', color:'#EF4444', type:'expense',    budget: 8500 },
    { name:'Ration + Food',            icon:'🛒', color:'#F97316', type:'expense',    budget: 6000 },
    { name:'Electricity + Wifi',       icon:'⚡', color:'#F59E0B', type:'expense',    budget: 1500 },
    { name:'Travel + Commute',         icon:'🚗', color:'#06B6D4', type:'expense',    budget: 3000 },
    { name:'Term + Health Insurance',  icon:'🛡️', color:'#8B5CF6', type:'expense',    budget: 1000 },
    { name:'SIP + Investments',        icon:'📈', color:'#10B981', type:'investment', budget: 9000 },
    { name:'Gold Savings',             icon:'🥇', color:'#F59E0B', type:'investment', budget: 1000 },
    { name:'FD Ladder',                icon:'🏦', color:'#06B6D4', type:'savings',    budget: 2000 },
    { name:'Emergency Fund',           icon:'🆘', color:'#EF4444', type:'savings',    budget: 3000 },
    { name:'Wellbeing',                icon:'🥗', color:'#10B981', type:'expense',    budget: 1500 },
    { name:'Other Expenses',           icon:'🧾', color:'#94A3B8', type:'expense',    budget: 3000 },
    { name:'Cash in Hand / Buffer',    icon:'💵', color:'#A78BFA', type:'expense',    budget: 2000 }
  ];

  var totalTemplate = templates.reduce(function(s,t){ return s + t.budget; }, 0); // 42500
  var ratio = salary / base;

  var rows = templates.map(function(t, idx) {
    return {
      user_id:       state.user.id,
      name:          t.name,
      icon:          t.icon,
      color:         t.color,
      budget_amount: Math.round(t.budget * ratio),
      type:          t.type,
      order_index:   idx,
      is_spare:      false,
      is_active:     true
    };
  });

  // Month's Spare — remaining after all categories
  var allocatedTotal = rows.reduce(function(s,r){ return s + r.budget_amount; }, 0);
  var spare = Math.max(0, salary - allocatedTotal);
  if (spare > 0) {
    rows.push({
      user_id:       state.user.id,
      name:          "Month's Spare",
      icon:          '💰',
      color:         '#A78BFA',
      budget_amount: spare,
      type:          'expense',
      order_index:   rows.length,
      is_spare:      true,
      is_active:     true
    });
  }

  try {
    var res = await state.sb.from('categories').insert(rows).select();
    if (res.error) {
      console.error('seedDefaultCategories insert error:', res.error);
      showToast('Could not seed categories: ' + res.error.message, 'error');
      return;
    }
    state.categories = res.data || [];
    showToast('Budget categories ready for ₹43,000 salary!', 'info');
  } catch(e) {
    console.error('seedDefaultCategories exception:', e);
    showToast('Error creating categories: ' + e.message, 'error');
  }
}

async function loadCategoriesSection() {
  await loadCategories();
  await ensureMonthRecord();
  await fetchTransactions();
  renderCategoriesTable();
  setElementText('month-label', MONTH_NAMES[state.currentMonth-1] + ' ' + state.currentYear);
}

function renderCategoriesTable() {
  var cats = state.categories.slice().sort(function(a,b) { return (a.order_index||0) - (b.order_index||0); });

  var salary = parseFloat(state.settings.salary) || 0;
  var totalBudget = cats.reduce(function(s, c) { return s + parseFloat(c.budget_amount || 0); }, 0);

  setElementText('cat-total-budget', formatCurrency(totalBudget));
  setElementText('cat-salary-ref', formatCurrency(salary));

  if (cats.length === 0) {
    setElement('cat-table-body',
      '<tr><td colspan="7"><div class="empty-state">' +
      '<div class="empty-icon">🏷️</div>' +
      '<div class="empty-title">No categories yet</div>' +
      '<div class="empty-desc" style="margin-bottom:16px">Your default ₹43,000 budget categories should auto-load. Click below if they haven\'t appeared.</div>' +
      '<button class="btn btn-primary" onclick="forceLoadDefaultCategories()">⚡ Load Default Categories</button>' +
      '</div></td></tr>'
    );
    return;
  }

  var html = '';
  cats.forEach(function(cat, idx) {
    var spent = state.transactions
      .filter(function(t) {
        return (t.type === 'expense' || t.type === 'split') && t.category_id === cat.id;
      })
      .reduce(function(s, t) {
        return s + parseFloat(t.is_split ? (t.my_share || t.amount) : t.amount);
      }, 0);

    var budget = parseFloat(cat.budget_amount) || 0;
    var pct = budget > 0 ? Math.min(Math.round((spent / budget) * 100), 100) : 0;
    var pctCls = getProgressClass(pct);

    html += '<tr>';
    html += '<td style="font-size:20px;text-align:center">' + escHtml(cat.icon) + '</td>';
    html += '<td><span style="font-weight:600">' + escHtml(cat.name) + '</span>' + (cat.is_spare ? ' <span class="badge badge-gold" style="font-size:10px">auto</span>' : '') + '</td>';
    html += '<td><span class="type-badge" style="background:rgba(212,160,23,0.1);color:var(--accent-gold)">' + escHtml(cat.type) + '</span></td>';
    html += '<td style="font-weight:600">' + formatCurrency(budget) + '</td>';
    html += '<td style="color:' + (pct >= 100 ? 'var(--accent-red)' : 'var(--text-primary)') + ';font-weight:600">' + formatCurrency(spent) + '</td>';
    html += '<td style="min-width:100px"><div class="progress-bar-wrap"><div class="progress-bar-fill ' + pctCls + '" style="width:' + pct + '%"></div></div><div style="font-size:10px;color:var(--text-secondary);margin-top:2px">' + pct + '%</div></td>';
    html += '<td style="white-space:nowrap">';
    if (!cat.is_spare) {
      html += '<button class="btn btn-sm btn-secondary" onclick="openEditCategory(\'' + cat.id + '\')" style="margin-right:4px">✏️</button>';
      html += '<button class="btn btn-sm btn-danger" onclick="deleteCategory(\'' + cat.id + '\')">🗑️</button>';
    } else {
      html += '<span style="font-size:11px;color:var(--text-muted)">Auto-managed</span>';
    }
    html += '</td>';
    html += '</tr>';
  });
  setElement('cat-table-body', html);
}

async function forceLoadDefaultCategories() {
  showLoading('Creating default categories...');
  try {
    // Delete any existing inactive categories first to avoid conflicts
    await state.sb.from('categories').delete().eq('user_id', state.user.id);
    state.categories = [];
    await seedDefaultCategories();
    renderCategoriesTable();
    showToast('Default categories loaded!', 'info');
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

function openAddCategory() {
  state.editingId = null;
  document.getElementById('modal-cat-title').textContent = 'Add Category';
  setVal('cat-name', '');
  setVal('cat-icon', '💰');
  document.getElementById('cat-color').value = '#D4A017';
  setVal('cat-budget', '');
  setVal('cat-type', 'expense');
  clearErr('cat-name-err');
  showModal('modal-category');
}

function openEditCategory(id) {
  var cat = state.categories.find(function(c) { return c.id === id; });
  if (!cat) return;
  state.editingId = id;
  document.getElementById('modal-cat-title').textContent = 'Edit Category';
  setVal('cat-name', cat.name);
  setVal('cat-icon', cat.icon);
  document.getElementById('cat-color').value = cat.color || '#D4A017';
  setVal('cat-budget', cat.budget_amount);
  setVal('cat-type', cat.type || 'expense');
  clearErr('cat-name-err');
  showModal('modal-category');
}

async function saveCategory() {
  var name   = getVal('cat-name');
  var icon   = getVal('cat-icon') || '💰';
  var color  = document.getElementById('cat-color').value || '#D4A017';
  var budget = parseFloat(getVal('cat-budget')) || 0;
  var type   = getVal('cat-type');

  clearErr('cat-name-err');
  if (!name) { showErr('cat-name-err'); return; }

  showLoading('Saving category...');
  try {
    var maxOrder = state.categories.reduce(function(m, c) { return Math.max(m, c.order_index||0); }, 0);
    var payload = {
      user_id: state.user.id,
      name: name, icon: icon, color: color,
      budget_amount: budget, type: type,
      order_index: state.editingId ? undefined : maxOrder + 1,
      is_active: true
    };

    if (!isOnline) {
      var localId = state.editingId || ('local_' + Date.now());
      var localCat = Object.assign({}, payload, { id: localId, is_active: true });
      await LocalDB.put('categories', localCat);
      if (!state.editingId) state.categories.push(localCat);
      await LocalDB.addPending({ action: state.editingId ? 'update' : 'insert', table: 'categories', data: payload, id: state.editingId });
      hideModal('modal-category');
      showToast('Category saved offline — will sync when connected ☁️', 'warning');
      await updateSpareCategory();
      renderCategoriesTable();
      hideLoading();
      return;
    }
    var res;
    if (state.editingId) {
      delete payload.order_index;
      res = await state.sb.from('categories').update(payload).eq('id', state.editingId);
    } else {
      res = await state.sb.from('categories').insert(payload);
    }
    if (res.error) throw res.error;
    // Update local cache
    await loadCategories();
    await LocalDB.putAll('categories', state.categories);

    hideModal('modal-category');
    showToast(state.editingId ? 'Category updated!' : 'Category added!');
    await updateSpareCategory();
    renderCategoriesTable();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

async function deleteCategory(id) {
  confirmDelete('Delete this category? Transactions will keep the category reference but it will be hidden.', async function() {
    showLoading('Deleting...');
    try {
      var res = await state.sb.from('categories').update({ is_active: false }).eq('id', id);
      if (res.error) throw res.error;
      showToast('Category deleted');
      await loadCategories();
      await updateSpareCategory();
      renderCategoriesTable();
    } catch(e) {
      showToast('Error: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  });
}

async function updateSpareCategory() {
  if (!state.user) return;
  var salary = parseFloat(state.settings.salary) || 0;
  if (salary <= 0) return;

  var activeCats = state.categories.filter(function(c) { return !c.is_spare; });
  var totalBudget = activeCats.reduce(function(s, c) { return s + parseFloat(c.budget_amount || 0); }, 0);
  var spare = salary - totalBudget;

  var spareCat = state.categories.find(function(c) { return c.is_spare; });

  try {
    if (spare > 0 && state.settings.show_spare_category) {
      if (spareCat) {
        await state.sb.from('categories').update({ budget_amount: spare }).eq('id', spareCat.id);
      } else {
        var maxOrder = state.categories.reduce(function(m, c) { return Math.max(m, c.order_index||0); }, 0);
        await state.sb.from('categories').insert({
          user_id: state.user.id,
          name: "Month's Spare",
          icon: '💰',
          color: '#1A7A4A',
          budget_amount: spare,
          type: 'savings',
          is_spare: true,
          is_active: true,
          order_index: maxOrder + 1
        });
      }
    } else if (spareCat) {
      if (!state.settings.show_spare_category || spare <= 0) {
        await state.sb.from('categories').update({ is_active: false }).eq('id', spareCat.id);
      }
    }
    await loadCategories();
  } catch(e) {
    console.error('updateSpareCategory error:', e);
  }
}

// ============================================================
// SECTION 14: UPCOMING / SCHEDULED
// ============================================================

async function loadScheduledItems() {
  if (!state.user) return;
  try {
    var res = await state.sb.from('scheduled_items')
      .select('*')
      .eq('user_id', state.user.id)
      .order('next_date', { ascending: true });
    state.scheduledItems = res.data || [];
  } catch(e) {
    console.error('loadScheduledItems error:', e);
    state.scheduledItems = [];
  }
}

async function loadUpcomingSection() {
  await loadScheduledItems();
  await loadCategories();
  renderUpcomingSection();
  setElementText('month-label', MONTH_NAMES[state.currentMonth-1] + ' ' + state.currentYear);
}

function renderUpcomingSection() {
  var today = new Date(); today.setHours(0,0,0,0);
  var in7   = new Date(today.getTime() +  7 * 86400000);
  var in30  = new Date(today.getTime() + 30 * 86400000);

  var items = state.scheduledItems;

  var overdue   = items.filter(function(i) { return i.is_active && new Date(i.next_date) < today; });
  var dueSoon   = items.filter(function(i) {
    var d = new Date(i.next_date); return i.is_active && d >= today && d <= in7;
  });
  var next30    = items.filter(function(i) {
    var d = new Date(i.next_date); return i.is_active && d > in7 && d <= in30;
  });

  // Update upcoming badge in sidebar
  var total = overdue.length + dueSoon.length;
  var badge = document.getElementById('sidebar-upcoming-badge');
  if (badge) {
    if (total > 0) { badge.textContent = total; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }

  // Overdue section
  var overdueSection = document.getElementById('overdue-section');
  if (overdue.length > 0) {
    overdueSection.classList.remove('hidden');
    setElement('overdue-list', overdue.map(function(i) { return buildUpcomingItemHtml(i, 'overdue'); }).join(''));
  } else {
    overdueSection.classList.add('hidden');
  }

  // Due soon section
  var dueSoonSection = document.getElementById('due-soon-section');
  if (dueSoon.length > 0) {
    dueSoonSection.classList.remove('hidden');
    setElement('due-soon-list', dueSoon.map(function(i) { return buildUpcomingItemHtml(i, 'due-soon'); }).join(''));
  } else {
    dueSoonSection.classList.add('hidden');
  }

  // Next 30 days
  if (next30.length > 0) {
    setElement('upcoming-list', next30.map(function(i) { return buildUpcomingItemHtml(i, ''); }).join(''));
  } else {
    setElement('upcoming-list', '<div class="empty-state"><div class="empty-icon">📭</div><div class="empty-title">Nothing due in the next 30 days</div></div>');
  }

  // All scheduled items
  if (items.length > 0) {
    setElement('all-scheduled-list', items.map(function(i) { return buildUpcomingItemHtml(i, '', true); }).join(''));
  } else {
    setElement('all-scheduled-list', '<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-title">No scheduled items</div><div class="empty-desc">Add EMIs, salaries, recurring bills...</div></div>');
  }
}

function buildUpcomingItemHtml(item, extraClass, showEdit) {
  var d = new Date(item.next_date);
  var day = pad2(d.getDate());
  var mon = SHORT_MONTHS[d.getMonth()];
  var daysLeft = daysUntil(item.next_date);
  var daysText = daysLeft < 0 ? Math.abs(daysLeft) + ' days overdue' : daysLeft === 0 ? 'Due today' : 'In ' + daysLeft + ' days';
  var amtColor = item.type === 'credit' ? 'var(--accent-green-light)' : 'var(--accent-red-light)';
  var sign = item.type === 'credit' ? '+' : '-';
  var cat = getCategoryById(item.category_id);
  var catStr = cat ? cat.icon + ' ' + cat.name : '';
  var freqBadge = '<span style="font-size:10px;color:var(--text-muted)">🔁 ' + escHtml(item.frequency) + '</span>';

  var html = '<div class="upcoming-item ' + extraClass + '">';
  html += '<div class="upcoming-date"><div class="upcoming-day">' + escHtml(day) + '</div><div class="upcoming-month">' + escHtml(mon) + '</div></div>';
  html += '<div class="upcoming-info">';
  html += '<div class="upcoming-name">' + escHtml(item.name) + '</div>';
  html += '<div class="upcoming-sub">' + daysText + (catStr ? ' · ' + escHtml(catStr) : '') + ' · ' + freqBadge + '</div>';
  if (item.notes) html += '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">' + escHtml(item.notes) + '</div>';
  html += '</div>';
  html += '<div class="upcoming-amount ' + (item.type === 'credit' ? 'credit' : 'debit') + '">' + sign + formatCurrency(item.amount) + '</div>';
  html += '<div style="display:flex;flex-direction:column;gap:4px;margin-left:8px">';
  html += '<button class="btn btn-sm btn-success" onclick="markScheduledDone(\'' + item.id + '\')" title="Mark as done">✅</button>';
  if (showEdit !== false) {
    html += '<button class="btn btn-sm btn-secondary" onclick="openEditScheduled(\'' + item.id + '\')" title="Edit">✏️</button>';
    html += '<button class="btn btn-sm btn-danger" onclick="deleteScheduled(\'' + item.id + '\')" title="Delete">🗑️</button>';
  }
  html += '</div></div>';
  return html;
}

function updateUpcomingBadge() {
  if (!state.scheduledItems) return;
  var today = new Date(); today.setHours(0,0,0,0);
  var in7 = new Date(today.getTime() + 7 * 86400000);
  var count = state.scheduledItems.filter(function(i) {
    if (!i.is_active) return false;
    var d = new Date(i.next_date); d.setHours(0,0,0,0);
    return d <= in7;
  }).length;
  var badge = document.getElementById('sidebar-upcoming-badge');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  }
}

function openAddScheduled() {
  state.editingId = null;
  document.getElementById('modal-sched-title').textContent = 'Add Scheduled Item';
  setVal('sched-name', '');
  setVal('sched-amount', '');
  setVal('sched-type', 'debit');
  setVal('sched-freq', 'monthly');
  setVal('sched-date', todayStr());
  setVal('sched-category', '');
  setVal('sched-mode', 'AxisBnk');
  setVal('sched-notes', '');
  clearErr('sched-name-err'); clearErr('sched-amount-err'); clearErr('sched-date-err');
  populateSchedCategorySelect();
  showModal('modal-scheduled');
}

function openEditScheduled(id) {
  var item = state.scheduledItems.find(function(x) { return x.id === id; });
  if (!item) return;
  state.editingId = id;
  document.getElementById('modal-sched-title').textContent = 'Edit Scheduled Item';
  setVal('sched-name', item.name);
  setVal('sched-amount', item.amount);
  setVal('sched-type', item.type);
  setVal('sched-freq', item.frequency);
  setVal('sched-date', item.next_date);
  setVal('sched-category', item.category_id || '');
  setVal('sched-mode', item.payment_mode || 'AxisBnk');
  setVal('sched-notes', item.notes || '');
  clearErr('sched-name-err'); clearErr('sched-amount-err'); clearErr('sched-date-err');
  populateSchedCategorySelect(item.category_id);
  showModal('modal-scheduled');
}

function populateSchedCategorySelect(selectedId) {
  var sel = document.getElementById('sched-category');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- None --</option>';
  state.categories.forEach(function(c) {
    var opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.icon + ' ' + c.name;
    if (c.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

async function saveScheduled() {
  var name   = getVal('sched-name');
  var amount = parseFloat(getVal('sched-amount'));
  var type   = getVal('sched-type');
  var freq   = getVal('sched-freq');
  var date   = getVal('sched-date');
  var catId  = getVal('sched-category') || null;
  var mode   = getVal('sched-mode');
  var notes  = getVal('sched-notes');

  var valid = true;
  clearErr('sched-name-err'); clearErr('sched-amount-err'); clearErr('sched-date-err');
  if (!name) { showErr('sched-name-err'); valid = false; }
  if (!amount || amount <= 0) { showErr('sched-amount-err'); valid = false; }
  if (!date) { showErr('sched-date-err'); valid = false; }
  if (!valid) return;

  showLoading('Saving...');
  try {
    var payload = {
      user_id: state.user.id,
      name: name, amount: amount, type: type,
      frequency: freq, next_date: date,
      category_id: catId, payment_mode: mode,
      notes: notes, is_active: true
    };

    var res;
    if (state.editingId) {
      res = await state.sb.from('scheduled_items').update(payload).eq('id', state.editingId);
    } else {
      res = await state.sb.from('scheduled_items').insert(payload);
    }
    if (res.error) throw res.error;

    hideModal('modal-scheduled');
    showToast(state.editingId ? 'Updated!' : 'Scheduled item added!');
    await loadScheduledItems();
    renderUpcomingSection();
    updateUpcomingBadge();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

async function deleteScheduled(id) {
  confirmDelete('Delete this scheduled item?', async function() {
    showLoading('Deleting...');
    try {
      var res = await state.sb.from('scheduled_items').delete().eq('id', id);
      if (res.error) throw res.error;
      showToast('Deleted');
      await loadScheduledItems();
      renderUpcomingSection();
    } catch(e) {
      showToast('Error: ' + e.message, 'error');
    } finally {
      hideLoading();
    }
  });
}

async function markScheduledDone(id) {
  var item = state.scheduledItems.find(function(x) { return x.id === id; });
  if (!item) return;

  showLoading('Adding transaction...');
  try {
    await ensureMonthRecord();

    // Create transaction
    var txnPayload = {
      user_id: state.user.id,
      month_id: state.currentMonthRecord.id,
      category_id: item.category_id || null,
      amount: item.amount,
      type: item.type === 'credit' ? 'credit' : 'expense',
      payment_mode: item.payment_mode || 'Cash',
      description: item.name,
      date: item.next_date || todayStr(),
      is_split: false
    };

    var txnRes = await state.sb.from('transactions').insert(txnPayload);
    if (txnRes.error) throw txnRes.error;

    // Update next_date based on frequency or deactivate
    if (item.frequency === 'once') {
      await state.sb.from('scheduled_items').update({ is_active: false }).eq('id', id);
    } else {
      var next = calculateNextDate(item.next_date, item.frequency);
      await state.sb.from('scheduled_items').update({ next_date: next }).eq('id', id);
    }

    showToast('Done! Transaction created.');
    await loadScheduledItems();
    await fetchTransactions();
    renderUpcomingSection();
    if (state.currentSection === 'dashboard') renderDashboard();
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

function calculateNextDate(dateStr, frequency) {
  var d = new Date(dateStr);
  if (frequency === 'weekly')  d.setDate(d.getDate() + 7);
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  if (frequency === 'yearly')  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split('T')[0];
}

// ============================================================
// SECTION 15: ANALYTICS
// ============================================================

async function loadAnalytics() {
  await ensureMonthRecord();
  await fetchTransactions();
  setElementText('month-label', MONTH_NAMES[state.currentMonth-1] + ' ' + state.currentYear);

  // Destroy existing charts
  Object.keys(state.charts).forEach(function(k) {
    if (state.charts[k]) { state.charts[k].destroy(); state.charts[k] = null; }
  });

  renderInsights();
  renderPieChart();
  renderDonutChart();
  renderBudgetActualChart();
  renderSavingsTrendChart();
  renderMonthlyStackedChart();
  renderDailySpendingChart();
}

function getChartColors() {
  return [
    '#D4A017','#C0392B','#1A7A4A','#2980B9','#8E44AD',
    '#D35400','#16A085','#2C3E50','#F39C12','#27AE60',
    '#E74C3C','#3498DB','#9B59B6','#1ABC9C','#F1C40F'
  ];
}

function getChartDefaults() {
  var isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return {
    textColor: isDark ? '#A89070' : '#5C4033',
    gridColor: isDark ? 'rgba(42,64,96,0.5)' : 'rgba(232,213,176,0.5)'
  };
}

function renderInsights() {
  var txns = state.transactions;

  var totalCredits = txns.filter(function(t) { return t.type === 'credit'; })
    .reduce(function(s,t) { return s+parseFloat(t.amount); }, 0);
  var totalIncome = totalCredits;

  var totalExpense = txns.filter(function(t) { return t.type === 'expense' || t.type === 'split'; })
    .reduce(function(s,t) { return s + parseFloat(t.is_split ? (t.my_share||t.amount) : t.amount); }, 0);

  var savingsPct = totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : 0;
  setElementText('ins-savings-rate', savingsPct + '%');
  var srEl = document.getElementById('ins-savings-rate');
  if (srEl) srEl.style.color = savingsPct >= 20 ? 'var(--accent-green-light)' : savingsPct >= 10 ? 'var(--accent-yellow)' : 'var(--accent-red)';

  // Top category
  var catSpend = {};
  txns.filter(function(t) { return (t.type === 'expense' || t.type === 'split') && t.category_id; })
    .forEach(function(t) {
      var amt = parseFloat(t.is_split ? (t.my_share||t.amount) : t.amount);
      catSpend[t.category_id] = (catSpend[t.category_id] || 0) + amt;
    });

  var topCatId = null, topAmt = 0;
  Object.keys(catSpend).forEach(function(id) {
    if (catSpend[id] > topAmt) { topAmt = catSpend[id]; topCatId = id; }
  });

  var topCat = topCatId ? getCategoryById(topCatId) : null;
  setElementText('ins-top-cat', topCat ? topCat.icon + ' ' + topCat.name : '—');

  // Overspent categories
  var overspentCats = state.categories.filter(function(c) {
    var spent = catSpend[c.id] || 0;
    return parseFloat(c.budget_amount) > 0 && spent > parseFloat(c.budget_amount);
  });
  setElementText('ins-overspent', overspentCats.length > 0 ? overspentCats.length + ' categories' : 'None 🎉');
  var ovEl = document.getElementById('ins-overspent');
  if (ovEl) ovEl.style.color = overspentCats.length > 0 ? 'var(--accent-red)' : 'var(--accent-green-light)';
}

function renderPieChart() {
  var canvas = document.getElementById('chart-pie');
  if (!canvas) return;
  var txns = state.transactions;

  var catSpend = {};
  txns.filter(function(t) { return (t.type === 'expense' || t.type === 'split') && t.category_id; })
    .forEach(function(t) {
      var amt = parseFloat(t.is_split ? (t.my_share||t.amount) : t.amount);
      catSpend[t.category_id] = (catSpend[t.category_id] || 0) + amt;
    });

  var labels = [], data = [], colors = [];
  var colorPalette = getChartColors();
  var i = 0;
  Object.keys(catSpend).forEach(function(id) {
    var cat = getCategoryById(id);
    labels.push(cat ? cat.icon + ' ' + cat.name : 'Unknown');
    data.push(catSpend[id]);
    colors.push(colorPalette[i % colorPalette.length]);
    i++;
  });

  if (data.length === 0) { setElement('chart-pie', '<canvas id="chart-pie"></canvas>'); return; }
  var cfg = getChartDefaults();

  state.charts.pie = new Chart(canvas, {
    type: 'pie',
    data: { labels: labels, datasets: [{ data: data, backgroundColor: colors, borderWidth: 2, borderColor: 'transparent' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: cfg.textColor, font: { size: 11 }, padding: 8 } },
        tooltip: { callbacks: { label: function(ctx) { return ' ' + formatCurrency(ctx.parsed); } } }
      }
    }
  });
}

function renderDonutChart() {
  var canvas = document.getElementById('chart-donut');
  if (!canvas) return;
  var txns = state.transactions;

  var typeSpend = { expense: 0, savings: 0, investment: 0 };
  txns.filter(function(t) { return t.type === 'expense' || t.type === 'split'; })
    .forEach(function(t) {
      var amt = parseFloat(t.is_split ? (t.my_share||t.amount) : t.amount);
      var cat = getCategoryById(t.category_id);
      var ctype = cat ? (cat.type || 'expense') : 'expense';
      typeSpend[ctype] = (typeSpend[ctype] || 0) + amt;
    });

  var cfg = getChartDefaults();
  state.charts.donut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Expense', 'Savings', 'Investment'],
      datasets: [{
        data: [typeSpend.expense, typeSpend.savings, typeSpend.investment],
        backgroundColor: ['#C0392B','#1A7A4A','#2980B9'],
        borderWidth: 2, borderColor: 'transparent'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: cfg.textColor, font: { size: 11 } } },
        tooltip: { callbacks: { label: function(ctx) { return ' ' + formatCurrency(ctx.parsed); } } }
      }
    }
  });
}

function renderBudgetActualChart() {
  var canvas = document.getElementById('chart-budget-actual');
  if (!canvas) return;
  var txns = state.transactions;

  var catSpend = {};
  txns.filter(function(t) { return t.type === 'expense' || t.type === 'split'; })
    .forEach(function(t) {
      var amt = parseFloat(t.is_split ? (t.my_share||t.amount) : t.amount);
      if (t.category_id) catSpend[t.category_id] = (catSpend[t.category_id] || 0) + amt;
    });

  var labels = [], budgets = [], actuals = [];
  var cats = state.categories.filter(function(c) { return c.is_active; });
  cats.forEach(function(c) {
    labels.push(c.icon + ' ' + c.name);
    budgets.push(parseFloat(c.budget_amount) || 0);
    actuals.push(catSpend[c.id] || 0);
  });

  var cfg = getChartDefaults();
  state.charts.budgetActual = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Budget', data: budgets, backgroundColor: 'rgba(212,160,23,0.3)', borderColor: '#D4A017', borderWidth: 1 },
        { label: 'Actual', data: actuals, backgroundColor: 'rgba(192,57,43,0.5)', borderColor: '#C0392B', borderWidth: 1 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: cfg.textColor } } },
      scales: {
        x: { ticks: { color: cfg.textColor, font: { size: 10 } }, grid: { color: cfg.gridColor } },
        y: {
          ticks: { color: cfg.textColor, callback: function(v) { return '₹' + v.toLocaleString('en-IN'); } },
          grid: { color: cfg.gridColor }
        }
      }
    }
  });
}

async function renderSavingsTrendChart() {
  var canvas = document.getElementById('chart-savings-trend');
  if (!canvas) return;

  // Fetch last 6 months data
  var months = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(state.currentYear, state.currentMonth - 1 - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: SHORT_MONTHS[d.getMonth()] + ' ' + d.getFullYear() });
  }

  var savingsData = [];

  try {
    for (var j = 0; j < months.length; j++) {
      var m = months[j];
      var mRes = await state.sb.from('months').select('id').eq('user_id', state.user.id).eq('year', m.year).eq('month', m.month).single();
      if (!mRes.data) { savingsData.push(0); continue; }
      var tRes = await state.sb.from('transactions').select('amount,type,is_split,my_share').eq('month_id', mRes.data.id);
      var txns = tRes.data || [];
      var credits = txns.filter(function(t) { return t.type === 'credit'; }).reduce(function(s,t) { return s+parseFloat(t.amount); }, 0);
      var expenses = txns.filter(function(t) { return t.type === 'expense' || t.type === 'split'; }).reduce(function(s,t) { return s+parseFloat(t.is_split?(t.my_share||t.amount):t.amount); }, 0);
      savingsData.push(Math.max(0, credits - expenses));
    }
  } catch(e) {
    console.error('Savings trend error:', e);
  }

  var cfg = getChartDefaults();
  state.charts.savingsTrend = new Chart(canvas, {
    type: 'line',
    data: {
      labels: months.map(function(m) { return m.label; }),
      datasets: [{
        label: 'Savings (₹)',
        data: savingsData,
        borderColor: '#27AE60',
        backgroundColor: 'rgba(39,174,96,0.1)',
        fill: true, tension: 0.4, pointRadius: 4, pointBackgroundColor: '#27AE60'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: cfg.textColor } } },
      scales: {
        x: { ticks: { color: cfg.textColor, font:{size:10} }, grid: { color: cfg.gridColor } },
        y: {
          ticks: { color: cfg.textColor, callback: function(v) { return '₹' + v.toLocaleString('en-IN'); } },
          grid: { color: cfg.gridColor }
        }
      }
    }
  });
}

async function renderMonthlyStackedChart() {
  var canvas = document.getElementById('chart-monthly-stacked');
  if (!canvas) return;

  var months = [];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(state.currentYear, state.currentMonth - 1 - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1, label: SHORT_MONTHS[d.getMonth()] });
  }

  // Build category-per-month data (top 5 categories)
  var topCats = state.categories.filter(function(c) { return c.is_active && c.type === 'expense'; }).slice(0, 5);
  var datasets = [];
  var colors = getChartColors();

  try {
    var monthTotals = [];
    for (var j = 0; j < months.length; j++) {
      var m = months[j];
      var mRes = await state.sb.from('months').select('id').eq('user_id', state.user.id).eq('year', m.year).eq('month', m.month).single();
      if (!mRes.data) { monthTotals.push({}); continue; }
      var tRes = await state.sb.from('transactions').select('amount,type,is_split,my_share,category_id').eq('month_id', mRes.data.id);
      var txns = tRes.data || [];
      var catMap = {};
      txns.filter(function(t) { return t.type === 'expense' || t.type === 'split'; })
        .forEach(function(t) {
          var amt = parseFloat(t.is_split?(t.my_share||t.amount):t.amount);
          catMap[t.category_id || 'none'] = (catMap[t.category_id || 'none'] || 0) + amt;
        });
      monthTotals.push(catMap);
    }

    topCats.forEach(function(cat, ci) {
      datasets.push({
        label: cat.icon + ' ' + cat.name,
        data: monthTotals.map(function(mt) { return mt[cat.id] || 0; }),
        backgroundColor: colors[ci % colors.length]
      });
    });
  } catch(e) {
    console.error('Monthly stacked error:', e);
  }

  var cfg = getChartDefaults();
  state.charts.monthlyStacked = new Chart(canvas, {
    type: 'bar',
    data: { labels: months.map(function(m) { return m.label; }), datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: cfg.textColor, font:{size:10} } } },
      scales: {
        x: { stacked: true, ticks: { color: cfg.textColor }, grid: { color: cfg.gridColor } },
        y: { stacked: true, ticks: { color: cfg.textColor, callback: function(v) { return '₹' + v.toLocaleString('en-IN'); } }, grid: { color: cfg.gridColor } }
      }
    }
  });
}

function renderDailySpendingChart() {
  var canvas = document.getElementById('chart-daily-spending');
  if (!canvas) return;

  // Build day → total spend map from current month's transactions
  var daysInMonth = new Date(state.currentYear, state.currentMonth, 0).getDate();
  var dailyMap = {};
  for (var d = 1; d <= daysInMonth; d++) dailyMap[d] = 0;

  state.transactions
    .filter(function(t) { return t.type === 'expense' || t.type === 'split'; })
    .forEach(function(t) {
      var day = parseInt(t.date.split('-')[2], 10);
      if (day >= 1 && day <= daysInMonth) {
        dailyMap[day] += parseFloat(t.is_split ? (t.my_share || t.amount) : t.amount);
      }
    });

  // Running cumulative total
  var days = [], barData = [], cumulData = [];
  var running = 0;
  var today = new Date();
  var todayDay = (today.getFullYear() === state.currentYear && today.getMonth() + 1 === state.currentMonth)
    ? today.getDate() : daysInMonth;

  for (var i = 1; i <= todayDay; i++) {
    days.push(i);
    barData.push(dailyMap[i]);
    running += dailyMap[i];
    cumulData.push(running);
  }

  var cfg = getChartDefaults();
  state.charts.ccTrend = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        {
          label: 'Spent (₹)',
          data: barData,
          backgroundColor: 'rgba(239,68,68,0.55)',
          borderColor: '#EF4444',
          borderWidth: 1,
          yAxisID: 'y'
        },
        {
          label: 'Cumulative (₹)',
          data: cumulData,
          type: 'line',
          borderColor: '#F59E0B',
          backgroundColor: 'rgba(245,158,11,0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 2,
          yAxisID: 'y'
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: cfg.textColor, font:{size:11} } },
        tooltip: { callbacks: { label: function(ctx) { return ' ₹' + ctx.parsed.y.toLocaleString('en-IN'); } } }
      },
      scales: {
        x: { ticks: { color: cfg.textColor, font:{size:10} }, grid: { color: cfg.gridColor } },
        y: { ticks: { color: cfg.textColor, callback: function(v) { return '₹' + v.toLocaleString('en-IN'); } }, grid: { color: cfg.gridColor } }
      }
    }
  });
}

// ============================================================
// SECTION 16: SETTINGS
// ============================================================

function loadSettingsSection() {
  var s = state.settings;
  setVal('settings-salary', s.salary || '');
  setVal('settings-gemini-key', s.gemini_api_key || '');
  setVal('settings-myzone-bank', s.myzone_cc_bank || 'AxisBnk');
  setVal('settings-neo-bank', s.neo_cc_bank || 'AxisBnk');
  var showSpare = document.getElementById('settings-show-spare');
  if (showSpare) showSpare.checked = s.show_spare_category !== false;
  var sbUrlEl = document.getElementById('settings-sb-url');
  if (sbUrlEl) sbUrlEl.value = localStorage.getItem(STORAGE_URL_KEY) || '';
}

async function saveSalary() {
  var salary = parseFloat(getVal('settings-salary')) || 0;
  showLoading('Saving salary...');
  try {
    var ok = await saveSettings({ salary: salary });
    if (ok) {
      state.settings.salary = salary;
      showToast('Salary updated!');
      await updateSpareCategory();
      // Ask if they want AI suggestions
      if (state.settings.gemini_api_key) {
        showToast('Tip: Go to Categories to use AI Suggest for budget breakdown.', 'info');
      }
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

async function saveGeminiKey() {
  var key = getVal('settings-gemini-key');
  showLoading('Saving...');
  try {
    var ok = await saveSettings({ gemini_api_key: key });
    if (ok) {
      state.settings.gemini_api_key = key;
      showToast('Gemini API key saved!');
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

async function saveCCMapping() {
  var myzone = getVal('settings-myzone-bank');
  var neo    = getVal('settings-neo-bank');
  showLoading('Saving...');
  try {
    var ok = await saveSettings({ myzone_cc_bank: myzone, neo_cc_bank: neo });
    if (ok) {
      state.settings.myzone_cc_bank = myzone;
      state.settings.neo_cc_bank = neo;
      showToast('CC mapping saved!');
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

async function saveShowSpare() {
  var show = document.getElementById('settings-show-spare').checked;
  showLoading('Saving...');
  try {
    var ok = await saveSettings({ show_spare_category: show });
    if (ok) {
      state.settings.show_spare_category = show;
      await updateSpareCategory();
      showToast('Preference saved!');
    }
  } catch(e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

function exportCSV() {
  var txns = state.transactions;
  if (txns.length === 0) { showToast('No transactions to export', 'info'); return; }

  var headers = ['Date','Description','Category','Amount','Type','Payment Mode','Is Split','My Share','Others Share','Credit Subtype','Split Recovered'];
  var rows = txns.map(function(t) {
    var cat = getCategoryById(t.category_id);
    return [
      t.date,
      '"' + (t.description||'').replace(/"/g,'""') + '"',
      cat ? '"' + cat.name + '"' : '',
      t.amount,
      t.type,
      t.payment_mode,
      t.is_split ? 'Yes' : 'No',
      t.my_share || '',
      t.others_share || '',
      t.credit_subtype || '',
      t.split_recovered ? 'Yes' : 'No'
    ].join(',');
  });

  var csv = headers.join(',') + '\n' + rows.join('\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'LakshmiNaraya_' + MONTH_NAMES[state.currentMonth-1] + '_' + state.currentYear + '.csv';
  a.click();
  URL.revokeObjectURL(url);
  showToast('Exported!');
}

// ============================================================
// SECTION 17: GEMINI AI BUDGET SUGGESTIONS
// ============================================================

async function getAIBudgetSuggestions(salary, apiKey) {
  var prompt = 'You are a personal finance advisor for someone in India earning ₹' + salary + '/month.\n' +
    'Suggest a monthly budget breakdown. Return ONLY valid JSON array, no markdown, no explanation.\n' +
    'Format: [{"name":"Category Name","icon":"emoji","budget_amount":number,"type":"expense|savings|investment","color":"#hexcolor"}]\n' +
    'Rules:\n' +
    '- All amounts must sum to exactly ' + salary + '\n' +
    '- Include categories for: Rent/Housing, Food/Ration, Utilities, Transport, Insurance, SIP/Investments, Gold/FD savings, Emergency Fund, Wellbeing, Entertainment, Other Expenses, Cash Buffer\n' +
    '- Adjust amounts proportionally for ₹' + salary + ' salary\n' +
    '- Use warm colors for expenses (reds/oranges), cool for savings (blues/greens), gold for investments\n' +
    '- type "savings" for Emergency Fund, type "investment" for SIP/Gold/FD';

  var response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });

  if (!response.ok) {
    var errData = await response.json().catch(function() { return {}; });
    throw new Error(errData.error ? errData.error.message : 'Gemini API error ' + response.status);
  }

  var data = await response.json();
  var text = data.candidates[0].content.parts[0].text;
  var jsonText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(jsonText);
}

async function openAISuggest() {
  var salary = parseFloat(state.settings.salary) || 0;
  var apiKey = state.settings.gemini_api_key || '';

  if (salary <= 0) {
    showToast('Please set your salary in Settings first.', 'warning');
    return;
  }
  if (!apiKey) {
    showToast('Please set your Gemini API key in Settings first.', 'warning');
    return;
  }

  state.aiSuggestions = [];
  document.getElementById('apply-ai-btn').classList.add('hidden');
  setElement('ai-suggest-content', '<div style="text-align:center;padding:20px"><div class="spinner" style="margin:0 auto 12px"></div><div style="color:var(--text-secondary)">Asking Gemini AI for budget suggestions...</div></div>');
  showModal('modal-ai-suggest');

  try {
    var suggestions = await getAIBudgetSuggestions(salary, apiKey);
    state.aiSuggestions = suggestions;

    var html = '<p style="font-size:13px;color:var(--text-secondary);margin-bottom:12px">AI suggested budget for salary of ' + formatCurrency(salary) + ':</p>';
    html += '<div style="overflow-x:auto"><table class="data-table">';
    html += '<thead><tr><th>Icon</th><th>Category</th><th>Type</th><th>Budget</th></tr></thead><tbody>';
    var total = 0;
    suggestions.forEach(function(s) {
      total += parseFloat(s.budget_amount) || 0;
      html += '<tr><td style="font-size:18px;text-align:center">' + escHtml(s.icon) + '</td>';
      html += '<td>' + escHtml(s.name) + '</td>';
      html += '<td><span class="type-badge" style="background:rgba(212,160,23,0.1);color:var(--accent-gold)">' + escHtml(s.type) + '</span></td>';
      html += '<td style="font-weight:600">' + formatCurrency(s.budget_amount) + '</td></tr>';
    });
    html += '</tbody><tfoot><tr><td colspan="3" style="font-weight:700;color:var(--text-secondary)">Total</td><td style="font-weight:700;color:var(--accent-gold)">' + formatCurrency(total) + '</td></tr></tfoot>';
    html += '</table></div>';
    html += '<div style="font-size:11px;color:var(--text-secondary);margin-top:8px">⚠️ Applying will REPLACE all existing non-spare categories.</div>';

    setElement('ai-suggest-content', html);
    document.getElementById('apply-ai-btn').classList.remove('hidden');
  } catch(e) {
    setElement('ai-suggest-content', '<div style="text-align:center;padding:20px;color:var(--accent-red)">❌ Error: ' + escHtml(e.message) + '</div>');
  }
}

async function applyAISuggestions() {
  if (!state.aiSuggestions || state.aiSuggestions.length === 0) return;
  showLoading('Applying AI suggestions...');
  try {
    // Delete all non-spare categories
    var toDelete = state.categories.filter(function(c) { return !c.is_spare; });
    for (var i = 0; i < toDelete.length; i++) {
      await state.sb.from('categories').update({ is_active: false }).eq('id', toDelete[i].id);
    }

    // Insert new categories
    for (var j = 0; j < state.aiSuggestions.length; j++) {
      var s = state.aiSuggestions[j];
      await state.sb.from('categories').insert({
        user_id: state.user.id,
        name: s.name,
        icon: s.icon || '💰',
        color: s.color || '#D4A017',
        budget_amount: parseFloat(s.budget_amount) || 0,
        type: s.type || 'expense',
        order_index: j,
        is_active: true,
        is_spare: false
      });
    }

    hideModal('modal-ai-suggest');
    showToast('AI budget applied! ' + state.aiSuggestions.length + ' categories created.');
    await loadCategories();
    await updateSpareCategory();
    renderCategoriesTable();
  } catch(e) {
    showToast('Error applying suggestions: ' + e.message, 'error');
  } finally {
    hideLoading();
  }
}

// ============================================================
// SECTION 18: MONTH NAVIGATION
// ============================================================

function prevMonth() {
  var m = state.currentMonth - 1, y = state.currentYear;
  if (m < 1) { m = 12; y--; }
  // Block navigation before Sep 2026
  if (y < TRACKING_START_YEAR || (y === TRACKING_START_YEAR && m < TRACKING_START_MONTH)) {
    showToast('Tracking starts from September 2026', 'info');
    return;
  }
  state.currentMonth = m; state.currentYear = y;
  state.currentMonthRecord = null;
  reloadCurrentSection();
}

function nextMonth() {
  state.currentMonth++;
  if (state.currentMonth > 12) { state.currentMonth = 1; state.currentYear++; }
  state.currentMonthRecord = null;
  reloadCurrentSection();
}

function reloadCurrentSection() {
  setElementText('month-label', MONTH_NAMES[state.currentMonth-1] + ' ' + state.currentYear);
  var section = state.currentSection || 'dashboard';
  if (section === 'dashboard')    loadDashboard();
  if (section === 'transactions') loadTransactionsSection();
  if (section === 'categories')   loadCategoriesSection();
  if (section === 'analytics')    loadAnalytics();
}

// ============================================================
// SECTION 19: KEYBOARD SHORTCUTS & GLOBAL EVENTS
// ============================================================

document.addEventListener('keydown', function(e) {
  // Close modals on Escape
  if (e.key === 'Escape') {
    var modals = ['modal-transaction','modal-category','modal-scheduled','modal-recoveries','modal-settle-cc','modal-ai-suggest','modal-confirm'];
    modals.forEach(function(id) { hideModal(id); });
    // Close mobile sidebar
    var sb = document.getElementById('sidebar');
    if (sb) sb.classList.remove('mobile-open');
  }
});

// Close modals when clicking overlay
document.addEventListener('click', function(e) {
  if (e.target && e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
  }
});

// Hash-based routing on popstate
window.addEventListener('popstate', function() {
  var hash = window.location.hash.replace('#','') || 'dashboard';
  navigate(hash);
});

// ============================================================
// SECTION 20: INITIALIZATION
// ============================================================

document.addEventListener('DOMContentLoaded', async function() {
  loadTheme();
  await LocalDB.open();
  updateOnlineStatus(navigator.onLine);

  // Check if Supabase config exists
  var cfg = getSupabaseConfig();
  if (!cfg.url || !cfg.key) {
    document.getElementById('supabase-config').classList.remove('hidden');
    return;
  }

  // Try to init Supabase
  if (!initSupabase()) {
    document.getElementById('supabase-config').classList.remove('hidden');
    return;
  }

  // Check auth state
  checkAuth();

  // Also load scheduled items in background for badge
  state.sb && state.sb.auth && state.sb.auth.getSession().then(function(res) {
    if (res.data && res.data.session) {
      loadScheduledItems().then(updateUpcomingBadge);
    }
  }).catch(function() {});
});
