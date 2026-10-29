export type DocumentData = Record<string, any>

export class Timestamp {
  constructor(readonly seconds: number, readonly nanoseconds = 0) {}
  static now() { return new Timestamp(Math.floor(Date.now() / 1000), 0) }
  toDate() { return new Date(this.seconds * 1000 + this.nanoseconds / 1_000_000) }
}

export type User = {
  uid: string
  email: string | null
  isAnonymous: boolean
}

type BackendUser = User & {
  role: 'patient' | 'receptionist' | 'doctor' | 'admin'
  hospitalId: string | null
}

type DocumentReference = { kind: 'document'; collection: string; id: string }
type CollectionReference = { kind: 'collection'; collection: string }
type Filter = { field: string; op: '==' | '>=' | '<=' | 'in' | 'array-contains'; value: unknown }
type QueryReference = { kind: 'query'; collection: string; filters: Filter[]; maxResults?: number }
type Reference = DocumentReference | CollectionReference | QueryReference
type Operation = { type: 'set' | 'update'; collection: string; id: string; data: DocumentData; merge?: boolean; baseData?: DocumentData }

const apiBase = '/api'

class ApiError extends Error {
  code: string
  constructor(message: string, status: number) {
    super(message)
    this.code = status === 401 ? 'auth/invalid-credential'
      : status === 409 ? 'auth/email-already-in-use'
        : status === 403 ? 'permission-denied' : 'local-api/error'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    })
  } catch {
    throw new ApiError('Cannot reach the CareFlow server. Run `npm run start` and open the local or network URL printed in the terminal.', 0)
  }
  if (response.status === 204) return undefined as T
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('This website address is not connected to the CareFlow API. Run `npm run start` and open the local or network URL printed in the terminal.', response.status)
  }
  if (!response.ok) {
    const body = await response.json() as { error?: unknown }
    throw new ApiError(typeof body.error === 'string' ? body.error : 'Local server request failed.', response.status)
  }
  return response.json() as Promise<T>
}

function serialize(value: unknown): unknown {
  if (value instanceof Timestamp) return { seconds: value.seconds, nanoseconds: value.nanoseconds }
  if (Array.isArray(value)) return value.map(serialize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, serialize(child)]))
}

function revive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(revive)
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  if (typeof object.seconds === 'number' && typeof object.nanoseconds === 'number' && Object.keys(object).every((key) => key === 'seconds' || key === 'nanoseconds')) {
    return new Timestamp(object.seconds, object.nanoseconds)
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, revive(child)]))
}

function toWire(value: unknown): unknown {
  if (value && typeof value === 'object' && '__careflowType' in value) return value
  if (value instanceof Timestamp) return { seconds: value.seconds, nanoseconds: value.nanoseconds }
  if (Array.isArray(value)) return value.map(toWire)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toWire(child)]))
}

function referenceData(reference: DocumentReference, data: DocumentData) {
  return { collection: reference.collection, id: reference.id, data: toWire(data) as DocumentData }
}

export const db = {}
export const isBackendConfigured = true
export const storage = {}
export const auth: { currentUser: BackendUser | null } = { currentUser: null }

const authListeners = new Set<(user: User | null) => void>()

function setCurrentUser(user: BackendUser | null) {
  auth.currentUser = user
  for (const listener of authListeners) listener(user)
}

export const EmailAuthProvider = {
  credential(email: string, password: string) { return { email, password } },
}

export async function signInAnonymously(_auth?: unknown) {
  const result = await request<{ user: BackendUser }>('/auth/guest', {
    method: 'POST',
    body: JSON.stringify({ uid: auth.currentUser?.isAnonymous ? auth.currentUser.uid : undefined }),
  })
  setCurrentUser(result.user)
  return { user: result.user }
}

export async function createUserWithEmailAndPassword(_auth: unknown, email: string, password: string) {
  const result = await request<{ user: BackendUser }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  setCurrentUser(result.user)
  return { user: result.user }
}

