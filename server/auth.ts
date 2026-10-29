import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { NextFunction, Request, Response } from 'express'
import { z } from 'zod'
import { database } from './db'

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

export async function registerPatient(email: string, password: string, existingUid?: string) {
  passwordSchema.parse(password)
  const normalizedEmail = z.string().email().max(254).parse(email.trim().toLowerCase())
  const passwordHash = await bcrypt.hash(password, 12)
  const existing = database.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(normalizedEmail) as { id: string } | undefined
  if (existing && existing.id !== existingUid) {
    throw Object.assign(new Error('An account with this email already exists.'), { status: 409 })
  }
  const uid = existingUid ?? crypto.randomUUID()
  database.prepare(`
    INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, createdAt)
    VALUES (?, ?, ?, 'patient', NULL, 0, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, passwordHash = excluded.passwordHash, isAnonymous = 0
  `).run(uid, normalizedEmail, passwordHash, new Date().toISOString())
  return { uid, role: 'patient' as const, hospitalId: null, email: normalizedEmail, isAnonymous: false }
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
