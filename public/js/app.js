// State
let state = {
  rooms: [],
  bookings: [],
  systemInfo: null,
  activeScheduleView: 'table',
  filterDateMode: 'today',
  currentEmployee: null,
  pendingDeleteId: null
};

// Elements
const notice = document.getElementById('notice');
const kpiTotalRooms = document.getElementById('kpiTotalRooms');
const kpiFreeRooms = document.getElementById('kpiFreeRooms');
const kpiBusyRooms = document.getElementById('kpiBusyRooms');
const kpiTodayBookings = document.getElementById('kpiTodayBookings');
const roomsStatusGrid = document.getElementById('roomsStatusGrid');
const scheduleTableBody = document.getElementById('scheduleTableBody');
const filterRoomSelect = document.getElementById('filterRoomSelect');
const filterDateInput = document.getElementById('filterDateInput');
const currentDateDisplay = document.getElementById('currentDateDisplay');

// Modals
const bookingModal = document.getElementById('bookingModal');
const modalRoomSelect = document.getElementById('modalRoomSelect');
const modalBookingDate = document.getElementById('modalBookingDate');
const modalStartTime = document.getElementById('modalStartTime');
const modalEndTime = document.getElementById('modalEndTime');
const modalBookedBy = document.getElementById('modalBookedBy');
const modalDepartment = document.getElementById('modalDepartment');
const modalTitle = document.getElementById('modalTitle');
const modalNote = document.getElementById('modalNote');
const modalPin = document.getElementById('modalPin');
const modalBookingError = document.getElementById('modalBookingError');
const modalRoomInfo = document.getElementById('modalRoomInfo');
const modalRoomMeta = document.getElementById('modalRoomMeta');

const empModal = document.getElementById('empModal');
const empKeyword = document.getElementById('empKeyword');
const empError = document.getElementById('empError');
const userAvatar = document.getElementById('userAvatar');
const userProfileText = document.getElementById('userProfileText');
const authBtn = document.getElementById('authBtn');

const cancelModal = document.getElementById('cancelModal');
const cancelPin = document.getElementById('cancelPin');
const cancelError = document.getElementById('cancelError');
const cancelModalDetails = document.getElementById('cancelModalDetails');
const qrModal = document.getElementById('qrModal');

// Amenity Icons Map
const amenityMap = {
  smart_tv: '🖥️ Smart TV',
  projector: '📽️ โปรเจกเตอร์',
  mic: '🎙️ ไมค์ลอย',
  video_conf: '📹 Video Conf',
  whiteboard: '📝 ไวท์บอร์ด',
  wifi: '📶 Wi-Fi'
};

