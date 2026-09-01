/* Orderskanner mot Google Sheets
 * ------------------------------------------------------------
 * Läser en streckkod (t.ex. spårningsnumret på en fraktetikett)
 * med kameran eller en handdator, hittar ordernumret på den raden
 * i ett Google Sheet, och ställer samman alla artikelrader som hör
 * till den ordern. Varje skanning loggas tillbaka till arket.
 *
 * Datamodell (kolumner räknas som i kalkylarket, A=1):
 *  - Ordernummer:        en kolumn (standard B / kolumn 2)
 *  - Spårningsnummer:    en kolumn med t.ex. en HYPERLINK-formel;
 *                        cellens VISADE text (länktexten) är koden
 *                        som skannas (standard AB / kolumn 28)
 *  - Artikel:             2-3 kolumner som slås ihop med "-"
 *                        (standard G-I / kolumn 7-9)
 *  - Antal:               en kolumn med numeriskt antal, summeras
 *                        per unik artikel inom samma order
 *                        (standard J / kolumn 10)
 *
 * Bygger på:
 *  - Google Identity Services (OAuth token client, ingen backend)
 *  - Google Sheets API v4 (REST, anropas direkt från webbläsaren)
 *  - html5-qrcode för streckkodsavläsning via kameran
 * ------------------------------------------------------------ */

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const STORAGE_KEY = "eanScannerSettings";
const HISTORY_KEY = "eanScannerHistory";
const MAX_HISTORY = 25;
const RESCAN_COOLDOWN_MS = 3000;
const DEFAULT_SETTINGS = {
  clientId: "",
  spreadsheetId: "",
  productSheet: "Produkter",
  logSheet: "Skanningar",
  defaultMode: "camera",
  trackingCol: "AB",
  orderCol: "B",
  articleCols: "G,H,I",
  qtyCol: "J",
  dataStartRow: "2",
  motivCol: "",
};

/* ---------------- State ---------------- */

let settings = loadSettings();
let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let currentUser = null;

let html5QrCode = null;
let cameraRunning = false;
let cameraPaused = false;
let torchOn = false;

let orderIndex = null;        // { trackingToOrder: Map<code,orderNumber>, ordersByNumber: Map<orderNumber,Order> }
let orderIndexLoadedAt = 0;
let logSheetEnsured = false;

let lastScan = { code: null, at: 0 };
let currentMode = "camera"; // "camera" | "wedge"

let activeOrder = null;       // { code, order } for a matched order awaiting pallet confirmation, else null
let checkedLines = new Set(); // article labels checked off for activeOrder

/* ---------------- DOM refs ---------------- */

const el = (id) => document.getElementById(id);
const statusBanner = el("statusBanner");
const authArea = el("authArea");
const settingsBtn = el("settingsBtn");
const settingsModal = el("settingsModal");
const settingsForm = el("settingsForm");
const cancelSettingsBtn = el("cancelSettingsBtn");
const clientIdInput = el("clientIdInput");
const spreadsheetIdInput = el("spreadsheetIdInput");
const productSheetInput = el("productSheetInput");
const logSheetInput = el("logSheetInput");
const defaultModeInput = el("defaultModeInput");
const trackingColInput = el("trackingColInput");
const orderColInput = el("orderColInput");
const articleColsInput = el("articleColsInput");
const qtyColInput = el("qtyColInput");
const dataStartRowInput = el("dataStartRowInput");
const motivColInput = el("motivColInput");

const modeCameraBtn = el("modeCameraBtn");
const modeWedgeBtn = el("modeWedgeBtn");
const cameraPanel = el("cameraPanel");
const wedgePanel = el("wedgePanel");
const wedgeInput = el("wedgeInput");

const startScanBtn = el("startScanBtn");
const stopScanBtn = el("stopScanBtn");
const scanNextBtn = el("scanNextBtn");
const cameraPausedHint = el("cameraPausedHint");
const torchBtn = el("torchBtn");
const manualForm = el("manualForm");
const manualInput = el("manualInput");

