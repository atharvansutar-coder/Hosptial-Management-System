import { createHash, randomUUID } from 'node:crypto'
import { database, listDocuments, readDocument, writeDocument, type RowData } from './db'

const hospitalNames: Record<string, string> = {
  'central-city-hospital': 'Central City Hospital',
  'riverside-general': 'Riverside General Hospital',
  'northside-medical-center': 'Northside Medical Center',
}

function stableId(key: string) {
  return `msg_${createHash('sha256').update(key).digest('hex')}`
}

export function patientLanguage(patientId: unknown) {
  const profile = typeof patientId === 'string' ? readDocument('patients', patientId) : null
  const language = String((profile?.details as RowData | undefined)?.preferredLanguage ?? '').toLowerCase()
  return language.includes('marathi') || language.includes('मराठी') || language === 'mr' ? 'mr'
    : language.includes('hindi') || language.includes('हिंदी') || language === 'hi' ? 'hi' : 'en'
}

function locale(language: string) {
  return language === 'mr' ? 'mr-IN' : language === 'hi' ? 'hi-IN' : 'en-IN'
}

function formatVisit(date: string, time: string, language: string) {
  const visit = new Date(`${date}T${time}:00`)
  return {
    date: new Intl.DateTimeFormat(locale(language), { day: 'numeric', month: 'short' }).format(visit),
    time: new Intl.DateTimeFormat(locale(language), { hour: 'numeric', minute: '2-digit' }).format(visit),
  }
}

function messageFor(
  type: 'confirmed' | 'rescheduled' | 'declined' | 'reminder-24h' | 'reminder-2h' | 'waitlist-offer',
  date: string,
  time: string,
  hospitalName: string,
  language: string,
) {
  const formatted = type === 'declined' ? { date: '', time: '' } : formatVisit(date, time, language)
  const when = `${formatted.date}, ${formatted.time}`
  if (language === 'hi') {
    if (type === 'declined') return `अस्पताल आपका अपॉइंटमेंट तय नहीं कर पाया। कृपया ${hospitalName} से संपर्क करें।`
    if (type === 'waitlist-offer') return `${hospitalName} में ${when} का समय उपलब्ध है। इसे 30 मिनट के भीतर स्वीकार करें।`
    if (type === 'reminder-24h') return `याद दिलाना: आपका अपॉइंटमेंट कल ${when} को ${hospitalName} में है।`
    if (type === 'reminder-2h') return `याद दिलाना: आपका अपॉइंटमेंट लगभग 2 घंटे में ${hospitalName} में है। समय: ${when}।`
    return `आपका अपॉइंटमेंट ${type === 'rescheduled' ? 'नए समय पर तय' : 'तय'} है: ${when}, ${hospitalName}।`
  }
  if (language === 'mr') {
    if (type === 'declined') return `${hospitalName} आपली भेट ठरवू शकले नाही. कृपया रुग्णालयाशी संपर्क साधा.`
    if (type === 'waitlist-offer') return `${hospitalName} येथे ${when} ची वेळ उपलब्ध आहे. ३० मिनिटांत स्वीकारा.`
    if (type === 'reminder-24h') return `आठवण: तुमची भेट उद्या ${when} वाजता ${hospitalName} येथे आहे.`
    if (type === 'reminder-2h') return `आठवण: तुमची भेट साधारण २ तासांत ${hospitalName} येथे आहे. वेळ: ${when}.`
    return `तुमची भेट ${type === 'rescheduled' ? 'नव्या वेळेनुसार' : 'निश्चित'} आहे: ${when}, ${hospitalName}.`
  }
  if (type === 'declined') return `The hospital could not schedule your request. Please contact ${hospitalName}.`
  if (type === 'waitlist-offer') return `A visit time is available at ${hospitalName} for ${when}. Accept it within 30 minutes.`
  if (type === 'reminder-24h') return `Reminder: Your appointment is tomorrow, ${when} at ${hospitalName}.`
  if (type === 'reminder-2h') return `Reminder: Your appointment is in about 2 hours at ${hospitalName}. Time: ${when}.`
  return `Your appointment is ${type === 'rescheduled' ? 'rescheduled' : 'confirmed'} for ${when} at ${hospitalName}.`
}

