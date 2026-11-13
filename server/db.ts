import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export const dataDirectory = resolve(process.env.DATA_DIR ?? 'data')
mkdirSync(dataDirectory, { recursive: true })

const databasePath = resolve(process.env.SQLITE_PATH ?? `${dataDirectory}/careflow.db`)
mkdirSync(dirname(databasePath), { recursive: true })

export const database = new Database(databasePath)
database.pragma('journal_mode = WAL')
database.pragma('foreign_keys = ON')
database.pragma('busy_timeout = 5000')

database.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE COLLATE NOCASE,
    passwordHash TEXT,
    role TEXT NOT NULL CHECK (role IN ('patient', 'receptionist', 'doctor', 'admin')),
    hospitalId TEXT,
    isAnonymous INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS doctors (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS patientDocuments (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS auditLogs (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS consents (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS privacyRequests (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS patientDetails (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tracking (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS appointmentTracking (id TEXT PRIMARY KEY, hospitalId TEXT, ownerUid TEXT, data TEXT NOT NULL, createdAt TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS hospitals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS staffAccessRequests (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    passwordHash TEXT NOT NULL,
    fullName TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('receptionist', 'doctor')),
    hospitalId TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    createdAt TEXT NOT NULL,
    reviewedAt TEXT,
    reviewedBy TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS staff_access_pending_email_idx ON staffAccessRequests(email COLLATE NOCASE) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS appointments_owner_idx ON appointments(ownerUid);
  CREATE INDEX IF NOT EXISTS appointments_hospital_idx ON appointments(hospitalId);
  CREATE INDEX IF NOT EXISTS appointments_date_idx ON appointments(hospitalId, createdAt);
  CREATE INDEX IF NOT EXISTS records_owner_idx ON records(ownerUid);
  CREATE INDEX IF NOT EXISTS records_hospital_idx ON records(hospitalId);
  CREATE INDEX IF NOT EXISTS patient_documents_owner_idx ON patientDocuments(ownerUid);
  CREATE INDEX IF NOT EXISTS patient_documents_hospital_idx ON patientDocuments(hospitalId);
  CREATE INDEX IF NOT EXISTS slots_date_idx ON slots(hospitalId);
  CREATE INDEX IF NOT EXISTS patients_mobile_idx ON patients(hospitalId);
`)
const defaultHospitals = [
  { id: 'central-city-hospital', name: 'Central City Hospital' },
  { id: 'riverside-general', name: 'Riverside General Hospital' },
  { id: 'northside-medical-center', name: 'Northside Medical Center' },
]
const insertDefaultHospital = database.prepare('INSERT OR IGNORE INTO hospitals (id, name, createdAt) VALUES (?, ?, ?)')
for (const hospital of defaultHospitals) {
  insertDefaultHospital.run(hospital.id, hospital.name, new Date().toISOString())
}
const userColumns = database.pragma('table_info(users)') as Array<{ name: string }>
if (!userColumns.some((column) => column.name === 'active')) {
  database.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1')
}

export const dataTables = new Set([
  'patients', 'appointments', 'slots', 'doctors', 'records', 'patientDocuments', 'notifications',
  'auditLogs', 'consents', 'tickets', 'patientDetails', 'tracking', 'appointmentTracking',
  'privacyRequests',
])

export type RowData = Record<string, unknown>

export type HospitalInfo = { id: string; name: string }

export function listHospitals(): HospitalInfo[] {
  return database.prepare('SELECT id, name FROM hospitals ORDER BY name COLLATE NOCASE')
    .all() as HospitalInfo[]
}

export function hospitalExists(id: string) {
  return Boolean(database.prepare('SELECT 1 FROM hospitals WHERE id = ?').get(id))
}

export function createHospital(name: string): HospitalInfo {
  const baseId = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'hospital'
  let id = baseId
  let suffix = 2
  while (hospitalExists(id)) {
    id = `${baseId}-${suffix}`
    suffix += 1
  }
  database.prepare('INSERT INTO hospitals (id, name, createdAt) VALUES (?, ?, ?)')
    .run(id, name, new Date().toISOString())
  return { id, name }
}

export function readDocument(table: string, id: string): RowData | null {
  if (!dataTables.has(table)) return null
  const row = database.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined
  return row ? JSON.parse(row.data) as RowData : null
}

export function writeDocument(table: string, id: string, value: RowData, merge = false) {
  if (!dataTables.has(table)) throw new Error('Unsupported collection')
  const old = merge ? readDocument(table, id) : null
  const data = old ? { ...old, ...value } : value
  const hospitalId = typeof data.hospitalId === 'string' ? data.hospitalId : null
  const ownerUid = typeof data.ownerUid === 'string' ? data.ownerUid : typeof data.patientId === 'string' ? data.patientId : null
  const createdAt = typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString()
  database.prepare(`
    INSERT INTO ${table} (id, hospitalId, ownerUid, data, createdAt) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET hospitalId = excluded.hospitalId, ownerUid = excluded.ownerUid, data = excluded.data
  `).run(id, hospitalId, ownerUid, JSON.stringify(data), createdAt)
  return data
}

export function deleteDocument(table: string, id: string) {
  if (!dataTables.has(table)) throw new Error('Unsupported collection')
  database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
}

export function listDocuments(table: string): Array<{ id: string; data: RowData }> {
  if (!dataTables.has(table)) throw new Error('Unsupported collection')
  return (database.prepare(`SELECT id, data FROM ${table}`).all() as Array<{ id: string; data: string }>)
    .map((row) => ({ id: row.id, data: JSON.parse(row.data) as RowData }))
}
