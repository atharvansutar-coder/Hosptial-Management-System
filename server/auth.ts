import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { database, writeDocument } from './db'

const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret || jwtSecret.length < 32) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters.')
}

const cookieName = 'careflow_session'
const tokenLifetime = '7d'
const passwordSchema = z.string().min(8).max(128)

export type AppRole = 'patient' | 'receptionist' | 'doctor' | 'admin'
export type AuthUser = {
  uid: string
  role: AppRole
  hospitalId: string | null
  email: string | null
  isAnonymous: boolean
}

export type PatientRegistrationRequest = {
  name: string
  mobileNumber: string
  hospitalId: string
  department: string
  requestedDate: string
  reason: string
}

export type StaffAccessRequest = {
  id: string
  email: string
  fullName: string
  role: 'receptionist' | 'doctor'
  hospitalId: string
  status: 'pending'
  createdAt: string
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser
    }
  }
}

export function issueSession(response: Response, user: AuthUser) {
  const token = jwt.sign(user, jwtSecret!, { expiresIn: tokenLifetime })
  response.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  })
}

export function clearSession(response: Response) {
  response.clearCookie(cookieName, { httpOnly: true, sameSite: 'strict', path: '/' })
}

export function requireAuth(request: Request, response: Response, next: NextFunction) {
  const token = request.cookies?.[cookieName]
  if (!token) {
    response.status(401).json({ error: 'Sign in is required.' })
    return
  }
  try {
    const claims = jwt.verify(token, jwtSecret!) as AuthUser
    const currentUser = userById(claims.uid)
    if (!currentUser) {
      response.status(401).json({ error: 'Your account is no longer available.' })
      return
    }
    request.user = currentUser
    next()
  } catch {
    response.status(401).json({ error: 'Your session expired. Please sign in again.' })
  }
}

export function requireRole(...roles: AppRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.user || !roles.includes(request.user.role)) {
      response.status(403).json({ error: 'You do not have permission to do this.' })
      return
    }
    next()
  }
}

export function requireHospital(request: Request, response: Response, hospitalId: unknown) {
  if (typeof hospitalId !== 'string' || request.user?.role === 'patient' || request.user?.hospitalId !== hospitalId) {
    response.status(403).json({ error: 'This hospital is outside your access.' })
    return false
  }
  return true
}

export async function registerPatientWithRequest(
  email: string,
  password: string,
  request: PatientRegistrationRequest,
  existingUid?: string,
) {
  passwordSchema.parse(password)
  const normalizedEmail = z.string().email().max(254).parse(email.trim().toLowerCase())
  const passwordHash = await bcrypt.hash(password, 12)
  const uid = existingUid ?? randomUUID()
  const appointmentId = randomUUID()
  const trackingId = randomUUID()
  const createdAt = new Date().toISOString()
  const timestamp = { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 }
  const user = { uid, role: 'patient' as const, hospitalId: null, email: normalizedEmail, isAnonymous: false }

  database.transaction(() => {
    const existing = database.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(normalizedEmail) as { id: string } | undefined
    if (existing && existing.id !== existingUid) {
      throw Object.assign(new Error('An account with this email already exists.'), { status: 409 })
    }
    if (existingUid) {
      const current = database.prepare('SELECT id FROM users WHERE id = ? AND isAnonymous = 1').get(existingUid)
      if (!current) throw Object.assign(new Error('This guest session is no longer available. Please sign in again.'), { status: 409 })
    }
    database.prepare(`
      INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, createdAt)
      VALUES (?, ?, ?, 'patient', NULL, 0, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, passwordHash = excluded.passwordHash, isAnonymous = 0
    `).run(uid, normalizedEmail, passwordHash, createdAt)

    writeDocument('patients', uid, {
      ownerUid: uid,
      hospitalIds: [request.hospitalId],
      details: { name: request.name, mobileNumber: request.mobileNumber },
      mobileNumber: request.mobileNumber,
      createdAt: timestamp,
    })
    writeDocument('appointments', appointmentId, {
      trackingId,
      patientId: uid,
      ownerUid: uid,
      hospitalId: request.hospitalId,
      department: request.department,
      doctorId: '',
      slotId: '',
      requestedSlotId: '',
      requestedDoctorId: '',
      patientMobile: request.mobileNumber,
      requestedDate: request.requestedDate,
      reason: request.reason,
      urgent: false,
      companions: 0,
      status: 'pending',
      assignedDate: '',
      assignedTime: '',
      staffNote: '',
      needsReschedule: false,
      patientAction: 'none',
      recordId: '',
      createdAt: timestamp,
      consentAt: timestamp,
      recordsConsentAt: timestamp,
    })
    writeDocument('appointmentTracking', trackingId, {
      appointmentId,
      ownerUid: uid,
      hospitalId: request.hospitalId,
      department: request.department,
      status: 'pending',
      requestedDate: request.requestedDate,
      assignedDate: '',
      assignedTime: '',
      doctorName: '',
      needsReschedule: false,
    })
    writeDocument('consents', randomUUID(), {
      ownerUid: uid,
      patientId: uid,
      hospitalId: request.hospitalId,
      appointmentId,
      consentType: 'records',
      granted: true,
      createdAt,
    })
  })()

  return { user, appointmentTrackingId: trackingId }
}

