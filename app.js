// ════════════════════════════════════════════════════════════════
//  RETRO COMPUTER LAB — app.js
//  Paste guard · Telemetry · IndexedDB · Heartbeat Sync Engine
//
//  Load order:  <script src="app.js" defer></script>
//  Place this tag immediately before </body> in index.html,
//  AFTER the existing inline <script> block.
//
//  GAS requirement: Your doPost() deployment must respond with the
//  header  Access-Control-Allow-Origin: *  so the browser can read
//  the JSON body. Without it, fetch() will throw a CORS error and
//  the app falls back gracefully to Local Storage Active mode.
// ════════════════════════════════════════════════════════════════

'use strict';

// ─────────────────────────────────────────────────────────────────
//  CONFIGURATION  ← only touch this block
// ─────────────────────────────────────────────────────────────────
const CFG = Object.freeze({
  SECRET_KEY    : 'MarshallHonors26',

  // ↓ Replace this with your deployed GAS Web App URL
  GAS_URL       : 'https://script.google.com/a/macros/fcpsschools.net/s/AKfycbwhAHtXH-h_P2mnxrxagY-vhVSZx8n15VqyrXlHR7jn_AORBO0Cc7kfTQYxoWCRhtaL/exec',

  HEARTBEAT_MS  : 5000,    // 5-second sync cadence

  DB_NAME       : 'RetroLabDB',
  DB_VERSION    : 1,
  STORE_ESSAY   : 'essay',
  STORE_TELEM   : 'telemetry',
});

// ─────────────────────────────────────────────────────────────────
//  MODULE STATE
// ─────────────────────────────────────────────────────────────────

/** @type {IDBDatabase|null} */
let _db = null;

/**
 * In-memory telemetry ring.
 * Each entry: { ts: ISO string, delta: number, key: string }
 *
 * _idbCursor tracks how many entries have already been written to IDB
 * so we only append the diff on each keystroke — never rewrite the whole array.
 *
 * @type {Array<{ts:string, delta:number, key:string}> & {_idbCursor:number}}
 */
let telemetryData = [];
telemetryData._idbCursor = 0;

/** Char count of editor content at the time of the last keyup. */
let _lastCharCount = 0;

/** Tracks the current sync state to avoid redundant DOM repaints. */
let _syncState = 'idle'; // 'idle' | 'active' | 'locked'

// ─────────────────────────────────────────────────────────────────
//  BOOT  — wait for both DOM and inline-script to be ready
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const editor = document.getElementById('editor');
  if (!editor) {
    console.error('[RetroLab] #editor element not found — app.js halted.');
    return;
  }

  _installPasteGuard(editor);
  _installTelemetryHooks(editor);
  _wrapOnEditorInput();

  openDatabase()
    .then(() => {
      restoreFromIDB();    // repopulate editor from last IDB snapshot
      startHeartbeat();    // begin 5-second sync loop
    })
    .catch(err => {
      console.error('[RetroLab] IndexedDB failed to open:', err);
      // Still run the heartbeat — IDB writes will no-op silently
      startHeartbeat();
    });
});

// ═════════════════════════════════════════════════════════════════
//  1.  PASTE GUARD
// ═════════════════════════════════════════════════════════════════

/**
 * Blocks clipboard paste and drag-and-drop text insertion on the
 * writing canvas.  Uses a native alert() per spec so it fires even
 * if the retro modal system is not yet initialised.
 *
 * @param {HTMLElement} editor
 */
function _installPasteGuard(editor) {
  // Block Ctrl+V / right-click Paste
  editor.addEventListener('paste', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    alert('Clipboard access denied.');
  });

  // Block drag-and-drop text (identical bypass vector)
  editor.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    alert('Clipboard access denied.');
  });

  // Block the context-menu "Paste" item by preventing the menu entirely
  // only when the editor is focused (so right-click elsewhere still works).
  editor.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });
}

// ═════════════════════════════════════════════════════════════════
//  2.  TELEMETRY
// ═════════════════════════════════════════════════════════════════