const resultCard = el("resultCard");
const resultBadge = el("resultBadge");
const resultTracking = el("resultTracking");
const resultOrder = el("resultOrder");
const resultProgress = el("resultProgress");
const resultLines = el("resultLines");
const resultNote = el("resultNote");
const confirmRow = el("confirmRow");
const confirmPalletBtn = el("confirmPalletBtn");

const historyList = el("historyList");
const clearHistoryBtn = el("clearHistoryBtn");
const toast = el("toast");

/* ---------------- Settings persistence ---------------- */

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return {
      clientId: parsed.clientId || "",
      spreadsheetId: parsed.spreadsheetId || "",
      productSheet: parsed.productSheet || DEFAULT_SETTINGS.productSheet,
      logSheet: parsed.logSheet || DEFAULT_SETTINGS.logSheet,
      defaultMode: parsed.defaultMode === "wedge" ? "wedge" : "camera",
      trackingCol: parsed.trackingCol || DEFAULT_SETTINGS.trackingCol,
      orderCol: parsed.orderCol || DEFAULT_SETTINGS.orderCol,
      articleCols: parsed.articleCols || DEFAULT_SETTINGS.articleCols,
      qtyCol: parsed.qtyCol || DEFAULT_SETTINGS.qtyCol,
      dataStartRow: parsed.dataStartRow || DEFAULT_SETTINGS.dataStartRow,
      motivCol: parsed.motivCol || "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(next) {
  settings = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  // Config changed -> cached order data & log-sheet check are no longer valid.
  orderIndex = null;
  logSheetEnsured = false;
}

/** Lightweight patch for settings that don't invalidate the cached order/log state (e.g. UI mode). */
function persistSettingsPatch(patch) {
  settings = { ...settings, ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

function settingsComplete() {
  return Boolean(settings.clientId && settings.spreadsheetId && settings.productSheet && settings.logSheet);
}

/* ---------------- Toast helper ---------------- */

let toastTimer = null;
function showToast(message, kind) {
  toast.textContent = message;
  toast.className = "toast" + (kind ? " " + kind : "");
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3800);
}

/* ---------------- Status banner ---------------- */

function refreshBanner() {
  if (!settingsComplete()) {
    statusBanner.hidden = false;
    statusBanner.textContent = "Kom igång: öppna Inställningar (kugghjulet) och fyll i din Google OAuth-klient-ID och ditt Google Sheet-ID. Se README för instruktioner.";
    return;
  }
  if (!accessToken) {
    statusBanner.hidden = false;
    statusBanner.textContent = "Logga in med Google för att kunna läsa och skriva till ditt kalkylark.";
    return;
  }
  statusBanner.hidden = true;
}

/* ---------------- Settings modal ---------------- */

settingsBtn.addEventListener("click", () => {
  clientIdInput.value = settings.clientId;
  spreadsheetIdInput.value = settings.spreadsheetId;
  productSheetInput.value = settings.productSheet;
  logSheetInput.value = settings.logSheet;
  defaultModeInput.value = settings.defaultMode;
  trackingColInput.value = settings.trackingCol;
  orderColInput.value = settings.orderCol;
  articleColsInput.value = settings.articleCols;
  qtyColInput.value = settings.qtyCol;
  dataStartRowInput.value = settings.dataStartRow;
  motivColInput.value = settings.motivCol;
  settingsModal.showModal();
});

cancelSettingsBtn.addEventListener("click", () => settingsModal.close());

// Refocus the external-scanner input whenever the settings dialog closes
// (Cancel, Save, or Esc all fire "close" on a <dialog>).
settingsModal.addEventListener("close", () => {
  if (currentMode === "wedge") setTimeout(focusWedgeInput, 100);
});

settingsForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const next = {
    clientId: clientIdInput.value.trim(),
    spreadsheetId: spreadsheetIdInput.value.trim(),
    productSheet: productSheetInput.value.trim() || "Produkter",
    logSheet: logSheetInput.value.trim() || "Skanningar",
    defaultMode: defaultModeInput.value === "wedge" ? "wedge" : "camera",
    trackingCol: trackingColInput.value.trim() || DEFAULT_SETTINGS.trackingCol,
    orderCol: orderColInput.value.trim() || DEFAULT_SETTINGS.orderCol,
    articleCols: articleColsInput.value.trim() || DEFAULT_SETTINGS.articleCols,
    qtyCol: qtyColInput.value.trim() || DEFAULT_SETTINGS.qtyCol,
    dataStartRow: dataStartRowInput.value.trim() || DEFAULT_SETTINGS.dataStartRow,
    motivCol: motivColInput.value.trim(), // optional, empty = feature off
  };
  const clientChanged = next.clientId !== settings.clientId;
  saveSettings(next);
  settingsModal.close();
  refreshBanner();
  showToast("Inställningar sparade.", "success");
  if (clientChanged) {
    // Client ID changed: (re)initialize the Google auth token client.
    initGoogleAuth();
  }
  setMode(next.defaultMode);
});