// Utilities
function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtDateThai(iso) {
  if (!iso) return '-';
  const parts = iso.slice(0, 10).split('-');
  if (parts.length < 3) return iso;
  const y = parseInt(parts[0], 10) + 543;
  const mList = ['', 'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  const m = mList[parseInt(parts[1], 10)] || parts[1];
  const d = parseInt(parts[2], 10);
  return `${d} ${m} ${y}`;
}

function fmtFullDateThai(date = new Date()) {
  const days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const months = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
  return `วัน${days[date.getDay()]}ที่ ${date.getDate()} ${months[date.getMonth()]} พ.ศ. ${date.getFullYear() + 543}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  return iso.slice(11, 16);
}

function esc(str = '') {
  return String(str).replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[s]));
}

function showNotice(msg, type = 'ok') {
  notice.innerHTML = msg;
  notice.className = `notice show ${type}`;
  notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (type === 'ok') {
    setTimeout(() => { notice.className = 'notice'; }, 5000);
  }
}

// App Initialization
async function initApp() {
  currentDateDisplay.textContent = fmtFullDateThai(new Date());

  const todayStr = getLocalDateString();
  const urlParams = new URLSearchParams(window.location.search);
  const paramDate = urlParams.get('date');
  const paramFilter = urlParams.get('filter');

  if (paramFilter === 'all') {
    filterDateInput.value = '';
    state.filterDateMode = 'all';
    document.getElementById('btnFilterToday')?.classList.remove('active');
    document.getElementById('btnFilterTomorrow')?.classList.remove('active');
    document.getElementById('btnFilterAll')?.classList.add('active');
  } else if (paramDate) {
    filterDateInput.value = paramDate;
    if (paramDate !== todayStr) {
      document.getElementById('btnFilterToday')?.classList.remove('active');
    }
  } else {
    filterDateInput.value = todayStr;
  }

  modalBookingDate.value = paramDate || todayStr;

  // Set default times (e.g. 13:00 - 14:00)
  const now = new Date();
  const nextHour = (now.getHours() + 1) % 24;
  modalStartTime.value = `${String(nextHour).padStart(2, '0')}:00`;
  modalEndTime.value = `${String((nextHour + 1) % 24).padStart(2, '0')}:00`;

  loadSavedEmployee();
  await loadSystemInfo();
  await loadRooms();
  await loadBookings();

  // Auto refresh every 10 seconds for real-time synchronization across devices
  setInterval(async () => {
    await loadRooms(false);
    await loadBookings(false);
  }, 10000);
}

// ----------------------------------------------------
// Employee Authentication
// ----------------------------------------------------
function loadSavedEmployee() {
  const saved = localStorage.getItem('company_employee');
  if (saved) {
    try {
      const emp = JSON.parse(saved);
      setEmployeeState(emp);
      return;
    } catch (e) {}
  }
  setEmployeeState(null);
}

function setEmployeeState(emp) {
  state.currentEmployee = emp;
  if (emp) {
    userAvatar.textContent = emp.name.charAt(0);
    userAvatar.style.background = 'var(--primary)';
    userAvatar.style.color = '#fff';
    userProfileText.innerHTML = `<b>${esc(emp.name)}</b> <span style="font-size:11px; color:var(--muted);">${esc(emp.department)}</span>`;
    authBtn.textContent = 'สลับผู้ใช้';

    modalBookedBy.value = emp.name;
    modalDepartment.value = emp.department;
  } else {
    userAvatar.textContent = '👤';
    userAvatar.style.background = 'var(--primary-light)';
    userAvatar.style.color = 'var(--primary)';
    userProfileText.textContent = 'ยังไม่ได้เข้าสู่ระบบ';
    authBtn.textContent = 'เข้าสู่ระบบ';

    modalBookedBy.value = '';
    modalDepartment.value = '';
  }
}

function openEmpLoginModal() {
  empKeyword.value = '';
  empError.style.display = 'none';
  empModal.classList.add('active');
  empKeyword.focus();
}

function closeEmpLoginModal() {
  empModal.classList.remove('active');
}

async function submitEmpLogin() {
  const keyword = empKeyword.value.trim();
  if (!keyword) {
    empError.textContent = 'กรุณากรอกรหัสพนักงาน หรือชื่อพนักงาน';
    empError.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/auth/employee-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword })
    });

    const data = await res.json();
    if (!res.ok) {
      empError.textContent = data.message || 'ไม่พบพนักงานในระบบ';
      empError.style.display = 'block';
      return;
    }

    localStorage.setItem('company_employee', JSON.stringify(data.employee));
    setEmployeeState(data.employee);
    closeEmpLoginModal();
    showNotice(`👋 เข้าสู่ระบบในชื่อ <b>${data.employee.name}</b> (${data.employee.department}) เรียบร้อยแล้ว`, 'ok');
  } catch (err) {
    empError.textContent = 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์';
    empError.style.display = 'block';
  }
}

// ----------------------------------------------------
// System Info & Dual QR (Wi-Fi + Public Internet)
// ----------------------------------------------------
async function loadSystemInfo() {
  try {
    const res = await fetch('/api/system/info');
    if (!res.ok) return;
    const data = await res.json();
    state.systemInfo = data;

    // Local Wi-Fi Info
    document.getElementById('qrImage').src = data.qrDataUrl;
    document.getElementById('qrUrlBox').textContent = data.networkUrl;

    // Public Internet Info (If Online Tunnel is running)
    const publicActiveEl = document.getElementById('qrPublicActive');
    const publicInactiveEl = document.getElementById('qrPublicInactive');
    if (data.publicUrl && data.publicQrDataUrl) {
      document.getElementById('qrPublicImage').src = data.publicQrDataUrl;
      document.getElementById('qrPublicUrlBox').textContent = data.publicUrl;
      if (publicActiveEl) publicActiveEl.style.display = 'block';
      if (publicInactiveEl) publicInactiveEl.style.display = 'none';
    } else {
      if (publicActiveEl) publicActiveEl.style.display = 'none';
      if (publicInactiveEl) publicInactiveEl.style.display = 'block';
    }

    if (data.orgName) {
      document.getElementById('orgSubtitle').textContent = data.orgName;
    }
  } catch (e) {}
}

function switchQrTab(tab) {
  const btnW = document.getElementById('tabQrWifi');
  const btnP = document.getElementById('tabQrPublic');
  const viewW = document.getElementById('qrWifiView');
  const viewP = document.getElementById('qrPublicView');

  if (tab === 'wifi') {
    btnW.className = 'filter-pill-btn active';
    btnP.className = 'filter-pill-btn';
    viewW.style.display = 'block';
    viewP.style.display = 'none';
  } else {
    btnP.className = 'filter-pill-btn active';
    btnW.className = 'filter-pill-btn';
    viewP.style.display = 'block';
    viewW.style.display = 'none';
  }
}

function copyPublicUrl() {
  if (state.systemInfo?.publicUrl) {
    navigator.clipboard.writeText(state.systemInfo.publicUrl).then(() => {
      alert('คัดลอกลิงก์เรียบร้อย: ' + state.systemInfo.publicUrl);
    }).catch(() => {
      prompt('คัดลอกลิงก์ด้านล่างนี้:', state.systemInfo.publicUrl);
    });
  }
}

function openQrModal() { 
  qrModal.classList.add('active'); 
  loadSystemInfo();
}
function closeQrModal() { qrModal.classList.remove('active'); }
document.getElementById('qrBtn').addEventListener('click', openQrModal);

// ----------------------------------------------------
// Rooms & KPI Dashboard
// ----------------------------------------------------
async function loadRooms(updateUI = true) {
  try {
    const res = await fetch('/api/rooms');
    const rooms = await res.json();
    state.rooms = rooms;

    if (updateUI) {
      updateKpis(rooms);
      renderRoomStatusCards(rooms);
      populateRoomDropdowns(rooms);
    }
  } catch (err) {
    console.error('Error loading rooms:', err);
  }
}

function updateKpis(rooms) {
  const total = rooms.length;
  const free = rooms.filter(r => !r.is_busy).length;
  const busy = total - free;

  kpiTotalRooms.textContent = total;
  kpiFreeRooms.textContent = free;
  kpiBusyRooms.textContent = busy;
}

function populateRoomDropdowns(rooms) {
  // Filter Dropdown
  const prevFilter = filterRoomSelect.value;
  filterRoomSelect.innerHTML = '<option value="">ทุกห้องประชุม</option>' +
    rooms.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  if (prevFilter) filterRoomSelect.value = prevFilter;

  // Modal Dropdown
  const prevModal = modalRoomSelect.value;
  modalRoomSelect.innerHTML = '<option value="">-- กรุณาเลือกห้องประชุม --</option>' +
    rooms.map(r => `<option value="${r.id}">${esc(r.name)} (${r.capacity} ท่าน)</option>`).join('');
  if (prevModal) modalRoomSelect.value = prevModal;
}

// Render Real-time Room Status Cards (ดูง่ายที่สุดในพริบตา)
function renderRoomStatusCards(rooms) {
  roomsStatusGrid.innerHTML = rooms.map(r => {
    const isBusy = r.is_busy;
    const cardClass = isBusy ? 'is-busy' : 'is-free';
    const badgeClass = isBusy ? 'badge-busy' : 'badge-free';
    const statusText = isBusy ? '🔴 กำลังประชุม' : '🟢 ว่างพร้อมใช้';

    let liveHtml = '';
    if (isBusy) {
      const b = r.current_booking;
      liveHtml = `
        <div class="room-live-box" style="border-left: 3px solid var(--danger);">
          <div style="font-weight:700; color:var(--danger); margin-bottom:2px;">${esc(b.title)}</div>
          <div style="font-size:12px; color:var(--muted);">ผู้จอง: <b>${esc(b.booked_by)}</b> • ถึง ${fmtTime(b.end_at)} น.</div>
        </div>
      `;
    } else {
      const nextTxt = r.next_booking 
        ? `มีคิวถัดไปเวลา ${fmtTime(r.next_booking.start_at)} น.` 
        : 'ว่างตลอดทั้งวัน';
      liveHtml = `
        <div class="room-live-box" style="border-left: 3px solid var(--success);">
          <div style="color:#059669; font-weight:700;">พร้อมให้เข้าใช้งานได้ทันที</div>
          <div style="font-size:12px; color:var(--muted);">${nextTxt}</div>
        </div>
      `;
    }

    const amenitiesList = (r.amenities || []).map(k => amenityMap[k] || k).slice(0, 3).join(' • ');

    return `
      <div class="room-card ${cardClass}">
        <div>
          <div class="room-card-head">
            <h4>${esc(r.name)}</h4>
            <span class="room-badge ${badgeClass}">${statusText}</span>
          </div>

          <div class="room-details">
            📍 ${esc(r.location || 'อาคารหลัก')} • 👥 รองรับ <b>${r.capacity}</b> ที่นั่ง
            ${amenitiesList ? `<div style="font-size:11px; margin-top:4px; opacity:0.85;">${amenitiesList}</div>` : ''}
          </div>

          ${liveHtml}
        </div>

        <button class="btn btn-secondary btn-sm" style="width:100%; font-weight:700;" onclick="quickBookRoom(${r.id})">
          ➕ จองห้องนี้
        </button>
      </div>
    `;
  }).join('');
}

// ----------------------------------------------------
// Bookings & Schedule Table
// ----------------------------------------------------
async function loadBookings(updateUI = true) {
  try {
    const params = new URLSearchParams();
    if (filterRoomSelect.value) params.set('room_id', filterRoomSelect.value);
    if (filterDateInput.value) params.set('date', filterDateInput.value);

    const res = await fetch(`/api/bookings?${params.toString()}`);
    const bookings = await res.json();
    state.bookings = bookings;

    // Today bookings count
    const todayStr = getLocalDateString();
    const todayCount = bookings.filter(b => b.start_at.startsWith(todayStr)).length;
    kpiTodayBookings.textContent = todayCount;

    if (updateUI) {
      renderScheduleTable(bookings);
      if (window.renderTimeline && state.activeScheduleView === 'timeline') {
        window.renderTimeline(state.rooms, bookings, filterDateInput.value);
      }
    }
  } catch (err) {
    console.error('Error loading bookings:', err);
  }
}

// Render Dashboard Schedule Table (เรียบง่าย สบายตา ชัดเจน)
function renderScheduleTable(bookings) {
  if (!bookings || bookings.length === 0) {
    scheduleTableBody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center; padding:50px 20px; color:var(--muted);">
          <div style="font-size:36px; margin-bottom:8px;">🗓️</div>
          <b>ไม่มีรายการจองตามเงื่อนไขที่เลือก</b>
          <p style="font-size:13px; margin-top:4px;">กดปุ่ม "+ จองห้องประชุมใหม่" ด้านบนเพื่อสร้างรายการ</p>
        </td>
      </tr>
    `;
    return;
  }

  scheduleTableBody.innerHTML = bookings.map(b => {
    const timeFormatted = `${fmtTime(b.start_at)} - ${fmtTime(b.end_at)} น.`;
    const dateFormatted = fmtDateThai(b.start_at);

    return `
      <tr>
        <td>
          <span class="time-badge">⏰ ${timeFormatted}</span>
        </td>
        <td>
          <b>${dateFormatted}</b>
        </td>
        <td>
          <span style="display:inline-flex; align-items:center; gap:6px; font-weight:700; color:${b.room_color || 'var(--primary)'};">
            <span style="width:8px; height:8px; border-radius:50%; background:${b.room_color || 'var(--primary)'};"></span>
            ${esc(b.room_name)}
          </span>
          <div style="font-size:11px; color:var(--muted);">${esc(b.room_location || '')}</div>
        </td>
        <td>
          <div style="font-weight:700; color:var(--dark);">${esc(b.title)}</div>
          ${b.note ? `<div style="font-size:12px; color:var(--muted);">💬 ${esc(b.note)}</div>` : ''}
        </td>
        <td>
          <b>${esc(b.booked_by)}</b>
          <div style="font-size:12px; color:var(--muted);">${esc(b.department || '-')}</div>
        </td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn btn-sm btn-secondary" style="margin-right:6px;" onclick="openEditBookingModal(${b.id})">
            ✏️ แก้ไข
          </button>
          <button class="btn btn-sm btn-secondary" style="color:var(--danger); border-color:#fecaca;" onclick="openCancelModal(${b.id}, '${esc(b.title)}', '${dateFormatted} ${timeFormatted}')">
            ยกเลิก
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Filter Quick Dates
function setFilterQuickDate(mode) {
  state.filterDateMode = mode;
  document.getElementById('btnFilterToday').className = `filter-pill-btn ${mode === 'today' ? 'active' : ''}`;
  document.getElementById('btnFilterTomorrow').className = `filter-pill-btn ${mode === 'tomorrow' ? 'active' : ''}`;
  document.getElementById('btnFilterAll').className = `filter-pill-btn ${mode === 'all' ? 'active' : ''}`;

  if (mode === 'today') {
    filterDateInput.value = getLocalDateString();
  } else if (mode === 'tomorrow') {
    const tmr = new Date();
    tmr.setDate(tmr.getDate() + 1);
    filterDateInput.value = getLocalDateString(tmr);
  } else if (mode === 'all') {
    filterDateInput.value = '';
  }
  loadBookings();
}

filterRoomSelect.addEventListener('change', () => loadBookings());
filterDateInput.addEventListener('change', () => {
  document.querySelectorAll('.filter-pill-btn').forEach(b => b.classList.remove('active'));
  loadBookings();
});

// View Switcher (Table vs Timeline)
function setScheduleView(view) {
  state.activeScheduleView = view;
  const tableEl = document.getElementById('scheduleTableView');
  const timeEl = document.getElementById('scheduleTimelineView');
  const btnT = document.getElementById('viewToggleTable');
  const btnL = document.getElementById('viewToggleTimeline');

  if (view === 'table') {
    tableEl.style.display = 'block';
    timeEl.style.display = 'none';
    btnT.style.background = 'var(--primary)';
    btnT.style.color = '#fff';
    btnT.style.borderColor = 'var(--primary)';
    btnL.style.background = 'var(--card)';
    btnL.style.color = 'var(--dark)';
    btnL.style.borderColor = 'var(--border)';
  } else {
    tableEl.style.display = 'none';
    timeEl.style.display = 'block';
    btnL.style.background = 'var(--primary)';
    btnL.style.color = '#fff';
    btnL.style.borderColor = 'var(--primary)';
    btnT.style.background = 'var(--card)';
    btnT.style.color = 'var(--dark)';
    btnT.style.borderColor = 'var(--border)';
    if (window.renderTimeline) {
      window.renderTimeline(state.rooms, state.bookings, filterDateInput.value);
    }
  }
}

// ----------------------------------------------------
// Booking Modal Logic (จองง่าย ไม่รกหน้าจอ)
// ----------------------------------------------------
function openBookingModal(defaultRoomId = null) {
  if (!state.currentEmployee) {
    openEmpLoginModal();
    showNotice('⚠️ กรุณายืนยันตัวตนพนักงานบริษัทก่อนเริ่มทำการจองห้องประชุม', 'error');
    return;
  }

  modalBookingError.style.display = 'none';
  if (defaultRoomId) {
    modalRoomSelect.value = defaultRoomId;
    handleModalRoomChange();
  }

  bookingModal.classList.add('active');
}

function closeBookingModal() {
  bookingModal.classList.remove('active');
}

function quickBookRoom(roomId) {
  openBookingModal(roomId);
}

function handleModalRoomChange() {
  const rId = Number(modalRoomSelect.value);
  const room = state.rooms.find(r => r.id === rId);
  if (!room) {
    modalRoomInfo.style.display = 'none';
    return;
  }
  modalRoomInfo.style.display = 'block';
  modalRoomMeta.innerHTML = `📍 <b>${esc(room.location || 'อาคารหลัก')}</b> • 👥 ความจุ <b>${room.capacity}</b> ที่นั่ง`;
}

async function handleBookingSubmit(e) {
  e.preventDefault();

  if (!state.currentEmployee) {
    openEmpLoginModal();
    return;
  }

  const roomId = Number(modalRoomSelect.value);
  const date = modalBookingDate.value;
  const startTime = modalStartTime.value;
  const endTime = modalEndTime.value;
  const bookedBy = modalBookedBy.value.trim();
  const department = modalDepartment.value.trim();
  const title = modalTitle.value.trim() || 'การประชุมทั่วไป';
  const note = modalNote.value.trim();
  const pin = modalPin.value.trim();

  if (!date || !startTime || !endTime) {
    modalBookingError.textContent = 'กรุณาระบุวันที่และเวลาให้ครบถ้วน';
    modalBookingError.style.display = 'block';
    return;
  }

  if (startTime >= endTime) {
    modalBookingError.textContent = '⛔ เวลาเริ่มต้องมาก่อนเวลาสิ้นสุดเสมอ';
    modalBookingError.style.display = 'block';
    return;
  }

  const payload = {
    room_id: roomId,
    emp_code: state.currentEmployee.emp_code,
    title,
    booked_by: bookedBy,
    department,
    start_at: `${date}T${startTime}:00`,
    end_at: `${date}T${endTime}:00`,
    note
  };

  const btn = document.getElementById('modalSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'กำลังบันทึก...';

  try {
    const res = await fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
      if (data.conflict) {
        modalBookingError.innerHTML = `
          ⛔ <b>ไม่สามารถจองซ้ำได้!</b> ห้องนี้ถูกจองแล้ว<br>
          ช่วงเวลา: <b>${data.conflict.time_range}</b> โดยคุณ ${esc(data.conflict.booked_by)}
        `;
      } else {
        modalBookingError.textContent = data.message || 'ไม่สามารถบันทึกได้';
      }
      modalBookingError.style.display = 'block';
      return;
    }

    closeBookingModal();
    showNotice(`✅ จองห้องประชุมสำเร็จเรียบร้อย! (รหัส PIN สำหรับยกเลิกคือ: <b>${data.pin}</b>)`, 'ok');

    modalTitle.value = '';
    modalNote.value = '';

    filterDateInput.value = date;
    filterRoomSelect.value = roomId;

    await loadRooms();
    await loadBookings();
  } catch (err) {
    modalBookingError.textContent = 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์';
    modalBookingError.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'ยืนยันการจองห้อง';
  }
}

// ----------------------------------------------------
// Cancel Booking Logic
// ----------------------------------------------------
function openCancelModal(id, title, time) {
  state.pendingDeleteId = id;
  cancelModalDetails.innerHTML = `ต้องการยกเลิกการจอง <b>"${title}"</b><br>ช่วงเวลา: <b>${time}</b>`;
  cancelPin.value = '';
  cancelError.style.display = 'none';
  cancelModal.classList.add('active');
  cancelPin.focus();
}

function closeCancelModal() {
  cancelModal.classList.remove('active');
  state.pendingDeleteId = null;
}

document.getElementById('confirmCancelBtn').addEventListener('click', async () => {
  const pin = cancelPin.value.trim();
  if (!pin) {
    cancelError.textContent = 'กรุณากรอกรหัส PIN ก่อนยกเลิก';
    cancelError.style.display = 'block';
    return;
  }

  try {
    const res = await fetch(`/api/bookings/${state.pendingDeleteId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });

    const data = await res.json();
    if (!res.ok) {
      cancelError.textContent = data.message || 'รหัส PIN ไม่ถูกต้อง';
      cancelError.style.display = 'block';
      return;
    }

    closeCancelModal();
    showNotice('ยกเลิกรายการจองเรียบร้อยแล้ว', 'ok');
    await loadRooms();
    await loadBookings();
  } catch (err) {
    cancelError.textContent = 'เกิดข้อผิดพลาดในการเชื่อมต่อ';
    cancelError.style.display = 'block';
  }
});

