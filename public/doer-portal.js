let DOER_CODE = null;
let DOER_NAME = null;
let CURRENT_TRIP_CODE = null; // trip currently open in the detail modal

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

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

function showView(id) {
  ['view-pick-doer', 'view-my-trips', 'errorState'].forEach(v => {
    document.getElementById(v).style.display = (v === id) ? '' : 'none';
  });
}

/* ---------------- IDENTIFY YOURSELF (no password) ---------------- */

async function init() {
  const savedCode = localStorage.getItem('voucher-doer-code');
  if (savedCode) {
    const ok = await tryLoadDoer(savedCode);
    if (ok) return;
    localStorage.removeItem('voucher-doer-code'); // saved doer no longer valid - fall through to picker
  }
  await loadDoerDropdown();
  showView('view-pick-doer');
}

async function loadDoerDropdown() {
  try {
    const res = await api('GET', '/api/public/doers');
    const select = document.getElementById('pd-doer-select');
    if (!res.doers.length) {
      select.innerHTML = '<option value="">No Doers set up yet - contact Accounts</option>';
      return;
    }
    select.innerHTML = '<option value="">Select your name...</option>' +
      res.doers.map(d => `<option value="${d.DoerCode}">${d.DoerName}</option>`).join('');
  } catch (err) {
    document.getElementById('errorText').textContent = err.message;
    showView('errorState');
  }
}

async function pickDoer() {
  const code = val('pd-doer-select');
  if (!code) { toast('Please select your name', true); return; }
  const ok = await tryLoadDoer(code);
  if (ok) localStorage.setItem('voucher-doer-code', code);
}

async function tryLoadDoer(doerCode) {
  try {
    const res = await api('GET', `/api/public/doer/${doerCode}/context`);
    DOER_CODE = doerCode;
    DOER_NAME = res.doerName;
    document.getElementById('mt-greeting').textContent = `Hi, ${DOER_NAME}`;
    document.getElementById('mt-balance').textContent = 'Rs. ' + res.availableBalance.toLocaleString('en-IN');
    showView('view-my-trips');
    loadMyTrips();
    loadMyAdvances();
    return true;
  } catch (err) {
    return false;
  }
}

function switchDoer() {
  localStorage.removeItem('voucher-doer-code');
  DOER_CODE = null; DOER_NAME = null;
  loadDoerDropdown();
  showView('view-pick-doer');
}

/* ---------------- MY TRIPS ---------------- */

function tripStatusBadgeClass(status) {
  if (status === 'Ongoing') return 'ongoing';
  if (status === 'Submitted') return 'pending';
  if (status === 'Passed') return 'pass';
  if (status === 'Rejected') return 'rejected';
  return '';
}

async function loadMyTrips() {
  try {
    const res = await api('GET', `/api/public/doer/${DOER_CODE}/trips`);
    const tbody = document.getElementById('mt-trips-body');
    if (!res.trips.length) { tbody.innerHTML = '<tr><td colspan="4" class="empty">No trips yet. Click "+ Start Trip" to begin.</td></tr>'; return; }
    tbody.innerHTML = res.trips.map(t => `
      <tr onclick="openTripView('${t.TripCode}')" style="cursor:pointer;">
        <td class="mono">${t.TripCode}</td><td>${t.LocationVisited}</td><td>${t.StartDate}</td>
        <td><span class="badge ${tripStatusBadgeClass(t.TripStatus)}">${t.TripStatus}</span></td>
      </tr>`).join('');
  } catch (err) { toast(err.message, true); }
}

async function loadMyAdvances() {
  try {
    const res = await api('GET', `/api/public/doer/${DOER_CODE}/advance-requests`);
    const tbody = document.getElementById('mt-advances-body');
    if (!res.requests.length) { tbody.innerHTML = '<tr><td colspan="5" class="empty">No advance requests yet.</td></tr>'; return; }
    tbody.innerHTML = res.requests.map(a => `
      <tr>
        <td class="mono">${a.RequestID}</td><td>${a.Purpose || '—'}</td><td>Rs. ${a.RequestedAmount.toLocaleString('en-IN')}</td>
        <td>${a.ApprovedAmount != null ? 'Rs. ' + a.ApprovedAmount.toLocaleString('en-IN') : '—'}</td>
        <td><span class="badge ${a.Status === 'Approved' ? 'pass' : a.Status === 'Rejected' ? 'rejected' : 'pending'}">${a.Status}</span></td>
      </tr>`).join('');
  } catch (err) { toast(err.message, true); }
}