/* ---------------- Google auth ---------------- */

function initGoogleAuth() {
  if (!settings.clientId) {
    renderSignedOut();
    return;
  }
  if (typeof google === "undefined" || !google.accounts || !google.accounts.oauth2) {
    // GIS script not loaded yet; try again shortly.
    setTimeout(initGoogleAuth, 300);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: settings.clientId,
    scope: SHEETS_SCOPE,
    callback: onTokenResponse,
    error_callback: (err) => {
      console.error("OAuth error", err);
      showToast("Inloggningen misslyckades eller avbröts.", "error");
    },
  });
  renderSignedOut();
}

function onTokenResponse(resp) {
  if (resp.error) {
    showToast("Kunde inte logga in: " + resp.error, "error");
    return;
  }
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3000) * 1000;
  fetchUserInfo().finally(() => {
    renderSignedIn();
    refreshBanner();
  });
}

async function fetchUserInfo() {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    if (r.ok) currentUser = await r.json();
  } catch {
    currentUser = null;
  }
}

function renderSignedOut() {
  authArea.innerHTML = "";
  const btn = document.createElement("button");
  btn.textContent = "Logga in med Google";
  btn.disabled = !settings.clientId;
  btn.addEventListener("click", () => {
    if (!tokenClient) { showToast("Fyll i klient-ID i Inställningar först.", "error"); return; }
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
  authArea.appendChild(btn);
}

function renderSignedIn() {
  authArea.innerHTML = "";
  const chip = document.createElement("div");
  chip.className = "user-chip";
  if (currentUser && currentUser.picture) {
    const img = document.createElement("img");
    img.src = currentUser.picture;
    img.alt = "";
    chip.appendChild(img);
  }
  const name = document.createElement("span");
  name.textContent = currentUser ? (currentUser.given_name || currentUser.name || "Inloggad") : "Inloggad";
  chip.appendChild(name);
  const out = document.createElement("button");
  out.textContent = "Logga ut";
  out.addEventListener("click", signOut);
  chip.appendChild(out);
  authArea.appendChild(chip);
}

function signOut() {
  if (accessToken && typeof google !== "undefined") {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  currentUser = null;
  orderIndex = null;
  logSheetEnsured = false;
  renderSignedOut();
  refreshBanner();
}

/** Ensures we have a (likely) valid access token, refreshing silently if needed. */
function ensureToken() {
  return new Promise((resolve, reject) => {
    if (accessToken && Date.now() < tokenExpiresAt - 30000) {
      resolve(accessToken);
      return;
    }
    if (!tokenClient) { reject(new Error("Inte inloggad.")); return; }
    const prevCallback = tokenClient.callback;
    tokenClient.callback = (resp) => {
      tokenClient.callback = prevCallback;
      if (resp.error) { reject(new Error(resp.error)); return; }
      accessToken = resp.access_token;
      tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3000) * 1000;
      resolve(accessToken);
    };
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

/* ---------------- Google Sheets API helpers ---------------- */

const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsFetch(path, options = {}, retry = true) {
  const token = await ensureToken();
  const res = await fetch(SHEETS_BASE + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && retry) {
    accessToken = null; // force refresh
    return sheetsFetch(path, options, false);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Sheets API-fel (${res.status}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

function a1(sheetName) {
  return encodeURIComponent(`'${sheetName.replace(/'/g, "''")}'`);
}

/** Raw (unencoded) quoted sheet reference, for building a range string before a single encodeURIComponent pass. */
function rawSheetRef(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

/** Converts a spreadsheet column letter ("A", "AB", ...) to a zero-based index. */
function colLetterToIndex(letters) {
  const s = String(letters || "").trim().toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) continue;
    n = n * 26 + (c - 64);
  }
  return n - 1; // zero-based; invalid/empty input -> -1
}

function parseQtyValue(raw) {
  const cleaned = String(raw || "").trim().replace(/\s+/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

function formatQty(n) {
  if (!isFinite(n)) return "0";
  const rounded = Math.round(n * 1000) / 1000;
  return rounded.toLocaleString("sv-SE", { maximumFractionDigits: 3 });
}

/**
 * Fetches the resolved hyperlink URL (works for both a HYPERLINK() formula
 * and a native "insert link" rich-text link) for every cell in one column,
 * via spreadsheets.get with fields=...hyperlink instead of values.get
 * (which only ever returns display text, never the URL).
 * Returns a Map<rowIndex (0-based, aligned with the main values array), url>.
 */
async function fetchColumnHyperlinks(sheetName, colLetter) {
  const map = new Map();
  if (!colLetter) return map;
  const id = settings.spreadsheetId;
  const range = `${rawSheetRef(sheetName)}!${colLetter}:${colLetter}`;
  const fields = "sheets.data.rowData.values.hyperlink";
  try {
    const data = await sheetsFetch(`/${id}?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`);
    const rowData = data?.sheets?.[0]?.data?.[0]?.rowData || [];
    rowData.forEach((row, idx) => {
      const link = row?.values?.[0]?.hyperlink;
      if (link) map.set(idx, link);
    });
  } catch (err) {
    console.warn("Kunde inte läsa motiv-länkar", err);
  }
  return map;
}

/**
 * Loads the order/line-item sheet into memory and builds two lookups:
 *  - trackingToOrder: spårningsnummer (t.ex. från en HYPERLINK-cell) -> ordernummer
 *  - ordersByNumber:  ordernummer -> { orderNumber, lineMap: Map<label,{qty,motivUrl}>, rowNumbers }
 * Rows with the same order number are grouped, and rows sharing the exact
 * same artikel-nyckel (kolumn 7-9 hopslagna) within an order have sitt
 * antal summerat. Om en motiv-länkkolumn är satt hämtas även den PDF-länk
 * (t.ex. till Drive) som hör till varje artikelrad.
 */
async function loadOrderIndex(force = false) {
  if (orderIndex && !force && Date.now() - orderIndexLoadedAt < 5 * 60 * 1000) {
    return orderIndex;
  }
  const id = settings.spreadsheetId;
  const range = `${a1(settings.productSheet)}`;

  const [data, motivLinks] = await Promise.all([
    sheetsFetch(`/${id}/values/${range}`),
    fetchColumnHyperlinks(settings.productSheet, settings.motivCol),
  ]);
  const rows = data.values || [];
  if (rows.length === 0) throw new Error(`Fliken "${settings.productSheet}" verkar vara tom.`);

  const orderCol = colLetterToIndex(settings.orderCol);
  const trackingCol = colLetterToIndex(settings.trackingCol);
  const articleCols = String(settings.articleCols)
    .split(",")
    .map((s) => colLetterToIndex(s))
    .filter((n) => n >= 0);
  const qtyCol = colLetterToIndex(settings.qtyCol);
  const startRow = Math.max(1, parseInt(settings.dataStartRow, 10) || 2) - 1; // zero-based

  if (orderCol < 0 || trackingCol < 0 || articleCols.length === 0 || qtyCol < 0) {
    throw new Error("Ogiltig kolumninställning – kontrollera kolumnbokstäverna i Inställningar.");
  }

  const ordersByNumber = new Map();
  const trackingToOrder = new Map();

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const orderNumber = (row[orderCol] || "").toString().trim();
    if (!orderNumber) continue;

    const tracking = normalizeCode(row[trackingCol] || "");
    const articleLabel = articleCols
      .map((c) => (row[c] || "").toString().trim())
      .filter(Boolean)
      .join("-");
    const qty = parseQtyValue(row[qtyCol]);

    if (!ordersByNumber.has(orderNumber)) {
      ordersByNumber.set(orderNumber, { orderNumber, lineMap: new Map(), rowNumbers: [] });
    }
    const order = ordersByNumber.get(orderNumber);
    order.rowNumbers.push(i + 1);

    if (tracking && !trackingToOrder.has(tracking)) {
      trackingToOrder.set(tracking, orderNumber);
    }
    if (articleLabel) {
      if (!order.lineMap.has(articleLabel)) order.lineMap.set(articleLabel, { qty: 0, motivUrl: null });
      const entry = order.lineMap.get(articleLabel);
      entry.qty += qty;
      if (!entry.motivUrl) {
        const link = motivLinks.get(i);
        if (link) entry.motivUrl = link;
      }
    }
  }

  orderIndex = { ordersByNumber, trackingToOrder };
  orderIndexLoadedAt = Date.now();
  return orderIndex;
}

/** Turns an order's internal lineMap into a sorted, display-ready array. */
function orderLines(order) {
  if (!order) return [];
  return Array.from(order.lineMap.entries())
    .map(([label, v]) => ({ label, qty: v.qty, motivUrl: v.motivUrl || null }))
    .sort((a, b) => a.label.localeCompare(b.label, "sv"));
}

function normalizeCode(code) {
  return String(code).trim().replace(/\s+/g, "");
}

/** Makes sure the log sheet/tab exists, creating it with headers if missing. */
async function ensureLogSheet() {
  if (logSheetEnsured) return;
  const id = settings.spreadsheetId;
  const meta = await sheetsFetch(`/${id}?fields=sheets.properties.title`);
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  if (!titles.includes(settings.logSheet)) {
    await sheetsFetch(`/${id}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: settings.logSheet } } }],
      }),
    });
    await sheetsFetch(`/${id}/values/${a1(settings.logSheet)}!A1:F1?valueInputOption=RAW`, {
      method: "PUT",
      body: JSON.stringify({ values: [["Tidpunkt", "Spårningsnummer", "Ordernummer", "Antal artikelrader", "Status", "Saknade artiklar"]] }),
    });
  }
  logSheetEnsured = true;
}

/**
 * Appends one scan/pallet event to the log sheet.
 *  - order == null            -> "Ingen träff" (spårningsnumret hittades inte)
 *  - order set, complete=true -> "Fullständig" (alla rader avbockade)
 *  - order set, complete=false-> "Ofullständig", med de saknade artiklarna listade
 */
async function appendLogRow(code, order, complete, missingLabels) {
  await ensureLogSheet();
  const id = settings.spreadsheetId;
  const lines = orderLines(order);
  let status;
  if (!order) status = "Ingen träff";
  else status = complete ? "Fullständig" : "Ofullständig";
  const missingText = order && !complete && missingLabels ? missingLabels.join("; ") : "";
  const values = [[
    new Date().toLocaleString("sv-SE"),
    code,
    order ? order.orderNumber : "",
    order ? String(lines.length) : "0",
    status,
    missingText,
  ]];
  await sheetsFetch(
    `/${id}/values/${a1(settings.logSheet)}!A:F:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values }) }
  );
}

/* ---------------- Scan handling (shared by camera + manual entry) ---------------- */

async function handleScannedCode(rawCode, { fromCamera, fromWedge } = {}) {
  const code = normalizeCode(rawCode);
  if (!code) return;

  const now = Date.now();
  if ((fromCamera || fromWedge) && code === lastScan.code && now - lastScan.at < RESCAN_COOLDOWN_MS) {
    return; // debounce repeated reads of the same code (camera stays open, or a wedge sends CR+LF)
  }
  lastScan = { code, at: now };

  if (navigator.vibrate) navigator.vibrate(80);

  if (!settingsComplete()) {
    showToast("Fyll i inställningarna (klient-ID och Sheet-ID) först.", "error");
    return;
  }
  if (!accessToken) {
    showToast("Logga in med Google för att slå upp koden.", "error");
    return;
  }

  if (activeOrder && activeOrder.code !== code) {
    showToast(`OBS: föregående pall (order ${activeOrder.order.orderNumber}) bekräftades aldrig och loggades inte.`, "error");
  }

  showResultLoading(code);

  try {
    const { trackingToOrder, ordersByNumber } = await loadOrderIndex();
    const orderNumber = trackingToOrder.get(code) || null;
    const order = orderNumber ? ordersByNumber.get(orderNumber) : null;

    activeOrder = order ? { code, order } : null;
    checkedLines = new Set();

    renderResult(code, order);

    if (!order) {
      // Nothing to check off against a pallet - log the miss right away, as before.
      addHistoryItem(code, null, null);
      appendLogRow(code, null, null, []).catch((err) => {
        console.error(err);
        showToast("Träffen visades, men loggning till arket misslyckades.", "error");
      });
    }
    // If a match was found, logging + history now wait for "Bekräfta pall".
  } catch (err) {
    console.error(err);
    showToast(err.message || "Något gick fel vid uppslag.", "error");
    resultCard.hidden = true;
  }
}

function showResultLoading(code) {
  resultCard.hidden = false;
  resultBadge.textContent = "Söker…";
  resultBadge.className = "badge";
  resultTracking.textContent = code;
  resultOrder.textContent = "–";
  resultProgress.hidden = true;
  resultLines.innerHTML = "";
  resultNote.textContent = "";
  confirmRow.hidden = true;
}

function updateResultProgress(total) {
  resultProgress.textContent = `Avbockat: ${checkedLines.size} av ${total}`;
}

function renderResult(code, order) {
  resultCard.hidden = false;
  resultTracking.textContent = code;
  resultLines.innerHTML = "";

  if (order) {
    const lines = orderLines(order);
    resultBadge.textContent = "Träff";
    resultBadge.className = "badge pending";
    resultOrder.textContent = order.orderNumber;
    confirmRow.hidden = false;

    if (lines.length === 0) {
      const li = document.createElement("li");
      li.className = "result-line-empty";
      li.textContent = "Ordern hittades, men inga artikelrader kunde läsas ut.";
      resultLines.appendChild(li);
      resultProgress.hidden = true;
    } else {
      lines.forEach((line) => {
        const li = document.createElement("li");
        li.className = "result-line";

        const check = document.createElement("label");
        check.className = "rl-check";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.addEventListener("change", () => {
          if (cb.checked) checkedLines.add(line.label);
          else checkedLines.delete(line.label);
          li.classList.toggle("checked", cb.checked);
          updateResultProgress(lines.length);
        });
        const label = document.createElement("span");
        label.className = "rl-label";
        label.textContent = line.label;
        check.appendChild(cb);
        check.appendChild(label);
        li.appendChild(check);

        if (line.motivUrl) {
          const a = document.createElement("a");
          a.href = line.motivUrl;
          a.target = "_blank";
          a.rel = "noopener";
          a.className = "rl-motiv";
          a.textContent = "Se motiv";
          li.appendChild(a);
        }

        const qty = document.createElement("span");
        qty.className = "rl-qty";
        qty.textContent = formatQty(line.qty) + " st";
        li.appendChild(qty);

        resultLines.appendChild(li);
      });
      resultProgress.hidden = false;
      updateResultProgress(lines.length);
    }
    resultNote.textContent = `Bocka av varje rad när du räknat den på pallen, tryck sedan "Bekräfta pall".`;
  } else {
    resultBadge.textContent = "Ingen träff";
    resultBadge.className = "badge nomatch";
    resultOrder.textContent = "–";
    resultProgress.hidden = true;
    confirmRow.hidden = true;
    resultNote.textContent = `Spårningsnumret hittades inte i fliken "${settings.productSheet}". Skanningen loggades ändå.`;
  }
}

confirmPalletBtn.addEventListener("click", async () => {
  if (!activeOrder) return;
  const { code, order } = activeOrder;
  const lines = orderLines(order);
  const missing = lines.filter((l) => !checkedLines.has(l.label)).map((l) => l.label);
  const complete = missing.length === 0;

  addHistoryItem(code, order, complete);
  confirmPalletBtn.disabled = true;
  try {
    await appendLogRow(code, order, complete, missing);
    showToast(
      complete ? "Pall bekräftad – fullständig." : `Pall bekräftad – ofullständig (${missing.length} rad(er) saknas).`,
      complete ? "success" : "error"
    );
  } catch (err) {
    console.error(err);
    showToast("Kunde inte logga till arket.", "error");
  } finally {
    confirmPalletBtn.disabled = false;
  }

  activeOrder = null;
  checkedLines = new Set();
  confirmRow.hidden = true;
  resultProgress.hidden = true;

  if (currentMode === "camera" && cameraPaused) resumeCameraScanning();
});

/* ---------------- History (local only, session convenience) ---------------- */

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}
function saveHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
}

function addHistoryItem(code, order, complete) {
  const items = loadHistory();
  items.unshift({
    tracking: code,
    orderNumber: order ? order.orderNumber : "",
    lineCount: order ? orderLines(order).length : 0,
    matched: Boolean(order),
    complete: order ? Boolean(complete) : null,
    time: new Date().toISOString(),
  });
  saveHistory(items);
  renderHistory();
}

function renderHistory() {
  const items = loadHistory();
  historyList.innerHTML = "";
  if (items.length === 0) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = "Inga skanningar ännu.";
    historyList.appendChild(li);
    return;
  }
  items.forEach((item) => {
    const li = document.createElement("li");
    const statusClass = !item.matched ? " nomatch" : (!item.complete ? " incomplete" : "");
    li.className = "history-item" + statusClass;
    const left = document.createElement("div");
    const name = document.createElement("div");
    name.className = "hi-name";
    name.textContent = !item.matched
      ? "Ingen träff"
      : item.complete
        ? `Order ${item.orderNumber} – fullständig (${item.lineCount})`
        : `Order ${item.orderNumber} – ofullständig`;
    const ean = document.createElement("div");
    ean.className = "hi-ean";
    ean.textContent = item.tracking;
    left.appendChild(name);
    left.appendChild(ean);
    const time = document.createElement("div");
    time.className = "hi-time";
    time.textContent = new Date(item.time).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
    li.appendChild(left);
    li.appendChild(time);
    historyList.appendChild(li);
  });
}

clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

/* ---------------- Manual entry ---------------- */

manualForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const val = manualInput.value.trim();
  if (!val) return;
  handleScannedCode(val, { fromCamera: false });
  manualInput.value = "";
});

/* ---------------- Input mode switch (camera vs. external/wedge scanner) ----------------
 * Handdatorer som Cipherlab har en inbyggd laser-/2D-skanner som normalt
 * konfigureras som "Keyboard Wedge" (Keyboard Emulation): en tryckning på
 * avtryckaren matar in den skannade koden som om den skrivits på ett
 * tangentbord, följt av Enter. Vi håller därför ett dolt-ish textfält
 * ständigt fokuserat i det här läget och läser av när Enter/Tab kommer.
 * Se README för hur man ställer in det på enheten. */

function setMode(mode) {
  currentMode = mode === "wedge" ? "wedge" : "camera";
  modeCameraBtn.classList.toggle("active", currentMode === "camera");
  modeWedgeBtn.classList.toggle("active", currentMode === "wedge");
  cameraPanel.hidden = currentMode !== "camera";
  wedgePanel.hidden = currentMode !== "wedge";

  if (currentMode === "wedge") {
    if (cameraRunning) stopCamera();
    setTimeout(focusWedgeInput, 50);
  }
  persistSettingsPatch({ defaultMode: currentMode });
}

function focusWedgeInput() {
  if (currentMode !== "wedge") return;
  if (settingsModal.open) return;
  wedgeInput.focus({ preventScroll: true });
}

modeCameraBtn.addEventListener("click", () => setMode("camera"));
modeWedgeBtn.addEventListener("click", () => setMode("wedge"));

wedgeInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    const val = wedgeInput.value.trim();
    wedgeInput.value = "";
    if (val) handleScannedCode(val, { fromWedge: true });
    setTimeout(focusWedgeInput, 50);
  }
});

