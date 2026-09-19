let STATE = { trips: [], advances: [], doers: [], settings: {}, user: null };

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
    const [tripsRes, advRes, doersRes, setRes] = await Promise.all([
      api('GET', '/api/trips'), api('GET', '/api/advance-requests'), api('GET', '/api/doers'), api('GET', '/api/settings')
    ]);
    STATE.trips = tripsRes.trips;
    STATE.advances = advRes.requests;
    STATE.doers = doersRes.doers;
    STATE.settings = setRes.settings;
    renderTrips(); renderAdvances(); renderDoers(); renderSettings();
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

const PAGE_TITLES = { trips: 'Trips', advances: 'Advance Requests', doers: 'Doers', settings: 'Settings' };
function showPage(page) {
  document.querySelectorAll('.side-item[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page === page));
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page];
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

function renderTrips() {
  const counts = { Ongoing: 0, Submitted: 0, Passed: 0, Rejected: 0 };
  STATE.trips.forEach(t => { if (counts[t.TripStatus] !== undefined) counts[t.TripStatus]++; });
  document.getElementById('metrics-trips').innerHTML = Object.entries(counts).map(([status, n]) => `
    <div class="metric"><div class="mvalue">${n}</div><div class="mlabel">${status}</div></div>
  `).join('');

  const tbody = document.getElementById('tbl-trips-body');
  if (!STATE.trips.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No trips yet.</td></tr>'; return; }
  tbody.innerHTML = STATE.trips.map(t => `
    <tr onclick="openTripDetail('${t.TripCode}')" style="cursor:pointer;">
      <td class="mono">${t.TripCode}</td><td>${t.DoerName || t.DoerCode}</td><td>${t.LocationVisited || '—'}</td>
      <td>${t.StartDate || '—'}</td><td>${t.EndDate || '—'}</td><td>Rs. ${t.AdvanceReceived.toLocaleString('en-IN')}</td>
      <td><span class="badge ${tripStatusBadgeClass(t.TripStatus)}">${t.TripStatus}</span></td>
    </tr>`).join('');
}

async function openTripDetail(tripCode) {
  try {
    const res = await api('GET', `/api/trips/${tripCode}`);
    const t = res.trip;
    const totalVouchers = res.vouchers.reduce((sum, v) => sum + v.Amount, 0);
    const balance = totalVouchers - t.AdvanceReceived; // positive = owed TO the Doer, negative = owed BY the Doer
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
      </div>
      <div class="field"><label>Purpose of Visit</label><div>${t.PurposeOfVisit}</div></div>
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
              <td>${v.ReceiptPhotoURL ? `<a class="doc-link" href="${v.ReceiptPhotoURL}" target="_blank">View</a>` : (v.NoReceiptReason ? 'None: ' + v.NoReceiptReason : '—')}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>
    `;
    const actions = document.getElementById('td-actions');
    if (t.TripStatus === 'Submitted') {
      actions.innerHTML = `
        <button class="secondary" style="border-color:var(--red);color:var(--red-text);" onclick="closeModal('modal-trip-detail');openRejectTrip('${t.TripCode}')">Reject</button>
        <button onclick="submitPassTrip('${t.TripCode}')">Pass</button>`;
    } else if (t.TripStatus === 'Rejected') {
      actions.innerHTML = `<button onclick="submitReopenTrip('${t.TripCode}')">Reopen for Correction</button>`;
    } else {
      actions.innerHTML = `<button class="secondary" onclick="closeModal('modal-trip-detail')">Close</button>`;
    }
    openModal('modal-trip-detail');
  } catch (err) { toast(err.message, true); }
}

async function submitPassTrip(tripCode) {
  try {
    await api('POST', `/api/trips/${tripCode}/pass`, {});
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

/* ---------------- ADVANCE REQUESTS ---------------- */

function renderAdvances() {
  const tbody = document.getElementById('tbl-advances-body');
  if (!STATE.advances.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty">No advance requests yet.</td></tr>'; return; }
  tbody.innerHTML = STATE.advances.map(a => `
    <tr>
      <td class="mono">${a.RequestID}</td><td>${a.DoerName || a.DoerCode}</td><td>${a.Purpose || '—'}</td>
      <td>Rs. ${a.RequestedAmount.toLocaleString('en-IN')}</td>
      <td>${a.ApprovedAmount != null ? 'Rs. ' + a.ApprovedAmount.toLocaleString('en-IN') : '—'}</td>
      <td><span class="badge ${a.Status === 'Approved' ? 'pass' : a.Status === 'Rejected' ? 'rejected' : 'pending'}">${a.Status}</span></td>
      <td>${a.Status === 'Pending' ? `<button class="small" onclick="openDecideAdvance('${a.RequestID}', ${a.RequestedAmount})">Decide</button>` : ''}</td>
    </tr>`).join('');
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
  const tbody = document.getElementById('tbl-doers-body');
  if (!STATE.doers.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No Doers added yet.</td></tr>'; return; }
  tbody.innerHTML = STATE.doers.map(d => `
    <tr>
      <td class="mono">${d.DoerCode}</td><td>${d.DoerName}</td><td>${d.Email || '—'}</td>
      <td><span class="badge ${d.Active === 'Y' ? 'active' : 'inactive'}">${d.Active === 'Y' ? 'Active' : 'Inactive'}</span></td>
      <td><button class="small secondary" onclick='openEditDoer(${JSON.stringify(d)})'>Edit</button></td>
    </tr>`).join('');
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

/* ---------------- SETTINGS ---------------- */

function renderSettings() {
  val_set('set-accounts-name', STATE.settings.ACCOUNTS_NAME || '');
  val_set('set-accounts-email', STATE.settings.ACCOUNTS_EMAIL || '');
}

async function submitSaveSettings() {
  try {
    await api('PUT', '/api/settings', {
      ACCOUNTS_NAME: val('set-accounts-name'),
      ACCOUNTS_EMAIL: val('set-accounts-email')
    });
    toast('Settings saved');
  } catch (err) { toast(err.message, true); }
}
