import 'dotenv/config'
import { networkInterfaces } from 'node:os'
import cron from 'node-cron'
import app from './app'
import { createBackup } from './backup'
import { runReminderAndFollowupSweep } from './smart'

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1)
const server = app.listen(port, host, () => {
  const addresses = Object.values(networkInterfaces()).flat().filter((network) => network?.family === 'IPv4' && !network.internal)
  console.log(`CareFlow local server listening on http://localhost:${port}`)
  for (const address of addresses) {
    if (address) console.log(`On this network: http://${address.address}:${port}`)
  }
  const sweep = () => {
    try {
      runReminderAndFollowupSweep()
    } catch (reason) {
      console.error('Appointment reminder sweep failed:', reason instanceof Error ? reason.name : 'unknown error')
    }
  }
  sweep()
  cron.schedule('*/5 * * * *', sweep)
  if (process.env.BACKUP_DIR) {
    const schedule = process.env.BACKUP_CRON ?? '0 2 * * *'
    if (!cron.validate(schedule)) {
      console.error('BACKUP_CRON is invalid; daily backups were not scheduled.')
      return
    }
    cron.schedule(schedule, () => {
      void createBackup()
        .then((destination) => console.log(`Daily CareFlow backup created at ${destination}`))
        .catch((reason: unknown) => console.error('Daily CareFlow backup failed:', reason))
    })
  } else {
    console.warn('Daily backup is not configured. Set BACKUP_DIR to an external drive or USB path.')
  }
})

server.on('error', (error) => {
  console.error('Unable to start the CareFlow server:', error)
  process.exitCode = 1
})
