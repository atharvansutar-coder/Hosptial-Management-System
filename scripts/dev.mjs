import { spawn } from 'node:child_process'

const children = [
  spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
]

let stopping = false

function stop(signal) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal)
  }
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('Unable to start the CareFlow development server:', error)
    process.exitCode = 1
    stop('SIGTERM')
  })
  child.on('exit', (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1
      stop('SIGTERM')
    }
  })
}

process.on('SIGINT', () => {
  process.exitCode = 130
  stop('SIGINT')
})
process.on('SIGTERM', () => {
  process.exitCode = 143
  stop('SIGTERM')
})
