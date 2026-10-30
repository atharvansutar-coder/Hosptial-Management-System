import express, { type Request, type Response } from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import multer from 'multer'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import { dataDirectory, database, dataTables, listDocuments, readDocument, writeDocument, type RowData } from './db'
import { clearSession, issueSession, login, registerPatient, requireAuth, userById } from './auth'
import { acceptWaitlistOffer, handleSlotRelease, patientLanguage, queueAppointmentUpdate, queueNotification } from './smart'

const app = express()
app.use((request, response, next) => {
  helmet({
    contentSecurityPolicy: {
      directives: {
        upgradeInsecureRequests: request.secure ? [] : null,
      },
    },
    crossOriginOpenerPolicy: request.secure ? undefined : false,
    hsts: request.secure ? undefined : false,
    originAgentCluster: request.secure ? undefined : false,
  })(request, response, next)
})
const medicalDocumentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const documentSchema = z.record(z.string(), z.unknown())
const medicalDocumentCategorySchema = z.enum([
  'Blood Test',
  'Urine Test',
  'X-ray',
  'MRI',
  'CT Scan',
  'ECG',
  'Ultrasound',
  'Prescription',
  'Other Medical Reports',
])
const medicalDocumentTypeByExtension = {
  pdf: { contentType: 'application/pdf', extension: 'pdf' },
  jpg: { contentType: 'image/jpeg', extension: 'jpg' },
  jpeg: { contentType: 'image/jpeg', extension: 'jpg' },
  png: { contentType: 'image/png', extension: 'png' },
} as const
const allowedHospitals = new Set(['central-city-hospital', 'riverside-general', 'northside-medical-center'])
const allowedDepartments = new Set(['General medicine', 'Pediatrics', 'Dental care', 'Diagnostics'])

function sniffMedicalDocumentType(buffer: Buffer) {
  if (buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'application/pdf'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  return null
}

app.use(cookieParser())
app.use(express.json({ limit: '1mb' }))
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false }))
const authenticationLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false })
const writeLimit = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false })
app.get('/api/health', (_request, response) => response.json({ ok: true }))

app.get('/api/public/tracking/:id', (request, response) => {
  const parsedId = idSchema.safeParse(String(request.params.id))
  const data = parsedId.success ? readDocument('tracking', parsedId.data) : null
  if (!parsedId.success || !data) {
    response.status(404).json({ exists: false })
    return
  }
  response.json({ exists: true, id: parsedId.data, data: publicTrackingProjection(data) })
})

app.get('/api/public/tracking', (request, response) => {
  const code = z.string().trim().min(1).max(16).parse(request.query.code).toUpperCase()
  const match = listDocuments('tracking').find(({ data }) => data.code === code)
  response.json({ docs: match ? [{ id: match.id, data: publicTrackingProjection(match.data) }] : [] })
})

app.get('/api/public/appointment-tracking/:id', (request, response) => {
  const parsedId = idSchema.safeParse(String(request.params.id))
  const data = parsedId.success ? readDocument('appointmentTracking', parsedId.data) : null
  if (!parsedId.success || !data) {
    response.status(404).json({ exists: false })
    return
  }
  const { appointmentId, hospitalId, department, status, requestedDate, assignedDate, assignedTime, doctorName, needsReschedule } = data
  response.json({
    exists: true,
    id: parsedId.data,
    data: { appointmentId, hospitalId, department, status, requestedDate, assignedDate, assignedTime, doctorName, needsReschedule },
  })
})

app.post('/api/auth/guest', authenticationLimit, (request, response) => {
  const parsed = z.object({}).strict().safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid guest session request.' })
    return
  }
  let user = null
  const cookie = request.cookies?.careflow_session
  if (cookie) {
    try {
      const claims = jwt.verify(cookie, process.env.JWT_SECRET!) as { uid?: string }
      const existing = claims.uid ? userById(claims.uid) : null
      if (existing?.isAnonymous) user = existing
    } catch {
      user = null
    }
  }
  if (!user) {
    const uid = randomUUID()
    database.prepare(`
      INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, createdAt)
      VALUES (?, NULL, NULL, 'patient', NULL, 1, ?)
    `).run(uid, new Date().toISOString())
    user = userById(uid)
  }
  issueSession(response, user!)
  response.json({ user })
})

app.get('/api/auth/me', (request, response) => {
  const token = request.cookies?.careflow_session
  if (!token) {
    response.json({ user: null })
    return
  }
  try {
    const claims = jwt.verify(token, process.env.JWT_SECRET!) as { uid?: string }
    const user = claims.uid ? userById(claims.uid) : null
    response.json({ user })
  } catch {
    response.json({ user: null })
  }
})

app.post('/api/auth/register', authenticationLimit, asyncRoute(async (request, response) => {
  const body = z.object({ email: z.string(), password: z.string(), uid: z.string().uuid().optional() }).parse(request.body)
  const user = await registerPatient(body.email, body.password, body.uid)
  issueSession(response, user)
  response.status(201).json({ user })
}))

app.post('/api/auth/login', authenticationLimit, asyncRoute(async (request, response) => {
  const body = z.object({ email: z.string(), password: z.string() }).parse(request.body)
  const user = await login(body.email, body.password)
  issueSession(response, user)
  response.json({ user })
}))