export function queueNotification(key: string, fields: RowData) {
  const id = stableId(key)
  if (readDocument('notifications', id)) return id
  writeDocument('notifications', id, {
    ...fields,
    status: 'queued',
    createdAt: new Date().toISOString(),
  })
  return id
}

export function queueAppointmentUpdate(appointment: RowData) {
  if (!['confirmed', 'rescheduled', 'declined'].includes(String(appointment.status))) return
  const language = patientLanguage(appointment.patientId)
  const type = appointment.status as 'confirmed' | 'rescheduled' | 'declined'
  const hospitalId = String(appointment.hospitalId ?? '')
  const assignedDate = String(appointment.assignedDate ?? appointment.requestedDate ?? '')
  const assignedTime = String(appointment.assignedTime ?? '')
  const message = messageFor(type, assignedDate, assignedTime, hospitalNames[hospitalId] ?? 'the hospital', language)
  queueNotification(`appointment-${appointment.id}-${type}-${assignedDate}-${assignedTime}`, {
    hospitalId,
    appointmentId: appointment.id,
    type: 'appointment-update',
    statusLabel: type,
    patientMobile: String(appointment.patientMobile ?? ''),
    patientLanguage: language,
    assignedDate,
    assignedTime,
    message,
  })
}

function currentConsent(ownerUid: string) {
  const rows = listDocuments('consents').map(({ data }) => data)
    .filter((data) => (data.ownerUid === ownerUid || data.patientId === ownerUid) && data.consentType === 'records')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return rows[0]
}

function offerReleasedSlot(slotId: string, slot: RowData) {
  const candidates = listDocuments('appointments')
    .filter(({ data }) => data.status === 'pending'
      && data.hospitalId === slot.hospitalId
      && data.requestedDate === slot.date
      && (!data.requestedDoctorId || data.requestedDoctorId === slot.doctorId)
      && !data.waitlistOfferSlotId
      && !data.waitlistOfferExpiredAt)
    .sort((a, b) => String(a.data.createdAt ?? '').localeCompare(String(b.data.createdAt ?? '')))
  const selected = candidates[0]
  if (!selected) return
  const doctor = readDocument('doctors', String(slot.doctorId))
  if (!doctor || doctor.status !== 'available') return
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
  const timestamp = { seconds: Math.floor(expiresAt.getTime() / 1000), nanoseconds: 0 }
  const tracking = readDocument('appointmentTracking', String(selected.data.trackingId ?? ''))
  const date = String(slot.date)
  const time = String(slot.startTime)
  const language = patientLanguage(selected.data.patientId)
  const hospitalId = String(slot.hospitalId)
  const message = messageFor('waitlist-offer', date, time, hospitalNames[hospitalId] ?? 'the hospital', language)
  writeDocument('appointments', selected.id, {
    ...selected.data,
    waitlistOfferSlotId: slotId,
    waitlistOfferExpiresAt: timestamp,
    waitlistOfferDate: date,
    waitlistOfferTime: time,
    waitlistOfferDoctorId: slot.doctorId,
  })
  if (tracking) {
    writeDocument('appointmentTracking', String(selected.data.trackingId), {
      ...tracking,
      waitlistOfferDate: date,
      waitlistOfferTime: time,
      waitlistOfferExpiresAt: timestamp,
    })
  }
  queueNotification(`waitlist-${selected.id}-${slotId}`, {
    hospitalId,
    appointmentId: selected.id,
    type: 'waitlist-offer',
    statusLabel: 'offer',
    patientMobile: String(selected.data.patientMobile ?? ''),
    patientLanguage: language,
    assignedDate: date,
    assignedTime: time,
    expiresAt: timestamp,
    message,
  })
}