export async function createStaffAccessRequest(input: Omit<StaffAccessRequest, 'id' | 'status' | 'createdAt'>, password: string) {
  const normalizedEmail = z.string().email().max(254).parse(input.email.trim().toLowerCase())
  const parsedPassword = passwordSchema.min(12).parse(password)
  const passwordHash = await bcrypt.hash(parsedPassword, 12)
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  try {
    database.prepare(`
      INSERT INTO staffAccessRequests (id, email, passwordHash, fullName, role, hospitalId, status, createdAt)
      SELECT ?, ?, ?, ?, ?, ?, 'pending', ?
      WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ? COLLATE NOCASE)
    `).run(id, normalizedEmail, passwordHash, input.fullName.trim(), input.role, input.hospitalId, createdAt, normalizedEmail)
  } catch (reason) {
    if (reason instanceof Error && reason.message.includes('UNIQUE constraint failed')) {
      throw Object.assign(new Error('A pending staff access request already uses this email.'), { status: 409 })
    }
    throw reason
  }
  const inserted = database.prepare('SELECT id FROM staffAccessRequests WHERE id = ?').get(id)
  if (!inserted) {
    throw Object.assign(new Error('An account already uses this email. Contact your administrator.'), { status: 409 })
  }
  return { id, email: normalizedEmail, fullName: input.fullName.trim(), role: input.role, hospitalId: input.hospitalId, status: 'pending' as const, createdAt }
}

export function listStaffAccessRequests() {
  return database.prepare(`
    SELECT id, email, fullName, role, hospitalId, status, createdAt
    FROM staffAccessRequests WHERE status = 'pending' ORDER BY createdAt ASC
  `).all() as StaffAccessRequest[]
}

export function reviewStaffAccessRequest(id: string, reviewerUid: string, approve: boolean) {
  return database.transaction(() => {
    const request = database.prepare(`
      SELECT id, email, passwordHash, fullName, role, hospitalId, status
      FROM staffAccessRequests WHERE id = ?
    `).get(id) as (StaffAccessRequest & { passwordHash: string }) | undefined
    if (!request || request.status !== 'pending') {
      throw Object.assign(new Error('This staff access request is no longer pending.'), { status: 404 })
    }
    let alreadyAdmin = false
    if (approve) {
      const existing = database.prepare('SELECT id, role, hospitalId, active FROM users WHERE email = ? COLLATE NOCASE').get(request.email) as
        { id: string; role: AppRole; hospitalId: string | null; active: number } | undefined
      if (existing) {
        if (existing.role !== 'admin' || existing.hospitalId !== request.hospitalId || existing.active !== 1) {
          throw Object.assign(new Error('This email now belongs to an existing account. Use a different email for the staff request.'), { status: 409 })
        }
        alreadyAdmin = true
      } else {
        database.prepare(`
          INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, active, createdAt)
          VALUES (?, ?, ?, ?, ?, 0, 1, ?)
        `).run(randomUUID(), request.email, request.passwordHash, request.role, request.hospitalId, new Date().toISOString())
      }
    }
    database.prepare(`
      UPDATE staffAccessRequests SET status = ?, reviewedAt = ?, reviewedBy = ?
      WHERE id = ? AND status = 'pending'
    `).run(approve ? 'approved' : 'rejected', new Date().toISOString(), reviewerUid, id)
    return { status: approve ? 'approved' as const : 'rejected' as const, alreadyAdmin }
  })()
}

export function userById(uid: string): AuthUser | null {
  const row = database.prepare('SELECT id, email, role, hospitalId, isAnonymous FROM users WHERE id = ? AND active = 1').get(uid) as
    { id: string; email: string | null; role: AppRole; hospitalId: string | null; isAnonymous: number } | undefined
  return row ? { uid: row.id, email: row.email, role: row.role, hospitalId: row.hospitalId, isAnonymous: row.isAnonymous === 1 } : null
}

export async function login(email: string, password: string) {
  const parsedEmail = z.string().email().max(254).parse(email.trim().toLowerCase())
  const row = database.prepare('SELECT id, email, passwordHash, role, hospitalId, isAnonymous FROM users WHERE email = ? COLLATE NOCASE AND active = 1').get(parsedEmail) as
    { id: string; email: string; passwordHash: string | null; role: AppRole; hospitalId: string | null; isAnonymous: number } | undefined
  if (!row?.passwordHash || !(await bcrypt.compare(password, row.passwordHash))) {
    throw Object.assign(new Error('Email or password is incorrect.'), { status: 401 })
  }
  return { uid: row.id, email: row.email, role: row.role, hospitalId: row.hospitalId, isAnonymous: row.isAnonymous === 1 }
}
