import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import supertest from 'supertest'
import bcrypt from 'bcrypt'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.JWT_SECRET = 'vitest-only-secret-do-not-use-outside-tests-123456'
const testDataDirectory = await mkdtemp(join(tmpdir(), 'careflow-vitest-'))
process.env.DATA_DIR = testDataDirectory
process.env.SQLITE_PATH = join(testDataDirectory, 'careflow.db')

const [{ default: app }, { database, writeDocument, listDocuments }, { queueAppointmentUpdate, runReminderAndFollowupSweep }] = await Promise.all([
  import('../app'),
  import('../db'),
  import('../smart'),
])

const password = 'Test-passphrase-2026'

async function addStaff(email: string, role: 'admin' | 'receptionist', hospitalId: string) {
  const uid = randomUUID()
  database.prepare(`
    INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, active, createdAt)
    VALUES (?, ?, ?, ?, ?, 0, 1, ?)
  `).run(uid, email, await bcrypt.hash(password, 4), role, hospitalId, new Date().toISOString())
  const agent = supertest.agent(app)
  const response = await agent.post('/api/auth/login').send({ email, password })
  expect(response.status).toBe(200)
  return agent
}

function makeAppointment(ownerUid: string, hospitalId: string, status = 'pending') {
  return {
    trackingId: randomUUID(),
    patientId: ownerUid,
    ownerUid,
    hospitalId,
    department: 'General medicine',
    doctorId: '',
    slotId: '',
    requestedSlotId: '',
    requestedDoctorId: '',
    patientMobile: '+919900000000',
    requestedDate: '2026-11-15',
    reason: 'Follow-up',
    urgent: false,
    companions: 0,
    status,
    assignedDate: '',
    assignedTime: '',
    staffNote: '',
    needsReschedule: false,
    patientAction: 'none',
    recordId: '',
    createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    consentAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
    recordsConsentAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 },
  }
}

let hospitalTestAdmin: Awaited<ReturnType<typeof addStaff>> | null = null
let northHospitalTestAdmin: Awaited<ReturnType<typeof addStaff>> | null = null

