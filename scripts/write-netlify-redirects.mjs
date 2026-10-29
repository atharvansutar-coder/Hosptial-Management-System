import { writeFile } from 'node:fs/promises'

const apiOrigin = process.env.CAREFLOW_API_ORIGIN?.trim()

if (!apiOrigin) {
  if (process.env.NETLIFY === 'true') {
    throw new Error('Set CAREFLOW_API_ORIGIN in Netlify to the HTTPS URL of the running CareFlow backend tunnel.')
  }
  process.exit(0)
}

let parsedOrigin
try {
  parsedOrigin = new URL(apiOrigin)
} catch {
  throw new Error('CAREFLOW_API_ORIGIN must be a valid HTTPS origin, for example https://example.trycloudflare.com.')
}

if (parsedOrigin.protocol !== 'https:' || parsedOrigin.username || parsedOrigin.password
  || parsedOrigin.pathname !== '/' || parsedOrigin.search || parsedOrigin.hash) {
  throw new Error('CAREFLOW_API_ORIGIN must be an HTTPS origin without a path, credentials, query, or fragment.')
}

await writeFile('dist/_redirects', `/api/* ${parsedOrigin.origin}/api/:splat 200\n/* /index.html 200\n`, 'utf8')
