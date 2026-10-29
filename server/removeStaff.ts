import 'dotenv/config'
import { z } from 'zod'
import { database } from './db'

const email = z.string().email().parse(process.env.STAFF_EMAIL?.trim().toLowerCase())
const result = database.prepare("UPDATE users SET active = 0 WHERE email = ? COLLATE NOCASE AND role != 'patient'").run(email)
if (result.changes !== 1) throw new Error('No active staff account was found for that email.')
console.log(`Staff access disabled for ${email}.`)