async function refreshBalance() {
  const res = await api('GET', `/api/public/doer/${DOER_CODE}/context`);
  document.getElementById('mt-balance').textContent = 'Rs. ' + res.availableBalance.toLocaleString('en-IN');
}

/* ---------------- START TRIP ---------------- */

function openStartTrip() {
  clearModal('modal-start-trip');
  val_set('st-useadvance', 'no');
  openModal('modal-start-trip');
}

async function submitStartTrip() {
  const locationVisited = val('st-location');
  const startDate = val('st-startdate');
  const purposeOfVisit = val('st-purpose');
  if (!locationVisited || !startDate || !purposeOfVisit) { toast('Location, start date, and purpose are all required', true); return; }
  try {
    await api('POST', `/api/public/doer/${DOER_CODE}/start-trip`, {
      initiatedBy: val('st-initiatedby'), vertical: val('st-vertical'), locationVisited, startDate, purposeOfVisit,
      useAdvance: val('st-useadvance') === 'yes'
    });
    closeModal('modal-start-trip');
    toast('Trip started');
    loadMyTrips(); refreshBalance();
  } catch (err) { toast(err.message, true); }
}

/* ---------------- REQUEST ADVANCE ---------------- */

function openRequestAdvance() {
  clearModal('modal-request-advance');
  openModal('modal-request-advance');
}

async function submitRequestAdvance() {
  const requestedAmount = val('ra-amount');
  if (!requestedAmount || Number(requestedAmount) <= 0) { toast('Enter a valid amount', true); return; }
  try {
    await api('POST', `/api/public/doer/${DOER_CODE}/advance-request`, { purpose: val('ra-purpose'), requestedAmount });
    closeModal('modal-request-advance');
    toast('Advance requested - Accounts will review it');
    loadMyAdvances();
  } catch (err) { toast(err.message, true); }
}

/* ---------------- TRIP DETAIL / VOUCHERS ---------------- */

async function openTripView(tripCode) {
  CURRENT_TRIP_CODE = tripCode;
  try {
    const res = await api('GET', `/api/public/doer/${DOER_CODE}/trip/${tripCode}`);
    renderTripView(res.trip, res.vouchers);
    openModal('modal-trip-view');
  } catch (err) { toast(err.message, true); }
}