describe('local CareFlow API', () => {
  beforeAll(() => {
    database.pragma('foreign_keys = ON')
  })

  it('does not request HTTPS asset upgrades when served over HTTP', async () => {
    const response = await supertest(app).get('/api/health')
    expect(response.status).toBe(200)
    expect(response.headers['content-security-policy']).not.toContain('upgrade-insecure-requests')
    expect(response.headers['content-security-policy']).toContain("default-src 'self'")
    expect(response.headers['cross-origin-opener-policy']).toBeUndefined()
    expect(response.headers['origin-agent-cluster']).toBeUndefined()
    expect(response.headers['strict-transport-security']).toBeUndefined()
  })

  it('creates a patient profile and pending appointment visible to the assigned hospital staff', async () => {
    const patient = supertest.agent(app)
    const registration = await patient.post('/api/auth/register').send({
      email: 'new-patient@example.test',
      password,
      registration: {
        name: 'New Test Patient',
        mobileNumber: '+919900000010',
        hospitalId: 'central-city-hospital',
        department: 'General medicine',
        requestedDate: '2026-11-20',
        reason: 'Routine check-up',
      },
      shareConsent: true,
      recordsConsent: true,
    })
    expect(registration.status).toBe(201)
    expect(registration.body.appointmentTrackingId).toBeTruthy()
    const patientId = registration.body.user.uid as string
    const staff = await addStaff('registration-review@example.test', 'receptionist', 'central-city-hospital')
    const requests = await staff.get('/api/data/appointments')
    const appointment = requests.body.docs.find((entry: { data: { patientId: string } }) => entry.data.patientId === patientId)
    expect(appointment?.data).toMatchObject({
      hospitalId: 'central-city-hospital',
      status: 'pending',
      requestedDate: '2026-11-20',
      department: 'General medicine',
      patientMobile: '+919900000010',
      reason: 'Routine check-up',
    })
    const tracking = await supertest(app).get(`/api/public/appointment-tracking/${registration.body.appointmentTrackingId}`)
    expect(tracking.body.data).toMatchObject({ status: 'pending', requestedDate: '2026-11-20' })
    const profile = await staff.get(`/api/data/patients/${patientId}`)
    expect(profile.body.data.details).toEqual({ name: 'New Test Patient', mobileNumber: '+919900000010' })
  })

  it('does not create an account when registration consent is missing', async () => {
    const response = await supertest(app).post('/api/auth/register').send({
      email: 'no-consent@example.test',
      password,
      registration: {
        name: 'No Consent Patient',
        mobileNumber: '+919900000011',
        hospitalId: 'central-city-hospital',
        department: 'General medicine',
        requestedDate: '2026-11-20',
        reason: 'Routine check-up',
      },
      shareConsent: false,
      recordsConsent: true,
    })
    expect(response.status).toBe(400)
    expect(database.prepare('SELECT id FROM users WHERE email = ?').get('no-consent@example.test')).toBeUndefined()
  })

  it('keeps staff requests inactive until an admin approves them', async () => {
    const request = await supertest(app).post('/api/staff-access-requests').send({
      email: 'new-staff@example.test',
      password,
      fullName: 'New Staff Member',
      role: 'receptionist',
      hospitalId: 'central-city-hospital',
    })
    expect(request.status).toBe(201)
    expect(JSON.stringify(request.body)).not.toContain(password)
    expect(database.prepare('SELECT id FROM users WHERE email = ?').get('new-staff@example.test')).toBeUndefined()
    const secondHospitalRequest = await supertest(app).post('/api/staff-access-requests').send({
      email: 'riverside-staff@example.test',
      password,
      fullName: 'Riverside Staff Member',
      role: 'doctor',
      hospitalId: 'riverside-general',
    })
    expect(secondHospitalRequest.status).toBe(201)

    const patient = supertest.agent(app)
    await patient.post('/api/auth/register').send({
      email: 'staff-review-patient@example.test',
      password,
      registration: {
        name: 'Test Patient',
        mobileNumber: '+919900000012',
        hospitalId: 'central-city-hospital',
        department: 'General medicine',
        requestedDate: '2026-11-20',
        reason: 'Routine check-up',
      },
      shareConsent: true,
      recordsConsent: true,
    })
    expect((await patient.get('/api/staff-access-requests')).status).toBe(403)

    const admin = await addStaff('staff-approval-admin@example.test', 'admin', 'central-city-hospital')
    hospitalTestAdmin = admin
    const pending = await admin.get('/api/staff-access-requests')
    expect(pending.body.requests).toHaveLength(2)
    expect(pending.body.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({ email: 'new-staff@example.test', role: 'receptionist', hospitalId: 'central-city-hospital' }),
      expect.objectContaining({ email: 'riverside-staff@example.test', role: 'doctor', hospitalId: 'riverside-general' }),
    ]))
    expect(JSON.stringify(pending.body)).not.toContain(password)

    const decision = await admin.post(`/api/staff-access-requests/${request.body.request.id}/approve`).send({})
    expect(decision.status).toBe(200)
    const staffLogin = await supertest.agent(app).post('/api/auth/login').send({ email: 'new-staff@example.test', password })
    expect(staffLogin.status).toBe(200)
    expect(staffLogin.body.user).toMatchObject({ role: 'receptionist', hospitalId: 'central-city-hospital' })
  })

  it('lets only administrators add hospitals and uses new hospitals throughout registration and notifications', async () => {
    const listed = await supertest(app).get('/api/hospitals')
    expect(listed.status).toBe(200)
    expect(listed.headers['cache-control']).toBe('no-store')
    expect(listed.body.hospitals).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'central-city-hospital', name: 'Central City Hospital' }),
      expect.objectContaining({ id: 'riverside-general', name: 'Riverside General Hospital' }),
      expect.objectContaining({ id: 'northside-medical-center', name: 'Northside Medical Center' }),
    ]))

    expect((await supertest(app).post('/api/hospitals').send({ name: 'Pine Valley Hospital' })).status).toBe(401)
    if (!hospitalTestAdmin) throw new Error('Hospital test administrator was not initialized.')
    const admin = hospitalTestAdmin
    const created = await admin.post('/api/hospitals').send({ name: 'Pine Valley Hospital' })
    expect(created.status).toBe(201)
    expect(created.body.hospital).toEqual({ id: 'pine-valley-hospital', name: 'Pine Valley Hospital' })
    expect((await admin.post('/api/hospitals').send({ name: 'pine valley hospital' })).status).toBe(409)
    expect((await supertest(app).get('/api/hospitals')).body.hospitals)
      .toEqual(expect.arrayContaining([created.body.hospital]))

    const patient = supertest.agent(app)
    const registration = await patient.post('/api/auth/register').send({
      email: 'new-hospital-patient@example.test',
      password,
      registration: {
        name: 'Pine Valley Patient',
        mobileNumber: '+919900000014',
        hospitalId: created.body.hospital.id,
        department: 'General medicine',
        requestedDate: '2026-11-20',
        reason: 'Routine check-up',
      },
      shareConsent: true,
      recordsConsent: true,
    })
    expect(registration.status).toBe(201)
    expect((await patient.post('/api/hospitals').send({ name: 'Patient Hospital' })).status).toBe(403)
    expect(database.prepare('SELECT hospitalId FROM appointments WHERE ownerUid = ?')
      .get(registration.body.user.uid)).toEqual({ hospitalId: created.body.hospital.id })

    const staffRequest = await supertest(app).post('/api/staff-access-requests').send({
      email: 'pine-valley-staff@example.test',
      password,
      fullName: 'Pine Valley Staff',
      role: 'receptionist',
      hospitalId: created.body.hospital.id,
    })
    expect(staffRequest.status).toBe(201)
    const cleanup = await admin.post(`/api/staff-access-requests/${staffRequest.body.request.id}/reject`).send({})
    expect(cleanup.status).toBe(200)

    queueAppointmentUpdate({
      id: randomUUID(),
      hospitalId: created.body.hospital.id,
      patientId: registration.body.user.uid,
      patientMobile: '+919900000014',
      status: 'confirmed',
      assignedDate: '2026-11-20',
      assignedTime: '09:00',
    })
    const notification = listDocuments('notifications').find(({ data }) =>
      data.appointmentId && String(data.message).includes('Pine Valley Hospital'),
    )
    expect(notification?.data.message).toContain('Pine Valley Hospital')
  })

  it('does not allow public staff requests for administrator roles', async () => {
    const response = await supertest(app).post('/api/staff-access-requests').send({
      email: 'public-admin@example.test',
      password,
      fullName: 'Public Admin',
      role: 'admin',
      hospitalId: 'central-city-hospital',
    })
    expect(response.status).toBe(400)
    expect(database.prepare('SELECT id FROM users WHERE email = ?').get('public-admin@example.test')).toBeUndefined()
  })

  it('closes a duplicate same-hospital admin staff request without downgrading the admin account', async () => {
    const request = await supertest(app).post('/api/staff-access-requests').send({
      email: 'existing-request-admin@example.test',
      password: 'Request-passphrase-2026',
      fullName: 'Existing Administrator',
      role: 'receptionist',
      hospitalId: 'central-city-hospital',
    })
    expect(request.status).toBe(201)
    const admin = await addStaff('existing-request-admin@example.test', 'admin', 'central-city-hospital')
    const originalUser = database.prepare('SELECT id, passwordHash FROM users WHERE email = ? COLLATE NOCASE').get('existing-request-admin@example.test') as
      { id: string; passwordHash: string }

    const decision = await admin.post(`/api/staff-access-requests/${request.body.request.id}/approve`).send({})
    expect(decision.status).toBe(200)
    expect(decision.body).toEqual({ status: 'approved', alreadyAdmin: true })
    expect(database.prepare('SELECT id, role, passwordHash FROM users WHERE email = ? COLLATE NOCASE').get('existing-request-admin@example.test'))
      .toEqual({ id: originalUser.id, role: 'admin', passwordHash: originalUser.passwordHash })
    const remaining = await admin.get('/api/staff-access-requests')
    expect(remaining.body.requests).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: request.body.request.id }),
    ]))
  })

  afterAll(async () => {
    database.close()
    await rm(testDataDirectory, { recursive: true, force: true })
  })

  it('denies staff access across hospital boundaries', async () => {
    const agent = await addStaff('north-admin@example.test', 'admin', 'northside-medical-center')
    northHospitalTestAdmin = agent
    const appointmentId = randomUUID()
    writeDocument('appointments', appointmentId, makeAppointment('patient-uid', 'riverside-general'))

    const response = await agent.get(`/api/data/appointments/${appointmentId}`)
    expect(response.status).toBe(403)
  })

  it('allows authorized front-desk staff to update a patient name and mobile without changing account ownership', async () => {
    const patientId = randomUUID()
    writeDocument('patients', patientId, {
      ownerUid: patientId,
      hospitalIds: ['central-city-hospital'],
      details: { name: 'Original Patient', mobileNumber: '+919900000020' },
      mobileNumber: '+919900000020',
    })
    if (!hospitalTestAdmin || !northHospitalTestAdmin) throw new Error('Hospital test staff accounts were not initialized.')
    const staff = hospitalTestAdmin
    const updated = await staff.post('/api/transactions').send({
      operations: [{
        type: 'update',
        collection: 'patients',
        id: patientId,
        data: {
          details: { name: 'Updated Patient', mobileNumber: '+919900000021' },
          mobileNumber: '+919900000021',
          updatedAt: new Date().toISOString(),
        },
      }],
    })
    expect(updated.status).toBe(200)
    expect((await staff.get(`/api/data/patients/${patientId}`)).body.data).toMatchObject({
      ownerUid: patientId,
      hospitalIds: ['central-city-hospital'],
      details: { name: 'Updated Patient', mobileNumber: '+919900000021' },
      mobileNumber: '+919900000021',
    })

    const denied = await northHospitalTestAdmin.post('/api/transactions').send({
      operations: [{
        type: 'update',
        collection: 'patients',
        id: patientId,
        data: { details: { name: 'Unauthorized', mobileNumber: '+919900000022' }, mobileNumber: '+919900000022' },
      }],
    })
    expect(denied.status).toBe(403)
  })

  it('publishes the assigned approximate visit window for a live patient countdown', async () => {
    if (!hospitalTestAdmin) throw new Error('Hospital test administrator was not initialized.')
    const staff = hospitalTestAdmin
    const patientId = randomUUID()
    const appointmentId = randomUUID()
    const trackingId = randomUUID()
    const doctorId = randomUUID()
    const slotId = randomUUID()
    const date = '2026-11-20'
    const appointment = { ...makeAppointment(patientId, 'central-city-hospital'), trackingId }
    const slot = {
      hospitalId: 'central-city-hospital',
      doctorId,
      date,
      startTime: '10:30',
      capacity: 1,
      booked: 0,
    }
    writeDocument('appointments', appointmentId, appointment)
    writeDocument('appointmentTracking', trackingId, {
      appointmentId,
      ownerUid: patientId,
      hospitalId: 'central-city-hospital',
      department: appointment.department,
      status: 'pending',
      requestedDate: date,
      assignedDate: '',
      assignedTime: '',
      visitWindowStart: '',
      visitWindowEnd: '',
      doctorName: '',
      needsReschedule: false,
    })
    writeDocument('doctors', doctorId, {
      name: 'Window Test Doctor',
      userId: 'window-test-doctor-user',
      hospitalId: 'central-city-hospital',
      department: appointment.department,
      status: 'available',
    })
    writeDocument('slots', slotId, slot)

    const updated = await staff.post('/api/transactions').send({
      operations: [
        {
          type: 'update',
          collection: 'appointments',
          id: appointmentId,
          data: {
            status: 'confirmed',
            doctorId,
            slotId,
            assignedDate: date,
            assignedTime: '10:30',
            visitWindowStart: '10:15',
            visitWindowEnd: '10:45',
          },
        },
        { type: 'update', collection: 'slots', id: slotId, baseData: slot, data: { booked: 1 } },
        {
          type: 'update',
          collection: 'appointmentTracking',
          id: trackingId,
          data: {
            status: 'confirmed',
            assignedDate: date,
            assignedTime: '10:30',
            visitWindowStart: '10:15',
            visitWindowEnd: '10:45',
            doctorName: 'Window Test Doctor',
          },
        },
      ],
    })
    expect(updated.status).toBe(200)
    const publicStatus = await supertest(app).get(`/api/public/appointment-tracking/${trackingId}`)
    expect(publicStatus.body.data).toMatchObject({
      assignedDate: date,
      assignedTime: '10:30',
      visitWindowStart: '10:15',
      visitWindowEnd: '10:45',
    })

    const invalidWindow = await staff.post('/api/transactions').send({
      operations: [{
        type: 'update',
        collection: 'appointmentTracking',
        id: trackingId,
        data: { visitWindowStart: '11:00', visitWindowEnd: '10:00' },
      }],
    })
    expect(invalidWindow.status).toBe(400)
  })

  it('does not allow a patient to read another patient medical record', async () => {
    const agent = supertest.agent(app)
    const session = await agent.post('/api/auth/guest').send({})
    expect(session.status).toBe(200)
    const otherPatientId = randomUUID()
    const recordId = randomUUID()
    writeDocument('records', recordId, {
      patientId: otherPatientId,
      ownerUid: otherPatientId,
      hospitalId: 'central-city-hospital',
      doctorId: randomUUID(),
      diagnosis: 'private test data',
      pdfFiles: [],
    })

    const response = await agent.get(`/api/data/records/${recordId}`)
    expect(response.status).toBe(403)
  })

  it('keeps patient identity QR details staff-only and out of public ticket data', async () => {
    const ticketId = randomUUID()
    const staff = await addStaff('identity-staff@example.test', 'receptionist', 'central-city-hospital')
    const otherHospitalStaff = await addStaff('identity-other@example.test', 'admin', 'riverside-general')
    writeDocument('patientDetails', ticketId, {
      hospitalId: 'central-city-hospital',
      ownerUid: 'patient-owner',
      details: { name: 'Private Test Patient', mobileNumber: '+15555550123' },
    })
    writeDocument('tracking', ticketId, {
      code: 'QR1234',
      hospitalId: 'central-city-hospital',
      department: 'General medicine',
      status: 'waiting',
      ownerUid: 'patient-owner',
    })

    const publicTicket = await supertest(app).get(`/api/public/tracking/${ticketId}`)
    expect(publicTicket.status).toBe(200)
    expect(JSON.stringify(publicTicket.body)).not.toContain('Private Test Patient')
    expect(JSON.stringify(publicTicket.body)).not.toContain('+15555550123')

    const allowedDetails = await staff.get(`/api/data/patientDetails/${ticketId}`)
    expect(allowedDetails.status).toBe(200)
    expect(allowedDetails.body.data.details).toEqual({ name: 'Private Test Patient', mobileNumber: '+15555550123' })

    const deniedDetails = await otherHospitalStaff.get(`/api/data/patientDetails/${ticketId}`)
    expect(deniedDetails.status).toBe(403)
  })

  it('allows exactly one concurrent confirmation for the last slot', async () => {
    const agent = await addStaff('reception@example.test', 'receptionist', 'central-city-hospital')
    const doctorId = randomUUID()
    const slotId = randomUUID()
    const date = '2026-11-20'
    writeDocument('doctors', doctorId, {
      name: 'Test doctor',
      userId: 'linked-doctor',
      hospitalId: 'central-city-hospital',
      department: 'General medicine',
      status: 'available',
    })
    const slot = {
      hospitalId: 'central-city-hospital',
      doctorId,
      date,
      startTime: '09:00',
      capacity: 1,
      booked: 0,
    }
    writeDocument('slots', slotId, slot)
    const ids = [randomUUID(), randomUUID()]
    const appointments = ids.map(() => makeAppointment(randomUUID(), 'central-city-hospital'))
    ids.forEach((id, index) => writeDocument('appointments', id, appointments[index]))

    const attempts = ids.map((id, index) => agent.post('/api/transactions').send({
      operations: [
        {
          type: 'update',
          collection: 'appointments',
          id,
          baseData: appointments[index],
          data: { status: 'confirmed', doctorId, slotId, assignedDate: date, assignedTime: '09:00' },
        },
        { type: 'update', collection: 'slots', id: slotId, baseData: slot, data: { booked: 1 } },
      ],
    }))
    const results = await Promise.all(attempts)
    expect(results.map((result) => result.status).sort()).toEqual([200, 409])
    expect((listDocuments('slots').find((entry) => entry.id === slotId)?.data.booked)).toBe(1)
  })

  it('does not queue a duplicate reminder when the scheduler runs repeatedly', () => {
    const patientId = randomUUID()
    const appointmentId = randomUUID()
    const visit = new Date(Date.now() + 12 * 60 * 60 * 1000)
    const date = `${visit.getFullYear()}-${String(visit.getMonth() + 1).padStart(2, '0')}-${String(visit.getDate()).padStart(2, '0')}`
    const time = `${String(visit.getHours()).padStart(2, '0')}:${String(visit.getMinutes()).padStart(2, '0')}`
    writeDocument('patients', patientId, {
      ownerUid: patientId,
      hospitalIds: ['central-city-hospital'],
      details: { preferredLanguage: 'Hindi', mobileNumber: '+919900000001' },
      mobileNumber: '+919900000001',
    })
    writeDocument('appointments', appointmentId, {
      ...makeAppointment(patientId, 'central-city-hospital', 'confirmed'),
      assignedDate: date,
      assignedTime: time,
    })

    runReminderAndFollowupSweep()
    runReminderAndFollowupSweep()
    const reminders = listDocuments('notifications').filter(({ data }) =>
      data.appointmentId === appointmentId && data.type === 'reminder-24h',
    )
    expect(reminders).toHaveLength(1)
    expect(reminders[0].data.message).toContain('याद दिलाना')
  })

  it('stores categorized medical document metadata and serves private PDFs, JPGs, and PNGs', async () => {
    const agent = await addStaff('records-admin@example.test', 'admin', 'central-city-hospital')
    const patientId = randomUUID()
    const recordId = randomUUID()
    writeDocument('records', recordId, {
      patientId,
      ownerUid: patientId,
      hospitalId: 'central-city-hospital',
      doctorId: randomUUID(),
      pdfFiles: [],
    })
    const validPdf = Buffer.from('%PDF-1.4\\n% local test\\n')
    const upload = await agent.post('/api/files')
      .field('hospitalId', 'central-city-hospital')
      .field('patientId', patientId)
      .field('recordId', recordId)
      .field('category', 'Blood Test')
      .field('description', 'Complete blood count')
      .attach('file', validPdf, { filename: 'report.pdf', contentType: 'application/pdf' })
    expect(upload.status).toBe(201)
    expect(upload.body.path).toMatch(/^records\/central-city-hospital\/.+\/.+\.pdf$/)
    expect(upload.body).toMatchObject({
      patientId,
      contentType: 'application/pdf',
      category: 'Blood Test',
      description: 'Complete blood count',
      uploaderRole: 'admin',
    })
    expect(upload.body.id).toEqual(expect.any(String))
    expect(upload.body.uploadedByUserId).toEqual(expect.any(String))

    const download = await agent.get(`/api/files?path=${encodeURIComponent(upload.body.path)}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => callback(null, Buffer.concat(chunks)))
      })
    expect(download.status).toBe(200)
    expect(download.headers['content-type']).toContain('application/pdf')
    expect(download.body).toEqual(validPdf)

    const medicalImages = [
      {
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        filename: 'xray.jpg',
        contentType: 'image/jpeg',
        category: 'X-ray',
      },
      {
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
        filename: 'scan.png',
        contentType: 'image/png',
        category: 'MRI',
      },
    ] as const
    for (const image of medicalImages) {
      const imageUpload = await agent.post('/api/files')
        .field('hospitalId', 'central-city-hospital')
        .field('patientId', patientId)
        .field('recordId', recordId)
        .field('category', image.category)
        .attach('file', image.bytes, { filename: image.filename, contentType: image.contentType })
      expect(imageUpload.status).toBe(201)
      expect(imageUpload.body.contentType).toBe(image.contentType)
      expect(imageUpload.body.category).toBe(image.category)

      const imageDownload = await agent.get(`/api/files?path=${encodeURIComponent(imageUpload.body.path)}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () => callback(null, Buffer.concat(chunks)))
        })
      expect(imageDownload.status).toBe(200)
      expect(imageDownload.headers['content-type']).toContain(image.contentType)
      expect(imageDownload.body).toEqual(image.bytes)
    }

    const patientAgent = supertest.agent(app)
    await patientAgent.post('/api/auth/guest').send({})
    const denied = await patientAgent.get(`/api/files?path=${encodeURIComponent(upload.body.path)}`)
    expect(denied.status).toBe(403)

    const invalid = await agent.post('/api/files')
      .field('hospitalId', 'central-city-hospital')
      .field('patientId', patientId)
      .field('recordId', recordId)
      .field('category', 'Other Medical Reports')
      .attach('file', Buffer.from('not a pdf'), { filename: 'bad.pdf', contentType: 'application/pdf' })
    expect(invalid.status).toBe(400)

    const mismatchedImage = await agent.post('/api/files')
      .field('hospitalId', 'central-city-hospital')
      .field('patientId', patientId)
      .field('recordId', recordId)
      .field('category', 'X-ray')
      .attach('file', medicalImages[1].bytes, { filename: 'wrong.jpg', contentType: 'image/png' })
    expect(mismatchedImage.status).toBe(400)
  })

  it('stores patient-profile PDFs independently from visits and enforces hospital access', async () => {
    if (!hospitalTestAdmin || !northHospitalTestAdmin) throw new Error('Hospital test staff accounts were not initialized.')
    const staff = hospitalTestAdmin
    const otherHospital = northHospitalTestAdmin
    const patientId = randomUUID()
    writeDocument('patients', patientId, {
      ownerUid: patientId,
      hospitalIds: ['central-city-hospital'],
      details: { name: 'Profile Document Patient', mobileNumber: '+15555550199' },
    })
    const validPdf = Buffer.from('%PDF-1.4\n% patient profile test\n')
    const upload = await staff.post('/api/patient-documents')
      .field('hospitalId', 'central-city-hospital')
      .field('patientId', patientId)
      .field('category', 'Prescription')
      .field('description', 'Current prescription')
      .attach('file', validPdf, { filename: 'prescription.pdf', contentType: 'application/pdf' })

    expect(upload.status).toBe(201)
    expect(upload.body).toMatchObject({
      patientId,
      ownerUid: patientId,
      hospitalId: 'central-city-hospital',
      name: 'prescription.pdf',
      contentType: 'application/pdf',
      category: 'Prescription',
      uploaderRole: 'admin',
    })
    expect((await staff.get(`/api/data/patientDocuments/${upload.body.id}`)).body.data.path).toBe(upload.body.path)

    const download = await staff.get(`/api/files?path=${encodeURIComponent(upload.body.path)}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => callback(null, Buffer.concat(chunks)))
      })
    expect(download.status).toBe(200)
    expect(download.body).toEqual(validPdf)

    expect((await otherHospital.get(`/api/files?path=${encodeURIComponent(upload.body.path)}`)).status).toBe(403)
    expect((await otherHospital.get(`/api/data/patientDocuments/${upload.body.id}`)).status).toBe(403)

    const invalid = await staff.post('/api/patient-documents')
      .field('hospitalId', 'central-city-hospital')
      .field('patientId', patientId)
      .field('category', 'Prescription')
      .attach('file', Buffer.from('not a PDF'), { filename: 'invalid.pdf', contentType: 'application/pdf' })
    expect(invalid.status).toBe(400)
  })
})
