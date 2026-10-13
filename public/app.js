let STATE = { trips: [], advances: [], doers: [], settings: {}, user: null, tripStatusFilter: null };
let CURRENT_TRIP_REMAINING = 0; // unspent advance on the trip currently open in the detail modal, if any

function toast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => t.classList.remove('show'), 3500);
}
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
function val(id) { return document.getElementById(id).value; }
function val_set(id, v) { document.getElementById(id).value = v; }
function clearModal(modalId) {
  document.querySelectorAll('#' + modalId + ' input, #' + modalId + ' textarea').forEach(el => el.value = '');
}
function markSynced() {
  document.getElementById('lastSynced').textContent = 'Last synced ' + new Date().toLocaleTimeString();
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

/* ---------------- LOGIN ---------------- */

async function submitLogin() {
  const email = val('login-email');
  const password = val('login-password');
  try {
    const res = await api('POST', '/api/login', { email, password });
    STATE.user = res.user;
    document.getElementById('login-error').textContent = '';
    showApp();
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
}

async function logout() {
  await api('POST', '/api/logout');
  location.reload();
}

async function checkSession() {
  try {
    const res = await api('GET', '/api/me');
    STATE.user = res.user;
    showApp();
  } catch (err) {
    document.getElementById('loginScreen').style.display = 'flex';
  }
}

function showApp() {
  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('mainApp').style.display = 'flex';
  document.getElementById('userboxName').textContent = STATE.user.name || STATE.user.email;
  document.getElementById('userboxRole').textContent = STATE.user.role;
  // Settings (including the Accounts login itself) is Admin-only -
  // hidden entirely from Accounts, not just visually de-emphasized.
  const settingsNav = document.querySelector('.side-item[data-page="settings"]');
  if (settingsNav) settingsNav.style.display = (STATE.user.role === 'Admin') ? '' : 'none';
  // Change Password is Admin-only too - Accounts' own login is managed
  // entirely through Settings by Admin, not self-service.
  const changePasswordBtn = document.getElementById('changePasswordBtn');
  if (changePasswordBtn) changePasswordBtn.style.display = (STATE.user.role === 'Admin') ? '' : 'none';
  loadAll();
}

function togglePasswordVisibility(inputId, btn) {
  const input = document.getElementById(inputId);
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.classList.toggle('showing', !showing);
  btn.title = showing ? 'Show password' : 'Hide password';
}

async function submitChangePassword() {
  const currentPassword = val('cp-current');
  const newPassword = val('cp-new');
  const confirmPassword = val('cp-confirm');
  if (!currentPassword || !newPassword || !confirmPassword) { toast('All fields are required', true); return; }
  if (newPassword.length < 6) { toast('New password must be at least 6 characters', true); return; }
  if (newPassword !== confirmPassword) { toast('New passwords do not match', true); return; }
  try {
    await api('POST', '/api/change-password', { currentPassword, newPassword });
    closeModal('modal-change-password'); clearModal('modal-change-password');
    toast('Password updated successfully');
  } catch (err) { toast(err.message, true); }
}

/* ---------------- LOAD / REFRESH ---------------- */

let refreshInFlight = false;
async function refreshAll(showToast) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  await loadAll(showToast);
  refreshInFlight = false;
}

async function loadAll(showToast) {
  try {
    const isAdmin = STATE.user && STATE.user.role === 'Admin';
    const [tripsRes, advRes, doersRes, setRes] = await Promise.all([
      api('GET', '/api/trips'), api('GET', '/api/advance-requests'), api('GET', '/api/doers'),
      isAdmin ? api('GET', '/api/settings') : Promise.resolve({ settings: {} })
    ]);
    STATE.trips = tripsRes.trips;
    STATE.advances = advRes.requests;
    STATE.doers = doersRes.doers;
    STATE.settings = setRes.settings;
    renderTrips(); renderAdvances(); renderDoers();
    if (isAdmin) { renderSettings(); loadCcRecipients(); }
    loadDoerBalances(); // the Dashboard's money picture - loads alongside, renders when ready
    renderDashboard();
    document.getElementById('count-trips').textContent = STATE.trips.filter(t => t.TripStatus === 'Submitted').length;
    document.getElementById('count-advances').textContent = STATE.advances.filter(a => a.Status === 'Pending').length;
    document.getElementById('count-doers').textContent = STATE.doers.length;
    markSynced();
    if (showToast) toast('Data refreshed');
  } catch (err) {
    toast('Could not refresh: ' + err.message, true);
  }
}

/* ---------------- THEME & SIDEBAR ---------------- */

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  setTheme(isLight ? 'dark' : 'light');
}
function setTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('voucher-theme', theme);
}
function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('voucher-sidebar-collapsed', collapsed ? '1' : '0');
}
function restorePreferences() {
  const savedTheme = localStorage.getItem('voucher-theme');
  if (savedTheme) setTheme(savedTheme);
  if (localStorage.getItem('voucher-sidebar-collapsed') === '1') {
    document.getElementById('sidebar').classList.add('collapsed');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  restorePreferences();
  document.getElementById('refreshTopBtn').addEventListener('click', () => { toast('Refreshing...'); refreshAll(true); });
  document.querySelectorAll('.side-item[data-page]').forEach(el => {
    el.addEventListener('click', () => showPage(el.dataset.page));
  });
  setInterval(() => {
    const modalOpen = document.querySelector('.modal-bg.open');
    if (!modalOpen && STATE.user) refreshAll();
  }, 15000);
});