export function runReminderAndFollowupSweep() {
  const now = Date.now()
  for (const { id, data } of listDocuments('appointments')) {
    if (!['confirmed', 'rescheduled'].includes(String(data.status))) continue
    const visit = new Date(`${String(data.assignedDate)}T${String(data.assignedTime)}:00`).getTime()
    const remaining = visit - now
    if (!Number.isFinite(visit) || remaining <= 0 || remaining > 24 * 60 * 60 * 1000) continue
    const stage = remaining <= 2 * 60 * 60 * 1000 ? 'reminder-2h' : 'reminder-24h'
    const hospitalId = String(data.hospitalId ?? '')
    const language = patientLanguage(data.patientId)
    const message = messageFor(stage, String(data.assignedDate), String(data.assignedTime), hospitalNames[hospitalId] ?? 'the hospital', language)
    queueNotification(`${stage}-${id}`, {
      hospitalId,
      appointmentId: id,
      type: stage,
      statusLabel: stage,
      patientMobile: String(data.patientMobile ?? ''),
      patientLanguage: language,
      assignedDate: data.assignedDate,
      assignedTime: data.assignedTime,
      message,
    })
  }
  expireWaitlistOffers(now)
  createFollowupRequests()
}

function expireWaitlistOffers(now: number) {
  for (const { id, data } of listDocuments('appointments')) {
    if (!data.waitlistOfferSlotId || !data.waitlistOfferExpiresAt) continue
    const value = data.waitlistOfferExpiresAt as { seconds?: number }
    if (typeof value.seconds !== 'number' || value.seconds * 1000 > now) continue
    const slot = readDocument('slots', String(data.waitlistOfferSlotId))
    const tracking = readDocument('appointmentTracking', String(data.trackingId ?? ''))
    const next: RowData = { ...data, waitlistOfferExpiredAt: new Date(now).toISOString() }
    delete next.waitlistOfferSlotId
    delete next.waitlistOfferExpiresAt
    delete next.waitlistOfferDate
    delete next.waitlistOfferTime
    delete next.waitlistOfferDoctorId
    writeDocument('appointments', id, next)
    if (tracking) {
      const projection = { ...tracking }
      delete projection.waitlistOfferDate
      delete projection.waitlistOfferTime
      delete projection.waitlistOfferExpiresAt
      writeDocument('appointmentTracking', String(data.trackingId), projection)
    }
    if (slot) offerReleasedSlot(String(data.waitlistOfferSlotId), slot)
  }
}

function createFollowupRequests() {
  const today = new Date().toISOString().slice(0, 10)
  for (const { id: recordId, data: record } of listDocuments('records')) {
    const followUpDate = String(record.followUpDate ?? '')
    const sourceAppointment = readDocument('appointments', String(record.appointmentId ?? ''))
    const ownerUid = String(sourceAppointment?.ownerUid ?? '')
    if (!followUpDate || followUpDate > today || !ownerUid || ownerUid !== record.patientId) continue
    if (currentConsent(ownerUid)?.granted === false) continue
    const appointmentId = `followup-${recordId}`
    if (readDocument('appointments', appointmentId)) continue
    const patient = readDocument('patients', ownerUid)
    if (!patient) continue
    const hospitalId = String(record.hospitalId ?? '')
    const trackingId = randomUUID()
    const patientMobile = String(patient.mobileNumber ?? (patient.details as RowData | undefined)?.mobileNumber ?? '')
    const appointment = {
      trackingId,
      patientId: ownerUid,
      ownerUid,
      createdBy: 'system',
      hospitalId,
      department: String(record.department ?? 'General medicine'),
      doctorId: '',
      slotId: '',
      requestedSlotId: '',
      requestedDoctorId: '',
      patientMobile,
      requestedDate: followUpDate,
      reason: 'Follow-up visit',
      urgent: false,
      companions: 0,
      status: 'pending',
      assignedDate: '',
      assignedTime: '',
      staffNote: '',
      needsReschedule: false,
      patientAction: 'none',
      recordId: '',
      createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
      consentAt: record.consentAt ?? null,
      recordsConsentAt: record.consentAt ?? null,
    }
    writeDocument('appointments', appointmentId, appointment)
    writeDocument('appointmentTracking', trackingId, {
      appointmentId,
      ownerUid,
      hospitalId,
      department: appointment.department,
      status: 'pending',
      requestedDate: followUpDate,
      assignedDate: '',
      assignedTime: '',
      doctorName: '',
      needsReschedule: false,
    })
    const language = patientLanguage(ownerUid)
    const hospitalName = hospitalNames[hospitalId] ?? 'the hospital'
    const message = language === 'hi'
      ? `आपकी देखभाल टीम ने फ़ॉलो-अप की सलाह दी है। समय तय करने के लिए ${hospitalName} से संपर्क करें।`
      : language === 'mr'
        ? `तुमच्या उपचार टीमने पुढील भेट सुचवली आहे. वेळ ठरवण्यासाठी ${hospitalName} शी संपर्क साधा.`
        : `Your care team recommends a follow-up visit. Contact ${hospitalName} to choose a time.`
    queueNotification(`follow-up-${appointmentId}`, {
      hospitalId,
      appointmentId,
      type: 'follow-up-request',
      statusLabel: 'follow-up',
      patientMobile,
      patientLanguage: language,
      assignedDate: followUpDate,
      assignedTime: '',
      message,
    })
  }
}