// The field should basically never lose focus while in scanner mode -
// refocus it if something (a stray tap, the OS) steals focus away.
wedgeInput.addEventListener("blur", () => {
  if (currentMode === "wedge" && !settingsModal.open) {
    setTimeout(focusWedgeInput, 150);
  }
});
window.addEventListener("focus", () => setTimeout(focusWedgeInput, 100));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) setTimeout(focusWedgeInput, 100);
});

/* ---------------- Camera scanning (html5-qrcode) ---------------- */

const SCAN_FORMATS = (typeof Html5QrcodeSupportedFormats !== "undefined") ? [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.CODE_128,
] : undefined;

async function startCamera() {
  if (cameraRunning) return;
  if (!settingsComplete()) {
    showToast("Fyll i inställningarna först.", "error");
    settingsBtn.click();
    return;
  }
  try {
    html5QrCode = new Html5Qrcode("reader", { formatsToSupport: SCAN_FORMATS, verbose: false });
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: (vw, vh) => ({ width: Math.min(320, vw * 0.85), height: Math.min(160, vh * 0.5) }) },
      (decodedText) => {
        // Single-shot: ignore further decodes until the user explicitly
        // resumes (via "Skanna nästa kod") — otherwise the same frame
        // keeps re-triggering scans every cooldown period.
        if (!cameraRunning || cameraPaused) return;
        pauseCameraAfterScan();
        handleScannedCode(decodedText, { fromCamera: true });
      },
      () => {} // per-frame decode failures are expected & noisy; ignore
    );
    cameraRunning = true;
    cameraPaused = false;
    startScanBtn.hidden = true;
    stopScanBtn.hidden = false;
    scanNextBtn.hidden = true;
    cameraPausedHint.hidden = true;
    maybeShowTorchButton();
  } catch (err) {
    console.error(err);
    showToast("Kunde inte starta kameran: " + (err.message || err), "error");
  }
}

