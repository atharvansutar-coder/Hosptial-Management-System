import 'dotenv/config'
import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { database } from './db'

const email = z.string().email().parse(process.env.STAFF_EMAIL?.trim().toLowerCase())
const password = z.string().min(12).max(128).parse(process.env.STAFF_PASSWORD)
const role = z.enum(['receptionist', 'doctor', 'admin']).parse(process.env.STAFF_ROLE)
const hospitalId = z.enum(['central-city-hospital', 'riverside-general', 'northside-medical-center']).parse(process.env.STAFF_HOSPITAL_ID)
const passwordHash = await bcrypt.hash(password, 12)
const uid = randomUUID()

database.prepare(`
  INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, active, createdAt)
  VALUES (?, ?, ?, ?, ?, 0, 1, ?)
  ON CONFLICT(email) DO UPDATE SET passwordHash = excluded.passwordHash, role = excluded.role, hospitalId = excluded.hospitalId, active = 1
`).run(uid, email, passwordHash, role, hospitalId, new Date().toISOString())

console.log(`Staff account ready for ${email} (${role}, ${hospitalId}). User ID: ${uid}`)