// ----------------------------------------------------
// Edit Booking Modal (แก้ไขข้อมูลการจอง)
// ----------------------------------------------------
const editBookingModal = document.getElementById('editBookingModal');
const editBookingId = document.getElementById('editBookingId');
const editBookingRoomSelect = document.getElementById('editBookingRoomSelect');
const editBookingDate = document.getElementById('editBookingDate');
const editBookingStartTime = document.getElementById('editBookingStartTime');
const editBookingEndTime = document.getElementById('editBookingEndTime');
const editBookingTitle = document.getElementById('editBookingTitle');
const editBookingBookedBy = document.getElementById('editBookingBookedBy');
const editBookingDepartment = document.getElementById('editBookingDepartment');
const editBookingNote = document.getElementById('editBookingNote');
const editBookingPin = document.getElementById('editBookingPin');
const editBookingError = document.getElementById('editBookingError');
const saveEditBookingBtn = document.getElementById('saveEditBookingBtn');

function openEditBookingModal(bookingId) {
  const b = state.bookings.find(item => item.id === bookingId);
  if (!b) return;

  editBookingId.value = b.id;
  
  // Populate rooms dropdown
  editBookingRoomSelect.innerHTML = state.rooms.map(r => 
    `<option value="${r.id}" ${r.id === b.room_id ? 'selected' : ''}>${esc(r.name)} (${r.capacity} ท่าน)</option>`
  ).join('');

  editBookingDate.value = b.start_at.slice(0, 10);
  editBookingStartTime.value = b.start_at.slice(11, 16);
  editBookingEndTime.value = b.end_at.slice(11, 16);
  editBookingTitle.value = b.title;
  editBookingBookedBy.value = b.booked_by;
  editBookingDepartment.value = b.department || '';
  editBookingNote.value = b.note || '';
  editBookingPin.value = '';
  editBookingError.style.display = 'none';

  editBookingModal.classList.add('active');
  editBookingPin.focus();
}