/** Freezes the camera decode loop right after a scan, until the user taps "Skanna nästa kod". */
function pauseCameraAfterScan() {
  if (!html5QrCode || cameraPaused) return;
  cameraPaused = true;
  try {
    html5QrCode.pause(true);
  } catch (err) {
    console.warn("Kunde inte pausa kameran", err);
  }
  scanNextBtn.hidden = false;
  cameraPausedHint.hidden = false;
}

function resumeCameraScanning() {
  if (!html5QrCode || !cameraPaused) return;
  try {
    html5QrCode.resume();
  } catch (err) {
    console.warn("Kunde inte återuppta kameran", err);
  }
  cameraPaused = false;
  scanNextBtn.hidden = true;
  cameraPausedHint.hidden = true;
}

scanNextBtn.addEventListener("click", resumeCameraScanning);

async function stopCamera() {
  if (!cameraRunning || !html5QrCode) return;
  try {
    await html5QrCode.stop();
    html5QrCode.clear();
  } catch (err) {
    console.warn(err);
  }
  cameraRunning = false;
  cameraPaused = false;
  torchOn = false;
  startScanBtn.hidden = false;
  stopScanBtn.hidden = true;
  scanNextBtn.hidden = true;
  cameraPausedHint.hidden = true;
  torchBtn.hidden = true;
}

async function maybeShowTorchButton() {
  try {
    const capabilities = html5QrCode.getRunningTrackCapabilities?.();
    if (capabilities && capabilities.torch) {
      torchBtn.hidden = false;
    }
  } catch {
    /* torch not supported on this device/browser */
  }
}

torchBtn.addEventListener("click", async () => {
  if (!html5QrCode) return;
  try {
    torchOn = !torchOn;
    await html5QrCode.applyVideoConstraints({ advanced: [{ torch: torchOn }] });
    torchBtn.textContent = torchOn ? "Lampa av" : "Lampa";
  } catch (err) {
    showToast("Lampan stöds inte på den här enheten.", "error");
    torchOn = false;
  }
});

startScanBtn.addEventListener("click", startCamera);
stopScanBtn.addEventListener("click", stopCamera);

/* ---------------- Init ---------------- */

window.addEventListener("load", () => {
  refreshBanner();
  renderHistory();
  initGoogleAuth();
  setMode(settings.defaultMode);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});

window.addEventListener("beforeunload", () => {
  if (cameraRunning && html5QrCode) {
    html5QrCode.stop().catch(() => {});
  }
});