const PAGE_TITLES = { dashboard: 'Dashboard', trips: 'Trips', advances: 'Advance Requests', doers: 'Doers', reports: 'Reports', settings: 'Settings' };
function showPage(page) {
  document.querySelectorAll('.side-item[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page];
}


/* ---------------- DASHBOARD ---------------- */

// Short, colour-coded settlement for a table cell:
// red = Doer owes the company, amber = company owes the Doer.
function settlementCell(t) {
  // A trip still being worked on has no settlement yet - its expenses aren't final
  if (t.TripStatus === 'Ongoing' || t.TripStatus === 'Rejected') return '<span class="sub">In progress</span>';
  const diff = Number(t.VoucherTotal || 0) - Number(t.AdvanceReceived || 0);
  if (diff === 0) return '<span class="sub">Settled</span>';
  if (diff < 0) {
    if (t.TripStatus === 'Passed' && t.AdvanceReturned === 'Y') return `<span class="sub">${rs(-diff)} returned</span>`;
    if (t.TripStatus === 'Passed') return `<span class="sub">${rs(-diff)} kept for next trip</span>`;
    return `<span class="amt-red">Doer owes ${rs(-diff)}</span>`; // Submitted - not yet decided
  }
  return `<span class="amt-amber">Pay Doer ${rs(diff)}</span>`;
}

// Days between a DD-MM-YYYY date and today
function daysSince(ddmmyyyy) {
  const iso = ddmmyyyyToIso(ddmmyyyy);
  if (!iso) return null;
  return Math.max(0, Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(iso + 'T00:00:00')) / 86400000));
}

async function loadDoerBalances() {
  try {
    const res = await api('GET', '/api/overview/doer-balances');
    STATE.doerBalances = res.balances;
  } catch (err) { STATE.doerBalances = []; }
  renderDashboard();
}

function goToTrips(filter) {
  clearTripFilters();
  if (filter.status) STATE.tripStatusFilter = filter.status;
  if (filter.doer) document.getElementById('ft-doer').value = filter.doer;
  renderTrips();
  showPage('trips');
}

function goToAdvances(status) {
  clearAdvanceFilters();
  document.getElementById('fa-status').value = status || '';
  renderAdvances();
  showPage('advances');
}