app.post('/api/auth/logout', (_request, response) => {
  clearSession(response)
  response.status(204).end()
})

app.post('/api/auth/link', authenticationLimit, requireAuth, asyncRoute(async (request, response) => {
  if (!request.user?.isAnonymous) {
    response.status(403).json({ error: 'Only a guest patient session can be linked.' })
    return
  }
  const body = z.object({ email: z.string(), password: z.string() }).parse(request.body)
  const user = await registerPatient(body.email, body.password, request.user.uid)
  issueSession(response, user)
  response.json({ user })
}))

app.post('/api/files', requireAuth, writeLimit, medicalDocumentUpload.single('file'), asyncRoute(async (request, response) => {
  const parsed = z.object({
    hospitalId: z.string().refine((value) => allowedHospitals.has(value)),
    patientId: idSchema,
    recordId: idSchema,
    category: medicalDocumentCategorySchema,
    description: z.string().trim().max(500).default(''),
  }).safeParse(request.body)
  if (!parsed.success || !request.file) {
    response.status(400).json({ error: 'Choose a supported medical document and provide its category and patient record details.' })
    return
  }
  const { hospitalId, patientId, recordId, category, description } = parsed.data
  if (!request.user || request.user.role === 'patient' || request.user.hospitalId !== hospitalId) {
    response.status(403).json({ error: 'This hospital is outside your access.' })
    return
  }
  const extension = request.file.originalname.toLowerCase().split('.').pop() ?? ''
  const expectedType = medicalDocumentTypeByExtension[extension as keyof typeof medicalDocumentTypeByExtension]
  const detectedContentType = sniffMedicalDocumentType(request.file.buffer)
  if (!expectedType || detectedContentType !== expectedType.contentType
    || (request.file.mimetype !== expectedType.contentType && request.file.mimetype !== 'application/octet-stream')) {
    response.status(400).json({ error: 'Only valid PDF, JPG, JPEG, or PNG files can be uploaded.' })
    return
  }
  const record = readDocument('records', recordId)
  if (!record || record.hospitalId !== hospitalId || record.patientId !== patientId) {
    response.status(404).json({ error: 'The patient record was not found at this hospital.' })
    return
  }
  if (request.user.role === 'doctor' && record.doctorId !== doctorIdForUser(request.user.uid, hospitalId)) {
    response.status(403).json({ error: 'You are not assigned to this patient record.' })
    return
  }
  if (latestRecordsConsent(patientId)?.granted === false) {
    response.status(403).json({ error: 'The patient has withdrawn consent for additional record attachments.' })
    return
  }
  const randomName = `${recordId}-${randomUUID()}.${expectedType.extension}`
  const relativePath = `records/${hospitalId}/${patientId}/${randomName}`
  const root = dataDirectory
  const absolutePath = resolve(root, relativePath)
  if (!absolutePath.startsWith(`${root}${sep}`)) {
    response.status(400).json({ error: 'Invalid medical document destination.' })
    return
  }
  await mkdir(resolve(root, 'records', hospitalId, patientId), { recursive: true })
  await writeFile(absolutePath, request.file.buffer, { flag: 'wx', mode: 0o600 })
  const originalName = request.file.originalname.split(/[\\/]/).pop()
  const entry = {
    id: randomUUID(),
    patientId,
    name: (originalName ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'medical-document',
    path: relativePath,
    contentType: expectedType.contentType,
    category,
    description,
    uploadedByUserId: request.user.uid,
    uploaderRole: request.user.role,
    uploadedAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
  }
  const files = Array.isArray(record.pdfFiles) ? record.pdfFiles : []
  writeDocument('records', recordId, { ...record, pdfFiles: [...files, entry], updatedAt: entry.uploadedAt })
  writeAudit(request.user, 'medical-document-upload', 'records', hospitalId)
  response.status(201).json(entry)
}))

app.get('/api/files', requireAuth, asyncRoute(async (request, response) => {
  const requestedPath = z.string().min(1).max(1024).parse(request.query.path)
  const parts = requestedPath.split('/')
  if (parts.length !== 4 || parts[0] !== 'records' || !/^[A-Za-z0-9_-]+\.(pdf|jpg|png)$/.test(parts[3])) {
    response.status(400).json({ error: 'Invalid medical document path.' })
    return
  }
  const [, hospitalId, patientId] = parts
  if (!request.user) {
    response.status(401).json({ error: 'Sign in is required.' })
    return
  }
  const matched = listDocuments('records').find(({ data }) =>
    data.hospitalId === hospitalId && data.patientId === patientId
      && Array.isArray(data.pdfFiles) && data.pdfFiles.some((file) => file && typeof file === 'object' && (file as RowData).path === requestedPath),
  )
  if (!matched || !canRead(request, 'records', matched.id, matched.data)) {
    response.status(403).json({ error: 'You do not have permission to access this medical document.' })
    return
  }
  const root = dataDirectory
  const absolutePath = resolve(root, requestedPath)
  if (!absolutePath.startsWith(`${root}${sep}`)) {
    response.status(400).json({ error: 'Invalid medical document path.' })
    return
  }
  const file = await readFile(absolutePath)
  const extension = parts[3].split('.').pop() as keyof typeof medicalDocumentTypeByExtension
  response.setHeader('Content-Type', medicalDocumentTypeByExtension[extension].contentType)
  response.setHeader('Content-Disposition', `inline; filename="${parts[3].replace(/["\\\r\n]/g, '_')}"`)
  response.send(file)
}))

app.post('/api/consents/withdraw', requireAuth, writeLimit, (request, response) => {
  if (request.user?.role !== 'patient') {
    response.status(403).json({ error: 'Only a patient can withdraw their records consent.' })
    return
  }
  const consent = {
    ownerUid: request.user.uid,
    hospitalId: null,
    consentType: 'records',
    granted: false,
    createdAt: new Date().toISOString(),
  }
  writeDocument('consents', randomUUID(), consent)
  writeAudit(request.user, 'consent-withdrawn', 'consents', '')
  response.json({ ok: true, withdrawnAt: consent.createdAt })
})

app.post('/api/waitlist/accept', requireAuth, writeLimit, (request, response) => {
  if (request.user?.role !== 'patient') {
    response.status(403).json({ error: 'Only the patient can accept this offer.' })
    return
  }
  const body = z.object({ appointmentId: idSchema }).safeParse(request.body)
  if (!body.success) {
    response.status(400).json({ error: 'Invalid appointment request.' })
    return
  }
  try {
    acceptWaitlistOffer(request.user.uid, body.data.appointmentId)
    const appointment = readDocument('appointments', body.data.appointmentId)
    writeAudit(request.user, 'waitlist-offer-accepted', 'appointments', String(appointment?.hospitalId ?? ''))
    response.json({ ok: true })
  } catch (reason) {
    sendError(response, reason)
  }
})

app.post('/api/appointments/:id/no-show', requireAuth, writeLimit, (request, response) => {
  const parsedId = idSchema.safeParse(String(request.params.id))
  if (!parsedId.success || !request.user || request.user.role === 'patient') {
    response.status(403).json({ error: 'Staff access is required to mark a no-show.' })
    return
  }
  const id = parsedId.data
  const current = readDocument('appointments', id)
  if (!current || current.hospitalId !== request.user.hospitalId) {
    response.status(404).json({ error: 'Appointment not found for your hospital.' })
    return
  }
  if (request.user.role === 'doctor' && current.doctorId !== doctorIdForUser(request.user.uid, request.user.hospitalId)) {
    response.status(403).json({ error: 'You are not assigned to this appointment.' })
    return
  }
  try {
    const commit = database.transaction(() => {
      const appointment = readDocument('appointments', id)
      if (!appointment || !['confirmed', 'rescheduled'].includes(String(appointment.status))) {
        throw Object.assign(new Error('This appointment is no longer eligible for a no-show update.'), { status: 409 })
      }
      const slotId = String(appointment.slotId ?? '')
      const slot = slotId ? readDocument('slots', slotId) : null
      if (slot && Number(slot.booked) > 0) {
        const released = { ...slot, booked: Number(slot.booked) - 1 }
        writeDocument('slots', slotId, released)
        handleSlotRelease(slotId, released, -1)
      }
      const next = { ...appointment, status: 'no_show', slotId: '' }
      writeDocument('appointments', id, next)
      const trackingId = String(appointment.trackingId ?? '')
      const tracking = readDocument('appointmentTracking', trackingId)
      if (tracking) writeDocument('appointmentTracking', trackingId, { ...tracking, status: 'no_show' })
      writeAudit(request.user, 'appointment-no-show', 'appointments', String(appointment.hospitalId))
    })
    commit()
    response.json({ ok: true })
  } catch (reason) {
    sendError(response, reason)
  }
})

app.post('/api/notifications', requireAuth, writeLimit, (request, response) => {
  const body = z.object({ appointmentId: idSchema, message: z.string().trim().min(1).max(1000) }).safeParse(request.body)
  if (!body.success) {
    response.status(400).json({ error: 'Provide an appointment and a message.' })
    return
  }
  const appointment = readDocument('appointments', body.data.appointmentId)
  if (!appointment || !request.user || !['admin', 'receptionist'].includes(request.user.role)
    || appointment.hospitalId !== request.user.hospitalId) {
    response.status(403).json({ error: 'You do not have permission to message this patient.' })
    return
  }
  const id = queueNotification(`staff-message-${body.data.appointmentId}-${randomUUID()}`, {
    hospitalId: appointment.hospitalId,
    appointmentId: body.data.appointmentId,
    type: 'staff-message',
    statusLabel: 'message',
    patientMobile: appointment.patientMobile,
    patientLanguage: patientLanguage(appointment.patientId),
    message: body.data.message,
  })
  writeAudit(request.user, 'notification-queued', 'notifications', String(appointment.hospitalId))
  response.status(201).json({ id, status: 'queued' })
})

app.post('/api/notifications/:id/handled', requireAuth, writeLimit, (request, response) => {
  const id = idSchema.safeParse(request.params.id)
  if (!id.success || !request.user || !['admin', 'receptionist'].includes(request.user.role)) {
    response.status(403).json({ error: 'You do not have permission to update this message.' })
    return
  }
  const notification = readDocument('notifications', id.data)
  if (!notification || notification.hospitalId !== request.user.hospitalId) {
    response.status(404).json({ error: 'Message not found for your hospital.' })
    return
  }
  writeDocument('notifications', id.data, { ...notification, status: 'handled', handledAt: new Date().toISOString() })
  writeAudit(request.user, 'notification-handled', 'notifications', String(notification.hospitalId))
  response.json({ ok: true })
})

app.post('/api/privacy-requests', requireAuth, writeLimit, (request, response) => {
  if (request.user?.role !== 'patient') {
    response.status(403).json({ error: 'Only a patient can request an export or erasure.' })
    return
  }
  const body = z.object({
    type: z.enum(['export', 'erase']),
    hospitalId: z.string().refine((value) => allowedHospitals.has(value)),
  }).safeParse(request.body)
  if (!body.success) {
    response.status(400).json({ error: 'Choose a valid hospital and request type.' })
    return
  }
  const hasData = ['patients', 'appointments', 'records', 'tickets'].some((table) =>
    listDocuments(table).some(({ id, data }) => data.hospitalId === body.data.hospitalId
      && (id === request.user?.uid || data.ownerUid === request.user?.uid || data.patientId === request.user?.uid
        || (Array.isArray(data.hospitalIds) && data.hospitalIds.includes(body.data.hospitalId)))),
  )
  if (!hasData) {
    response.status(404).json({ error: 'No patient data was found for this hospital.' })
    return
  }
  const id = randomUUID()
  const data = {
    ownerUid: request.user.uid,
    hospitalId: body.data.hospitalId,
    type: body.data.type,
    status: 'pending',
    requestedAt: new Date().toISOString(),
  }
  writeDocument('privacyRequests', id, data)
  writeAudit(request.user, 'privacy-request-created', 'privacyRequests', body.data.hospitalId)
  response.status(201).json({ id, ...data })
})

app.get('/api/privacy-requests', requireAuth, (request, response) => {
  if (request.user?.role !== 'admin') {
    response.status(403).json({ error: 'Administrator access is required.' })
    return
  }
  const requests = listDocuments('privacyRequests')
    .filter(({ data }) => data.hospitalId === request.user?.hospitalId && data.status === 'pending')
    .map(({ id, data }) => ({ id, type: data.type, status: data.status, requestedAt: data.requestedAt }))
  response.json({ requests })
})

app.post('/api/privacy-requests/:id/approve', requireAuth, writeLimit, asyncRoute(async (request, response) => {
  if (request.user?.role !== 'admin') {
    response.status(403).json({ error: 'Administrator access is required.' })
    return
  }
  const id = idSchema.parse(request.params.id)
  const requestData = readDocument('privacyRequests', id)
  if (!requestData || requestData.hospitalId !== request.user.hospitalId || requestData.status !== 'pending') {
    response.status(404).json({ error: 'This pending privacy request was not found.' })
    return
  }
  const uid = String(requestData.ownerUid)
  if (requestData.type === 'export') {
    const exportData = Object.fromEntries(['patients', 'appointments', 'records', 'tickets', 'patientDetails']
      .map((table) => [table, listDocuments(table).filter(({ id: docId, data }) =>
        (docId === uid || data.ownerUid === uid || data.patientId === uid)
          && (data.hospitalId === request.user?.hospitalId
            || (Array.isArray(data.hospitalIds) && data.hospitalIds.includes(request.user?.hospitalId))),
      ).map(({ id: docId, data }) => ({ id: docId, ...data }))]))
    writeDocument('privacyRequests', id, { ...requestData, status: 'approved', approvedAt: new Date().toISOString() })
    writeAudit(request.user, 'privacy-export-approved', 'privacyRequests', String(requestData.hospitalId))
    response.json({ ok: true, export: exportData })
    return
  }
  const filesToDelete: string[] = []
  for (const { id: recordId, data } of listDocuments('records')) {
    if (data.patientId !== uid && data.ownerUid !== uid) continue
    if (data.hospitalId !== request.user.hospitalId) continue
    if (Array.isArray(data.pdfFiles)) {
      for (const file of data.pdfFiles) {
        if (file && typeof file === 'object' && typeof (file as RowData).path === 'string') {
          filesToDelete.push(resolve(dataDirectory, (file as RowData).path as string))
        }
      }
    }
    database.prepare('DELETE FROM records WHERE id = ?').run(recordId)
  }
  for (const table of ['patients', 'appointments', 'tickets', 'patientDetails', 'tracking', 'appointmentTracking']) {
    for (const { id: docId, data } of listDocuments(table)) {
      if ((docId === uid || data.ownerUid === uid || data.patientId === uid)
        && (data.hospitalId === request.user.hospitalId
          || (Array.isArray(data.hospitalIds) && data.hospitalIds.includes(request.user.hospitalId)))) {
        database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(docId)
      }
    }
  }
  for (const file of filesToDelete) {
    if (file.startsWith(`${resolve(dataDirectory, 'records')}${sep}`)) await rm(file, { force: true })
  }
  const patientDirectory = resolve(dataDirectory, 'records', String(requestData.hospitalId), uid)
  if (patientDirectory.startsWith(`${resolve(dataDirectory, 'records')}${sep}`)) await rm(patientDirectory, { recursive: true, force: true })
  const remainingPatientData = ['appointments', 'records', 'tickets'].some((table) =>
    listDocuments(table).some(({ data }) => data.ownerUid === uid || data.patientId === uid),
  )
  if (!remainingPatientData) database.prepare('UPDATE users SET email = NULL, passwordHash = NULL, isAnonymous = 1 WHERE id = ?').run(uid)
  for (const { id: consentId, data } of listDocuments('consents')) {
    if (data.ownerUid === uid && data.hospitalId === request.user.hospitalId) {
      writeDocument('consents', consentId, { ...data, ownerUid: '' })
    }
  }
  writeDocument('privacyRequests', id, { ...requestData, ownerUid: '', status: 'approved', approvedAt: new Date().toISOString() })
  writeAudit(request.user, 'privacy-erasure-approved', 'privacyRequests', String(requestData.hospitalId))
  response.json({ ok: true })
}))

app.use('/api/data', requireAuth)
app.get('/api/data/:collection', (request, response) => {
  const table = validTable(request.params.collection, response)
  if (!table) return
  const filters = parseFilters(request.query.filters, response)
  if (!filters) return
  const docs = listDocuments(table)
    .filter(({ id, data }) => canRead(request, table, id, data))
    .filter(({ id, data }) => filters.every((filter) => matchesFilter(data, id, filter)))
    .slice(0, 500)
    .map(({ id, data }) => ({ id, data }))
  response.json({ docs })
})

app.get('/api/data/:collection/:id', (request, response) => {
  const table = validTable(request.params.collection, response)
  if (!table) return
  const id = idSchema.safeParse(request.params.id)
  if (!id.success) {
    response.status(400).json({ error: 'Invalid document ID.' })
    return
  }
  const data = readDocument(table, id.data)
  if (!data) {
    response.json({ exists: false })
    return
  }
  if (!canRead(request, table, id.data, data)) {
    response.status(403).json({ error: 'You do not have permission to access this record.' })
    return
  }
  response.json({ exists: true, id: id.data, data })
})

app.post('/api/transactions', requireAuth, writeLimit, (request, response) => {
  const parsed = z.object({
    operations: z.array(z.object({
      type: z.enum(['set', 'update']),
      collection: z.string(),
      id: idSchema,
      data: documentSchema,
      baseData: documentSchema.optional(),
      merge: z.boolean().optional(),
    })).min(1).max(100),
  }).safeParse(request.body)
  if (!parsed.success) {
    response.status(400).json({ error: 'Invalid transaction request.' })
    return
  }
  try {
    const commit = database.transaction(() => {
      const operations = parsed.data.operations.map((operation) => {
        if (!dataTables.has(operation.collection)) throw Object.assign(new Error('Unsupported collection.'), { status: 400 })
        const previous = readDocument(operation.collection, operation.id)
        if (operation.type === 'update' && !previous) throw Object.assign(new Error('The requested record no longer exists.'), { status: 404 })
        if (operation.baseData && previous && operation.collection === 'appointments'
          && operation.baseData.status !== previous.status) {
          throw Object.assign(new Error('This appointment was already changed. Refresh the request list.'), { status: 409 })
        }
        let next = operation.type === 'update' || operation.merge
          ? applyPatch(previous ?? {}, operation.data)
          : resolveValues(operation.data)
        if (operation.collection === 'slots' && previous && typeof operation.data.booked === 'number' && operation.baseData) {
          const bookingDelta = operation.data.booked - Number(operation.baseData.booked ?? 0)
          if (Math.abs(bookingDelta) > 1) throw Object.assign(new Error('Invalid slot booking update.'), { status: 400 })
          next = { ...next, booked: Number(previous.booked ?? 0) + bookingDelta }
          const capacity = Number(next.capacity ?? previous.capacity ?? 0)
          if (Number(next.booked) > capacity || Number(next.booked) < 0) {
            throw Object.assign(new Error('The selected slot is full or changed. Refresh and choose another.'), { status: 409 })
          }
        }
        if (previous && previous.hospitalId !== undefined && next.hospitalId !== previous.hospitalId) {
          throw Object.assign(new Error('Hospital assignment cannot be changed.'), { status: 403 })
        }
        if (operation.collection === 'slots' && previous
          && Number(previous.booked ?? 0) !== Number(next.booked ?? 0) && !operation.baseData) {
          throw Object.assign(new Error('Slot booking changes must be part of a transaction.'), { status: 403 })
        }
        if (!canWrite(request, operation.collection, operation.id, next, previous, parsed.data.operations)) {
          throw Object.assign(new Error('You do not have permission to update this record.'), { status: 403 })
        }
        validateDocument(operation.collection, next)
        return { ...operation, data: next, previous }
      })
      for (const operation of operations) {
        if (operation.collection === 'appointments' && ['confirmed', 'rescheduled'].includes(String(operation.data.status))) {
          const slotId = String(operation.data.slotId ?? '')
          const slot = operations.find((candidate) => candidate.collection === 'slots' && candidate.id === slotId)?.data
            ?? readDocument('slots', slotId)
          const doctorId = String(operation.data.doctorId ?? '')
          const doctor = operations.find((candidate) => candidate.collection === 'doctors' && candidate.id === doctorId)?.data
            ?? readDocument('doctors', doctorId)
          if (!slot || !doctor || slot.hospitalId !== operation.data.hospitalId || doctor.hospitalId !== operation.data.hospitalId
            || slot.doctorId !== doctorId || slot.date !== operation.data.assignedDate
            || doctor.status !== 'available' || Number(slot.booked) > Number(slot.capacity)) {
            throw Object.assign(new Error('The selected doctor or appointment slot is no longer available.'), { status: 409 })
          }
        }
        if (operation.collection === 'appointments' && operation.previous?.status === 'pending'
          && operation.data.status === 'confirmed' && !operation.data.slotId) {
          throw Object.assign(new Error('A confirmed appointment must reserve a slot.'), { status: 400 })
        }
        writeDocument(operation.collection, operation.id, operation.data)
        writeAudit(request.user, operation.type === 'set' ? 'create' : 'update', operation.collection, String(operation.data.hospitalId ?? ''))
        if (operation.collection === 'appointments' && !operation.previous && operation.data.recordsConsentAt) {
          const consentAt = new Date().toISOString()
          writeDocument('consents', randomUUID(), {
            ownerUid: operation.data.ownerUid,
            patientId: operation.data.patientId,
            hospitalId: operation.data.hospitalId,
            appointmentId: operation.id,
            consentType: 'records',
            granted: true,
            createdAt: consentAt,
          })
          writeAudit(request.user, 'consent-granted', 'consents', String(operation.data.hospitalId ?? ''))
        }
      }
      for (const operation of operations) {
        if (operation.collection === 'appointments' && operation.previous?.status !== operation.data.status) {
          queueAppointmentUpdate({ ...operation.data, id: operation.id })
        }
        if (operation.collection === 'slots' && operation.previous && operation.baseData
          && typeof operation.data.booked === 'number' && typeof operation.baseData.booked === 'number') {
          handleSlotRelease(operation.id, operation.data, operation.data.booked - operation.baseData.booked)
        }
      }
    })
    commit()
    response.json({ ok: true })
  } catch (reason) {
    sendError(response, reason)
  }
})

app.put('/api/data/:collection/:id', writeLimit, (request, response) => {
  const table = validTable(String(request.params.collection), response)
  if (!table) return
  const id = idSchema.safeParse(request.params.id)
  const body = z.object({ data: documentSchema, merge: z.boolean().optional() }).safeParse(request.body)
  if (!id.success || !body.success) {
    response.status(400).json({ error: 'Invalid document write.' })
    return
  }
  const previous = readDocument(table, id.data)
  const next = body.data.merge && previous
    ? applyPatch(previous, body.data.data)
    : resolveValues(body.data.data)
  if (!canWrite(request, table, id.data, next, previous)) {
    response.status(403).json({ error: 'You do not have permission to update this record.' })
    return
  }
  try {
    validateDocument(table, next)
    writeDocument(table, id.data, next, Boolean(body.data.merge))
    response.json({ ok: true })
  } catch (reason) {
    sendError(response, reason)
  }
})

function validTable(value: string, response: Response): string | null {
  if (!dataTables.has(value)) {
    response.status(404).json({ error: 'Collection not found.' })
    return null
  }
  return value
}

function publicTrackingProjection(data: RowData): RowData {
  return {
    code: data.code,
    hospitalId: data.hospitalId,
    department: data.department,
    status: data.status,
    createdAt: data.createdAt,
  }
}

type Filter = { field: string; op: string; value: unknown }
function parseFilters(value: unknown, response: Response): Filter[] | null {
  if (value === undefined) return []
  try {
    const raw = typeof value === 'string' ? JSON.parse(value) : value
    const parsed = z.array(z.object({ field: z.string().min(1).max(100), op: z.enum(['==', '>=', '<=', 'in', 'array-contains']), value: z.unknown() })).max(10).safeParse(raw)
    if (!parsed.success) throw new Error('Invalid query filters.')
    return parsed.data
  } catch {
    response.status(400).json({ error: 'Invalid query filters.' })
    return null
  }
}

function matchesFilter(data: RowData, id: string, filter: Filter) {
  const actual = filter.field === '__name__' ? id : data[filter.field]
  if (filter.op === '==') return actual === filter.value
  if (filter.op === 'in') return Array.isArray(filter.value) && filter.value.includes(actual)
  if (filter.op === 'array-contains') return Array.isArray(actual) && actual.includes(filter.value)
  if (filter.op === '>=') return typeof actual === 'string' && typeof filter.value === 'string' && actual >= filter.value
  return typeof actual === 'string' && typeof filter.value === 'string' && actual <= filter.value
}

function canRead(request: Request, table: string, id: string, data: RowData) {
  const user = request.user
  if (!user) return false
  if (user.role === 'patient') {
    if (table === 'patients') return id === user.uid && data.ownerUid === user.uid
    if (['appointments', 'records', 'tickets', 'patientDetails'].includes(table)) {
      return data.ownerUid === user.uid || data.patientId === user.uid
    }
    if (table === 'tracking' || table === 'appointmentTracking') return data.ownerUid === user.uid
    if (table === 'consents' || table === 'privacyRequests') return data.ownerUid === user.uid
    return false
  }
  if (table === 'auditLogs' || table === 'privacyRequests') {
    return user.role === 'admin' && data.hospitalId === user.hospitalId
  }
  if (table === 'consents') return data.hospitalId === user.hospitalId
  if (user.role === 'doctor') {
    if (table === 'doctors') return data.userId === user.uid && data.hospitalId === user.hospitalId
    if (['patients', 'patientDetails', 'tickets'].includes(table)) return belongsToHospital(data, user.hospitalId)
    if (table === 'appointments') return data.hospitalId === user.hospitalId && data.doctorId === doctorIdForUser(user.uid, user.hospitalId)
    if (table === 'records') return data.hospitalId === user.hospitalId
      && data.doctorId === doctorIdForUser(user.uid, user.hospitalId)
    return data.hospitalId === user.hospitalId && ['slots', 'tracking', 'appointmentTracking'].includes(table)
  }
  return belongsToHospital(data, user.hospitalId)
}

function canWrite(
  request: Request,
  table: string,
  id: string,
  next: RowData,
  previous: RowData | null,
  relatedOperations: Array<{ collection: string; id: string; data: RowData; baseData?: RowData }> = [],
) {
  const user = request.user
  if (!user) return false
  const hospitalId = next.hospitalId ?? previous?.hospitalId
  if (previous && previous.hospitalId !== undefined && next.hospitalId !== previous.hospitalId) return false
  if (user.role === 'patient') {
    if (table === 'patients') return id === user.uid && next.ownerUid === user.uid && (!previous || previous.ownerUid === user.uid)
    if (table === 'slots' && previous && Number(next.booked) === Number(previous.booked) - 1) {
      return relatedOperations.some((operation) => operation.collection === 'appointments'
        && operation.baseData?.ownerUid === user.uid && operation.baseData.slotId === id
        && operation.data.status === 'cancelled')
    }
    if (table === 'appointmentTracking' && previous) {
      const changedKeys = Object.keys(next).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
      return next.ownerUid === user.uid && previous.ownerUid === user.uid && next.status === 'cancelled'
        && changedKeys.every((key) => key === 'status')
    }
    if (['appointments', 'tickets', 'patientDetails', 'tracking', 'appointmentTracking'].includes(table)) {
      const owner = next.ownerUid ?? next.patientId
      if (owner !== user.uid || (previous && (previous.ownerUid ?? previous.patientId) !== user.uid)) return false
      if (previous && table === 'appointments') {
        const changedKeys = Object.keys(next).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
        if (!changedKeys.every((key) => ['status', 'patientAction', 'slotId', 'needsReschedule'].includes(key))) return false
        if (next.status !== previous.status && next.status !== 'cancelled') return false
        return next.status !== 'confirmed' && next.status !== 'completed' && next.status !== 'no_show'
      }
      return !previous
    }
    return false
  }
  const isPatientProfileForHospital = table === 'patients'
    && Array.isArray(next.hospitalIds) && next.hospitalIds.includes(user.hospitalId)
  if ((typeof hospitalId !== 'string' || user.hospitalId !== hospitalId) && !isPatientProfileForHospital) return false
  if (table === 'doctors') return ['receptionist', 'admin'].includes(user.role)
  if (table === 'slots') {
    if (!['receptionist', 'admin'].includes(user.role)) return false
    if (previous && JSON.stringify(previous.booked) !== JSON.stringify(next.booked)) {
      const changedKeys = Object.keys(next).filter((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
      const bookingDelta = Number(next.booked) - Number(previous.booked)
      const hasRelatedAppointment = relatedOperations.some((operation) => operation.collection === 'appointments'
        && (bookingDelta > 0
          ? operation.data.slotId === id && ['confirmed', 'rescheduled'].includes(String(operation.data.status))
          : operation.baseData?.slotId === id
            && (operation.data.status === 'cancelled'
              || ['confirmed', 'rescheduled'].includes(String(operation.data.status)))))
      if (Math.abs(bookingDelta) !== 1 || !hasRelatedAppointment
        || !changedKeys.every((key) => ['booked', 'lastBookedAppointmentId', 'lastReleasedAppointmentId'].includes(key))) return false
    }
    return true
  }
  if (table === 'records') {
    if (user.role === 'doctor') return next.doctorId === doctorIdForUser(user.uid, user.hospitalId)
    if (user.role === 'receptionist' || user.role === 'admin') {
      const old = previous ?? {}
      return Object.keys(next).every((key) => key === 'pdfFiles' || key === 'updatedAt' || JSON.stringify(old[key]) === JSON.stringify(next[key]))
    }
    return false
  }
  if (table === 'appointments') {
    if (user.role === 'receptionist' || user.role === 'admin') return true
    if (user.role !== 'doctor' || next.doctorId !== doctorIdForUser(user.uid, user.hospitalId)) return false
    const changedKeys = Object.keys(next).filter((key) => JSON.stringify(previous?.[key]) !== JSON.stringify(next[key]))
    return changedKeys.length > 0 && changedKeys.every((key) => ['status', 'recordId'].includes(key))
      && (next.status === 'completed' || next.recordId === previous?.recordId)
  }
  if (table === 'patients') return !previous || next.ownerUid === previous.ownerUid
  if (['patientDetails', 'tickets', 'tracking', 'appointmentTracking'].includes(table)) return true
  return ['admin'].includes(user.role) && ['notifications', 'consents'].includes(table)
}

function doctorIdForUser(uid: string, hospitalId: string | null) {
  if (!hospitalId) return ''
  const rows = database.prepare('SELECT id, data FROM doctors WHERE hospitalId = ?').all(hospitalId) as Array<{ id: string; data: string }>
  return rows.find((item) => (JSON.parse(item.data) as RowData).userId === uid)?.id ?? ''
}

function belongsToHospital(data: RowData, hospitalId: string | null) {
  return Boolean(hospitalId && (data.hospitalId === hospitalId
    || (Array.isArray(data.hospitalIds) && data.hospitalIds.includes(hospitalId))))
}

function latestRecordsConsent(ownerUid: string) {
  const consents = listDocuments('consents')
    .map(({ data }) => data)
    .filter((data) => (data.ownerUid === ownerUid || data.patientId === ownerUid) && data.consentType === 'records')
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  return consents[0]
}

function writeAudit(user: Request['user'], action: string, collectionName: string, hospitalId: string) {
  if (!user) return
  writeDocument('auditLogs', randomUUID(), {
    actorUid: user.uid,
    actorRole: user.role,
    action,
    collection: collectionName,
    hospitalId,
    createdAt: new Date().toISOString(),
  })
}

function validateDocument(table: string, data: RowData) {
  if (data.hospitalId !== undefined && (typeof data.hospitalId !== 'string' || !allowedHospitals.has(data.hospitalId))) {
    throw Object.assign(new Error('Invalid hospital assignment.'), { status: 400 })
  }
  if (data.department !== undefined && !allowedDepartments.has(data.department as string)) {
    throw Object.assign(new Error('Invalid department.'), { status: 400 })
  }
  if (table === 'appointments') {
    z.object({
      patientId: z.string().min(1).max(128),
      ownerUid: z.string().min(1).max(128),
      hospitalId: z.string().refine((value) => allowedHospitals.has(value)),
      department: z.string().refine((value) => allowedDepartments.has(value)),
      requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().min(1).max(500),
      urgent: z.boolean(),
      companions: z.number().int().min(0).max(20),
      status: z.enum(['pending', 'confirmed', 'rescheduled', 'declined', 'cancelled', 'completed', 'no_show']),
    }).passthrough().parse(data)
  } else if (table === 'slots') {
    z.object({
      hospitalId: z.string().refine((value) => allowedHospitals.has(value)),
      doctorId: z.string().min(1).max(128),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      capacity: z.number().int().min(1).max(500),
      booked: z.number().int().min(0),
    }).passthrough().parse(data)
  } else if (table === 'doctors') {
    z.object({
      hospitalId: z.string().refine((value) => allowedHospitals.has(value)),
      name: z.string().min(1).max(120),
      department: z.string().refine((value) => allowedDepartments.has(value)),
      status: z.enum(['available', 'late', 'on_leave', 'emergency_only']),
    }).passthrough().parse(data)
  }
}

function applyPatch(previous: RowData, patch: RowData): RowData {
  const output = { ...previous }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
      && (value as RowData).__careflowType === 'arrayUnion') {
      const oldItems = Array.isArray(previous[key]) ? previous[key] as unknown[] : []
      const items = ((value as { values: unknown[] }).values).map(resolveValues)
      output[key] = [...oldItems, ...items.filter((item) => !oldItems.some((old) => JSON.stringify(old) === JSON.stringify(item)))]
    } else {
      output[key] = resolveValues(value)
    }
  }
  return output
}

function resolveValues(value: unknown): any {
  if (Array.isArray(value)) return value.map(resolveValues)
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if (object.__careflowType === 'timestamp') return { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }
  if (object.__careflowType === 'arrayUnion') return { __careflowType: 'arrayUnion', values: object.values }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, resolveValues(child)]))
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: express.NextFunction) => {
    void handler(request, response).catch((reason: unknown) => {
      if (response.headersSent) return next(reason)
      sendError(response, reason)
    })
  }
}