/**
 * Attaches a keyup listener that records a telemetry entry for every
 * character-producing keystroke.
 *
 * Logged fields:
 *   ts    — ISO-8601 timestamp of the event
 *   delta — character count delta (+N typed, −N deleted) since last event
 *   key   — sanitised key label: actual char is replaced with '_' so no
 *            student content leaks into the telemetry log; spaces are
 *            labelled 'SPACE'; control keys use their e.key name.
 *
 * @param {HTMLElement} editor
 */
function _installTelemetryHooks(editor) {
  // Keys that produce no character delta — skip them
  const SKIP_KEYS = new Set([
    'Shift','Control','Alt','Meta','CapsLock','Tab',
    'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
    'Home','End','PageUp','PageDown',
    'Insert','ContextMenu','Escape','F1','F2','F3','F4','F5',
    'F6','F7','F8','F9','F10','F11','F12',
  ]);

  editor.addEventListener('keyup', (e) => {
    if (SKIP_KEYS.has(e.key)) return;

    const currentCount = _editorCharCount();
    const delta        = currentCount - _lastCharCount;
    _lastCharCount     = currentCount;

    if (delta === 0) return; // selection move with no edit — skip

    // Sanitise the key label so no private content enters the log
    let keyLabel;
    if (e.key === ' ')              keyLabel = 'SPACE';
    else if (e.key === 'Enter')     keyLabel = 'ENTER';
    else if (e.key === 'Backspace') keyLabel = 'BACKSPACE';
    else if (e.key === 'Delete')    keyLabel = 'DELETE';
    else if (e.key.length === 1)    keyLabel = '_';   // printable char — obfuscated
    else                            keyLabel = e.key; // named key

    /** @type {{ts:string, delta:number, key:string}} */
    const entry = {
      ts    : new Date().toISOString(),
      delta : delta,
      key   : keyLabel,
    };

    telemetryData.push(entry);
    // Persist immediately — if the laptop dies, the entry is already on disk
    _writeNewTelemetryToIDB();
  });
}

/** Returns the raw character count of the editor's visible text. */
function _editorCharCount() {
  const editor = document.getElementById('editor');
  return editor ? (editor.innerText || '').replace(/\n$/, '').length : 0;
}

// ═════════════════════════════════════════════════════════════════
//  3.  INDEXEDDB
// ═════════════════════════════════════════════════════════════════
//
//  Schema
//  ──────
//  STORE_ESSAY     keyPath: 'id'               (single record: id='current')
//  STORE_TELEMETRY keyPath: 'id' autoIncrement  (one row per telemetry entry)
//                  index:   'ts'               (for time-ordered queries)

/**
 * Opens (or upgrades) the RetroLabDB database.
 * Returns a Promise that resolves with the IDBDatabase handle.
 */
function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(CFG.DB_NAME, CFG.DB_VERSION);

    req.onupgradeneeded = (e) => {
      const idb = e.target.result;

      // Essay store — stores the full editor snapshot as a single record
      if (!idb.objectStoreNames.contains(CFG.STORE_ESSAY)) {
        idb.createObjectStore(CFG.STORE_ESSAY, { keyPath: 'id' });
      }

      // Telemetry store — append-only, auto-increment primary key
      if (!idb.objectStoreNames.contains(CFG.STORE_TELEM)) {
        const tStore = idb.createObjectStore(CFG.STORE_TELEM, {
          keyPath      : 'id',
          autoIncrement: true,
        });
        tStore.createIndex('ts', 'ts', { unique: false });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;

      // Surface IDB errors that bubble to the connection
      _db.onerror = (ev) =>
        console.error('[RetroLab] IDB error:', ev.target.error);

      console.log('[RetroLab] IndexedDB ready →', CFG.DB_NAME, 'v' + CFG.DB_VERSION);
      resolve(_db);
    };

    req.onerror   = (e) => reject(e.target.error);
    req.onblocked = ()  => console.warn('[RetroLab] IDB upgrade blocked by another tab.');
  });
}

/**
 * Writes (or overwrites) the current essay snapshot to STORE_ESSAY.
 * Called from the augmented onEditorInput() on every keystroke.
 */