function renderDashboard() {
  const trips = STATE.trips || [], advances = STATE.advances || [], balances = STATE.doerBalances || [];
  const name = STATE.user ? (STATE.user.name || '').split(' ')[0] : '';
  document.getElementById('dash-greeting').textContent = name ? `Hello, ${name}` : 'Dashboard';

  const submitted = trips.filter(t => t.TripStatus === 'Submitted');
  const pendingAdv = advances.filter(a => a.Status === 'Pending');
  const withDoers = balances.reduce((s2, b) => s2 + Math.max(0, b.WithDoer), 0);
  const toCollect = balances.reduce((s2, b) => s2 + b.ToCollect, 0);
  const claimed = submitted.reduce((s2, t) => s2 + Number(t.VoucherTotal || 0), 0);
  const requested = pendingAdv.reduce((s2, a) => s2 + Number(a.RequestedAmount || 0), 0);

  const kpi = (color, label, value, sub, onclick) =>
    `<div class="kpi" style="--kpi-color:${color}" onclick="${onclick}"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-sub">${sub}</div></div>`;
  document.getElementById('dash-kpis').innerHTML =
    kpi('var(--amber-text)', 'Trips to review', submitted.length, submitted.length ? `${rs(claimed)} claimed` : 'All caught up', "goToTrips({status:'Submitted'})") +
    kpi('var(--brand)', 'Advance requests', pendingAdv.length, pendingAdv.length ? `${rs(requested)} requested` : 'None pending', "goToAdvances('Pending')") +
    kpi('#4a90d9', 'Cash with Doers', rs(withDoers), 'Unused advance + open trips', "document.getElementById('tbl-dash-balances').scrollIntoView({behavior:'smooth'})") +
    kpi('var(--text-3)', 'Kept, not returned', rs(toCollect), toCollect ? 'Already part of cash with Doers' : 'None', "document.getElementById('tbl-dash-balances').scrollIntoView({behavior:'smooth'})");

  // ---- Needs your attention: oldest first, so nothing waits too long ----
  const items = [];
  submitted.forEach(t => {
    const waited = daysSince(t.EndDate || t.StartDate);
    items.push({ sortKey: waited == null ? 0 : waited, color: 'var(--amber-text)',
      main: `Review ${t.TripCode} — ${t.DoerName}`,
      meta: `${t.LocationVisited || ''}${waited != null ? ` · waiting ${waited} day${waited === 1 ? '' : 's'}` : ''}`,
      amt: rs(t.VoucherTotal), click: `openTripDetail('${t.TripCode}')` });
  });
  pendingAdv.forEach(a => {
    const waited = daysSince(a.CreatedAt);
    items.push({ sortKey: waited == null ? 0 : waited, color: 'var(--brand)',
      main: `Advance ${a.RequestID} — ${a.DoerName || a.DoerCode}`,
      meta: `${a.Purpose || 'No purpose given'}${waited != null ? ` · requested ${waited === 0 ? 'today' : waited + ' day' + (waited === 1 ? '' : 's') + ' ago'}` : ''}`,
      amt: rs(a.RequestedAmount), click: `openDecideAdvance('${a.RequestID}', ${a.RequestedAmount})` });
  });
  items.sort((x, y) => y.sortKey - x.sortKey);
  document.getElementById('dash-attn-count').textContent = items.length ? `${items.length} item${items.length === 1 ? '' : 's'}` : '';
  document.getElementById('dash-attention').innerHTML = items.length
    ? items.slice(0, 8).map(i => `
      <div class="attn-item" style="--attn-color:${i.color}" onclick="${i.click}">
        <div><div class="attn-main">${i.main}</div><div class="attn-meta">${i.meta}</div></div>
        <div class="attn-amt">${i.amt}</div>
      </div>`).join('') + (items.length > 8 ? `<div class="sub" style="padding:6px 4px;">+ ${items.length - 8} more</div>` : '')
    : '<div class="attn-empty">Nothing waiting on you right now.</div>';

  // ---- This month (by Passed Date) ----
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0'), yyyy = String(now.getFullYear());
  const inMonth = (d) => { const iso = ddmmyyyyToIso(d); return iso && iso.slice(0, 7) === `${yyyy}-${mm}`; };
  const passedThisMonth = trips.filter(t => t.TripStatus === 'Passed' && inMonth(t.PassedDate));
  const startedThisMonth = trips.filter(t => inMonth(t.StartDate));
  const approvedThisMonth = advances.filter(a => a.Status === 'Approved' && inMonth(a.DecidedAt || a.CreatedAt));
  document.getElementById('dash-month-label').textContent = now.toLocaleString('en-IN', { month: 'long', year: 'numeric' });
  const row = (label, value) => `<div class="month-row"><span>${label}</span><b>${value}</b></div>`;
  document.getElementById('dash-month').innerHTML =
    row('Trips started', startedThisMonth.length) +
    row('Trips passed', passedThisMonth.length) +
    row('Expenses passed', rs(passedThisMonth.reduce((s2, t) => s2 + Number(t.VoucherTotal || 0), 0))) +
    row('Advances approved', rs(approvedThisMonth.reduce((s2, a) => s2 + Number(a.ApprovedAmount || 0), 0)));

  // ---- Doer balances ----
  const tbody = document.getElementById('tbl-dash-balances');
  const shown = balances.filter(b => b.Active === 'Y' || b.WithDoer !== 0 || b.ToCollect > 0 || b.OpenTrips > 0)
    .sort((x, y) => (y.WithDoer + y.ToCollect) - (x.WithDoer + x.ToCollect));
  tbody.innerHTML = shown.length ? shown.map(b => `
    <tr style="cursor:pointer;" onclick="goToTrips({doer:'${b.DoerCode}'})">
      <td>${b.DoerName}${b.Active === 'Y' ? '' : ' <span class="sub">(inactive)</span>'}</td>
      <td class="${b.Available < 0 ? 'amt-red' : ''}">${rs(b.Available)}</td>
      <td>${rs(b.OnActiveTrips)}</td>
      <td><b>${rs(b.WithDoer)}</b></td>
      <td>${b.ToCollect > 0 ? rs(b.ToCollect) : '—'}</td>
      <td>${b.OpenTrips}</td>
    </tr>`).join('')
    : '<tr><td colspan="6" class="empty">No Doers yet.</td></tr>';
}

/* ---------------- BADGES ---------------- */