function renderTripView(trip, vouchers) {
  const isOngoing = trip.TripStatus === 'Ongoing';
  const total = vouchers.reduce((sum, v) => sum + v.Amount, 0);

  document.getElementById('tv-title').textContent = `${trip.TripCode} — ${trip.LocationVisited}`;
  document.getElementById('tv-body').innerHTML = `
    <div class="grid2" style="margin-bottom:10px;">
      <div><label>Status</label><div><span class="badge ${tripStatusBadgeClass(trip.TripStatus)}">${trip.TripStatus}</span></div></div>
      <div><label>Advance Received</label><div>Rs. ${trip.AdvanceReceived.toLocaleString('en-IN')}</div></div>
      <div><label>Start Date</label><div>${trip.StartDate}</div></div>
      <div><label>End Date</label><div>${trip.EndDate || '—'}</div></div>
    </div>
    <div class="field"><label>Purpose</label><div>${trip.PurposeOfVisit}</div></div>
    ${trip.RejectionRemark ? `<div class="field"><label>Accounts' Remark</label><div style="color:var(--red-text);">${trip.RejectionRemark}</div></div>` : ''}
    <div style="font-size:12.5px;color:var(--text-3);margin-top:6px;">Total vouchers so far: Rs. ${total.toLocaleString('en-IN')}</div>
  `;

  const list = document.getElementById('tv-vouchers-list');
  if (!vouchers.length) {
    list.innerHTML = '<p class="sub">No vouchers added yet.</p>';
  } else {
    list.innerHTML = vouchers.map(v => `
      <div class="voucher-row">
        <div>
          <div style="font-weight:600;font-size:13.5px;">${v.ExpenseType} — Rs. ${v.Amount.toLocaleString('en-IN')}</div>
          <div style="font-size:12px;color:var(--text-3);">${v.Description || ''} ${v.DateTime ? '· ' + v.DateTime : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          ${v.ReceiptPhotoURL ? `<a class="doc-link" href="${v.ReceiptPhotoURL}" target="_blank">Receipt</a>` : `<span class="sub">No receipt</span>`}
          ${isOngoing ? `<button class="small secondary" onclick="deleteVoucher('${v.VoucherID}')">Delete</button>` : ''}
        </div>
      </div>`).join('');
  }

  document.getElementById('tv-add-voucher-btn').style.display = isOngoing ? '' : 'none';

  const actions = document.getElementById('tv-actions');
  if (isOngoing) {
    actions.innerHTML = `
      <button class="secondary" onclick="closeModal('modal-trip-view')">Close</button>
      <button onclick="openSubmitTrip()">Submit Trip</button>`;
  } else {
    actions.innerHTML = `<button class="secondary" onclick="closeModal('modal-trip-view')">Close</button>`;
  }
}

/* ---------------- ADD VOUCHER ---------------- */

function toggleNoReceiptFields() {
  const noReceipt = document.getElementById('av-noreceipt').checked;
  document.getElementById('av-receipt-field').style.display = noReceipt ? 'none' : '';
  document.getElementById('av-noreceipt-field').style.display = noReceipt ? '' : 'none';
}

function openAddVoucher() {
  clearModal('modal-add-voucher');
  document.getElementById('av-noreceipt').checked = false;
  toggleNoReceiptFields();
  val_set('av-date', new Date().toISOString().slice(0, 10));
  openModal('modal-add-voucher');
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]); // strip "data:image/jpeg;base64,"
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function submitAddVoucher() {
  const amount = val('av-amount');
  const noReceipt = document.getElementById('av-noreceipt').checked;
  if (!amount || Number(amount) <= 0) { toast('Enter a valid amount', true); return; }

  const btn = document.getElementById('av-save-btn');
  const originalText = btn.textContent;

  const payload = {
    dateTime: val('av-date'), expenseType: val('av-type'), description: val('av-description'), amount,
    receiptAvailable: !noReceipt, noReceiptReason: val('av-noreceipt-reason')
  };

  if (noReceipt) {
    if (!payload.noReceiptReason) { toast('A reason is required when no receipt is available', true); return; }
  } else {
    const file = document.getElementById('av-receipt-file').files[0];
    if (!file) { toast('A receipt photo is required (or check "No receipt available")', true); return; }
    btn.disabled = true; btn.textContent = 'Uploading photo...';
    payload.receiptPhotoBase64 = await fileToBase64(file);
    payload.receiptPhotoMimeType = file.type;
  }

  try {
    btn.disabled = true; btn.textContent = 'Saving...';
    await api('POST', `/api/public/doer/${DOER_CODE}/trip/${CURRENT_TRIP_CODE}/vouchers`, payload);
    closeModal('modal-add-voucher');
    toast('Voucher added');
    openTripView(CURRENT_TRIP_CODE); // refresh the trip view behind it
    loadMyTrips();
  } catch (err) {
    toast(err.message, true);
  }
  btn.disabled = false; btn.textContent = originalText;
}

async function deleteVoucher(voucherId) {
  if (!confirm('Delete this voucher?')) return;
  try {
    await api('DELETE', `/api/public/doer/${DOER_CODE}/trip/${CURRENT_TRIP_CODE}/vouchers/${voucherId}`);
    toast('Voucher deleted');
    openTripView(CURRENT_TRIP_CODE);
  } catch (err) { toast(err.message, true); }
}

/* ---------------- SUBMIT / CLOSE TRIP ---------------- */

function openSubmitTrip() {
  clearModal('modal-submit-trip');
  val_set('sb-enddate', new Date().toISOString().slice(0, 10));
  openModal('modal-submit-trip');
}

async function submitCloseTrip() {
  const endDate = val('sb-enddate');
  if (!endDate) { toast('End date is required', true); return; }
  try {
    await api('POST', `/api/public/doer/${DOER_CODE}/trip/${CURRENT_TRIP_CODE}/submit`, { endDate, closingRemarks: val('sb-remarks') });
    closeModal('modal-submit-trip');
    closeModal('modal-trip-view');
    toast('Trip submitted for Accounts review');
    loadMyTrips();
  } catch (err) { toast(err.message, true); }
}

document.addEventListener('DOMContentLoaded', init);