function _writeEssayToIDB() {
  if (!_db) return;

  const editor = document.getElementById('editor');
  const record = {
    id          : 'current',
    html        : editor?.innerHTML   || '',
    studentName : (document.getElementById('studentName')?.value  || '').trim(),
    classPeriod : (document.getElementById('classPeriod')?.value  || '').trim(),
    promptId    : (document.getElementById('promptId')?.value     || '').trim(),
    savedAt     : new Date().toISOString(),
  };

  const tx = _db.transaction(CFG.STORE_ESSAY, 'readwrite');
  tx.objectStore(CFG.STORE_ESSAY).put(record);
  tx.onerror = (e) =>
    console.warn('[RetroLab] Essay IDB write failed:', e.target.error);
}

/**
 * Appends only the telemetry entries that haven't been written yet
 * (tracked via telemetryData._idbCursor).
 * This avoids re-inserting the entire buffer on every keystroke.
 */
function _writeNewTelemetryToIDB() {
  if (!_db) return;

  const pending = telemetryData.slice(telemetryData._idbCursor);
  if (pending.length === 0) return;

  const tx    = _db.transaction(CFG.STORE_TELEM, 'readwrite');
  const store = tx.objectStore(CFG.STORE_TELEM);

  // Add each entry; IDB auto-assigns the numeric 'id' key
  pending.forEach(({ ts, delta, key }) => store.add({ ts, delta, key }));

  tx.oncomplete = () => {
    // Advance cursor so these entries are not re-written
    telemetryData._idbCursor += pending.length;
  };
  tx.onerror = (e) =>
    console.warn('[RetroLab] Telemetry IDB write failed:', e.target.error);
}

/**
 * Reads the most recently saved essay snapshot from IDB and repopulates
 * the editor and student fields.  Called once on startup.
 */
function restoreFromIDB() {
  if (!_db) return;

  const tx  = _db.transaction(CFG.STORE_ESSAY, 'readonly');
  const req = tx.objectStore(CFG.STORE_ESSAY).get('current');

  req.onsuccess = (e) => {
    const data = e.target.result;
    if (!data) {
      console.log('[RetroLab] No prior IDB snapshot found — starting fresh.');
      return;
    }

    const editor = document.getElementById('editor');
    if (editor && data.html)  editor.innerHTML = data.html;

    const nameEl   = document.getElementById('studentName');
    const periodEl = document.getElementById('classPeriod');
    const promptEl = document.getElementById('promptId');

    if (nameEl   && data.studentName) nameEl.value   = data.studentName;
    if (periodEl && data.classPeriod) periodEl.value = data.classPeriod;
    if (promptEl && data.promptId)    promptEl.value = data.promptId;

    // Re-seed char count baseline after restore
    _lastCharCount = _editorCharCount();

    // Update status bar timestamp
    if (data.savedAt) {
      const t   = new Date(data.savedAt).toLocaleTimeString();
      const el  = document.getElementById('syncStatus');
      if (el) el.textContent = `Last Sync: ${t}`;
    }

    // Trigger word count refresh from the inline script
    if (typeof updateStats === 'function') updateStats();

    console.log('[RetroLab] Restored from IDB snapshot saved at', data.savedAt);
  };

  req.onerror = () => console.warn('[RetroLab] IDB restore read failed.');
}

/**
 * Reads all rows from STORE_TELEM and returns them as a Promise<Array>.
 * Used to build the heartbeat payload.
 *
 * @returns {Promise<Array<{id:number, ts:string, delta:number, key:string}>>}
 */
function _readAllTelemetryFromIDB() {
  return new Promise((resolve, reject) => {
    if (!_db) return resolve([]);

    const tx  = _db.transaction(CFG.STORE_TELEM, 'readonly');
    const req = tx.objectStore(CFG.STORE_TELEM).getAll();

    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror   = (e) => reject(e.target.error);
  });
}

/**
 * Clears ALL rows from STORE_TELEM and resets the in-memory buffer.
 * Called ONLY after a confirmed successful server sync.
 * The essay store is intentionally left untouched.
 *
 * @returns {Promise<void>}
 */