function tripStatusBadgeClass(status) {
  if (status === 'Ongoing') return 'ongoing';
  if (status === 'Submitted') return 'pending';
  if (status === 'Passed') return 'pass';
  if (status === 'Rejected') return 'rejected';
  return '';
}

/* ---------------- TRIPS ---------------- */

/* ---------- shared filter helpers ---------- */

const rs = (n) => 'Rs. ' + Number(n || 0).toLocaleString('en-IN');
const fval = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

// "DD-MM-YYYY" (how dates are stored) -> "YYYY-MM-DD" (how date inputs
// report them), so the two compare correctly as plain strings.
function ddmmyyyyToIso(d) {
  if (!d) return '';
  const p = String(d).split('-');
  return p.length === 3 && p[2].length === 4 ? `${p[2]}-${p[1]}-${p[0]}` : '';
}

// Fills a Doer dropdown from the Doers list, keeping whatever was already
// selected (so a Refresh doesn't wipe the filter the person had set).
function fillDoerFilter(id) {
  const sel = document.getElementById(id);
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">All Doers</option>' +
    [...STATE.doers].sort((x, y) => x.DoerName.localeCompare(y.DoerName))
      .map(d => `<option value="${d.DoerCode}">${d.DoerName}</option>`).join('');
  sel.value = current;
}

function matchesSearch(q, fields) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some(f => String(f || '').toLowerCase().includes(needle));
}

