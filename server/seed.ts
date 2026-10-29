import 'dotenv/config'
import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import { database } from './db'
import { z } from 'zod'

const email = z.string().email().parse(process.env.ADMIN_EMAIL?.trim().toLowerCase())
const password = z.string().min(12).max(128).parse(process.env.ADMIN_PASSWORD)
const hospitalId = z.enum(['central-city-hospital', 'riverside-general', 'northside-medical-center']).parse(process.env.ADMIN_HOSPITAL_ID)
const passwordHash = await bcrypt.hash(password, 12)

database.prepare(`
  INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, createdAt)
  VALUES (?, ?, ?, 'admin', ?, 0, 1, ?)
  ON CONFLICT(email) DO UPDATE SET passwordHash = excluded.passwordHash, role = 'admin', hospitalId = excluded.hospitalId, active = 1
`).run(randomUUID(), email, passwordHash, hospitalId, new Date().toISOString())

console.log(`Admin account ready for ${email} at ${hospitalId}.`)