function closeEditBookingModal() {
  if (editBookingModal) {
    editBookingModal.classList.remove('active');
  }
}

async function saveEditBooking(e) {
  e.preventDefault();

  const id = editBookingId.value;
  const pin = editBookingPin.value.trim();
  if (!pin) {
    editBookingError.textContent = 'กรุณาระบุรหัส PIN 4 หลักของผู้จอง (หรือรหัส Admin) เพื่อยืนยัน';
    editBookingError.style.display = 'block';
    return;
  }

  const roomId = Number(editBookingRoomSelect.value);
  const date = editBookingDate.value;
  const startAt = `${date}T${editBookingStartTime.value}:00`;
  const endAt = `${date}T${editBookingEndTime.value}:00`;

  if (new Date(startAt) >= new Date(endAt)) {
    editBookingError.textContent = 'เวลาเริ่มต้องมาก่อนเวลาสิ้นสุดเสมอ';
    editBookingError.style.display = 'block';
    return;
  }

  const payload = {
    pin,
    room_id: roomId,
    title: editBookingTitle.value.trim(),
    booked_by: editBookingBookedBy.value.trim(),
    department: editBookingDepartment.value.trim(),
    note: editBookingNote.value.trim(),
    start_at: startAt,
    end_at: endAt
  };

  saveEditBookingBtn.disabled = true;
  saveEditBookingBtn.textContent = 'กำลังบันทึก...';
  editBookingError.style.display = 'none';

  try {
    const res = await fetch(`/api/bookings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      editBookingError.textContent = data.message || data.error || 'บันทึกข้อมูลไม่สำเร็จ';
      editBookingError.style.display = 'block';
      saveEditBookingBtn.disabled = false;
      saveEditBookingBtn.textContent = 'บันทึกการแก้ไข';
      return;
    }

    closeEditBookingModal();
    showNotice(`✅ ${data.message || 'บันทึกการแก้ไขเรียบร้อยแล้ว'}`, 'ok');
    await loadRooms();
    await loadBookings();
  } catch (err) {
    editBookingError.textContent = 'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์: ' + err.message;
    editBookingError.style.display = 'block';
  } finally {
    saveEditBookingBtn.disabled = false;
    saveEditBookingBtn.textContent = 'บันทึกการแก้ไข';
  }
}

// Theme Toggle
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');
themeToggle.addEventListener('click', () => {
  const isDark = document.body.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.body.removeAttribute('data-theme');
    themeIcon.textContent = '🌙';
    localStorage.setItem('theme', 'light');
  } else {
    document.body.setAttribute('data-theme', 'dark');
    themeIcon.textContent = '☀️';
    localStorage.setItem('theme', 'dark');
  }
});

if (localStorage.getItem('theme') === 'dark') {
  document.body.setAttribute('data-theme', 'dark');
  themeIcon.textContent = '☀️';
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeBookingModal();
    closeEditBookingModal();
    closeCancelModal();
    closeEmpLoginModal();
    closeQrModal();
  }
});

window.addEventListener('DOMContentLoaded', initApp);

