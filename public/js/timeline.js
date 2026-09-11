// Timeline Grid Rendering
window.renderTimeline = function (rooms, bookings, selectedDate) {
  const container = document.getElementById('timelineBody');
  if (!container) return;

  const startHour = 8;  // 08:00
  const endHour = 20;   // 20:00
  const totalMinutes = (endHour - startHour) * 60; // 720 mins

  // Filter only rooms to display
  const targetRooms = rooms.filter(r => r.is_active !== 0);

  if (targetRooms.length === 0) {
    container.innerHTML = '<div style="padding:40px; text-align:center; color:var(--muted);">ไม่มีห้องประชุมในระบบ</div>';
    return;
  }

  let html = '';

  targetRooms.forEach(room => {
    // Find bookings for this room on selected date
    const roomBookings = bookings.filter(b => b.room_id === room.id && b.status === 'confirmed');

    html += `
      <div class="timeline-row" data-room-id="${room.id}">
        <div class="timeline-room-label">
          <b>${esc(room.name)}</b>
          <span>👥 ${room.capacity} ที่นั่ง • ${esc(room.location || '')}</span>
        </div>
        <div class="timeline-slots">
    `;

    // Render 12 Hour click slots
    for (let h = startHour; h < endHour; h++) {
      const hStr = String(h).padStart(2, '0');
      const nextHStr = String(h + 1).padStart(2, '0');
      html += `
        <div class="timeline-slot-hour" 
             title="คลิกเพื่อจอง ${hStr}:00 - ${nextHStr}:00" 
             onclick="selectRoomForBooking(${room.id}, '${hStr}:00', '${nextHStr}:00')">
        </div>
      `;
    }

    // Render Booking Blocks
    roomBookings.forEach(b => {
      const bStartDate = new Date(b.start_at);
      const bEndDate = new Date(b.end_at);

      const bStartMins = bStartDate.getHours() * 60 + bStartDate.getMinutes();
      const bEndMins = bEndDate.getHours() * 60 + bEndDate.getMinutes();

      // Clamp between 08:00 (480 mins) and 20:00 (1200 mins)
      const clampedStart = Math.max(startHour * 60, bStartMins);
      const clampedEnd = Math.min(endHour * 60, bEndMins);

      if (clampedEnd > clampedStart) {
        const leftPercent = ((clampedStart - (startHour * 60)) / totalMinutes) * 100;
        const widthPercent = ((clampedEnd - clampedStart) / totalMinutes) * 100;

        const roomColor = room.color || '#ff6a00';
        const sTime = fmtTime(b.start_at);
        const eTime = fmtTime(b.end_at);

        html += `
          <div class="timeline-booking-block" 
               style="left: ${leftPercent}%; width: ${widthPercent}%; background: ${roomColor};"
               title="${esc(b.title)} (${sTime} - ${eTime}) โดย ${esc(b.booked_by)}"
               onclick="event.stopPropagation(); openCancelModal(${b.id}, '${esc(b.title)}', '${sTime}-${eTime}');">
            <span class="t-title">${esc(b.title)}</span>
            <span class="t-time">${sTime} - ${eTime} • ${esc(b.booked_by)}</span>
          </div>
        `;
      }
    });

    html += `
        </div>
      </div>
    `;
  });

  container.innerHTML = html;

  // Add Current Time Indicator if viewing Today
  const todayStr = getLocalDateString();
  if (selectedDate === todayStr) {
    renderCurrentTimeIndicator(container, startHour, totalMinutes);
  }
};

function renderCurrentTimeIndicator(container, startHour, totalMinutes) {
  const now = new Date();
  const curMins = now.getHours() * 60 + now.getMinutes();
  const timelineStartMins = startHour * 60;
  const timelineEndMins = 20 * 60;

  if (curMins >= timelineStartMins && curMins <= timelineEndMins) {
    const leftPercent = ((curMins - timelineStartMins) / totalMinutes) * 100;
    
    // We add the indicator across all rows
    const indicator = document.createElement('div');
    indicator.className = 'current-time-indicator';
    // Offset by the room-label width (160px)
    indicator.style.left = `calc(160px + (100% - 160px) * ${leftPercent / 100})`;
    container.appendChild(indicator);
  }
}