export function handleSlotRelease(slotId: string, data: RowData, bookedDelta: number) {
  if (bookedDelta < 0 && Number(data.booked) < Number(data.capacity)) offerReleasedSlot(slotId, data)
}

export function acceptWaitlistOffer(uid: string, appointmentId: string) {
  const appointment = readDocument('appointments', appointmentId)
  if (!appointment || appointment.ownerUid !== uid || appointment.status !== 'pending') {
    throw Object.assign(new Error('This waitlist offer is no longer available.'), { status: 404 })
  }
  const expiry = (appointment.waitlistOfferExpiresAt as { seconds?: number } | undefined)?.seconds
  if (!appointment.waitlistOfferSlotId || !expiry || expiry * 1000 <= Date.now()) {
    throw Object.assign(new Error('This waitlist offer has expired.'), { status: 409 })
  }
  const slotId = String(appointment.waitlistOfferSlotId)
  const slot = readDocument('slots', slotId)
  const doctor = slot ? readDocument('doctors', String(slot.doctorId)) : null
  if (!slot || !doctor || Number(slot.booked) >= Number(slot.capacity) || doctor.status !== 'available') {
    throw Object.assign(new Error('This appointment time is no longer available.'), { status: 409 })
  }
  const trackingId = String(appointment.trackingId ?? '')
  const tracking = readDocument('appointmentTracking', trackingId)
  if (!tracking) throw Object.assign(new Error('Appointment tracking is unavailable.'), { status: 409 })
  const commit = database.transaction(() => {
    const latestAppointment = readDocument('appointments', appointmentId)
    const latestSlot = readDocument('slots', slotId)
    if (!latestAppointment || !latestSlot || latestAppointment.ownerUid !== uid || latestAppointment.status !== 'pending'
      || Number(latestSlot.booked) >= Number(latestSlot.capacity)
      || ((latestAppointment.waitlistOfferExpiresAt as { seconds?: number } | undefined)?.seconds ?? 0) * 1000 <= Date.now()) {
      throw Object.assign(new Error('This appointment time is no longer available.'), { status: 409 })
    }
    const assignedDoctor = readDocument('doctors', String(latestSlot.doctorId))
    if (!assignedDoctor || assignedDoctor.status !== 'available') throw Object.assign(new Error('This doctor is no longer available.'), { status: 409 })
    writeDocument('slots', slotId, { ...latestSlot, booked: Number(latestSlot.booked) + 1 })
    const assigned: RowData = {
      ...latestAppointment,
      status: 'confirmed',
      doctorId: latestSlot.doctorId,
      slotId,
      assignedDate: latestSlot.date,
      assignedTime: latestSlot.startTime,
    }
    for (const key of ['waitlistOfferSlotId', 'waitlistOfferExpiresAt', 'waitlistOfferDate', 'waitlistOfferTime', 'waitlistOfferDoctorId']) {
      delete assigned[key]
    }
    writeDocument('appointments', appointmentId, assigned)
    writeDocument('appointmentTracking', trackingId, {
      ...tracking,
      status: 'confirmed',
      assignedDate: latestSlot.date,
      assignedTime: latestSlot.startTime,
      doctorName: assignedDoctor.name,
    })
    queueAppointmentUpdate(assigned)
  })
  commit()
}
