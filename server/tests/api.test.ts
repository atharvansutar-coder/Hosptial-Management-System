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

const [{ default: app }, { database, writeDocument, listDocuments }, { runReminderAndFollowupSweep }] = await Promise.all([
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

describe('local CareFlow API', () => {
  beforeAll(() => {
    database.pragma('foreign_keys = ON')
  })

  afterAll(async () => {
    database.close()
    await rm(testDataDirectory, { recursive: true, force: true })
  })

  it('denies staff access across hospital boundaries', async () => {
    const agent = await addStaff('north-admin@example.test', 'admin', 'northside-medical-center')
    const appointmentId = randomUUID()
    writeDocument('appointments', appointmentId, makeAppointment('patient-uid', 'riverside-general'))

    const response = await agent.get(`/api/data/appointments/${appointmentId}`)
    expect(response.status).toBe(403)
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

  it('accepts only authenticated PDFs and serves them through the private API', async () => {
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
      .attach('file', validPdf, { filename: 'report.pdf', contentType: 'application/pdf' })
    expect(upload.status).toBe(201)
    expect(upload.body.path).toMatch(/^records\/central-city-hospital\/.+\/.+\.pdf$/)

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

    const invalid = await agent.post('/api/files')
      .field('hospitalId', 'central-city-hospital')
      .field('patientId', patientId)
      .field('recordId', recordId)
      .attach('file', Buffer.from('not a pdf'), { filename: 'bad.pdf', contentType: 'application/pdf' })
    expect(invalid.status).toBe(400)
  })
})