export async function signInWithEmailAndPassword(_auth: unknown, email: string, password: string) {
  const result = await request<{ user: BackendUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  setCurrentUser(result.user)
  return { user: result.user }
}

export async function linkWithCredential(user: User, credential: { email: string; password: string }) {
  const result = await request<{ user: BackendUser }>('/auth/link', {
    method: 'POST',
    body: JSON.stringify({ ...credential, uid: user.uid }),
  })
  setCurrentUser(result.user)
  return { user: result.user }
}

export async function signOut(_auth?: unknown) {
  await request('/auth/logout', { method: 'POST' })
  setCurrentUser(null)
}

export async function withdrawRecordsConsent() {
  return request<{ ok: boolean; withdrawnAt: string }>('/consents/withdraw', { method: 'POST', body: '{}' })
}

export async function submitPrivacyRequest(type: 'export' | 'erase', hospitalId: string) {
  return request<{ id: string; type: string; status: string }>('/privacy-requests', {
    method: 'POST',
    body: JSON.stringify({ type, hospitalId }),
  })
}

export async function listPrivacyRequests() {
  return request<{ requests: Array<{ id: string; type: 'export' | 'erase'; status: string; requestedAt: string }> }>('/privacy-requests')
}

export async function approvePrivacyRequest(id: string) {
  return request<{ ok: boolean; export?: Record<string, unknown> }>(`/privacy-requests/${encodeURIComponent(id)}/approve`, { method: 'POST', body: '{}' })
}

export async function acceptWaitlistOffer(appointmentId: string) {
  return request<{ ok: boolean }>('/waitlist/accept', { method: 'POST', body: JSON.stringify({ appointmentId }) })
}

export async function queuePatientMessage(appointmentId: string, message: string) {
  return request<{ id: string; status: string }>('/notifications', {
    method: 'POST',
    body: JSON.stringify({ appointmentId, message }),
  })
}

export async function markNotificationHandled(id: string) {
  return request<{ ok: boolean }>(`/notifications/${encodeURIComponent(id)}/handled`, { method: 'POST', body: '{}' })
}

export async function markAppointmentNoShow(appointmentId: string) {
  return request<{ ok: boolean }>(`/appointments/${encodeURIComponent(appointmentId)}/no-show`, { method: 'POST', body: '{}' })
}

export function onAuthStateChanged(_auth: unknown, listener: (user: User | null) => void) {
  authListeners.add(listener)
  void request<{ user: BackendUser | null }>('/auth/me')
    .then(({ user }) => {
      auth.currentUser = user
      listener(user)
    })
    .catch((reason: unknown) => {
      console.error('Unable to restore the local CareFlow session:', reason)
      listener(null)
    })
  return () => { authListeners.delete(listener) }
}

export async function getIdTokenResult(user: User) {
  const current = auth.currentUser?.uid === user.uid ? auth.currentUser : null
  const claims = {
    role: current?.role,
    hospitalId: current?.hospitalId,
    staff: current?.role === 'receptionist' || current?.role === 'doctor' || current?.role === 'admin',
  }
  return { claims }
}

type UploadedPdf = { name: string; path: string; uploadedAt: { seconds: number; nanoseconds: number } }

export async function getBlob(fileReference: { path: string }): Promise<Blob> {
  const response = await fetch(`${apiBase}/files?path=${encodeURIComponent(fileReference.path)}`, { credentials: 'same-origin' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Unable to download this private PDF.' }))
    throw new ApiError(typeof body.error === 'string' ? body.error : 'Unable to download this private PDF.', response.status)
  }
  return response.blob()
}

export function ref(_storage: unknown, path: string) { return { path } }
export function uploadBytesResumable(fileReference: { path: string }, file: File, metadata?: { contentType?: string; customMetadata?: { recordId?: string } }) {
  return {
    result: undefined as UploadedPdf | undefined,
    on(
      _event: 'state_changed',
      progress: (snapshot: { bytesTransferred: number; totalBytes: number }) => void,
      error: (reason: Error) => void,
      complete: () => void,
    ) {
      const parts = fileReference.path.split('/')
      if (parts.length !== 4 || parts[0] !== 'records' || !metadata?.customMetadata?.recordId) {
        queueMicrotask(() => error(new Error('The patient record upload path is invalid.')))
        return
      }
      const formData = new FormData()
      formData.set('file', file)
      formData.set('hospitalId', parts[1])
      formData.set('patientId', parts[2])
      formData.set('recordId', metadata.customMetadata.recordId)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${apiBase}/files`)
      xhr.withCredentials = true
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) progress({ bytesTransferred: event.loaded, totalBytes: event.total })
      }
      xhr.onerror = () => error(new Error('The local server could not be reached while uploading the PDF.'))
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          let message = 'Unable to upload this PDF.'
          try { message = JSON.parse(xhr.responseText).error ?? message } catch { /* The server returned a non-JSON error. */ }
          error(new ApiError(message, xhr.status))
          return
        }
        try {
          this.result = JSON.parse(xhr.responseText) as UploadedPdf
          complete()
        } catch {
          error(new Error('The local server returned an invalid upload response.'))
        }
      }
      xhr.send(formData)
    },
  }
}

export const TimestampMarker = { serverTimestamp: true }
export function serverTimestamp() { return { __careflowType: 'timestamp' } }
export function arrayUnion(...values: unknown[]) { return { __careflowType: 'arrayUnion', values } }

export function collection(_database: unknown, name: string): CollectionReference {
  return { kind: 'collection', collection: name }
}

export function doc(_databaseOrCollection: unknown, nameOrId?: string, maybeId?: string): DocumentReference {
  if (typeof nameOrId === 'string' && typeof maybeId === 'string') {
    return { kind: 'document', collection: nameOrId, id: maybeId }
  }
  const collectionName = (typeof _databaseOrCollection === 'object' && _databaseOrCollection !== null && 'collection' in _databaseOrCollection)
    ? String((_databaseOrCollection as CollectionReference).collection)
    : ''
  return { kind: 'document', collection: collectionName, id: nameOrId ?? crypto.randomUUID() }
}

export function where(field: string, op: Filter['op'], value: unknown): Filter {
  return { field, op, value: serialize(value) }
}

export function limit(maxResults: number) { return { maxResults } }

export function query(reference: CollectionReference, ...constraints: Array<Filter | { maxResults: number }>): QueryReference {
  return {
    kind: 'query',
    collection: reference.collection,
    filters: constraints.filter((constraint): constraint is Filter => 'field' in constraint),
    maxResults: constraints.find((constraint): constraint is { maxResults: number } => 'maxResults' in constraint)?.maxResults,
  }
}

export class QueryDocumentSnapshot<T = DocumentData> {
  constructor(readonly id: string, private readonly value: T) {}
  data() { return this.value }
}

export class DocumentSnapshot<T = DocumentData> {
  private readonly present: boolean
  constructor(readonly id: string, private readonly value: T | undefined) { this.present = value !== undefined }
  exists() { return this.present }
  data(): T { return this.value as T }
}
export type QuerySnapshot<T = DocumentData> = {
  docs: QueryDocumentSnapshot<T>[]
  empty: boolean
  size: number
  forEach(callback: (snapshot: QueryDocumentSnapshot<T>) => void): void
}

async function readReference(reference: Reference) {
  if (reference.kind === 'document') {
    const publicCollection = reference.collection === 'tracking' || reference.collection === 'appointmentTracking'
    const endpoint = reference.collection === 'appointmentTracking'
      ? `/public/appointment-tracking/${encodeURIComponent(reference.id)}`
      : publicCollection
        ? `/public/tracking/${encodeURIComponent(reference.id)}`
        : `/data/${encodeURIComponent(reference.collection)}/${encodeURIComponent(reference.id)}`
    const result = await request<{ exists: boolean; id?: string; data?: DocumentData }>(endpoint)
    return new DocumentSnapshot(reference.id, result.exists ? revive(result.data) as DocumentData : undefined)
  }
  const filters = reference.kind === 'query' ? reference.filters : []
  const maxResults = reference.kind === 'query' ? reference.maxResults : undefined
  const publicCode = reference.collection === 'tracking'
    ? filters.find((filter) => filter.field === 'code' && filter.op === '==')
    : undefined
  if (publicCode) {
    const result = await request<{ docs: Array<{ id: string; data: DocumentData }> }>(`/public/tracking?code=${encodeURIComponent(String(publicCode.value))}`)
    const docs = result.docs.slice(0, maxResults).map((item) => new QueryDocumentSnapshot(item.id, revive(item.data) as DocumentData))
    return {
      docs,
      empty: docs.length === 0,
      size: docs.length,
      forEach(callback: (snapshot: QueryDocumentSnapshot) => void) { docs.forEach(callback) },
    }
  }
  const params = new URLSearchParams()
  if (filters.length) params.set('filters', JSON.stringify(filters.map((filter) => ({ ...filter, value: serialize(filter.value) }))))
  const result = await request<{ docs: Array<{ id: string; data: DocumentData }> }>(`/data/${encodeURIComponent(reference.collection)}?${params}`)
  const docs = result.docs.slice(0, maxResults).map((item) => new QueryDocumentSnapshot(item.id, revive(item.data) as DocumentData))
  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach(callback: (snapshot: QueryDocumentSnapshot) => void) { docs.forEach(callback) },
  }
}

export async function getDoc(reference: DocumentReference) {
  return await readReference(reference) as DocumentSnapshot
}

export async function getDocs(reference: QueryReference) {
  return await readReference(reference) as QuerySnapshot
}

export function onSnapshot<T = DocumentData>(
  reference: DocumentReference,
  next: (snapshot: DocumentSnapshot<T>) => void,
  error?: (reason: Error) => void,
): () => void
export function onSnapshot<T = DocumentData>(
  reference: CollectionReference | QueryReference,
  next: (snapshot: QuerySnapshot<T>) => void,
  error?: (reason: Error) => void,
): () => void
export function onSnapshot(
  reference: Reference,
  next: (snapshot: never) => void,
  error?: (reason: Error) => void,
): () => void {
  let active = true
  let serialized = ''
  const refresh = async () => {
    try {
      const snapshot = await readReference(reference)
      const docs = 'docs' in snapshot ? snapshot.docs.map((item) => ({ id: item.id, data: item.data() })) : snapshot.data()
      const nextState = JSON.stringify(docs)
      if (active && nextState !== serialized) {
        serialized = nextState
        next(snapshot as never)
      }
    } catch (reason) {
      if (active) error?.(reason instanceof Error ? reason : new Error('Unable to refresh local data.'))
    }
  }
  void refresh()
  const timer = window.setInterval(() => { void refresh() }, 5000)
  return () => { active = false; window.clearInterval(timer) }
}

export async function setDoc(reference: DocumentReference, data: DocumentData, options?: { merge?: boolean }) {
  await request(`/data/${encodeURIComponent(reference.collection)}/${encodeURIComponent(reference.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ data: toWire(data), merge: options?.merge ?? false }),
  })
}

export async function updateDoc(reference: DocumentReference, data: DocumentData) {
  await setDoc(reference, data, { merge: true })
}

export async function runTransaction<T>(_database: unknown, callback: (transaction: {
  get(reference: DocumentReference): Promise<DocumentSnapshot>
  set(reference: DocumentReference, data: DocumentData, options?: { merge?: boolean }): void
  update(reference: DocumentReference, data: DocumentData): void
}) => Promise<T>): Promise<T> {
  const operations: Operation[] = []
  const reads = new Map<string, DocumentData>()
  const transaction = {
    get: async (reference: DocumentReference) => {
      const snapshot = await getDoc(reference)
      if (snapshot.exists()) reads.set(`${reference.collection}/${reference.id}`, snapshot.data())
      return snapshot
    },
    set: (reference: DocumentReference, data: DocumentData, options?: { merge?: boolean }) => operations.push({
      ...referenceData(reference, data), type: 'set', merge: options?.merge,
      baseData: reads.get(`${reference.collection}/${reference.id}`),
    }),
    update: (reference: DocumentReference, data: DocumentData) => operations.push({
      ...referenceData(reference, data), type: 'update',
      baseData: reads.get(`${reference.collection}/${reference.id}`),
    }),
  }
  const result = await callback(transaction)
  if (operations.length) {
    await request('/transactions', { method: 'POST', body: JSON.stringify({ operations: operations.map((op) => ({ ...op, data: toWire(op.data), baseData: toWire(op.baseData) })) }) })
  }
  return result
}

export function writeBatch(_database: unknown) {
  const operations: Operation[] = []
  return {
    set(reference: DocumentReference, data: DocumentData, options?: { merge?: boolean }) {
      operations.push({ ...referenceData(reference, data), type: 'set', merge: options?.merge })
      return this
    },
    update(reference: DocumentReference, data: DocumentData) {
      operations.push({ ...referenceData(reference, data), type: 'update' })
      return this
    },
    async commit() {
      if (operations.length) {
        await request('/transactions', { method: 'POST', body: JSON.stringify({ operations: operations.map((op) => ({ ...op, data: toWire(op.data) })) }) })
      }
    },
  }
}

export const storageRef = ref
export type TimestampType = Timestamp
export type UserType = User
export type DocumentReferenceType = DocumentReference
export type CollectionReferenceType = CollectionReference