function flushTelemetryIDB() {
  return new Promise((resolve, reject) => {
    if (!_db) return resolve();

    const tx  = _db.transaction(CFG.STORE_TELEM, 'readwrite');
    const req = tx.objectStore(CFG.STORE_TELEM).clear();

    req.onsuccess = () => {
      // Reset in-memory buffer and cursor together atomically
      telemetryData           = [];
      telemetryData._idbCursor = 0;
      console.log('[RetroLab] Telemetry IDB buffer flushed after successful sync.');
      resolve();
    };

    req.onerror = (e) => {
      console.error('[RetroLab] Telemetry flush failed — buffer preserved:', e.target.error);
      reject(e.target.error);
    };
  });
}

// ═════════════════════════════════════════════════════════════════
//  4.  HEARTBEAT — fires every 5 seconds
// ═════════════════════════════════════════════════════════════════

/**
 * Starts the recurring sync heartbeat.
 * The first beat fires immediately so the UI reflects sync state on load.
 */
function startHeartbeat() {
  _sendHeartbeat();                               // immediate first beat
  setInterval(_sendHeartbeat, CFG.HEARTBEAT_MS); // then every 5 s
  console.log(`[RetroLab] Heartbeat started — interval ${CFG.HEARTBEAT_MS}ms`);
}

/**
 * Assembles the sync payload, POSTs it to the GAS endpoint, and
 * branches on the response:
 *
 *   • { "status": "network_locked" } → amber status bar, keep IDB
 *   • { "status": "success" }        → green status bar, flush IDB
 *   • fetch() throws / CORS error    → amber status bar, keep IDB
 */
async function _sendHeartbeat() {
  const editor = document.getElementById('editor');

  // ── Gather current document state ──────────────────────────────
  const essayText   = (editor?.innerText   || '').trim();
  const essayHTML   = editor?.innerHTML    || '';
  const studentName = (document.getElementById('studentName')?.value || '').trim();
  const classPeriod = (document.getElementById('classPeriod')?.value || '').trim();
  const promptId    = (document.getElementById('promptId')?.value    || '').trim();

  // ── Read full telemetry log from IDB ───────────────────────────
  let idbTelemetry = [];
  try {
    idbTelemetry = await _readAllTelemetryFromIDB();
  } catch (err) {
    console.warn('[RetroLab] Could not read telemetry for heartbeat:', err);
  }

  // ── Build POST payload (matches doPost() schema in Code.gs) ────
  const payload = {
    secret_key    : CFG.SECRET_KEY,
    student_name  : studentName,
    class_period  : classPeriod,
    prompt_id     : promptId,
    essay_text    : essayText,
    telemetry_log : idbTelemetry,           // full structured array
    client_ts     : new Date().toISOString(),
  };

  // ── POST and handle response ────────────────────────────────────
  try {
    const response = await fetch(CFG.GAS_URL, {
      method  : 'POST',
      // Note: Do NOT use mode:'no-cors' — we need to read the response body
      // to detect the network_locked status.  Your GAS deployment must return
      //   Access-Control-Allow-Origin: *
      // in its ContentService response, or add a doOptions() CORS preflight.
      headers : {
        'Content-Type' : 'application/json',
      },
      body    : JSON.stringify(payload),
    });

    // ── Parse the JSON body from GAS ───────────────────────────────
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      // Body was not valid JSON (e.g. GAS returned an HTML error page)
      data = null;
    }

    // ── Branch on response status ──────────────────────────────────
    if (data && data.status === 'network_locked') {
      // ── LAB IS CLOSED — keep all local data intact ──────────────
      _setStatusLocked();

    } else if (data && (data.status === 'success' || response.ok)) {
      // ── SUCCESSFUL SYNC — flush telemetry buffer ────────────────
      await flushTelemetryIDB();
      _setStatusActive();

    } else {
      // Unexpected response shape — treat as a soft failure
      console.warn('[RetroLab] Unexpected GAS response:', data);
      _setStatusLocked();
    }

  } catch (networkErr) {
    // Covers: offline, DNS failure, CORS rejection, timeout
    console.warn('[RetroLab] Heartbeat network error:', networkErr.message);
    _setStatusLocked();
    // IndexedDB is deliberately NOT flushed — data stays safe locally
  }
}

// ═════════════════════════════════════════════════════════════════
//  5 & 6.  STATUS BAR VISUAL STATES
// ═════════════════════════════════════════════════════════════════

/**
 * AMBER — 'Local Storage Active'
 * Triggered by: network_locked response OR any fetch failure.
 * IndexedDB is NEVER cleared in this branch.
 */