function renderTrips() {
  fillDoerFilter('ft-doer');
  const q = fval('ft-search'), doer = fval('ft-doer'), from = fval('ft-from'), to = fval('ft-to');

  // Everything except status first, so the scorecards show counts for the
  // CURRENT search - e.g. "how many of Ravi's trips are Submitted".
  const base = STATE.trips.filter(t => {
    if (doer && t.DoerCode !== doer) return false;
    if (!matchesSearch(q, [t.TripCode, t.DoerName, t.DoerCode, t.LocationVisited, t.PurposeOfVisit])) return false;
    const start = ddmmyyyyToIso(t.StartDate);
    if (from && (!start || start < from)) return false;
    if (to && (!start || start > to)) return false;
    return true;
  });

  const counts = { Ongoing: 0, Submitted: 0, Passed: 0, Rejected: 0 };
  base.forEach(t => { if (counts[t.TripStatus] !== undefined) counts[t.TripStatus]++; });
  document.getElementById('metrics-trips').innerHTML = Object.entries(counts).map(([status, n]) => `
    <div class="metric ${STATE.tripStatusFilter === status ? 'active' : ''}" onclick="filterTripsByStatus('${status}')">
      <div class="mvalue">${n}</div><div class="mlabel">${status}</div>
    </div>
  `).join('');

  const filtered = STATE.tripStatusFilter ? base.filter(t => t.TripStatus === STATE.tripStatusFilter) : base;
  const anyFilter = q || doer || from || to || STATE.tripStatusFilter;
  const totalAdvance = filtered.reduce((sum, t) => sum + Number(t.AdvanceReceived || 0), 0);
  const totalSpent = filtered.reduce((sum, t) => sum + Number(t.VoucherTotal || 0), 0);
  document.getElementById('ft-summary').innerHTML =
    `<span>Showing <b>${filtered.length}</b> of ${STATE.trips.length} trips${STATE.tripStatusFilter ? ` &middot; status: <b>${STATE.tripStatusFilter}</b>` : ''}</span>` +
    `<span>Advance given: <b>${rs(totalAdvance)}</b> &middot; Expenses claimed: <b>${rs(totalSpent)}</b></span>`;

  const tbody = document.getElementById('tbl-trips-body');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty">${anyFilter ? 'No trips match these filters.' : 'No trips yet.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(t => `
    <tr onclick="openTripDetail('${t.TripCode}')" style="cursor:pointer;">
      <td class="mono">${t.TripCode}</td><td>${t.DoerName || t.DoerCode}</td><td>${t.LocationVisited || '—'}</td>
      <td>${t.StartDate || '—'}</td><td>${t.EndDate || '—'}</td><td>${rs(t.AdvanceReceived)}</td>
      <td>${rs(t.VoucherTotal)}</td><td>${settlementCell(t)}</td>
      <td><span class="badge ${tripStatusBadgeClass(t.TripStatus)}">${t.TripStatus}</span></td>
    </tr>`).join('');
}

function clearTripFilters() {
  ['ft-search', 'ft-doer', 'ft-from', 'ft-to'].forEach(id => { document.getElementById(id).value = ''; });
  STATE.tripStatusFilter = null;
  renderTrips();
}

function filterTripsByStatus(status) {
  STATE.tripStatusFilter = (STATE.tripStatusFilter === status) ? null : status; // click again to clear
  renderTrips();
}

async function openTripDetail(tripCode) {
  try {
    const res = await api('GET', `/api/trips/${tripCode}`);
    const t = res.trip;
    const totalVouchers = res.vouchers.reduce((sum, v) => sum + v.Amount, 0);
    const balance = totalVouchers - t.AdvanceReceived; // positive = owed TO the Doer, negative = owed BY the Doer
    CURRENT_TRIP_REMAINING = balance < 0 ? Math.abs(balance) : 0;
    document.getElementById('td-title').textContent = `${t.TripCode} — ${t.DoerName}`;
    document.getElementById('td-body').innerHTML = `
      <div class="grid2" style="margin-bottom:14px;">
        <div><label>Doer</label><div>${t.DoerName}</div></div>
        <div><label>Vertical</label><div>${t.Vertical || '—'}</div></div>
        <div><label>Location</label><div>${t.LocationVisited}</div></div>
        <div><label>Status</label><div><span class="badge ${tripStatusBadgeClass(t.TripStatus)}">${t.TripStatus}</span></div></div>
        <div><label>Start Date</label><div>${t.StartDate}</div></div>
        <div><label>End Date</label><div>${t.EndDate || '—'}</div></div>
        <div><label>Advance Received</label><div>Rs. ${t.AdvanceReceived.toLocaleString('en-IN')}</div></div>
        <div><label>Total Vouchers</label><div>Rs. ${totalVouchers.toLocaleString('en-IN')}</div></div>
      </div>
      <div class="field" style="background:var(--bg-2);border-radius:8px;padding:10px 14px;margin-bottom:14px;">
        <label style="margin-bottom:2px;">Settlement</label>
        <div style="font-weight:700;font-size:15px;color:${balance === 0 ? 'var(--text-1)' : (balance > 0 ? 'var(--amber-text)' : 'var(--red-text)')};">
          ${balance === 0 ? 'Fully settled - nothing owed either way' :
            balance > 0 ? `Company owes ${t.DoerName}: Rs. ${balance.toLocaleString('en-IN')} (reimbursement)` :
            `${t.DoerName} owes Company: Rs. ${Math.abs(balance).toLocaleString('en-IN')} (unspent advance to return)`}
        </div>
        ${t.TripStatus === 'Passed' && balance < 0 ? `<div style="margin-top:6px;font-size:12.5px;color:${t.AdvanceReturned === 'Y' ? 'var(--green-text)' : 'var(--amber-text)'};">
          ${t.AdvanceReturned === 'Y' ? '✓ Confirmed returned - no longer counted in their available balance' : '⚠ Not yet returned - still counted as available for their next trip'}
        </div>` : ''}
      </div>
      <div class="field"><label>Purpose of Visit</label><div>${t.PurposeOfVisit}</div></div>
      ${t.VoucherPdfDriveLink ? `<div class="field"><label>Saved Voucher PDF</label><div><a class="doc-link" href="${t.VoucherPdfDriveLink}" target="_blank">View Saved PDF</a></div></div>` : ''}
      ${t.ClosingRemarks ? `<div class="field"><label>Doer's Closing Remarks</label><div>${t.ClosingRemarks}</div></div>` : ''}
      ${t.ReceiptNotReceivedFor ? `<div class="field"><label>Missing Receipts</label><div style="color:var(--amber-text);">${t.ReceiptNotReceivedFor}</div></div>` : ''}
      ${t.TripStatus === 'Rejected' && t.RejectionRemark ? `<div class="field"><label>Rejection Remark</label><div style="color:var(--red-text);">${t.RejectionRemark}</div></div>` : ''}
      <div class="tablewrap" style="margin-top:10px;max-height:280px;">
        <table>
          <thead><tr><th>Voucher</th><th>Type</th><th>Description</th><th>Amount</th><th>Receipt</th></tr></thead>
          <tbody>${res.vouchers.map(v => `
            <tr>
              <td class="mono">${v.VoucherID}</td><td>${v.ExpenseType}</td><td>${v.Description || '—'}</td>
              <td>Rs. ${v.Amount.toLocaleString('en-IN')}</td>
              <td>${v.ReceiptPhotoURL ? `<a class="doc-link" href="${v.ReceiptPhotoURL}" target="_blank">View</a>` : (v.ReceiptAvailable === 'Y' ? 'Has bill' : (v.NoReceiptReason ? 'None: ' + v.NoReceiptReason : '—'))}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    `;
    const actions = document.getElementById('td-actions');
    const deleteBtn = `<button class="secondary" style="border-color:var(--red);color:var(--red-text);margin-right:auto;" onclick="submitDeleteTrip('${t.TripCode}')">Delete</button>`;
    const pdfBtn = `<button class="secondary" onclick="window.open('/api/trips/${t.TripCode}/pdf', '_blank')">Download PDF</button>`;
    // Close is offered in EVERY state, so Accounts can always back out
    // without having to Pass, Reject, or Reopen first.
    const closeBtn = `<button class="secondary" onclick="closeModal('modal-trip-detail')">Close</button>`;
    if (t.TripStatus === 'Submitted') {
      actions.innerHTML = deleteBtn + pdfBtn + closeBtn + `
        <button class="secondary" style="border-color:var(--red);color:var(--red-text);" onclick="closeModal('modal-trip-detail');openRejectTrip('${t.TripCode}')">Reject</button>
        <button onclick="submitPassTrip('${t.TripCode}')">Pass</button>`;
    } else if (t.TripStatus === 'Rejected') {
      actions.innerHTML = deleteBtn + pdfBtn + closeBtn + `<button onclick="submitReopenTrip('${t.TripCode}')">Reopen for Correction</button>`;
    } else {
      actions.innerHTML = deleteBtn + pdfBtn + closeBtn;
    }
    openModal('modal-trip-detail');
  } catch (err) { toast(err.message, true); }
}

async function submitPassTrip(tripCode) {
  if (CURRENT_TRIP_REMAINING > 0) {
    val_set('ar-tripcode', tripCode);
    document.getElementById('ar-message').textContent = `Did the Doer return the remaining Rs. ${CURRENT_TRIP_REMAINING.toLocaleString('en-IN')}?`;
    openModal('modal-advance-returned');
    return;
  }
  await passTripNow(tripCode, null);
}

async function submitPassWithReturn(returned) {
  const tripCode = val('ar-tripcode');
  closeModal('modal-advance-returned');
  await passTripNow(tripCode, returned);
}

async function passTripNow(tripCode, advanceReturned) {
  try {
    const body = advanceReturned === null ? {} : { advanceReturned };
    await api('POST', `/api/trips/${tripCode}/pass`, body);
    closeModal('modal-trip-detail');
    toast('Trip passed');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

function openRejectTrip(tripCode) {
  val_set('rt-code', tripCode);
  val_set('rt-remark', '');
  openModal('modal-reject-trip');
}

async function submitRejectTrip() {
  const tripCode = val('rt-code');
  const remark = val('rt-remark');
  if (!remark) { toast('A remark is required', true); return; }
  try {
    await api('POST', `/api/trips/${tripCode}/reject`, { remark });
    closeModal('modal-reject-trip');
    toast('Trip rejected — Doer has been notified');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

async function submitReopenTrip(tripCode) {
  try {
    await api('POST', `/api/trips/${tripCode}/reopen`, {});
    closeModal('modal-trip-detail');
    toast('Trip reopened for correction');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

async function submitDeleteTrip(tripCode) {
  if (!confirm(`Permanently delete ${tripCode} and all its vouchers? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/trips/${tripCode}`);
    closeModal('modal-trip-detail');
    toast('Trip deleted');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

/* ---------------- ADVANCE REQUESTS ---------------- */

function renderAdvances() {
  fillDoerFilter('fa-doer');
  const q = fval('fa-search'), status = fval('fa-status'), doer = fval('fa-doer');
  const filtered = STATE.advances.filter(a => {
    if (status && a.Status !== status) return false;
    if (doer && a.DoerCode !== doer) return false;
    return matchesSearch(q, [a.RequestID, a.DoerName, a.DoerCode, a.Purpose]);
  });
  // Pending requests always sit at the top, so nothing awaiting a decision
  // gets buried under older approved/rejected ones.
  filtered.sort((x, y) => (x.Status === 'Pending' ? 0 : 1) - (y.Status === 'Pending' ? 0 : 1));

  const totalReq = filtered.reduce((s2, a) => s2 + Number(a.RequestedAmount || 0), 0);
  const totalAppr = filtered.reduce((s2, a) => s2 + Number(a.ApprovedAmount || 0), 0);
  const pendingCount = STATE.advances.filter(a => a.Status === 'Pending').length;
  document.getElementById('fa-summary').innerHTML =
    `<span>Showing <b>${filtered.length}</b> of ${STATE.advances.length} requests${pendingCount ? ` &middot; <b>${pendingCount}</b> pending overall` : ''}</span>` +
    `<span>Requested: <b>${rs(totalReq)}</b> &middot; Approved: <b>${rs(totalAppr)}</b></span>`;

  const tbody = document.getElementById('tbl-advances-body');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">${STATE.advances.length ? 'No requests match these filters.' : 'No advance requests yet.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(a => `
    <tr>
      <td class="mono">${a.RequestID}</td><td>${a.CreatedAt || '—'}</td><td>${a.DoerName || a.DoerCode}</td><td>${a.Purpose || '—'}</td>
      <td>${rs(a.RequestedAmount)}</td>
      <td>${a.ApprovedAmount != null ? rs(a.ApprovedAmount) : '—'}</td>
      <td><span class="badge ${a.Status === 'Approved' ? 'pass' : a.Status === 'Rejected' ? 'rejected' : 'pending'}">${a.Status}</span></td>
      <td>
        ${a.Status === 'Pending' ? `<button class="small" onclick="openDecideAdvance('${a.RequestID}', ${a.RequestedAmount})">Decide</button>` : ''}
        <button class="small secondary" style="border-color:var(--red);color:var(--red-text);" onclick="submitDeleteAdvance('${a.RequestID}')">Delete</button>
      </td>
    </tr>`).join('');
}

function clearAdvanceFilters() {
  ['fa-search', 'fa-status', 'fa-doer'].forEach(id => { document.getElementById(id).value = ''; });
  renderAdvances();
}

async function submitDeleteAdvance(requestId) {
  if (!confirm(`Permanently delete advance request ${requestId}? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/advance-requests/${requestId}`);
    toast('Advance request deleted');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

function openDecideAdvance(requestId, requestedAmount) {
  val_set('da-id', requestId);
  document.getElementById('da-summary').textContent = `Requested amount: Rs. ${requestedAmount.toLocaleString('en-IN')}`;
  val_set('da-amount', requestedAmount);
  openModal('modal-decide-advance');
}

async function submitDecideAdvance(approved) {
  const requestId = val('da-id');
  const approvedAmount = val('da-amount');
  try {
    await api('POST', `/api/advance-requests/${requestId}/decide`, { approved, approvedAmount: approved ? approvedAmount : 0 });
    closeModal('modal-decide-advance');
    toast(approved ? 'Advance approved' : 'Advance rejected');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

/* ---------------- DOERS ---------------- */

function renderDoers() {
  const q = fval('fd-search'), active = fval('fd-active');
  const filtered = STATE.doers.filter(d => {
    if (active && d.Active !== active) return false;
    return matchesSearch(q, [d.DoerName, d.DoerCode, d.Email]);
  });
  const activeCount = STATE.doers.filter(d => d.Active === 'Y').length;
  document.getElementById('fd-summary').innerHTML =
    `<span>Showing <b>${filtered.length}</b> of ${STATE.doers.length} Doers &middot; <b>${activeCount}</b> active</span><span></span>`;

  const tbody = document.getElementById('tbl-doers-body');
  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">${STATE.doers.length ? 'No Doers match these filters.' : 'No Doers added yet.'}</td></tr>`;
    return;
  }
  tbody.innerHTML = filtered.map(d => `
    <tr>
      <td class="mono">${d.DoerCode}</td><td>${d.DoerName}</td><td>${d.Email || '—'}</td>
      <td><span class="badge ${d.Active === 'Y' ? 'active' : 'inactive'}">${d.Active === 'Y' ? 'Active' : 'Inactive'}</span></td>
      <td><button class="small secondary" onclick='openEditDoer(${JSON.stringify(d)})'>Edit</button></td>
    </tr>`).join('');
}

function clearDoerFilters() {
  ['fd-search', 'fd-active'].forEach(id => { document.getElementById(id).value = ''; });
  renderDoers();
}

async function submitNewDoer() {
  const doerName = val('nd-name');
  if (!doerName) { toast('Name is required', true); return; }
  try {
    await api('POST', '/api/doers', { doerName, email: val('nd-email') });
    closeModal('modal-new-doer'); clearModal('modal-new-doer');
    toast('Doer added');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

function openEditDoer(d) {
  val_set('ed-code', d.DoerCode);
  val_set('ed-name', d.DoerName);
  val_set('ed-email', d.Email || '');
  val_set('ed-active', d.Active);
  openModal('modal-edit-doer');
}

async function submitEditDoer() {
  const doerCode = val('ed-code');
  try {
    await api('PUT', `/api/doers/${doerCode}`, { doerName: val('ed-name'), email: val('ed-email'), active: val('ed-active') });
    closeModal('modal-edit-doer');
    toast('Doer updated');
    loadAll();
  } catch (err) { toast(err.message, true); }
}

/* ---------------- REPORTS ---------------- */

function onReportStartChange() {
  const start = val('rpt-start');
  if (!start) return;
  const startDate = new Date(start + 'T00:00:00');
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + 6);
  val_set('rpt-end', endDate.toISOString().slice(0, 10));
}

async function submitGenerateReport() {
  const start = val('rpt-start'), end = val('rpt-end');
  if (!start || !end) { toast('Pick both a start and end date', true); return; }
  if (end < start) { toast('End date cannot be before the start date', true); return; }

  const btn = document.getElementById('rpt-generate-btn');
  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Generating...';
  try {
    const res = await api('POST', '/api/reports/weekly', { start, end });
    document.getElementById('rpt-trip-count').textContent = res.tripCount;
    const driveLinkEl = document.getElementById('rpt-drive-link');
    if (res.driveLink) { driveLinkEl.href = res.driveLink; driveLinkEl.style.display = ''; }
    else { driveLinkEl.style.display = 'none'; }

    const tbody = document.getElementById('rpt-summary-body');
    if (!res.doerRows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No trips were passed in this week.</td></tr>';
    } else {
      const rows = res.doerRows.map(d => `
        <tr>
          <td>${d.doerName}</td><td>${d.trips}</td>
          <td>Rs. ${d.advanceDisbursed.toLocaleString('en-IN')}</td>
          <td>Rs. ${d.totalExpenses.toLocaleString('en-IN')}</td>
          <td>Rs. ${d.reimbursementPaid.toLocaleString('en-IN')}</td>
          <td>Rs. ${d.confirmedReturned.toLocaleString('en-IN')}</td>
          <td style="${d.stillOutstanding > 0 ? 'color:var(--amber-text);font-weight:700;' : ''}">Rs. ${d.stillOutstanding.toLocaleString('en-IN')}</td>
        </tr>`).join('');
      const t = res.totals;
      const totalsRow = `
        <tr style="font-weight:700;background:var(--bg-2);">
          <td>TOTAL</td><td>${t.trips}</td>
          <td>Rs. ${t.advanceDisbursed.toLocaleString('en-IN')}</td>
          <td>Rs. ${t.totalExpenses.toLocaleString('en-IN')}</td>
          <td>Rs. ${t.reimbursementPaid.toLocaleString('en-IN')}</td>
          <td>Rs. ${t.confirmedReturned.toLocaleString('en-IN')}</td>
          <td style="${t.stillOutstanding > 0 ? 'color:var(--amber-text);' : ''}">Rs. ${t.stillOutstanding.toLocaleString('en-IN')}</td>
        </tr>`;
      tbody.innerHTML = rows + totalsRow;
    }
    document.getElementById('rpt-results').style.display = '';
    toast(res.driveLink ? 'Report generated and saved to Drive' : 'Report generated (Drive save failed - check logs)');
  } catch (err) { toast(err.message, true); }
  btn.disabled = false; btn.textContent = originalText;
}

/* ---------------- SETTINGS ---------------- */

function renderSettings() {
  val_set('set-accounts-name', STATE.settings.ACCOUNTS_NAME || '');
  val_set('set-accounts-email', STATE.settings.ACCOUNTS_EMAIL || '');
}

async function submitSaveSettings() {
  try {
    await api('PUT', '/api/settings', {
      ACCOUNTS_NAME: val('set-accounts-name'),
      ACCOUNTS_EMAIL: val('set-accounts-email'),
      accountsPassword: val('set-accounts-password') || undefined
    });
    val_set('set-accounts-password', ''); // never leave a typed password sitting in the form after saving
    toast('Settings saved');
  } catch (err) { toast(err.message, true); }
}

/* ---------------- CC LIST FOR ADVANCE EMAILS ---------------- */

async function loadCcRecipients() {
  try {
    const res = await api('GET', '/api/advance-cc-recipients');
    STATE.ccRecipients = res.recipients;
    renderCcRecipients();
  } catch (err) { /* quiet - non-critical list */ }
}

function renderCcRecipients() {
  const list = STATE.ccRecipients || [];
  const tbody = document.getElementById('tbl-cc-recipients-body');
  if (!list.length) { tbody.innerHTML = '<tr><td colspan="3" class="empty">Nobody added yet.</td></tr>'; return; }
  tbody.innerHTML = list.map(r => `
    <tr>
      <td>${r.Name || '—'}</td><td>${r.Email}</td>
      <td><button class="small secondary" onclick="deleteCcRecipient(${r.Id})">Delete</button></td>
    </tr>`).join('');
}

async function submitAddCcRecipient() {
  const name = val('cc-name'), email = val('cc-email');
  if (!email) { toast('Email is required', true); return; }
  try {
    await api('POST', '/api/advance-cc-recipients', { name, email });
    val_set('cc-name', ''); val_set('cc-email', '');
    toast('Added');
    loadCcRecipients();
  } catch (err) { toast(err.message, true); }
}

async function deleteCcRecipient(id) {
  if (!confirm('Remove this person from the CC list?')) return;
  try {
    await api('DELETE', `/api/advance-cc-recipients/${id}`);
    loadCcRecipients();
  } catch (err) { toast(err.message, true); }
}