function sendError(response: Response, reason: unknown) {
  const error = reason as { status?: number; message?: string }
  const status = error.status ?? (reason instanceof z.ZodError ? 400 : 500)
  response.status(status).json({
    error: status === 500 ? 'The local server could not complete the request.'
      : reason instanceof z.ZodError ? 'Invalid input. Check the provided fields.'
        : error.message ?? 'Invalid request.',
  })
}

app.use((error: unknown, _request: Request, response: Response, next: express.NextFunction) => {
  if (response.headersSent) return next(error)
  if (error instanceof multer.MulterError) {
    response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Medical documents must be no larger than 10 MB.' : 'Invalid medical document upload.' })
    return
  }
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: 'Invalid input. Check the provided fields.' })
    return
  }
  console.error('CareFlow API internal error:', error instanceof Error ? error.name : 'unknown error')
  response.status(500).json({ error: 'The local server could not complete the request.' })
})

const clientBuildDirectory = resolve(process.cwd(), 'dist')
app.use(express.static(clientBuildDirectory, { index: false, dotfiles: 'deny', fallthrough: true }))
app.get('/{*path}', (request, response, next) => {
  if (request.path.startsWith('/api/')) {
    next()
    return
  }
  response.sendFile(resolve(clientBuildDirectory, 'index.html'), (error) => {
    if (error) next(error)
  })
})

export default app