function _setStatusLocked() {
  if (_syncState === 'locked') return; // already amber — skip repaint
  _syncState = 'locked';

  _applyStatusTheme({
    barBg     : '#2a1a00',
    barBorder : '#996600',
    cellBg    : '#5a3a00',
    cellFg    : '#ffcc44',
    glow      : '0 0 5px #cc8800, inset 1px 1px 0 #ffdd88, inset -1px -1px 0 #443300',
  });

  const el = document.getElementById('syncStatus');
  if (el) {
    el.textContent = '⚠ Local Storage Active';
    el.title = 'Lab is closed or offline — your work is saved locally in IndexedDB';
  }
}

/**
 * GREEN — 'Matrix Sync Active'
 * Triggered only after a confirmed successful POST + IDB flush.
 */
function _setStatusActive() {
  const wasLocked = _syncState === 'locked';
  _syncState = 'active';

  _applyStatusTheme({
    barBg     : '#001a00',
    barBorder : '#007700',
    cellBg    : '#003300',
    cellFg    : '#66ff66',
    glow      : '0 0 5px #00cc00, inset 1px 1px 0 #88ff88, inset -1px -1px 0 #002200',
  });

  const el = document.getElementById('syncStatus');
  if (el) {
    const ts = new Date().toLocaleTimeString();
    el.textContent = `✔ Matrix Sync Active  ${ts}`;
    el.title = `Last successful server sync at ${ts}`;
  }

  if (wasLocked) {
    console.log('[RetroLab] Connection restored — returning to green sync state.');
  }
}

/**
 * Applies a colour theme to the status bar and all its .status-cell children
 * without altering the text content or layout of any cell.
 *
 * @param {{ barBg:string, barBorder:string, cellBg:string, cellFg:string, glow:string }} theme
 */
function _applyStatusTheme({ barBg, barBorder, cellBg, cellFg, glow }) {
  const bar = document.querySelector('.status-bar');
  if (!bar) return;

  bar.style.background   = barBg;
  bar.style.borderColor  = barBorder;
  bar.style.transition   = 'background 0.4s ease, border-color 0.4s ease';

  bar.querySelectorAll('.status-cell').forEach(cell => {
    cell.style.background  = cellBg;
    cell.style.color       = cellFg;
    cell.style.boxShadow   = glow;
    cell.style.fontWeight  = '700';
    cell.style.transition  = 'background 0.4s ease, color 0.3s ease';
  });

  // Dividers get a subtle tint too
  bar.querySelectorAll('.status-divider').forEach(d => {
    d.style.background = cellFg;
    d.style.opacity    = '0.4';
  });
}

// ═════════════════════════════════════════════════════════════════
//  INTEGRATION — hook into the inline script's onEditorInput()
// ═════════════════════════════════════════════════════════════════

/**
 * The index.html inline script defines onEditorInput() and attaches it
 * to the editor via oninput="onEditorInput()".
 *
 * We wrap that function so every input event also triggers an IDB
 * essay write, without modifying index.html.
 *
 * This runs on window 'load' (after DOMContentLoaded) to guarantee
 * the inline script has already executed and defined onEditorInput.
 */
function _wrapOnEditorInput() {
  window.addEventListener('load', () => {
    const original = window.onEditorInput;

    if (typeof original === 'function') {
      window.onEditorInput = function (...args) {
        original.apply(this, args); // run original (word count, localStorage etc.)
        _writeEssayToIDB();         // then persist to IDB
      };
    } else {
      // Fallback: if inline function was not found, attach directly
      const editor = document.getElementById('editor');
      if (editor) editor.addEventListener('input', _writeEssayToIDB);
    }
  });
}

// ─────────────────────────────────────────────────────────────────
//  PUBLIC SURFACE
//  (Exposed on window so browser console can inspect during testing)
// ─────────────────────────────────────────────────────────────────
window.RetroLab = {
  get telemetryData()    { return [...telemetryData]; },
  get syncState()        { return _syncState; },
  get db()               { return _db; },
  flushTelemetryIDB,
  restoreFromIDB,
  triggerHeartbeat: _sendHeartbeat,
};