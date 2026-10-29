import 'dotenv/config'
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { dataDirectory, database } from './db'

export async function createBackup() {
  const configuredDirectory = process.env.BACKUP_DIR?.trim()
  if (!configuredDirectory) throw new Error('Set BACKUP_DIR to a separate drive or USB folder before running backups.')
  const backupRoot = resolve(configuredDirectory)
  if (backupRoot === dataDirectory || backupRoot.startsWith(`${dataDirectory}${sep}`)) {
    throw new Error('BACKUP_DIR must be outside the CareFlow data directory.')
  }
  await mkdir(backupRoot, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destination = resolve(backupRoot, `careflow-${stamp}`)
  if (!destination.startsWith(`${backupRoot}${sep}`)) throw new Error('Invalid backup destination.')
  await mkdir(destination, { recursive: false })
  await database.backup(resolve(destination, 'careflow.db'))
  const records = resolve(dataDirectory, 'records')
  try {
    if ((await stat(records)).isDirectory()) await cp(records, resolve(destination, 'records'), { recursive: true, errorOnExist: true })
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason
  }
  const entries = (await readdir(backupRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('careflow-'))
  const backups = await Promise.all(entries.map(async (entry) => ({
    path: resolve(backupRoot, entry.name),
    createdAt: (await stat(resolve(backupRoot, entry.name))).mtimeMs,
  })))
  backups.sort((a, b) => b.createdAt - a.createdAt)
  for (const oldBackup of backups.slice(14)) {
    if (oldBackup.path.startsWith(`${backupRoot}${sep}`)) await rm(oldBackup.path, { recursive: true, force: true })
  }
  return destination
}

if (process.argv[1]?.endsWith('/backup.ts')) {
  const destination = await createBackup()
  console.log(`CareFlow backup created at ${destination}`)
}
