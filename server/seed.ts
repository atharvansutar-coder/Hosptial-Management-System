import 'dotenv/config'
import bcrypt from 'bcrypt'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const configuration = z.object({
  ADMIN_EMAIL: z.string().trim().email(),
  ADMIN_PASSWORD: z.string().min(12).max(128),
  ADMIN_HOSPITAL_ID: z.enum(['central-city-hospital', 'riverside-general', 'northside-medical-center']),
}).safeParse({
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_HOSPITAL_ID: process.env.ADMIN_HOSPITAL_ID || 'central-city-hospital',
})

if (!configuration.success) {
  const missingOrInvalid = [...new Set(configuration.error.issues.map((issue) => issue.path[0]))]
  console.error(`Cannot create the administrator account. Check these .env settings: ${missingOrInvalid.join(', ')}.`)
  console.error('ADMIN_PASSWORD must be 12–128 characters. ADMIN_HOSPITAL_ID must be a configured hospital ID.')
  process.exitCode = 1
} else {
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password, ADMIN_HOSPITAL_ID: hospitalId } = configuration.data
  const passwordHash = await bcrypt.hash(password, 12)
  const { database } = await import('./db')

  database.prepare(`
  INSERT INTO users (id, email, passwordHash, role, hospitalId, isAnonymous, createdAt)
  VALUES (?, ?, ?, 'admin', ?, 0, ?)
  ON CONFLICT(email) DO UPDATE SET passwordHash = excluded.passwordHash, role = 'admin', hospitalId = excluded.hospitalId, active = 1
  `).run(randomUUID(), email, passwordHash, hospitalId, new Date().toISOString())

  console.log(`Admin account ready for ${email} at ${hospitalId}.`)
}
