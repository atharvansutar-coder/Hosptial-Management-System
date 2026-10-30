import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  CircleHelp,
  Clock3,
  FileText,
  HeartPulse,
  Hospital,
  LogOut,
  MapPin,
  MessageCircle,
  Phone,
  Plus,
  QrCode,
  Search,
  ScanLine,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Users,
  X,
  UserPlus,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import {
  EmailAuthProvider,
  createUserWithEmailAndPassword,
  getIdTokenResult,
  linkWithCredential,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  approvePrivacyRequest,
  acceptWaitlistOffer,
  listPrivacyRequests,
  markNotificationHandled,
  markAppointmentNoShow,
  queuePatientMessage,
  submitPrivacyRequest,
  withdrawRecordsConsent,
  type MedicalDocumentCategory,
  type User,
} from './localBackend'
import {
  collection,
  arrayUnion,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type QueryDocumentSnapshot,
} from './localBackend'
import { getBlob, ref as storageRef, uploadBytesResumable } from './localBackend'
import { auth, db, isBackendConfigured, storage } from './localBackend'
import { translatePatientText, type PatientLanguage } from './i18n'

const PatientLanguageContext = createContext<{
  language: PatientLanguage
  setLanguage: (language: PatientLanguage) => void
}>({ language: 'en', setLanguage: () => undefined })

function usePatientText() {
  const { language } = useContext(PatientLanguageContext)
  return (text: string) => translatePatientText(language, text)
}

function PatientLanguagePicker() {
  const { language, setLanguage } = useContext(PatientLanguageContext)
  return <label className="language-picker">
    <span className="sr-only">Language</span>
    <select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value as PatientLanguage)}>
      <option value="en">English</option>
      <option value="hi">हिन्दी</option>
      <option value="mr">मराठी</option>
    </select>
  </label>
}

const departments = [
  { name: 'General medicine', detail: 'Everyday health concerns', icon: Stethoscope, color: 'mint' },
  { name: 'Pediatrics', detail: 'Care for little ones', icon: HeartPulse, color: 'peach' },
  { name: 'Dental care', detail: 'Teeth & oral health', icon: Sparkles, color: 'lavender' },
  { name: 'Diagnostics', detail: 'Tests & imaging', icon: Activity, color: 'blue' },
] as const
const medicalPdfUploadsEnabled = true
const medicalDocumentCategories = [
  'Blood Test',
  'Urine Test',
  'X-ray',
  'MRI',
  'CT Scan',
  'ECG',
  'Ultrasound',
  'Prescription',
  'Other Medical Reports',
] as const satisfies readonly MedicalDocumentCategory[]

const hospitals = [
  { id: 'central-city-hospital', name: 'Central City Hospital', address: import.meta.env.VITE_CENTRAL_CITY_HOSPITAL_ADDRESS ?? '', phone: import.meta.env.VITE_CENTRAL_CITY_HOSPITAL_PHONE ?? '', whatsapp: import.meta.env.VITE_CENTRAL_CITY_HOSPITAL_WHATSAPP ?? '', mapLink: import.meta.env.VITE_CENTRAL_CITY_HOSPITAL_MAP_LINK ?? '' },
  { id: 'riverside-general', name: 'Riverside General Hospital', address: import.meta.env.VITE_RIVERSIDE_GENERAL_ADDRESS ?? '', phone: import.meta.env.VITE_RIVERSIDE_GENERAL_PHONE ?? '', whatsapp: import.meta.env.VITE_RIVERSIDE_GENERAL_WHATSAPP ?? '', mapLink: import.meta.env.VITE_RIVERSIDE_GENERAL_MAP_LINK ?? '' },
  { id: 'northside-medical-center', name: 'Northside Medical Center', address: import.meta.env.VITE_NORTHSIDE_MEDICAL_ADDRESS ?? '', phone: import.meta.env.VITE_NORTHSIDE_MEDICAL_PHONE ?? '', whatsapp: import.meta.env.VITE_NORTHSIDE_MEDICAL_WHATSAPP ?? '', mapLink: import.meta.env.VITE_NORTHSIDE_MEDICAL_MAP_LINK ?? '' },
] as const

type Hospital = (typeof hospitals)[number]
type HospitalId = Hospital['id']
type Department = (typeof departments)[number]['name']
type StaffRole = 'receptionist' | 'doctor' | 'admin'
type TicketStatus = 'waiting' | 'called' | 'arrived' | 'completed' | 'no_show'
type Ticket = {
  id: string
  code: string
  hospitalId: string
  department: Department
  status: TicketStatus
  createdAt: { seconds: number } | null
}
type PatientDetails = {
  name: string
  mobileNumber: string
  firstName?: string
  middleName?: string
  lastName?: string
}
type AppointmentStatus = 'pending' | 'confirmed' | 'rescheduled' | 'declined' | 'cancelled' | 'completed' | 'no_show'
type Appointment = {
  id: string
  trackingId: string
  patientId: string
  ownerUid: string
  hospitalId: HospitalId
  department: Department
  doctorId: string
  slotId: string
  requestedSlotId: string
  requestedDoctorId: string
  patientMobile: string
  requestedDate: string
  reason: string
  urgent: boolean
  companions: number
  status: AppointmentStatus
  assignedDate: string
  assignedTime: string
  staffNote: string
  needsReschedule: boolean
  patientAction: 'none' | 'reschedule_requested' | 'visit_confirmed'
  recordId: string
  recordsConsentAt: { seconds: number } | null
  waitlistOfferSlotId: string
  waitlistOfferExpiresAt: { seconds: number } | null
  waitlistOfferDate: string
  waitlistOfferTime: string
  createdAt: { seconds: number } | null
}
type AppointmentTracking = {
  id: string
  appointmentId: string
  hospitalId: HospitalId
  department: Department
  status: AppointmentStatus
  requestedDate: string
  assignedDate: string
  assignedTime: string
  doctorName: string
  needsReschedule: boolean
}
type AppointmentRequest = Appointment & { patient: PatientDetails | null }
type DoctorStatus = 'available' | 'late' | 'on_leave' | 'emergency_only'
type Doctor = {
  id: string
  name: string
  department: Department
  hospitalId: HospitalId
  userId: string
  status: DoctorStatus
  lateByMinutes: number
  note: string
}
type AppointmentSlot = {
  id: string
  doctorId: string
  date: string
  startTime: string
  capacity: number
  booked: number
}
type MedicalDocument = {
  id?: string
  name: string
  path: string
  uploadedAt: Timestamp
  contentType?: string
  category?: MedicalDocumentCategory
  description?: string
  uploadedByUserId?: string
  uploaderRole?: StaffRole
}
type MedicalRecord = {
  id: string
  patientId: string
  appointmentId: string
  hospitalId: HospitalId
  doctorId: string
  visitDate: string
  diagnosis: string
  allergies: string
  chronicConditions: string
  currentMedicines: string
  prescription: string
  notes: string
  followUpDate: string
  pdfFiles: MedicalDocument[]
  consentAt: Timestamp | null
  createdBy: string
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
}
type SelectedPatient = { id: string; details: PatientDetails; mobileNumber: string }
type View = 'patient' | 'staff' | 'staff-inbox' | 'staff-scheduler' | 'staff-doctors' | 'staff-search' | 'staff-create' | 'staff-today' | 'staff-history' | 'staff-privacy' | 'staff-notifications' | 'patient-auth' | 'appointment-request' | 'appointment-status' | 'patient-records'

function getLocalDateInputValue() {
  const date = new Date()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function isPatientDetails(value: unknown): value is PatientDetails {
  if (typeof value !== 'object' || value === null) return false
  const name = Reflect.get(value, 'name')
  const firstName = Reflect.get(value, 'firstName')
  return typeof Reflect.get(value, 'mobileNumber') === 'string'
    && (typeof name === 'string' || typeof firstName === 'string')
}

function patientFullName(details: PatientDetails) {
  return (details.name || [details.firstName, details.middleName, details.lastName].filter(Boolean).join(' ')).trim()
}

function getHospital(hospitalId: unknown): Hospital | undefined {
  return hospitals.find((hospital) => hospital.id === hospitalId)
}

function getHospitalMapUrl(hospital: Hospital | undefined) {
  return hospital?.mapLink || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(hospital?.address || hospital?.name || 'Hospital')}`
}

function getWhatsAppUrl(phone: string, message: string) {
  const digits = phone.replace(/\D/g, '')
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
}

export async function notifyPatient(appointment: Appointment, message: string) {
  return queuePatientMessage(appointment.id, message)
}

function getDoctor(snapshot: QueryDocumentSnapshot<DocumentData>): Doctor {
  const data = snapshot.data()
  return {
    id: snapshot.id,
    name: String(data.name ?? ''),
    department: data.department as Department,
    hospitalId: data.hospitalId as HospitalId,
    userId: String(data.userId ?? ''),
    status: data.status as DoctorStatus,
    lateByMinutes: Number(data.lateByMinutes ?? 0),
    note: String(data.note ?? ''),
  }
}

function getSlot(snapshot: QueryDocumentSnapshot<DocumentData>): AppointmentSlot {
  const data = snapshot.data()
  return {
    id: snapshot.id,
    doctorId: String(data.doctorId ?? ''),
    date: String(data.date ?? ''),
    startTime: String(data.startTime ?? ''),
    capacity: Number(data.capacity ?? 0),
    booked: Number(data.booked ?? 0),
  }
}

function toMedicalRecord(id: string, data: DocumentData): MedicalRecord {
    const pdfFiles = Array.isArray(data.pdfFiles)
      ? data.pdfFiles.flatMap((file): MedicalDocument[] => {
        if (typeof file !== 'object' || file === null) return []
        const name = Reflect.get(file, 'name')
        const path = Reflect.get(file, 'path')
        const uploadedAt = Reflect.get(file, 'uploadedAt')
        return typeof name === 'string' && typeof path === 'string' && uploadedAt instanceof Timestamp
          ? [{
            id: typeof Reflect.get(file, 'id') === 'string' ? Reflect.get(file, 'id') as string : undefined,
            name,
            path,
            uploadedAt,
            contentType: typeof Reflect.get(file, 'contentType') === 'string' ? Reflect.get(file, 'contentType') as string : undefined,
            category: medicalDocumentCategories.includes(Reflect.get(file, 'category') as MedicalDocumentCategory)
              ? Reflect.get(file, 'category') as MedicalDocumentCategory
              : undefined,
            description: typeof Reflect.get(file, 'description') === 'string' ? Reflect.get(file, 'description') as string : undefined,
            uploadedByUserId: typeof Reflect.get(file, 'uploadedByUserId') === 'string' ? Reflect.get(file, 'uploadedByUserId') as string : undefined,
            uploaderRole: ['receptionist', 'doctor', 'admin'].includes(String(Reflect.get(file, 'uploaderRole')))
              ? Reflect.get(file, 'uploaderRole') as StaffRole
              : undefined,
          }]
          : []
      })
      : []
    return {
      id,
      patientId: String(data.patientId ?? ''),
      appointmentId: String(data.appointmentId ?? ''),
      hospitalId: data.hospitalId as HospitalId,
      doctorId: String(data.doctorId ?? ''),
      visitDate: String(data.visitDate ?? ''),
      diagnosis: String(data.diagnosis ?? ''),
      allergies: String(data.allergies ?? ''),
      chronicConditions: String(data.chronicConditions ?? ''),
      currentMedicines: String(data.currentMedicines ?? ''),
      prescription: String(data.prescription ?? ''),
      notes: String(data.notes ?? ''),
      followUpDate: String(data.followUpDate ?? ''),
      pdfFiles,
      consentAt: data.consentAt instanceof Timestamp ? data.consentAt : null,
      createdBy: String(data.createdBy ?? ''),
      createdAt: data.createdAt instanceof Timestamp ? data.createdAt : null,
      updatedAt: data.updatedAt instanceof Timestamp ? data.updatedAt : null,
    }
}

function medicalDocumentContentType(fileName: string) {
  const extension = fileName.toLowerCase().split('.').pop()
  if (extension === 'pdf') return 'application/pdf'
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'png') return 'image/png'
  return null
}

function validateMedicalDocuments(files: File[]) {
    for (const file of files) {
      const expectedContentType = medicalDocumentContentType(file.name)
      if (!expectedContentType || (file.type && file.type !== expectedContentType)) {
        throw new Error(`${file.name} must be a PDF, JPG, JPEG, or PNG file.`)
      }
      if (file.size === 0 || file.size > 10 * 1024 * 1024) {
        throw new Error(`${file.name} must be no larger than 10 MB.`)
      }
    }
}

function hasValidMedicalDocumentSignature(contentType: string, bytes: Uint8Array) {
    if (contentType === 'application/pdf') {
      return new TextDecoder('ascii').decode(bytes).includes('%PDF-')
    }
    if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (contentType === 'image/png') {
      return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)
    }
    return false
}

async function uploadMedicalDocument(
  file: File,
  hospitalId: string,
  patientId: string,
  recordId: string,
  category: MedicalDocumentCategory,
  description: string,
  onProgress: (progress: number) => void,
): Promise<MedicalDocument> {
    if (!storage) throw new Error('The local CareFlow file service is unavailable.')
    validateMedicalDocuments([file])
    const contentType = medicalDocumentContentType(file.name)
    if (!contentType || !hasValidMedicalDocumentSignature(contentType, new Uint8Array(await file.slice(0, 1024).arrayBuffer()))) {
      throw new Error(`${file.name} does not contain a valid ${contentType === 'application/pdf' ? 'PDF' : contentType === 'image/jpeg' ? 'JPEG' : 'PNG'} file signature.`)
    }
    const extension = contentType === 'application/pdf' ? 'pdf' : contentType === 'image/jpeg' ? 'jpg' : 'png'
    const path = `records/${hospitalId}/${patientId}/${recordId}.${extension}`
    const task = uploadBytesResumable(storageRef(storage, path), file, {
      contentType,
      customMetadata: { recordId, category, description: description.trim() },
    })
    let uploadedFile: {
      id: string
      name: string
      path: string
      uploadedAt: { seconds: number; nanoseconds: number }
      contentType: string
      category: MedicalDocumentCategory
      description: string
      uploadedByUserId: string
      uploaderRole: StaffRole
    } | undefined
    await new Promise<void>((resolve, reject) => {
      task.on('state_changed',
        (snapshot) => onProgress(snapshot.totalBytes === 0 ? 0 : Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100)),
        reject,
        () => {
          uploadedFile = task.result
          resolve()
        },
      )
    })
    if (!uploadedFile) throw new Error('The local server did not confirm the uploaded medical document.')
    return { ...uploadedFile, uploadedAt: new Timestamp(uploadedFile.uploadedAt.seconds, uploadedFile.uploadedAt.nanoseconds) }
}

const statusLabels: Record<TicketStatus, string> = {
  waiting: 'Waiting',
  called: 'Please come in',
  arrived: 'Arrived',
  completed: 'Completed',
  no_show: 'No-show',
}

const appointmentStatusLabels: Record<AppointmentStatus, string> = {
  pending: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  rescheduled: 'New time suggested',
  declined: 'Declined',
  cancelled: 'Cancelled',
  completed: 'Completed',
  no_show: 'Missed appointment',
}

function toTicket(snapshot: QueryDocumentSnapshot<DocumentData>): Ticket {
  return {
    id: snapshot.id,
    code: String(snapshot.data().code ?? snapshot.id.slice(0, 6)).toUpperCase(),
    hospitalId: String(snapshot.data().hospitalId ?? ''),
    department: snapshot.data().department as Department,
    status: snapshot.data().status as TicketStatus,
    createdAt: snapshot.data().createdAt ?? null,
  }
}

function formatTime(createdAt: Ticket['createdAt']) {
  if (!createdAt?.seconds) return 'Just now'
  return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(createdAt.seconds * 1000),
  )
}

function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button className="icon-button" onClick={onClose} aria-label="Dismiss error"><X size={16} /></button>
    </div>
  )
}

function Brand({ onClick }: { onClick: () => void }) {
  return (
    <button className="brand" onClick={onClick} aria-label="CareFlow home">
      <span className="brand-mark"><HeartPulse size={21} strokeWidth={2.1} /></span>
      <span>careflow<span className="brand-period">.</span></span>
    </button>
  )
}

export default function App() {
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).has('appointment') ? 'appointment-status' : 'patient')
  const [language, setLanguage] = useState<PatientLanguage>(() => {
    const saved = window.localStorage.getItem('careflow-language')
    return saved === 'hi' || saved === 'mr' ? saved : 'en'
  })
  const [user, setUser] = useState<User | null>(null)
  const [isStaff, setIsStaff] = useState(false)
  const [staffRole, setStaffRole] = useState<StaffRole | null>(null)
  const [staffHospital, setStaffHospital] = useState<Hospital | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [error, setError] = useState('')
  const [ticketId, setTicketId] = useState(() => new URLSearchParams(window.location.search).get('ticket'))
  const [appointmentId, setAppointmentId] = useState(() => new URLSearchParams(window.location.search).get('appointment'))
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [ticketMissing, setTicketMissing] = useState(false)
  const [ticketError, setTicketError] = useState('')
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [selectedPatient, setSelectedPatient] = useState<SelectedPatient | null>(null)
  const [isOnline, setIsOnline] = useState(window.navigator.onLine)
  const [retryVersion, setRetryVersion] = useState(0)

  useEffect(() => {
    window.localStorage.setItem('careflow-language', language)
  }, [language])

  useEffect(() => {
    const updateOnlineState = () => setIsOnline(window.navigator.onLine)
    window.addEventListener('online', updateOnlineState)
    window.addEventListener('offline', updateOnlineState)
    return () => {
      window.removeEventListener('online', updateOnlineState)
      window.removeEventListener('offline', updateOnlineState)
    }
  }, [])

  useEffect(() => {
    if (!auth) {
      setAuthReady(true)
      return
    }
    return onAuthStateChanged(auth, async (nextUser) => {
      let staffAccount = false
      let accountRole: StaffRole | null = null
      let assignedHospital: Hospital | null = null
      if (nextUser && !nextUser.isAnonymous) {
        try {
          const token = await getIdTokenResult(nextUser)
          const hospital = getHospital(token.claims.hospitalId)
          const claimedRole = token.claims.role
          accountRole = claimedRole === 'receptionist' || claimedRole === 'doctor' || claimedRole === 'admin'
            ? claimedRole
            : token.claims.staff === true && claimedRole === undefined ? 'receptionist' : null
          staffAccount = token.claims.staff === true && Boolean(hospital) && accountRole !== null
          assignedHospital = staffAccount ? hospital ?? null : null
          if (token.claims.staff === true && !accountRole) {
            setError('This staff account has no valid role. Contact your administrator.')
          }
          if (token.claims.staff === true && !hospital) {
            setError('This staff account has no valid hospital assignment. Contact your administrator.')
          }
        } catch (reason) {
          setError(reason instanceof Error ? `Unable to verify account access: ${reason.message}` : 'Unable to verify account access.')
          setAuthReady(true)
          return
        }
      }
      setUser(nextUser)
      setIsStaff(staffAccount)
      setStaffRole(staffAccount ? accountRole : null)
      setStaffHospital(assignedHospital)
      setAuthReady(true)
      setView((currentView) => staffAccount
        ? new URLSearchParams(window.location.search).has('ticket')
          ? 'patient'
          : currentView === 'staff-inbox' ? currentView : 'staff'
        : currentView === 'staff' || currentView === 'staff-inbox' ? 'patient' : currentView)
    })
  }, [])

  useEffect(() => {
    if (view !== 'appointment-status' || !auth || !authReady || auth.currentUser) return
    let active = true
    signInAnonymously(auth).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? `Unable to open appointment status: ${reason.message}` : 'Unable to open appointment status.')
    })
    return () => { active = false }
  }, [view, authReady])

  useEffect(() => {
    if (!db || !ticketId) {
      setTicket(null)
      setTicketMissing(false)
      setTicketError('')
      return
    }
    setTicketMissing(false)
    setTicketError('')
    return onSnapshot(
      doc(db, 'tracking', ticketId),
      (snapshot) => {
        if (!snapshot.exists()) {
          setTicket(null)
          setTicketMissing(true)
          return
        }
        const data = snapshot.data()
        setTicket({
          id: ticketId,
          code: String(data.code ?? ticketId.slice(0, 6)).toUpperCase(),
          hospitalId: String(data.hospitalId ?? ''),
          department: data.department as Department,
          status: data.status as TicketStatus,
          createdAt: data.createdAt ?? null,
        })
      },
      (reason) => setTicketError(reason.message),
    )
  }, [ticketId])

  useEffect(() => {
    if (!db || view !== 'staff' || !user || !isStaff || !staffHospital) {
      setTickets([])
      return
    }
    return onSnapshot(
      query(collection(db, 'tickets'), where('hospitalId', '==', staffHospital.id)),
      (snapshot) => setTickets(snapshot.docs.map(toTicket)),
      (reason) => setError(`Unable to load the queue: ${reason.message}`),
    )
  }, [view, user, isStaff, staffHospital])

  const showTicket = (id: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('ticket', id)
    url.searchParams.delete('checkin')
    url.hash = ''
    window.history.pushState({}, '', url)
    setTicketId(id)
    setView('patient')
  }

  const trackTicket = async (value: string) => {
    if (!db) {
      setError('The local CareFlow server is not available, so tickets cannot be looked up.')
      return
    }
    const normalizedValue = value.trim()
    if (!normalizedValue) return
    try {
      const directTicket = await getDoc(doc(db, 'tracking', normalizedValue))
      if (directTicket.exists()) {
        showTicket(directTicket.id)
        return
      }
      const ticketMatches = await getDocs(
        query(
          collection(db, 'tracking'),
          where('code', '==', normalizedValue.toUpperCase()),
          limit(1),
        ),
      )
      if (!ticketMatches.empty) {
        showTicket(ticketMatches.docs[0].id)
        return
      }
      showTicket(normalizedValue)
    } catch (reason) {
      const code = typeof reason === 'object' && reason !== null && 'code' in reason && typeof reason.code === 'string'
        ? reason.code
        : undefined
      if (code === 'permission-denied') {
        setError('CareFlow denied ticket lookup. Check your account and hospital access, then try again.')
      } else {
        setError(reason instanceof Error ? `Unable to look up ticket: ${reason.message}` : 'Unable to look up ticket.')
      }
    }
  }

  const clearTicket = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('ticket')
    window.history.pushState({}, '', url)
    setTicketId(null)
    setTicket(null)
    setTicketMissing(false)
    setTicketError('')
  }

  const logout = async () => {
    if (!auth) return
    try {
      await signOut(auth)
      setView('patient')
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to sign out.')
    }
  }

  const staffReady = Boolean(user && isStaff)
  const patientAccount = Boolean(user && !user.isAnonymous && !isStaff)
  const activeTicket = ticketId && !ticketMissing
  const openAppointmentStatus = async () => {
    if (!auth) {
      setError('The local CareFlow server is not available, so appointment status cannot be loaded.')
      return
    }
    try {
      if (!auth.currentUser) await signInAnonymously(auth)
      setError('')
      setView('appointment-status')
    } catch (reason) {
      setError(reason instanceof Error ? `Unable to open appointment status: ${reason.message}` : 'Unable to open appointment status.')
    }
  }
  const openAppointmentRequest = async () => {
    if (!auth) {
      setError('The local CareFlow server is not available, so appointment requests cannot be sent.')
      return
    }
    try {
      if (!auth.currentUser) await signInAnonymously(auth)
      setError('')
      setView('appointment-request')
    } catch (reason) {
      setError(reason instanceof Error ? `Unable to open appointment request: ${reason.message}` : 'Unable to open appointment request.')
    }
  }

  const t = (text: string) => translatePatientText(language, text)

  return (
    <PatientLanguageContext.Provider value={{ language, setLanguage }}>
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Brand onClick={() => { clearTicket(); setView('patient') }} />
          <nav className="top-nav" aria-label="Main navigation">
            {staffReady && (view.startsWith('staff') || activeTicket) ? (
              <>
                <span className="staff-identity"><span className="online-dot" /> {activeTicket && !view.startsWith('staff') ? 'Patient QR details' : view === 'staff-inbox' ? 'Request inbox' : view === 'staff-today' ? 'My patients today' : view === 'staff-history' ? 'Patient history' : view === 'staff-search' ? 'Patient search' : view === 'staff-privacy' ? 'Privacy requests' : view === 'staff-notifications' ? 'Patient messages' : 'Staff dashboard'}</span>
                <button className="nav-login" onClick={logout}><LogOut size={15} /> Sign out</button>
              </>
            ) : patientAccount ? (
              <>
                <span className="staff-identity"><span className="online-dot" /> {user?.email}</span>
                <button className="nav-login" onClick={logout}><LogOut size={15} /> Sign out</button>
                <button className="nav-login" onClick={() => { setError(''); setView('staff') }}>Staff login <ArrowUpRight size={15} /></button>
              </>
            ) : (
              <>
                <span className="nav-promise"><ShieldCheck size={16} /> Your visit, made simpler</span>
                <button className="nav-login" onClick={() => { setError(''); setView('patient-auth') }}>Patient account <ArrowUpRight size={15} /></button>
                <button className="nav-login" onClick={() => { setError(''); setView('staff') }}>Staff login <ArrowUpRight size={15} /></button>
              </>
            )}
            <PatientLanguagePicker />
          </nav>
        </div>
      </header>

      {error && <div className="global-error"><ErrorBanner message={error} onClose={() => setError('')} /><button className="retry-button" onClick={() => { setError(''); setRetryVersion((value) => value + 1) }}>{t('Try again')}</button></div>}

      {!isOnline && <div className="offline-banner" role="status">{t('You are offline. Some information may be old.')}</div>}

      <div key={retryVersion}>
      {view === 'staff' || view === 'staff-inbox' ? (
        staffReady
          ? view === 'staff-inbox'
            ? <RequestInbox hospital={staffHospital} role={staffRole} onBack={() => setView('staff')} onError={setError} />
            : <StaffDashboard
              tickets={tickets}
              hospital={staffHospital}
              onOpenInbox={() => setView('staff-inbox')}
              onOpenScheduler={() => setView('staff-scheduler')}
              onOpenDoctors={() => setView('staff-doctors')}
              onOpenSearch={() => setView('staff-search')}
              onOpenToday={() => setView('staff-today')}
              role={staffRole}
              onCreateRequest={() => setView('staff-create')}
              onOpenPrivacy={() => setView('staff-privacy')}
              onOpenNotifications={() => setView('staff-notifications')}
              onLogout={logout}
              onError={setError}
            />
          : <StaffLogin authReady={authReady} onBack={() => { setError(''); setView('patient') }} onError={setError} />
      ) : view === 'staff-scheduler' ? (
        staffReady ? <SlotScheduler hospital={staffHospital} role={staffRole} onBack={() => setView('staff')} onError={setError} /> : <StaffLogin authReady={authReady} onBack={() => setView('patient')} onError={setError} />
      ) : view === 'staff-doctors' ? (
        staffReady ? <DoctorAvailability hospital={staffHospital} role={staffRole} onBack={() => setView('staff')} onError={setError} /> : <StaffLogin authReady={authReady} onBack={() => setView('patient')} onError={setError} />
      ) : view === 'staff-search' ? (
        staffReady ? <PatientSearch hospital={staffHospital} onBack={() => setView('staff')} onError={setError} onOpenHistory={(patient) => { setSelectedPatient(patient); setView('staff-history') }} /> : <StaffLogin authReady={authReady} onBack={() => setView('patient')} onError={setError} />
      ) : view === 'staff-history' ? (
        staffReady && selectedPatient
          ? <PatientHistoryPage patient={selectedPatient} hospital={staffHospital} role={staffRole} patientView={false} onBack={() => setView('staff-search')} onError={setError} />
          : <StaffLogin authReady={authReady} onBack={() => setView('staff')} onError={setError} />
      ) : view === 'staff-privacy' ? (
        staffReady && staffRole === 'admin'
          ? <PrivacyRequestsPage onBack={() => setView('staff')} onError={setError} />
          : <StaffLogin authReady={authReady} onBack={() => setView('staff')} onError={setError} />
      ) : view === 'staff-notifications' ? (
        staffReady && (staffRole === 'admin' || staffRole === 'receptionist')
          ? <NotificationQueuePage hospital={staffHospital} onBack={() => setView('staff')} onError={setError} />
          : <StaffLogin authReady={authReady} onBack={() => setView('staff')} onError={setError} />
      ) : view === 'staff-today' ? (
        staffReady && staffRole === 'doctor'
          ? <DoctorTodayPage hospital={staffHospital} userId={user?.uid ?? ''} onBack={() => setView('staff')} onError={setError} />
          : <StaffLogin authReady={authReady} onBack={() => setView('staff')} onError={setError} />
      ) : view === 'staff-create' ? (
        staffReady ? <CreateRequestOnBehalf hospital={staffHospital} role={staffRole} onBack={() => setView('staff')} onError={setError} onCreated={(id) => {
          const url = new URL(window.location.href)
          url.searchParams.set('appointment', id)
          window.history.pushState({}, '', url)
          setAppointmentId(id)
          setView('appointment-status')
        }} /> : <StaffLogin authReady={authReady} onBack={() => setView('patient')} onError={setError} />
      ) : view === 'patient-auth' ? (
        <PatientAuth authReady={authReady} onBack={() => { setError(''); setView('patient') }} onDone={() => { setError(''); setView('patient') }} onError={setError} />
      ) : view === 'appointment-request' ? (
        <AppointmentRequestPage onBack={() => setView('patient')} onError={setError} onSubmitted={(id) => {
          const url = new URL(window.location.href)
          url.searchParams.set('appointment', id)
          window.history.pushState({}, '', url)
          setAppointmentId(id)
          setView('appointment-status')
        }} />
      ) : view === 'appointment-status' ? (
        user || auth?.currentUser ? <AppointmentStatusPage appointmentId={appointmentId} userId={user?.uid ?? auth?.currentUser?.uid ?? null} authReady={authReady} onBack={() => {
          const url = new URL(window.location.href)
          url.searchParams.delete('appointment')
          window.history.pushState({}, '', url)
          setAppointmentId(null)
          setView('patient')
        }} onError={setError} /> : <main className="appointment-page"><div className="appointment-empty"><span className="spinner dark-spinner" /><p>{t('Loading your requests…')}</p></div></main>
      ) : view === 'patient-records' ? (
        <PatientHistoryPage patient={user ? { id: user.uid, details: emptyPatientDetails(), mobileNumber: '' } : null} hospital={null} role={null} patientView onBack={() => setView('patient')} onError={setError} />
      ) : activeTicket ? (
        <TicketTracking
          ticket={ticket}
          missing={ticketMissing}
          error={ticketError}
          isStaff={staffReady}
          staffHospital={staffHospital}
          onStaffLogin={() => { setError(''); setView('staff') }}
          onBack={clearTicket}
        />
      ) : (
        <PatientHome
          onTicketCreated={showTicket}
          onError={setError}
          onTrackTicket={trackTicket}
          onRequestAppointment={() => void openAppointmentRequest()}
          onCheckAppointmentStatus={openAppointmentStatus}
          onMyRecords={async () => {
            if (!auth) {
              setError('The local CareFlow server is not available, so patient records cannot be loaded.')
              return
            }
            try {
              if (!auth.currentUser) await signInAnonymously(auth)
              setView('patient-records')
            } catch (reason) {
              setError(reason instanceof Error ? `Unable to open patient records: ${reason.message}` : 'Unable to open patient records.')
            }
          }}
          focusCheckIn={new URLSearchParams(window.location.search).get('checkin') === '1'}
        />
      )}
      </div>

      <footer className="footer">
        <span>© 2026 CareFlow Health</span>
        <span><ShieldCheck size={14} /> Private by design</span>
        <button onClick={() => setView(view === 'staff' ? 'patient' : 'staff')}>Need help?</button>
      </footer>
    </div>
    </PatientLanguageContext.Provider>
  )
}

function PatientHome({
  onTicketCreated,
  onError,
  onTrackTicket,
  onRequestAppointment,
  onCheckAppointmentStatus,
  onMyRecords,
  focusCheckIn,
}: {
  onTicketCreated: (id: string) => void
  onError: (message: string) => void
  onTrackTicket: (id: string) => void
  onRequestAppointment: () => void
  onCheckAppointmentStatus: () => void
  onMyRecords: () => void
  focusCheckIn: boolean
}) {
  const t = usePatientText()
  const [hospitalId, setHospitalId] = useState<HospitalId>(hospitals[0].id)
  const [selected, setSelected] = useState<Department>('General medicine')
  const [creating, setCreating] = useState(false)
  const [showDepartments, setShowDepartments] = useState(false)
  const [lookup, setLookup] = useState('')
  const [consentGiven, setConsentGiven] = useState(false)
  const [patientDetails, setPatientDetails] = useState<PatientDetails>(emptyPatientDetails)
  const selectedDepartment = departments.find((item) => item.name === selected) ?? departments[0]
  const SelectedIcon = selectedDepartment.icon
  const checkInUrl = new URL(window.location.href)
  checkInUrl.searchParams.delete('ticket')
  checkInUrl.searchParams.set('checkin', '1')
  checkInUrl.hash = 'check-in'

  useEffect(() => {
    if (!focusCheckIn) return
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('check-in')?.scrollIntoView({ block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [focusCheckIn])

  const updatePatientDetails = (field: keyof PatientDetails, value: string) => {
    setPatientDetails((current) => ({ ...current, [field]: value }))
  }

  const checkIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!auth || !db) {
      onError('The local CareFlow server is not available. Start it with `npm run start`, then try again.')
      return
    }
    const detailsToSave = normalizePatientDetails(patientDetails)
    if (!consentGiven || !hasRequiredPatientDetails(detailsToSave)) {
      onError('Enter your name and mobile number, then agree to share these details with your selected hospital.')
      return
    }
    setCreating(true)
    try {
      const credential = auth.currentUser ? undefined : await signInAnonymously(auth)
      const ownerUid = credential?.user.uid ?? auth.currentUser?.uid
      if (!ownerUid) throw new Error('Could not establish a patient session. Please try again.')
      const ticketRef = doc(collection(db, 'tickets'))
      const code = ticketRef.id.slice(0, 6).toUpperCase()
      const trackingRef = doc(db, 'tracking', ticketRef.id)
      const patientDetailsRef = doc(db, 'patientDetails', ticketRef.id)
      await runTransaction(db, async (transaction) => {
        transaction.set(ticketRef, {
          code,
          hospitalId,
          department: selected,
          status: 'waiting',
          ownerUid,
          createdAt: serverTimestamp(),
        })
        transaction.set(trackingRef, {
          code,
          hospitalId,
          department: selected,
          status: 'waiting',
          ownerUid,
          createdAt: serverTimestamp(),
        })
        transaction.set(patientDetailsRef, {
          ownerUid,
          hospitalId,
          details: detailsToSave,
          consentAt: serverTimestamp(),
        })
      })
      onTicketCreated(ticketRef.id)
    } catch (reason) {
      const code = typeof reason === 'object' && reason !== null && 'code' in reason && typeof reason.code === 'string'
        ? reason.code
        : undefined
      if (code === 'auth/admin-restricted-operation' || code === 'auth/operation-not-allowed') {
        onError('Could not start a patient session. Check that the CareFlow server is running, then try again.')
      } else if (code === 'permission-denied') {
        onError('CareFlow denied ticket creation. Check your hospital selection and patient details, then try again.')
      } else {
        onError(reason instanceof Error ? reason.message : 'Could not create your ticket. Please try again.')
      }
    } finally {
      setCreating(false)
    }
  }

  const trackExisting = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const id = lookup.trim()
    if (id) onTrackTicket(id)
  }

  return (
    <main className={focusCheckIn ? 'checkin-only-page' : undefined}>
      {!focusCheckIn && <section className="patient-actions-section" aria-label="Patient services">
        <div className="patient-actions-heading">
          <div className="eyebrow"><span className="eyebrow-line" /> {t('CARE THAT FITS YOUR JOURNEY')}</div>
          <h1>{t('Plan your care before you travel.')}</h1>
          <p>{t('Request a visit, then check for a confirmed time before setting out.')}</p>
        </div>
        <div className="patient-action-grid">
          <button className="patient-action-card patient-action-primary" onClick={onRequestAppointment}>
            <span className="patient-action-icon"><CalendarDays size={21} /></span>
            <span><strong>{t('Request Appointment')}</strong><small>{t('Ask the hospital to confirm a date and time.')}</small></span>
            <ArrowRight size={17} />
          </button>
          <button className="patient-action-card" onClick={onCheckAppointmentStatus}>
            <span className="patient-action-icon"><Activity size={21} /></span>
            <span><strong>{t('Check Status')}</strong><small>{t('See live updates to your appointment requests.')}</small></span>
            <ArrowRight size={17} />
          </button>
          <button className="patient-action-card" onClick={onMyRecords}>
            <span className="patient-action-icon"><ClipboardList size={21} /></span>
            <span><strong>{t('My Records')}</strong><small>{t('Your patient record space.')}</small></span>
            <ArrowRight size={17} />
          </button>
        </div>
      </section>}
      {!focusCheckIn && <section className="hero-section">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> {t('A BETTER WAY TO WAIT')}</div>
          <h1>{t('More care.')}<br /><span>{t('Less waiting.')}</span></h1>
          <p className="hero-subtitle">{t('Join your hospital queue from anywhere. We’ll let you know when it’s your turn — so you can focus on feeling better.')}</p>
          <div className="hero-actions">
            <a className="button button-primary" href="#check-in">{t('Get your place in line')} <ArrowRight size={17} /></a>
            <a className="text-link" href="#how-it-works">{t('How it works')} <ArrowRight size={15} /></a>
          </div>
          <div className="trust-line"><div className="avatar-stack"><span>J</span><span>M</span><span>A</span><span>+</span></div><span>Helping patients feel <strong>in control</strong></span></div>
        </div>
        <div className="hero-art" aria-label="Illustration of a patient checking their place in a hospital queue">
          <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
          <div className="art-sun" />
          <div className="clinic-card">
            <div className="clinic-card-head"><span className="clinic-icon"><Hospital size={17} /></span><span>YOUR VISIT TODAY</span><span className="live-pill"><span /> LIVE</span></div>
            <div className="clinic-status"><span className="status-wave"><Activity size={21} /></span><div><strong>{t('You’re in good hands.')}</strong><span>{t('Your care team is ready for you.')}</span></div></div>
              <div className="mini-queue"><div><span className="queue-dot current" /><strong>{t('You’re checked in')}</strong><small>{t('Right on track')}</small></div><div className="mini-queue-count">01</div></div>
              <div className="mini-queue"><div><span className="queue-dot next" /><strong>{t('We’ll call you next')}</strong><small>{t('Keep your phone close')}</small></div><Clock3 className="mini-clock" size={19} /></div>
              <div className="card-footer"><ShieldCheck size={14} /> {t('Your place is saved securely')}</div>
          </div>
          <div className="floating-note"><span className="note-icon"><Bell size={17} /></span><span><strong>{t("You're all set")}</strong><small>{t('No need to wait in line')}</small></span><CheckCircle2 size={17} className="note-check" /></div>
          <div className="art-caption">{t('Care that moves with you')} <span>✳</span></div>
        </div>
      </section>}

      <section className={`checkin-section${focusCheckIn ? ' checkin-focused' : ''}`} id="check-in">
        <div className="section-heading">
          <div><div className="eyebrow"><span className="eyebrow-line" /> {t('QUICK & EASY')}</div><h2>{t('Start with a check-in.')}</h2></div>
          <p>{t('No account, no paperwork.')}<br />{t('Just a few taps to get started.')}</p>
        </div>
        <div className="checkin-card">
          <div className="checkin-card-main">
            <div className="step-label"><span>01</span> {t('CHOOSE A HOSPITAL')}</div>
            <label className="hospital-field" htmlFor="patient-hospital">
              <span className="sr-only">Hospital</span>
              <Hospital size={17} />
              <select id="patient-hospital" value={hospitalId} onChange={(event) => {
                const hospital = getHospital(event.target.value)
                if (hospital) setHospitalId(hospital.id)
              }}>
                {hospitals.map((hospital) => <option key={hospital.id} value={hospital.id}>{hospital.name}</option>)}
              </select>
              <ChevronDown size={16} />
            </label>
            <div className="checkin-divider" />
            <div className="step-label"><span>02</span> {t('CHOOSE A DEPARTMENT')}</div>
            <button className="department-select" onClick={() => setShowDepartments(!showDepartments)} aria-expanded={showDepartments}>
              <span className={`department-icon ${selectedDepartment.color}`}><SelectedIcon size={20} /></span>
              <span className="department-name"><strong>{t(selected)}</strong><small>{t(selectedDepartment.detail)}</small></span>
              <ChevronDown size={18} className={showDepartments ? 'chevron-open' : ''} />
            </button>
            {showDepartments && <div className="department-menu">{departments.map((department) => {
              const Icon = department.icon
              return <button key={department.name} className={department.name === selected ? 'department-option selected-option' : 'department-option'} onClick={() => { setSelected(department.name); setShowDepartments(false) }}><span className={`department-icon ${department.color}`}><Icon size={18} /></span><span><strong>{t(department.name)}</strong><small>{t(department.detail)}</small></span>{department.name === selected && <Check size={16} />}</button>
            })}</div>}
            <div className="checkin-divider" />
            <div className="step-label"><span>03</span> {t('PATIENT DETAILS')}</div>
            <p className="checkin-description">{t('Enter your name and mobile number so the care team can identify and contact you.')}</p>
            <form className="patient-details-form" onSubmit={checkIn}>
              <PatientDetailsFields patientDetails={patientDetails} updatePatientDetails={updatePatientDetails} />
              <label className="patient-consent">
                <input type="checkbox" required checked={consentGiven} onChange={(event) => setConsentGiven(event.target.checked)} />
                <span>{t('I agree to share these details with the care team at my selected hospital for this visit.')}</span>
              </label>
              <p className="patient-privacy-note"><ShieldCheck size={14} /> {t('Personal details are stored separately from your public ticket QR and are readable only by you and staff assigned to this hospital.')}</p>
              <div className="checkin-divider" />
              <div className="step-label"><span>04</span> {t('GET YOUR DIGITAL TICKET')}</div>
              <p className="checkin-description">{t('We’ll save your place and create a QR ticket you can show at the hospital.')}</p>
              <button className="button button-dark checkin-button" type="submit" disabled={creating || !isBackendConfigured}>{creating ? <><span className="spinner" /> {t('Saving your place…')}</> : <>{t('Check in now')} <ArrowRight size={17} /></>}</button>
            </form>
          </div>
          {!focusCheckIn && <div className="checkin-card-side">
            <div className="side-top"><span className="side-icon"><QrCode size={18} /></span><span>SELF-SERVICE CHECK-IN QR</span></div>
            <h3>Check in on<br />your phone.</h3>
            <p>Scan this QR code to open the check-in form. Patients can enter their own details and join the queue.</p>
            <div className="sample-qr"><QRCodeSVG value={checkInUrl.toString()} size={74} bgColor="transparent" fgColor="#183a34" level="M" /><span><strong>Scan to check in</strong><small>Fill in your details</small></span></div>
            <div className="side-decoration">✳</div>
          </div>}
        </div>
        {!focusCheckIn && <form className="track-form" onSubmit={trackExisting}>
          <ScanLine size={17} /><label htmlFor="ticket-code">Already have a ticket?</label><input id="ticket-code" value={lookup} onChange={(event) => setLookup(event.target.value)} placeholder="Ticket number or ID" /><button type="submit" disabled={!lookup.trim()}>Track ticket <ArrowRight size={15} /></button>
        </form>}
      </section>

        {!focusCheckIn && <section className="hospital-contact-section">
          <div className="section-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> {t('HOSPITAL CONTACTS')}</div><h2>{t('Contact your hospital.')}</h2></div></div>
          <div className="hospital-contact-grid">{hospitals.map((hospital) => <article className="hospital-contact-card" key={hospital.id}>
            <strong>{hospital.name}</strong>
            <p>{hospital.address || t('Hospital address not configured')}</p>
            <div className="hospital-contact-actions">
              {hospital.phone && <a className="button button-outline" href={`tel:${hospital.phone.replace(/[^\d+]/g, '')}`}><Phone size={15} /> {t('Call hospital')}</a>}
              {hospital.whatsapp && <a className="button button-outline" href={getWhatsAppUrl(hospital.whatsapp, `Hello, I need help with an appointment at ${hospital.name}.`)} target="_blank" rel="noreferrer"><MessageCircle size={15} /> {t('WhatsApp hospital')}</a>}
              <a className="text-link" href={getHospitalMapUrl(hospital)} target="_blank" rel="noreferrer"><MapPin size={15} /> {t('Google Maps')}</a>
            </div>
          </article>)}</div>
        </section>}

        {!focusCheckIn && <section className="steps-section" id="how-it-works">
        <div className="steps-title"><div className="eyebrow"><span className="eyebrow-line" /> A LITTLE MORE PEACE OF MIND</div><h2>Here for you,<br /><span>every step.</span></h2></div>
        <div className="steps-grid">
          <article className="step-card"><span className="step-number">01</span><div className="step-art step-art-check"><span className="illustration-ring"><Check size={25} /></span><span className="tiny-spark spark-a">✳</span><span className="tiny-spark spark-b">✦</span></div><h3>Check in, your way.</h3><p>Choose the care you need and save your place in a few seconds.</p></article>
          <article className="step-card"><span className="step-number">02</span><div className="step-art step-art-qr"><div className="qr-demo"><QRCodeSVG value="careflow-ticket" size={60} bgColor="transparent" fgColor="#183a34" level="M" /></div><span className="qr-spark">✳</span></div><h3>Keep your ticket close.</h3><p>Your QR ticket is always on your phone. No paper, no stress.</p></article>
          <article className="step-card"><span className="step-number">03</span><div className="step-art step-art-bell"><div className="bell-illustration"><Bell size={27} /></div><span className="bell-wave wave-one" /><span className="bell-wave wave-two" /><span className="bell-dot">✦</span></div><h3>We’ll call when it’s time.</h3><p>Follow live updates and be ready when your care team calls.</p></article>
        </div>
      </section>}
      {!focusCheckIn && <section className="bottom-cta"><span className="cta-spark">✳</span><div><span>YOUR TIME MATTERS</span><h2>A calmer visit starts here.</h2></div><a className="button button-light" href="#check-in">Get checked in <ArrowRight size={16} /></a></section>}
    </main>
  )
}

function emptyPatientDetails(): PatientDetails {
  return {
    name: '',
    mobileNumber: '',
  }
}

function normalizePatientDetails(details: PatientDetails): PatientDetails {
  return {
    name: patientFullName(details),
    mobileNumber: details.mobileNumber.trim(),
  }
}

function hasRequiredPatientDetails(details: PatientDetails) {
  return Boolean(details.name && details.mobileNumber)
}

function PatientDetailsFields({
  patientDetails,
  updatePatientDetails,
}: {
  patientDetails: PatientDetails
  updatePatientDetails: (field: keyof PatientDetails, value: string) => void
}) {
  const t = usePatientText()
  return (
    <div className="patient-details-grid">
      <label className="patient-field">{t('Full name')}<input required autoComplete="name" maxLength={200} value={patientDetails.name} onChange={(event) => updatePatientDetails('name', event.target.value)} /></label>
      <label className="patient-field">{t('Mobile number')}<input required type="tel" autoComplete="tel" maxLength={24} value={patientDetails.mobileNumber} onChange={(event) => updatePatientDetails('mobileNumber', event.target.value)} /></label>
    </div>
  )
}

function AppointmentRequestPage({ onBack, onError, onSubmitted }: { onBack: () => void; onError: (message: string) => void; onSubmitted: (trackingId: string) => void }) {
  const t = usePatientText()
  const [hospitalId, setHospitalId] = useState<HospitalId>(hospitals[0].id)
  const [department, setDepartment] = useState<Department>('General medicine')
  const [requestedDate, setRequestedDate] = useState(getLocalDateInputValue)
  const [availableDoctors, setAvailableDoctors] = useState<Doctor[]>([])
  const [availableSlots, setAvailableSlots] = useState<AppointmentSlot[]>([])
  const [preferredDoctorId, setPreferredDoctorId] = useState('')
  const [requestedSlotId, setRequestedSlotId] = useState('')
  const [reason, setReason] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [companions, setCompanions] = useState(0)
  const [patientDetails, setPatientDetails] = useState<PatientDetails>(emptyPatientDetails)
  const [consentGiven, setConsentGiven] = useState(false)
  const [recordsConsentGiven, setRecordsConsentGiven] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const selectedHospital = getHospital(hospitalId)

  useEffect(() => {
    if (!db || !hospitalId || !requestedDate || !auth?.currentUser) {
      setAvailableDoctors([])
      setAvailableSlots([])
      setPreferredDoctorId('')
      setRequestedSlotId('')
      return
    }
    let active = true
    let doctorsForHospital: Doctor[] = []
    let slotsForDate: AppointmentSlot[] = []
    const publish = () => {
      if (!active) return
      const doctors = doctorsForHospital.filter((doctor) => doctor.department === department && doctor.status === 'available')
      const doctorIds = new Set(doctors.map((doctor) => doctor.id))
      const slots = slotsForDate.filter((slot) => doctorIds.has(slot.doctorId) && slot.booked < slot.capacity)
        .sort((a, b) => a.startTime.localeCompare(b.startTime))
      setAvailableDoctors(doctors)
      setAvailableSlots(slots)
      setPreferredDoctorId((current) => doctors.some((doctor) => doctor.id === current) ? current : '')
      setRequestedSlotId((current) => slots.some((slot) => slot.id === current) ? current : '')
    }
    const unsubscribeDoctors = onSnapshot(
      query(collection(db, 'doctors'), where('hospitalId', '==', hospitalId)),
      (snapshot) => {
        doctorsForHospital = snapshot.docs.map(getDoctor)
        publish()
      },
      (reason) => onError(`Unable to load hospital availability: ${reason.message}`),
    )
    const unsubscribeSlots = onSnapshot(
      query(collection(db, 'slots'), where('hospitalId', '==', hospitalId), where('date', '==', requestedDate)),
      (snapshot) => {
        slotsForDate = snapshot.docs.map(getSlot)
        publish()
      },
      (reason) => onError(`Unable to load available appointment slots: ${reason.message}`),
    )
    return () => {
      active = false
      unsubscribeDoctors()
      unsubscribeSlots()
    }
  }, [hospitalId, requestedDate, department, onError])

  const updatePatientDetails = (field: keyof PatientDetails, value: string) => {
    setPatientDetails((current) => ({ ...current, [field]: value }))
  }

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!auth || !db) {
      onError('The local CareFlow server is not available. Start it with `npm run start`, then try again.')
      return
    }
    const details = normalizePatientDetails(patientDetails)
    if (!consentGiven || !recordsConsentGiven || !hasRequiredPatientDetails(details) || !reason.trim() || !requestedDate) {
      onError('Complete the required patient and appointment details, and agree to both hospital sharing and medical-record storage.')
      return
    }
    setSubmitting(true)
    try {
      if (!auth.currentUser) await signInAnonymously(auth)
      const ownerUid = auth.currentUser?.uid
      if (!ownerUid) throw new Error('Could not establish a patient session. Please try again.')
      const patientRef = doc(db, 'patients', ownerUid)
      const appointmentRef = doc(collection(db, 'appointments'))
      const trackingRef = doc(collection(db, 'appointmentTracking'))
      const preferredSlot = availableSlots.find((slot) => slot.id === requestedSlotId)
      if (requestedSlotId && !preferredSlot) {
        throw new Error('That preferred slot is no longer available. Choose another slot or submit without a preference.')
      }
      if (preferredSlot && preferredDoctorId && preferredSlot.doctorId !== preferredDoctorId) {
        throw new Error('Choose a time offered by your selected doctor.')
      }
      await runTransaction(db, async (transaction) => {
        const patientSnapshot = await transaction.get(patientRef)
        const previousProfile = patientSnapshot.data()
        const hospitalIds = Array.isArray(previousProfile?.hospitalIds)
          ? [...new Set([...previousProfile.hospitalIds.filter((value): value is string => typeof value === 'string'), hospitalId])]
          : [hospitalId]
        transaction.set(patientRef, {
          ownerUid,
          hospitalIds,
          details,
          mobileNumber: details.mobileNumber,
          createdAt: previousProfile?.createdAt ?? serverTimestamp(),
        })
        transaction.set(appointmentRef, {
          trackingId: trackingRef.id,
          patientId: ownerUid,
          ownerUid,
          hospitalId,
          department,
          doctorId: '',
          slotId: '',
          requestedSlotId: preferredSlot?.id ?? '',
          requestedDoctorId: preferredSlot?.doctorId ?? preferredDoctorId,
          patientMobile: details.mobileNumber,
          requestedDate,
          reason: reason.trim(),
          urgent,
          companions,
          status: 'pending',
          assignedDate: '',
          assignedTime: '',
          staffNote: '',
          needsReschedule: false,
          patientAction: 'none',
          recordId: '',
          createdAt: serverTimestamp(),
          consentAt: serverTimestamp(),
          recordsConsentAt: serverTimestamp(),
        })
        transaction.set(trackingRef, {
          appointmentId: appointmentRef.id,
          ownerUid,
          hospitalId,
          department,
          status: 'pending',
          requestedDate,
          assignedDate: '',
          assignedTime: '',
          doctorName: '',
          needsReschedule: false,
        })
      })
      onError('')
      onSubmitted(trackingRef.id)
    } catch (reasonValue) {
      const code = typeof reasonValue === 'object' && reasonValue !== null && 'code' in reasonValue && typeof reasonValue.code === 'string'
        ? reasonValue.code
        : undefined
      if (code === 'permission-denied') {
        onError('CareFlow denied this appointment request. Check the patient details and consent, then try again.')
      } else {
        onError(reasonValue instanceof Error ? `Unable to send appointment request: ${reasonValue.message}` : 'Unable to send appointment request.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="appointment-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> {t('Back to CareFlow')}</button>
      <section className="appointment-form-card">
        <div className="eyebrow"><span className="eyebrow-line" /> {t('PLAN YOUR VISIT')}</div>
        <h1>{t('Request an appointment.')}</h1>
        <p className="appointment-intro">{t('The hospital will review your preferred date and send a confirmed time or an alternative suggestion. Wait for confirmation before travelling.')}</p>
        <form className="patient-details-form" onSubmit={submit}>
          <div className="appointment-fields-grid">
            <label className="patient-field patient-field-wide">{t('Hospital')}
              <select required value={hospitalId} onChange={(event) => {
                const hospital = getHospital(event.target.value)
                if (hospital) setHospitalId(hospital.id)
              }}>{hospitals.map((hospital) => <option key={hospital.id} value={hospital.id}>{hospital.name}</option>)}</select>
            </label>
            <label className="patient-field">{t('Department')}
              <select required value={department} onChange={(event) => setDepartment(event.target.value as Department)}>{departments.map((item) => <option key={item.name} value={item.name}>{t(item.name)}</option>)}</select>
            </label>
            <label className="patient-field">{t('Preferred date')}
              <input required type="date" min={getLocalDateInputValue()} value={requestedDate} onChange={(event) => setRequestedDate(event.target.value)} />
            </label>
            <label className="patient-field patient-field-wide">{t('Preferred doctor')}
              <select value={preferredDoctorId} onChange={(event) => {
                setPreferredDoctorId(event.target.value)
                setRequestedSlotId('')
              }}>
                <option value="">{t('Any available doctor')}</option>
                {availableDoctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
              </select>
            </label>
            <label className="patient-field patient-field-wide">{t('Preferred available time')}
              <select value={requestedSlotId} onChange={(event) => setRequestedSlotId(event.target.value)}>
                <option value="">{t('No preference — hospital can suggest a time')}</option>
                {availableSlots.filter((slot) => !preferredDoctorId || slot.doctorId === preferredDoctorId).map((slot) => {
                  const doctor = availableDoctors.find((item) => item.id === slot.doctorId)
                  return <option key={slot.id} value={slot.id}>{slot.startTime} · {doctor?.name ?? 'Doctor'} · {slot.capacity - slot.booked} available</option>
                })}
              </select>
              <small>{availableSlots.length ? t('The hospital will confirm this preference. Your request is not booked until staff confirms it.') : t('No open slots are listed for this date. You can still send a request and the hospital will suggest a time.')}</small>
            </label>
            <label className="patient-field patient-field-wide">{t('Short reason for your visit')}
              <textarea required maxLength={500} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('Briefly describe why you need an appointment')} />
            </label>
            <label className="patient-field">{t('Companions coming with you')}
              <input type="number" min={0} max={20} step={1} required value={companions} onChange={(event) => setCompanions(Number(event.target.value))} />
            </label>
          </div>
          <label className="appointment-urgent"><input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} /><span><strong>{t('My request is urgent')}</strong><small>{t('If this is a medical emergency, contact local emergency services or go to the nearest emergency department.')}</small></span></label>
          {urgent && <div className="urgent-emergency-note" role="alert">
            <strong>{t('For emergencies call:')}</strong>{' '}
            {selectedHospital?.phone
              ? <a href={`tel:${selectedHospital.phone.replace(/[^\d+]/g, '')}`}>{selectedHospital.phone}</a>
              : <span>{t('This hospital has not configured a phone number.')}</span>}
          </div>}
          <div className="checkin-divider" />
          <h2 className="appointment-subheading">{t('Patient details')}</h2>
          <p className="checkin-description">{t('Your name and mobile number create your patient profile and help the hospital contact you.')}</p>
          <PatientDetailsFields patientDetails={patientDetails} updatePatientDetails={updatePatientDetails} />
          <label className="patient-consent"><input type="checkbox" required checked={consentGiven} onChange={(event) => setConsentGiven(event.target.checked)} /><span>{t('I consent to sharing my patient details and appointment request with the selected hospital.')}</span></label>
          <label className="patient-consent"><input type="checkbox" required checked={recordsConsentGiven} onChange={(event) => setRecordsConsentGiven(event.target.checked)} /><span>{t('I agree to my medical records being stored securely and shared with my care team.')}</span></label>
          <p className="patient-privacy-note"><ShieldCheck size={14} /> {t('Your profile is private to you and staff at hospitals you contact.')}</p>
          <button className="button button-dark appointment-submit" type="submit" disabled={submitting || !isBackendConfigured}>{submitting ? <><span className="spinner" /> {t('Sending request…')}</> : <>{t('Send appointment request')} <ArrowRight size={17} /></>}</button>
        </form>
      </section>
    </main>
  )
}

function toAppointment(snapshot: QueryDocumentSnapshot<DocumentData>): Appointment {
  const data = snapshot.data()
  return {
    id: snapshot.id,
    trackingId: String(data.trackingId ?? ''),
    patientId: String(data.patientId ?? ''),
    ownerUid: String(data.ownerUid ?? ''),
    hospitalId: data.hospitalId as HospitalId,
    department: data.department as Department,
    doctorId: String(data.doctorId ?? ''),
    slotId: String(data.slotId ?? ''),
    requestedSlotId: String(data.requestedSlotId ?? ''),
    requestedDoctorId: String(data.requestedDoctorId ?? ''),
    patientMobile: String(data.patientMobile ?? ''),
    requestedDate: String(data.requestedDate ?? ''),
    reason: String(data.reason ?? ''),
    urgent: data.urgent === true,
    companions: Number(data.companions ?? 0),
    status: data.status as AppointmentStatus,
    assignedDate: String(data.assignedDate ?? ''),
    assignedTime: String(data.assignedTime ?? ''),
    staffNote: String(data.staffNote ?? ''),
    needsReschedule: data.needsReschedule === true,
    patientAction: data.patientAction === 'reschedule_requested' || data.patientAction === 'visit_confirmed' ? data.patientAction : 'none',
    recordId: String(data.recordId ?? ''),
    recordsConsentAt: data.recordsConsentAt ?? null,
    waitlistOfferSlotId: String(data.waitlistOfferSlotId ?? ''),
    waitlistOfferExpiresAt: data.waitlistOfferExpiresAt ?? null,
    waitlistOfferDate: String(data.waitlistOfferDate ?? ''),
    waitlistOfferTime: String(data.waitlistOfferTime ?? ''),
    createdAt: data.createdAt ?? null,
  }
}

function toAppointmentTracking(id: string, data: DocumentData): AppointmentTracking {
  return {
    id,
    appointmentId: String(data.appointmentId ?? ''),
    hospitalId: data.hospitalId as HospitalId,
    department: data.department as Department,
    status: data.status as AppointmentStatus,
    requestedDate: String(data.requestedDate ?? ''),
    assignedDate: String(data.assignedDate ?? ''),
    assignedTime: String(data.assignedTime ?? ''),
    doctorName: String(data.doctorName ?? ''),
    needsReschedule: data.needsReschedule === true,
  }
}

function AppointmentStatusPage({ appointmentId, userId, authReady, onBack, onError }: { appointmentId: string | null; userId: string | null; authReady: boolean; onBack: () => void; onError: (message: string) => void }) {
  const t = usePatientText()
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [tracking, setTracking] = useState<AppointmentTracking | null>(null)
  const [mobileLookup, setMobileLookup] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!db || !userId) {
      setAppointments([])
      setLoading(!authReady)
      return
    }
    setLoading(true)
    return onSnapshot(
      query(collection(db, 'appointments'), where('ownerUid', '==', userId)),
      (snapshot) => {
        setAppointments(snapshot.docs.map(toAppointment).sort((a, b) => (b.createdAt?.seconds ?? 0) - (a.createdAt?.seconds ?? 0)))
        setLoading(false)
      },
      (reason) => {
        setLoading(false)
        onError(`Unable to load appointment status: ${reason.message}`)
      },
    )
  }, [userId, authReady, onError])

  useEffect(() => {
    if (!db || !appointmentId) {
      setTracking(null)
      return
    }
    return onSnapshot(
      doc(db, 'appointmentTracking', appointmentId),
      (snapshot) => {
        setTracking(snapshot.exists() ? toAppointmentTracking(snapshot.id, snapshot.data()) : null)
      },
      (reason) => onError(`Unable to load appointment tracking link: ${reason.message}`),
    )
  }, [appointmentId, onError])

  const matchingAppointments = appointments.filter((appointment) => {
    if (appointmentId) return tracking ? appointment.id === tracking.appointmentId : false
    const digits = mobileLookup.replace(/\D/g, '')
    return !digits || appointment.patientMobile.replace(/\D/g, '') === digits
  })

  const patientUpdate = async (appointment: Appointment, action: 'cancelled' | 'reschedule_requested' | 'visit_confirmed') => {
    if (!db || !userId || appointment.ownerUid !== userId) return
    try {
      const firestore = db
      const appointmentRef = doc(firestore, 'appointments', appointment.id)
      const trackingRef = doc(firestore, 'appointmentTracking', appointment.trackingId)
      await runTransaction(firestore, async (transaction) => {
        const [appointmentSnapshot, trackingSnapshot] = await Promise.all([
          transaction.get(appointmentRef),
          transaction.get(trackingRef),
        ])
        if (!appointmentSnapshot.exists() || !trackingSnapshot.exists()) {
          throw new Error('This appointment is no longer available.')
        }

        const currentData = appointmentSnapshot.data()
        const slotRef = currentData.slotId ? doc(firestore, 'slots', String(currentData.slotId)) : null
        const slotSnapshot = slotRef ? await transaction.get(slotRef) : null
        const currentStatus = currentData.status as AppointmentStatus
        if (action === 'cancelled' && currentStatus !== 'confirmed' && currentStatus !== 'rescheduled' && currentStatus !== 'pending') {
          throw new Error('This appointment can no longer be cancelled.')
        }
        const updates = action === 'cancelled'
          ? { status: 'cancelled', patientAction: 'none' }
          : { patientAction: action }
        transaction.update(appointmentRef, action === 'cancelled'
          ? { ...updates, slotId: '', needsReschedule: false }
          : updates)
        if (action === 'cancelled') transaction.update(trackingRef, { status: 'cancelled' })
        if (action === 'cancelled' && slotRef && slotSnapshot?.exists()) {
          transaction.update(slotRef, { booked: Math.max(0, Number(slotSnapshot.data().booked ?? 0) - 1), lastReleasedAppointmentId: appointment.id })
        }
      })
      onError('')
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to update this appointment.')
    }
  }

  const acceptOffer = async (appointment: Appointment) => {
    try {
      await acceptWaitlistOffer(appointment.id)
      onError('')
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to accept this appointment time.')
    }
  }

  return (
    <main className="appointment-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> {t('Back to CareFlow')}</button>
      <div className="appointment-page-heading"><div className="eyebrow"><span className="eyebrow-line" /> {t('LIVE APPOINTMENT UPDATES')}</div><h1>{t('Request status.')}</h1><p>{t('Updates appear here as soon as the hospital responds. Use your appointment link or filter your signed-in requests by mobile number.')}</p></div>
      {!appointmentId && <label className="mobile-lookup-field"><Search size={17} /><input type="tel" autoComplete="tel" value={mobileLookup} onChange={(event) => setMobileLookup(event.target.value)} placeholder={t('Filter by your mobile number')} aria-label={t('Filter appointments by your mobile number')} /></label>}
      {appointmentId && tracking && !appointments.some((appointment) => appointment.id === tracking.appointmentId) && (
        <AppointmentStatusCard tracking={tracking} appointment={null} userId={userId} onUpdate={() => undefined} onAcceptOffer={() => undefined} />
      )}
      {loading ? <div className="appointment-empty"><span className="spinner dark-spinner" /><p>Loading your requests…</p></div> : matchingAppointments.length ? (
        <div className="appointment-status-list">{matchingAppointments.map((appointment) => (
          <AppointmentStatusCard
            key={appointment.id}
            appointment={appointment}
            tracking={tracking && tracking.appointmentId === appointment.id ? tracking : null}
            userId={userId}
            onUpdate={(action) => void patientUpdate(appointment, action)}
            onAcceptOffer={() => void acceptOffer(appointment)}
          />
        ))}</div>
      ) : appointmentId && !tracking ? (
        <div className="appointment-empty"><span className="empty-icon"><CircleHelp size={21} /></span><strong>{t('We couldn’t find this appointment link')}</strong><p>{t('Check that the QR code or link is correct.')}</p></div>
      ) : appointmentId && tracking ? null : appointments.length && mobileLookup ? (
        <div className="appointment-empty"><span className="empty-icon"><Search size={21} /></span><strong>{t('No requests match that mobile number')}</strong><p>{t('Check the number used on your appointment request.')}</p></div>
      ) : appointments.length ? null : (
        <div className="appointment-empty"><span className="empty-icon"><CalendarDays size={21} /></span><strong>{t('No appointment requests yet')}</strong><p>{t('When you send a request, its status will appear here.')}</p><button className="button button-dark" onClick={onBack}>{t('Return to CareFlow')}</button></div>
      )}
    </main>
  )
}

function AppointmentStatusCard({
  appointment,
  tracking,
  userId,
  onUpdate,
  onAcceptOffer,
}: {
  appointment: Appointment | null
  tracking: AppointmentTracking | null
  userId: string | null
  onUpdate: (action: 'cancelled' | 'reschedule_requested' | 'visit_confirmed') => void
  onAcceptOffer: () => void
}) {
  const t = usePatientText()
  const [doctor, setDoctor] = useState<Doctor | null>(null)
  const hospital = getHospital(appointment?.hospitalId ?? tracking?.hospitalId)
  const status = appointment?.status ?? tracking?.status ?? 'pending'
  const assignedDate = appointment?.assignedDate ?? tracking?.assignedDate ?? ''
  const assignedTime = appointment?.assignedTime ?? tracking?.assignedTime ?? ''
  const doctorName = doctor?.name || tracking?.doctorName || ''
  const canAct = Boolean(appointment && userId && appointment.ownerUid === userId)
  const confirmed = status === 'confirmed' || status === 'rescheduled'
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isDayBefore = assignedDate === `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

  useEffect(() => {
    if (!db || !appointment?.doctorId) {
      setDoctor(null)
      return
    }
    return onSnapshot(doc(db, 'doctors', appointment.doctorId), (snapshot) => {
      setDoctor(snapshot.exists() ? {
        id: snapshot.id,
        name: String(snapshot.data().name ?? ''),
        department: snapshot.data().department as Department,
        hospitalId: snapshot.data().hospitalId as HospitalId,
        userId: String(snapshot.data().userId ?? ''),
        status: snapshot.data().status as DoctorStatus,
        lateByMinutes: Number(snapshot.data().lateByMinutes ?? 0),
        note: String(snapshot.data().note ?? ''),
      } : null)
    })
  }, [appointment?.doctorId])

  const phone = hospital?.phone.replace(/[^\d+]/g, '') ?? ''
  const whatsapp = hospital?.whatsapp.replace(/\D/g, '') || phone.replace(/\D/g, '')
  const googleMapsUrl = getHospitalMapUrl(hospital)
  const dueTomorrow = isDayBefore && confirmed && canAct
  const offerActive = Boolean(appointment?.waitlistOfferSlotId
    && (appointment.waitlistOfferExpiresAt?.seconds ?? 0) * 1000 > Date.now())
  const statusNotice = appointment?.needsReschedule || tracking?.needsReschedule || (doctor && doctor.status !== 'available')

  return (
    <article className="appointment-status-card">
      <div className="appointment-status-top">
        <span className={`appointment-status-pill ${status}`}>{t(appointmentStatusLabels[status])}</span>
        {appointment?.urgent && <span className="urgent-label">{t('Urgent')}</span>}
        <span className="status-live-mark"><span /> {t('Live')}</span>
      </div>
      <h2>{hospital?.name ?? 'Hospital'}</h2>
      <p>{t(appointment?.department ?? tracking?.department ?? '')} · {t('Requested for')} {appointment?.requestedDate ?? tracking?.requestedDate ?? ''}</p>
      {statusNotice && <div className="doctor-notice"><AlertTriangle size={17} /><span><strong>{t('Appointment needs your attention')}</strong><small>{doctor?.status === 'late' ? `${t('Your doctor is running')} ${doctor.lateByMinutes} ${t('minutes late.')}` : doctor?.status === 'on_leave' ? t('Your doctor is on leave. The hospital will arrange a new time.') : doctor?.status === 'emergency_only' ? t('Your doctor is handling emergencies only. Please contact the hospital.') : t('The hospital flagged your appointment for rescheduling.')} {doctor?.note}</small></span></div>}
      {confirmed && assignedDate && <div className="appointment-assignment"><CalendarDays size={17} /><span><strong>{assignedDate} {t('at')} {assignedTime}</strong><small>{t(status === 'confirmed' ? 'Confirmed appointment time' : 'Suggested new appointment time')}</small></span></div>}
      {offerActive && appointment && <div className="doctor-notice"><CalendarDays size={17} /><span><strong>{t('A visit time opened up')}</strong><small>{appointment.waitlistOfferDate} {t('at')} {appointment.waitlistOfferTime} · {t('Offer expires at')} {new Date(appointment.waitlistOfferExpiresAt!.seconds * 1000).toLocaleTimeString()}</small></span></div>}
      {confirmed && <>
        <div className="appointment-hospital-contact">
          <MapPin size={17} />
          <span><strong>{hospital?.address || t('Hospital address not configured')}</strong><small>{doctorName ? `${t('Doctor:')} ${doctorName}` : t('Doctor not assigned yet')}</small></span>
          <a href={googleMapsUrl} target="_blank" rel="noreferrer">{t('Google Maps')} <ArrowUpRight size={13} /></a>
        </div>
        <div className="what-to-bring"><strong>{t('What to bring')}</strong><ul><li>{t('Appointment confirmation or this QR code')}</li><li>{t('Photo ID and any previous medical records')}</li><li>{t('Current medicines and relevant prescriptions')}</li></ul></div>
      </>}
      {appointment?.reason && <p className="appointment-reason"><strong>{t('Your reason:')}</strong> {appointment.reason}</p>}
      {appointment?.staffNote && <div className="appointment-staff-note"><strong>{t('Hospital note:')}</strong> {appointment.staffNote}</div>}
      {appointment?.patientAction === 'reschedule_requested' && <div className="patient-action-notice">{t('Your request to reschedule has been sent to the hospital.')}</div>}
      {appointment?.patientAction === 'visit_confirmed' && <div className="patient-action-notice">{t('You confirmed that you plan to attend.')}</div>}
      {hospital && <div className="appointment-contact-actions">
        {phone
          ? <a className="button button-outline" href={`tel:${phone}`}><Phone size={15} /> {t('Call hospital')}</a>
          : <span className="contact-not-configured"><Phone size={15} /> {t('Hospital phone not configured')}</span>}
        {whatsapp
          ? <a className="button button-outline" href={getWhatsAppUrl(whatsapp, `Hello, I need help with my appointment at ${hospital?.name ?? 'the hospital'}.`)} target="_blank" rel="noreferrer"><MessageCircle size={15} /> {t('WhatsApp hospital')}</a>
          : <span className="contact-not-configured"><MessageCircle size={15} /> {t('WhatsApp not configured')}</span>}
      </div>}
      {canAct && status === 'pending' && <div className="request-actions patient-appointment-actions"><button className="button button-decline" onClick={() => onUpdate('cancelled')}>{t('Cancel request')} <X size={15} /></button></div>}
      {canAct && offerActive && <div className="request-actions patient-appointment-actions"><button className="button button-dark" onClick={onAcceptOffer}>{t('Accept offered time')} <Check size={15} /></button></div>}
      {canAct && confirmed && <div className="request-actions patient-appointment-actions">
        {dueTomorrow && appointment?.patientAction !== 'visit_confirmed' && <button className="button button-dark" onClick={() => onUpdate('visit_confirmed')}>{t('Confirm my visit')} <Check size={15} /></button>}
        <button className="button button-outline" onClick={() => onUpdate('reschedule_requested')}>{t('Ask to reschedule')} <CalendarDays size={15} /></button>
        <button className="button button-decline" onClick={() => onUpdate('cancelled')}>{t('Cancel appointment')} <X size={15} /></button>
      </div>}
      {appointment && <>
        <div className="appointment-share-link">
          <span><QrCode size={16} /> {t('Appointment status QR')}</span>
          <div className="qr-paper"><QRCodeSVG value={`${window.location.origin}${window.location.pathname}?appointment=${appointment.trackingId}`} size={116} bgColor="#ffffff" fgColor="#173c36" level="H" includeMargin /></div>
          <small>{t('Open this QR in the same signed-in patient session to view private request details.')}</small>
        </div>
      </>}
    </article>
  )
}

function PatientHistoryPage({ patient, hospital, role, patientView, onBack, onError }: {
  patient: SelectedPatient | null
  hospital: Hospital | null
  role: StaffRole | null
  patientView: boolean
  onBack: () => void
  onError: (message: string) => void
}) {
  const [records, setRecords] = useState<MedicalRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [privacyBusy, setPrivacyBusy] = useState(false)
  const [privacyMessage, setPrivacyMessage] = useState('')
  const canAttachFiles = !patientView && (role === 'receptionist' || role === 'admin')

  const withdrawConsent = async () => {
    setPrivacyBusy(true)
    try {
      await withdrawRecordsConsent()
      setPrivacyMessage('Consent withdrawn. Existing records remain available where legally required; new medical document attachments are blocked.')
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to withdraw records consent.')
    } finally {
      setPrivacyBusy(false)
    }
  }

  const createPrivacyRequest = async (type: 'export' | 'erase') => {
    const hospitalId = records[0]?.hospitalId
    if (!hospitalId) {
      onError('A visit record is required before requesting an export or erasure.')
      return
    }
    if (type === 'erase' && !window.confirm('Request deletion of your data for this hospital? An administrator must review and approve it.')) return
    setPrivacyBusy(true)
    try {
      await submitPrivacyRequest(type, hospitalId)
      setPrivacyMessage(`Your ${type} request was sent for administrator approval.`)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to submit your privacy request.')
    } finally {
      setPrivacyBusy(false)
    }
  }

  useEffect(() => {
    if (!db || !patient?.id || (!patientView && !hospital)) {
      setRecords([])
      setLoading(false)
      return
    }
    setLoading(true)
    const constraints = patientView
      ? [where('patientId', '==', patient.id)]
      : [where('patientId', '==', patient.id), where('hospitalId', '==', hospital?.id)]
    return onSnapshot(query(collection(db, 'records'), ...constraints), (snapshot) => {
      setRecords(snapshot.docs.map((record) => toMedicalRecord(record.id, record.data()))
        .sort((a, b) => b.visitDate.localeCompare(a.visitDate)))
      setLoading(false)
    }, (reason) => {
      setLoading(false)
      onError(`Unable to load patient history: ${reason.message}`)
    })
  }, [patient?.id, hospital?.id, patientView, onError])

  const allergies = [...new Set(records.flatMap((record) => record.allergies.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean)))]
  const chronicConditions = [...new Set(records.flatMap((record) => record.chronicConditions.split(/[,;\n]/).map((value) => value.trim()).filter(Boolean)))]

  return (
    <main className={patientView ? 'appointment-page patient-history-page' : 'dashboard-page staff-tool-page'}>
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> {patientView ? 'Back to CareFlow' : 'Back to patient search'}</button>
      <div className="appointment-page-heading"><div className="eyebrow"><span className="eyebrow-line" /> {patientView ? 'MY RECORDS' : 'PRIVATE PATIENT HISTORY'}</div><h1>{patientView ? 'Your visit history.' : 'Patient history.'}</h1>
        <p>{patientView ? 'Your visit records and uploaded documents are available here.' : patient ? `${patientFullName(patient.details)} · ${patient.mobileNumber}` : 'Patient history'}</p>
      </div>
      {!patient && <div className="appointment-empty"><span className="empty-icon"><ClipboardList size={21} /></span><strong>Sign in to view your records</strong><p>Open My Records from the patient page to access records linked to your account.</p></div>}
      {patient && <>
        {patientView && <section className="staff-note privacy-controls">
          <ShieldCheck size={17} />
          <div><strong>Privacy choices</strong><p>Withdraw consent or ask the hospital for an export or deletion review. Required clinical records may need to be retained.</p>
            <div className="request-actions">
              <button className="button button-outline" disabled={privacyBusy} onClick={() => void withdrawConsent()}>Withdraw records consent</button>
              <button className="button button-outline" disabled={privacyBusy || records.length === 0} onClick={() => void createPrivacyRequest('export')}>Request export</button>
              <button className="button button-decline" disabled={privacyBusy || records.length === 0} onClick={() => void createPrivacyRequest('erase')}>Request erasure</button>
            </div>
            {privacyMessage && <small role="status">{privacyMessage}</small>}
          </div>
        </section>}
        <section className="medical-alert-grid" aria-label="Important medical history">
          <article className="medical-alert-card allergy-alert"><strong><AlertTriangle size={17} /> Allergies</strong><p>{allergies.length ? allergies.join(', ') : records.length ? 'No allergies recorded.' : 'No records available.'}</p></article>
          <article className="medical-alert-card condition-alert"><strong><HeartPulse size={17} /> Chronic conditions</strong><p>{chronicConditions.length ? chronicConditions.join(', ') : records.length ? 'No chronic conditions recorded.' : 'No records available.'}</p></article>
        </section>
        {loading ? <div className="appointment-empty"><span className="spinner dark-spinner" /><p>Loading medical history…</p></div>
          : records.length === 0 ? <div className="appointment-empty"><span className="empty-icon"><ClipboardList size={21} /></span><strong>No visit records yet</strong><p>Records from completed visits will appear here.</p></div>
            : <section className="medical-record-timeline">
              <h2>Visits</h2>
              {records.map((record) => <MedicalRecordCard key={record.id} record={record} onError={onError}>
                {medicalPdfUploadsEnabled && canAttachFiles && hospital && patient && <MedicalRecordPdfUpload record={record} hospital={hospital} patient={patient} onError={onError} />}
              </MedicalRecordCard>)}
            </section>}
      </>}
    </main>
  )
}

function MedicalRecordCard({ record, children, onError }: { record: MedicalRecord; children?: React.ReactNode; onError: (message: string) => void }) {
  return <article className="medical-record-card">
    <div className="medical-record-heading"><div><span className="eyebrow"><span className="eyebrow-line" /> {getHospital(record.hospitalId)?.name ?? 'Hospital'}</span><h3>{record.visitDate}</h3></div><span className="medical-record-tag"><Stethoscope size={13} /> Visit record</span></div>
    <dl className="medical-record-fields">
      {record.diagnosis && <div><dt>Diagnosis</dt><dd>{record.diagnosis}</dd></div>}
      {record.allergies && <div><dt>Allergies</dt><dd>{record.allergies}</dd></div>}
      {record.chronicConditions && <div><dt>Chronic conditions</dt><dd>{record.chronicConditions}</dd></div>}
      {record.currentMedicines && <div><dt>Current medicines</dt><dd>{record.currentMedicines}</dd></div>}
      {record.prescription && <div><dt>Prescription</dt><dd>{record.prescription}</dd></div>}
      {record.notes && <div><dt>Notes</dt><dd>{record.notes}</dd></div>}
      {record.followUpDate && <div><dt>Follow-up</dt><dd>{record.followUpDate}</dd></div>}
    </dl>
    <RecordPdfList files={record.pdfFiles} onError={onError} />
    {children}
  </article>
}

function RecordPdfList({ files, onError }: { files: MedicalDocument[]; onError: (message: string) => void }) {
  return medicalPdfUploadsEnabled && files.length > 0 ? <div className="record-pdf-list"><strong><FileText size={15} /> Reports and prescriptions</strong>{files.map((file) => <PrivatePdfActions file={file} key={file.path} onError={onError} />)}</div> : null
}

function PrivatePdfActions({ file, onError }: { file: MedicalDocument; onError: (message: string) => void }) {
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])

  const prepare = async () => {
    if (!storage) {
      onError('The local CareFlow file service is unavailable.')
      return
    }
    setLoading(true)
    try {
      const blob = await getBlob(storageRef(storage, file.path))
      setUrl(URL.createObjectURL(blob))
    } catch (reason) {
      onError(reason instanceof Error
        ? `Unable to access this private medical document: ${reason.message}`
        : 'Unable to access this private medical document.')
    } finally {
      setLoading(false)
    }
  }

  const uploaderLabel = file.uploaderRole ? `${file.uploaderRole[0].toUpperCase()}${file.uploaderRole.slice(1)}` : ''
  return <div className="record-pdf-item"><FileText size={15} /><span>
    <strong>{file.name}</strong>
    <small>{[file.category ?? 'Uncategorized', file.uploadedAt.toDate().toLocaleDateString(), uploaderLabel && `Uploaded by ${uploaderLabel}`].filter(Boolean).join(' · ')}</small>
    {file.description && <small>{file.description}</small>}
  </span>{url
    ? <><a href={url} target="_blank" rel="noreferrer">View</a><a href={url} download={file.name}>Download</a></>
    : <button className="queue-action" onClick={() => void prepare()} disabled={loading}>{loading ? 'Loading…' : 'Open securely'}</button>}</div>
}

function MedicalRecordPdfUpload({ record, hospital, patient, onError }: { record: MedicalRecord; hospital: Hospital; patient: SelectedPatient; onError: (message: string) => void }) {
  const [files, setFiles] = useState<File[]>([])
  const [category, setCategory] = useState<MedicalDocumentCategory>('Other Medical Reports')
  const [description, setDescription] = useState('')
  const [progress, setProgress] = useState(0)
  const [saving, setSaving] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!db || !files.length) return
    try {
      validateMedicalDocuments(files)
      if (record.pdfFiles.length + files.length > 100) throw new Error('A visit record can contain at most 100 medical documents.')
      setSaving(true)
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        const uploaded = await uploadMedicalDocument(file, hospital.id, patient.id, record.id, category, description, (value) => {
          setProgress(Math.round((index + value / 100) / files.length * 100))
        })
        await updateDoc(doc(db, 'records', record.id), { pdfFiles: arrayUnion(uploaded), updatedAt: serverTimestamp() })
      }
      setFiles([])
      setDescription('')
      setProgress(0)
      onError('')
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to attach medical document: ${reason.message}` : 'Unable to attach medical document.')
    } finally {
      setSaving(false)
    }
  }

  return <form className="record-upload-form" onSubmit={(event) => void submit(event)}>
    <label className="patient-field">Attach report or scan (PDF, JPG, or PNG; up to 10 MB each)<input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /></label>
    <label className="patient-field">Document category<select value={category} onChange={(event) => setCategory(event.target.value as MedicalDocumentCategory)}>{medicalDocumentCategories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    <label className="patient-field record-upload-description">Description (optional)<input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    {saving && <progress max={100} value={progress} aria-label="Medical document upload progress" />}
    <button className="button button-outline" disabled={saving || files.length === 0}>{saving ? `Uploading ${progress}%…` : <>Upload documents <FileText size={15} /></>}</button>
  </form>
}

function DoctorTodayPage({ hospital, userId, onBack, onError }: { hospital: Hospital | null; userId: string; onBack: () => void; onError: (message: string) => void }) {
  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [appointments, setAppointments] = useState<Array<{ appointment: Appointment; patient: SelectedPatient | null }>>([])
  const [loading, setLoading] = useState(true)
  const [selectedAppointmentId, setSelectedAppointmentId] = useState('')
  const today = getLocalDateInputValue()

  useEffect(() => {
    if (!db || !hospital || !userId) {
      setDoctors([])
      return
    }
    return onSnapshot(query(collection(db, 'doctors'), where('hospitalId', '==', hospital.id), where('userId', '==', userId)), (snapshot) => {
      setDoctors(snapshot.docs.map(getDoctor))
    }, (reason) => onError(`Unable to load your doctor profile: ${reason.message}`))
  }, [hospital?.id, userId, onError])

  useEffect(() => {
    if (!db || !hospital) {
      setAppointments([])
      setLoading(false)
      return
    }
    setLoading(true)
    const firestore = db
    let active = true
    return onSnapshot(query(collection(firestore, 'appointments'), where('hospitalId', '==', hospital.id), where('assignedDate', '==', today)), (snapshot) => {
      const todays = snapshot.docs.map(toAppointment).filter((appointment) =>
        ['confirmed', 'rescheduled'].includes(appointment.status))
      void Promise.all(todays.map(async (appointment) => {
        const patientSnapshot = await getDoc(doc(firestore, 'patients', appointment.patientId))
        const data = patientSnapshot.data()
        return {
          appointment,
          patient: data && isPatientDetails(data.details)
            ? { id: appointment.patientId, details: data.details, mobileNumber: String(data.mobileNumber ?? '') }
            : null,
        }
      })).then((next) => {
        if (!active) return
        setAppointments(next.sort((a, b) => a.appointment.assignedTime.localeCompare(b.appointment.assignedTime)))
        setLoading(false)
      }).catch((reason: unknown) => {
        if (!active) return
        setLoading(false)
        onError(reason instanceof Error ? `Unable to load today's patient details: ${reason.message}` : 'Unable to load today’s patient details.')
      })
    }, (reason) => {
      if (!active) return
      setLoading(false)
      onError(`Unable to load today's appointments: ${reason.message}`)
    })
  }, [hospital?.id, today, onError])

  const ownDoctorIds = new Set(doctors.map((doctor) => doctor.id))
  const ownAppointments = appointments.filter(({ appointment }) => ownDoctorIds.has(appointment.doctorId))
  const markNoShow = async (appointment: Appointment) => {
    if (!window.confirm('Mark this visit as no-show? This will not prevent the patient from requesting care again.')) return
    try {
      await markAppointmentNoShow(appointment.id)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to update appointment status.')
    }
  }

  return <main className="dashboard-page staff-tool-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to queue dashboard</button>
    <div className="appointment-page-heading"><div className="eyebrow"><span className="eyebrow-line" /> DOCTOR WORKLIST</div><h1>My patients today.</h1><p>Confirmed appointments assigned to you at {hospital?.name ?? 'your hospital'}.</p></div>
    {doctors.length === 0 && <div className="staff-note"><ShieldCheck size={16} /> Ask reception to link your staff user ID to your doctor profile in Doctor availability before appointments appear here.</div>}
    {loading ? <div className="appointment-empty"><span className="spinner dark-spinner" /><p>Loading today’s appointments…</p></div>
      : ownAppointments.length === 0 ? <div className="appointment-empty"><span className="empty-icon"><CalendarDays size={21} /></span><strong>No confirmed patients today</strong><p>Appointments assigned to your doctor profile will appear here.</p></div>
        : <div className="doctor-list">{ownAppointments.map(({ appointment, patient }) => {
          const doctor = doctors.find((item) => item.id === appointment.doctorId)
          return <article className="doctor-card doctor-today-card" key={appointment.id}>
            <div className="doctor-card-summary"><span className="department-icon mint"><Users size={18} /></span><div><strong>{patient ? patientFullName(patient.details) : 'Patient details unavailable'}</strong><small>{appointment.assignedTime} · {appointment.department} · {doctor?.name ?? 'Assigned doctor'}</small></div><span className="ticket-status confirmed"><span />{appointment.status}</span></div>
            <dl className="request-details"><div><dt>Mobile</dt><dd>{patient?.mobileNumber ?? appointment.patientMobile}</dd></div><div><dt>Reason for visit</dt><dd>{appointment.reason}</dd></div><div><dt>Patient ID</dt><dd>{appointment.patientId}</dd></div></dl>
            <button className="button button-outline" onClick={() => void markNoShow(appointment)}>Mark no-show</button>
            {appointment.recordId && <p className="staff-note"><FileText size={15} /> A visit record has been started for this appointment. Continue below or return to patient history.</p>}
            <button className="button button-dark" onClick={() => setSelectedAppointmentId((current) => current === appointment.id ? '' : appointment.id)}>
              {selectedAppointmentId === appointment.id ? 'Close visit record' : appointment.recordId ? 'Continue visit record' : 'Add visit record'} <ArrowRight size={15} />
            </button>
            {selectedAppointmentId === appointment.id && patient && hospital && doctor && <DoctorVisitForm
              appointment={appointment}
              patient={patient}
              hospital={hospital}
              doctor={doctor}
              onError={onError}
              onDone={() => setSelectedAppointmentId('')}
            />}
          </article>
        })}</div>}
  </main>
}

function DoctorVisitForm({ appointment, patient, hospital, doctor, onError, onDone }: {
  appointment: Appointment
  patient: SelectedPatient
  hospital: Hospital
  doctor: Doctor
  onError: (message: string) => void
  onDone: () => void
}) {
  const [diagnosis, setDiagnosis] = useState('')
  const [allergies, setAllergies] = useState('')
  const [chronicConditions, setChronicConditions] = useState('')
  const [currentMedicines, setCurrentMedicines] = useState('')
  const [prescription, setPrescription] = useState('')
  const [notes, setNotes] = useState('')
  const [followUpDate, setFollowUpDate] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [documentCategory, setDocumentCategory] = useState<MedicalDocumentCategory>('Other Medical Reports')
  const [documentDescription, setDocumentDescription] = useState('')
  const [progress, setProgress] = useState(0)
  const [recordId, setRecordId] = useState(appointment.recordId)
  const [existingDocumentCount, setExistingDocumentCount] = useState(0)
  const [recordsConsentGiven, setRecordsConsentGiven] = useState(Boolean(appointment.recordsConsentAt))
  const [loadingRecord, setLoadingRecord] = useState(Boolean(appointment.recordId))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!recordId || !db) {
      setLoadingRecord(false)
      return
    }
    let active = true
    setLoadingRecord(true)
    void getDoc(doc(db, 'records', recordId)).then((snapshot) => {
      if (!active || !snapshot.exists()) return
      const record = toMedicalRecord(snapshot.id, snapshot.data())
      setExistingDocumentCount(record.pdfFiles.length)
      setDiagnosis(record.diagnosis)
      setAllergies(record.allergies)
      setChronicConditions(record.chronicConditions)
      setCurrentMedicines(record.currentMedicines)
      setPrescription(record.prescription)
      setNotes(record.notes)
      setFollowUpDate(record.followUpDate)
    }).catch((reason: unknown) => {
      if (active) onError(reason instanceof Error ? `Unable to resume visit record: ${reason.message}` : 'Unable to resume visit record.')
    }).finally(() => {
      if (active) setLoadingRecord(false)
    })
    return () => { active = false }
  }, [recordId, onError])

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!db || !auth?.currentUser) {
      onError('A signed-in doctor account is required to save a visit record.')
      return
    }
    if (!diagnosis.trim() || !recordsConsentGiven) {
      onError(!diagnosis.trim() ? 'Enter the visit diagnosis before saving.' : 'Confirm that the patient agrees to their records being stored.')
      return
    }
    try {
      validateMedicalDocuments(files)
      if (existingDocumentCount + files.length > 100) throw new Error('A visit record can contain at most 100 medical documents.')
      setSaving(true)
      let activeRecordId = recordId
      if (!activeRecordId) {
        const recordRef = doc(collection(db, 'records'))
        const batch = writeBatch(db)
        batch.set(recordRef, {
          patientId: patient.id,
          appointmentId: appointment.id,
          hospitalId: hospital.id,
          doctorId: doctor.id,
          visitDate: appointment.assignedDate,
          diagnosis: diagnosis.trim(),
          allergies: allergies.trim(),
          chronicConditions: chronicConditions.trim(),
          currentMedicines: currentMedicines.trim(),
          prescription: prescription.trim(),
          notes: notes.trim(),
          followUpDate,
          pdfFiles: [],
          consentAt: appointment.recordsConsentAt ?? serverTimestamp(),
          createdBy: auth.currentUser.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
        batch.update(doc(db, 'appointments', appointment.id), {
          recordId: recordRef.id,
          ...(!appointment.recordsConsentAt ? { recordsConsentAt: serverTimestamp() } : {}),
        })
        await batch.commit()
        activeRecordId = recordRef.id
        setRecordId(recordRef.id)
      } else {
        await updateDoc(doc(db, 'records', activeRecordId), {
          diagnosis: diagnosis.trim(),
          allergies: allergies.trim(),
          chronicConditions: chronicConditions.trim(),
          currentMedicines: currentMedicines.trim(),
          prescription: prescription.trim(),
          notes: notes.trim(),
          followUpDate,
          updatedAt: serverTimestamp(),
        })
      }

      for (let index = 0; index < files.length; index += 1) {
        const uploaded = await uploadMedicalDocument(files[index], hospital.id, patient.id, activeRecordId, documentCategory, documentDescription, (value) => {
          setProgress(Math.round((index + value / 100) / Math.max(1, files.length) * 100))
        })
        await updateDoc(doc(db, 'records', activeRecordId), { pdfFiles: arrayUnion(uploaded), updatedAt: serverTimestamp() })
        setExistingDocumentCount((count) => count + 1)
      }

      const finish = writeBatch(db)
      finish.update(doc(db, 'appointments', appointment.id), { status: 'completed' })
      finish.update(doc(db, 'appointmentTracking', appointment.trackingId), { status: 'completed' })
      await finish.commit()
      onError('')
      onDone()
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to save visit record: ${reason.message}` : 'Unable to save visit record.')
    } finally {
      setSaving(false)
    }
  }

  return <form className="visit-record-form" onSubmit={(event) => void submit(event)}>
    <div className="record-form-heading"><h3>Add visit record</h3><span>{patientFullName(patient.details)} · {appointment.assignedDate}</span></div>
    <div className="record-form-grid">
      <label className="patient-field">Diagnosis<textarea required maxLength={5000} rows={3} value={diagnosis} onChange={(event) => setDiagnosis(event.target.value)} /></label>
      <label className="patient-field">Allergies<textarea maxLength={2000} rows={3} value={allergies} onChange={(event) => setAllergies(event.target.value)} placeholder="List known allergies, or enter none reported" /></label>
      <label className="patient-field">Chronic conditions<textarea maxLength={2000} rows={3} value={chronicConditions} onChange={(event) => setChronicConditions(event.target.value)} /></label>
      <label className="patient-field">Current medicines<textarea maxLength={3000} rows={3} value={currentMedicines} onChange={(event) => setCurrentMedicines(event.target.value)} /></label>
      <label className="patient-field">Prescription<textarea maxLength={5000} rows={3} value={prescription} onChange={(event) => setPrescription(event.target.value)} /></label>
      <label className="patient-field">Clinical notes<textarea maxLength={5000} rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <label className="patient-field">Follow-up date<input type="date" min={appointment.assignedDate} value={followUpDate} onChange={(event) => setFollowUpDate(event.target.value)} /></label>
      <label className="patient-field patient-field-wide">Attach medical reports (PDF, JPG, or PNG; up to 10 MB each)<input type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /></label>
      <label className="patient-field">Document category<select value={documentCategory} onChange={(event) => setDocumentCategory(event.target.value as MedicalDocumentCategory)}>{medicalDocumentCategories.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
      <label className="patient-field">Document description (optional)<input maxLength={500} value={documentDescription} onChange={(event) => setDocumentDescription(event.target.value)} /></label>
    </div>
    <label className="patient-consent"><input type="checkbox" required checked={recordsConsentGiven} onChange={(event) => setRecordsConsentGiven(event.target.checked)} /><span>I agree to my records being stored. Confirm with the patient before saving.</span></label>
    {saving && <progress max={100} value={progress} aria-label="Medical document upload progress" />}
    <button className="button button-dark" disabled={saving || loadingRecord}>{saving ? files.length ? `Saving and uploading ${progress}%…` : 'Saving record…' : loadingRecord ? 'Loading existing record…' : <>Save record and complete visit <Check size={15} /></>}</button>
  </form>
}

function TicketTracking({
  ticket,
  missing,
  error,
  isStaff,
  staffHospital,
  onStaffLogin,
  onBack,
}: {
  ticket: Ticket | null
  missing: boolean
  error: string
  isStaff: boolean
  staffHospital: Hospital | null
  onStaffLogin: () => void
  onBack: () => void
}) {
  const [patientDetails, setPatientDetails] = useState<PatientDetails | null>(null)
  const [detailsError, setDetailsError] = useState('')
  const [loadingDetails, setLoadingDetails] = useState(false)

  useEffect(() => {
    setPatientDetails(null)
    setDetailsError('')
    if (!isStaff || !ticket || staffHospital?.id !== ticket.hospitalId || !db) {
      setLoadingDetails(false)
      return
    }

    let active = true
    setLoadingDetails(true)
    void getDoc(doc(db, 'patientDetails', ticket.id)).then((snapshot) => {
      const data = snapshot.data()
      if (!snapshot.exists() || !data || data.hospitalId !== ticket.hospitalId || !isPatientDetails(data.details)) {
        throw new Error('No patient details are available for this ticket.')
      }
      if (active) setPatientDetails(data.details)
    }).catch((reason: unknown) => {
      if (active) setDetailsError(reason instanceof Error ? reason.message : 'Unable to load patient details.')
    }).finally(() => {
      if (active) setLoadingDetails(false)
    })

    return () => { active = false }
  }, [ticket?.id, ticket?.hospitalId, isStaff, staffHospital?.id])

  if (error) return <main className="tracking-page"><button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to check-in</button><div className="tracking-card not-found"><span className="tracking-status-icon"><CircleHelp size={25} /></span><h1>We couldn’t load your ticket.</h1><p>{error.includes('permission') ? 'Ticket access was denied. Check that you are using the CareFlow server address and try again.' : `Please check your connection and try again. (${error})`}</p><button className="button button-dark" onClick={() => window.location.reload()}>Try again <ArrowRight size={16} /></button></div></main>
  if (missing) return <main className="tracking-page"><button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to check-in</button><div className="tracking-card not-found"><span className="tracking-status-icon"><CircleHelp size={25} /></span><h1>We couldn't find that ticket.</h1><p>Check the ticket ID in your QR link and try again.</p><button className="button button-dark" onClick={onBack}>Back to check-in <ArrowRight size={16} /></button></div></main>
  if (!ticket) return <main className="tracking-page"><div className="tracking-card loading-card"><span className="spinner dark-spinner" /><p>Loading your ticket…</p></div></main>

  const url = `${window.location.origin}${window.location.pathname}?ticket=${ticket.id}`
  const hospitalName = getHospital(ticket.hospitalId)?.name ?? 'Hospital'
  const called = ticket.status === 'called'
  const completed = ticket.status === 'completed'
  return (
    <main className="tracking-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to CareFlow</button>
      <div className="tracking-layout">
        <section className="tracking-card">
          <div className="tracking-top"><span className="eyebrow"><span className="eyebrow-line" /> YOUR DIGITAL TICKET</span><span className={`ticket-status ${ticket.status}`}><span />{statusLabels[ticket.status]}</span></div>
          <div className="ticket-code-label">YOUR TICKET NUMBER</div>
          <div className="ticket-code">#{ticket.code}</div>
          <div className="ticket-dept"><span className="department-icon mint"><Stethoscope size={17} /></span><span><strong>{ticket.department}</strong><small>{hospitalName} · Checked in at {formatTime(ticket.createdAt)}</small></span></div>
          <div className={called ? 'call-banner called-banner' : completed ? 'call-banner completed-banner' : 'call-banner'}>
            {called ? <Bell size={19} /> : completed ? <CheckCircle2 size={19} /> : <Clock3 size={19} />}
            <span><strong>{called ? 'It’s your turn — please come in.' : completed ? 'Your visit is complete. Take care!' : 'You’re in line. We’ll call you when it’s your turn.'}</strong><small>{called ? 'Please show your ticket to the care team.' : completed ? 'Thank you for visiting CareFlow.' : 'Keep this page open for live updates.'}</small></span>
          </div>
          <div className="ticket-privacy"><ShieldCheck size={15} /> This unique QR contains only a ticket reference. Patient details are not encoded in the QR.</div>
          {isStaff && staffHospital?.id === ticket.hospitalId ? (
            <section className="ticket-patient-details">
              <h2><ShieldCheck size={16} /> Patient details</h2>
              {loadingDetails ? <p><span className="spinner dark-spinner" /> Loading private details…</p>
                : detailsError ? <p role="alert">{detailsError}</p>
                  : patientDetails ? <dl className="patient-details-list">
                    <div><dt>Full name</dt><dd>{patientFullName(patientDetails)}</dd></div>
                    <div><dt>Mobile number</dt><dd>{patientDetails.mobileNumber}</dd></div>
                  </dl>
                    : <p>Patient details are unavailable for this ticket.</p>}
            </section>
          ) : !isStaff ? (
            <div className="ticket-details-access">
              <p>Hospital staff can scan this QR and sign in to view your name and mobile number.</p>
              <button className="button button-outline" onClick={onStaffLogin}>Staff sign in <ArrowRight size={15} /></button>
            </div>
          ) : (
            <p className="ticket-details-access" role="status">Patient details are available only to staff assigned to this hospital.</p>
          )}
        </section>
        <aside className="qr-ticket">
          <span className="qr-title"><QrCode size={16} /> SHOW THIS AT CHECK-IN</span>
          <div className="qr-paper"><QRCodeSVG value={url} size={172} bgColor="#ffffff" fgColor="#173c36" level="H" includeMargin /></div>
          <strong>Scan to view your ticket</strong>
          <small>Authorized hospital staff can see your name and mobile number after signing in.</small>
          <span className="qr-code-label">{ticket.code}</span>
        </aside>
      </div>
      <div className="tracking-help"><CircleHelp size={16} /><span>Need help? Ask the front desk and show them your ticket number.</span></div>
    </main>
  )
}

function PatientAuth({
  authReady,
  onBack,
  onDone,
  onError,
}: {
  authReady: boolean
  onBack: () => void
  onDone: () => void
  onError: (message: string) => void
}) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [creatingAccount, setCreatingAccount] = useState(true)
  const [loading, setLoading] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!auth) {
      onError('The local CareFlow server is not available. Start it with `npm run start`, then try again.')
      return
    }
    setLoading(true)
    try {
      if (creatingAccount) {
        const currentUser = auth.currentUser
        if (currentUser?.isAnonymous) {
          await linkWithCredential(currentUser, EmailAuthProvider.credential(email.trim(), password))
        } else {
          await createUserWithEmailAndPassword(auth, email.trim(), password)
        }
      } else {
        const credential = await signInWithEmailAndPassword(auth, email.trim(), password)
        const token = await getIdTokenResult(credential.user)
        if (token.claims.staff === true) {
          await signOut(auth)
          throw new Error('This is a staff account. Please use Staff login instead.')
        }
      }
      onDone()
    } catch (reason) {
      const code = (reason as { code?: string }).code
      const message = code === 'auth/email-already-in-use'
        ? 'An account with this email already exists. Sign in instead. Data from a separate anonymous session is not automatically transferred.'
        : code === 'auth/credential-already-in-use'
          ? 'This email already belongs to an account. Sign in instead. This anonymous session stays separate and its data is not transferred.'
        : code === 'auth/invalid-credential'
          ? 'Email or password is incorrect.'
          : code === 'auth/weak-password'
            ? 'Choose a password with at least 6 characters.'
            : reason instanceof Error ? reason.message : 'Unable to access your account.'
      onError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to patient check-in</button>
      <div className="login-card">
        <span className="login-mark"><HeartPulse size={22} /></span>
        <div className="eyebrow"><span className="eyebrow-line" /> PATIENT ACCOUNT</div>
        <h1>{creatingAccount ? 'Your care, in one place.' : 'Welcome back.'}</h1>
        <p>{creatingAccount
          ? auth?.currentUser?.isAnonymous
            ? 'Create an account to link this anonymous session and keep its appointments and records connected.'
            : 'Create an account to keep your visits connected.'
          : auth?.currentUser?.isAnonymous
            ? 'Signing in switches to your existing account. Data from this anonymous session is not transferred.'
            : 'Sign in to continue to CareFlow.'}</p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="patient-email">Email address</label>
          <input id="patient-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
          <label htmlFor="patient-password">Password</label>
          <input id="patient-password" type="password" autoComplete={creatingAccount ? 'new-password' : 'current-password'} minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" />
          <button className="button button-dark login-submit" disabled={loading || !authReady || !isBackendConfigured}>{loading ? <><span className="spinner" /> Please wait…</> : <>{creatingAccount ? 'Create patient account' : 'Sign in'} <ArrowRight size={16} /></>}</button>
        </form>
        <div className="login-switch">{creatingAccount ? 'Already have an account?' : 'New to CareFlow?'} <button onClick={() => { setCreatingAccount(!creatingAccount); onError('') }}>{creatingAccount ? 'Sign in' : 'Create an account'}</button></div>
        <div className="login-security"><ShieldCheck size={15} /> Your account is securely managed by CareFlow</div>
      </div>
    </main>
  )
}

function StaffLogin({ authReady, onBack, onError }: { authReady: boolean; onBack: () => void; onError: (message: string) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!auth) {
      onError('The local CareFlow server is not available. Start it with `npm run start`, then try again.')
      return
    }
    setLoading(true)
    try {
      const credential = await signInWithEmailAndPassword(auth, email.trim(), password)
      const token = await getIdTokenResult(credential.user)
      if (token.claims.staff !== true) {
        await signOut(auth)
        throw new Error('This account is not authorized for staff access. Contact your administrator.')
      }
      if (token.claims.role !== undefined && token.claims.role !== 'receptionist' && token.claims.role !== 'doctor' && token.claims.role !== 'admin') {
        await signOut(auth)
        throw new Error('This staff account has no valid role. Contact your administrator.')
      }
      if (!getHospital(token.claims.hospitalId)) {
        await signOut(auth)
        throw new Error('This staff account has no valid hospital assignment. Contact your administrator.')
      }
    } catch (reason) {
      const code = (reason as { code?: string }).code
      onError(code === 'auth/invalid-credential' ? 'Email or password is incorrect.' : reason instanceof Error ? reason.message : 'Unable to sign in.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to patient check-in</button>
      <div className="login-card">
        <span className="login-mark"><Hospital size={22} /></span>
        <div className="eyebrow"><span className="eyebrow-line" /> CARE TEAM ACCESS</div>
        <h1>Welcome back.</h1>
        <p>Sign in to manage the patient queue and appointment requests for your hospital.</p>
        <form onSubmit={submit} className="login-form">
          <label htmlFor="staff-email">Work email</label>
          <input id="staff-email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@hospital.org" />
          <label htmlFor="staff-password">Password</label>
          <input id="staff-password" type="password" autoComplete="current-password" minLength={6} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Your password" />
          <button className="button button-dark login-submit" disabled={loading || !authReady || !isBackendConfigured}>{loading ? <><span className="spinner" /> Signing in…</> : <>Sign in to dashboard <ArrowRight size={16} /></>}</button>
        </form>
        <div className="login-security"><ShieldCheck size={15} /> Secure access for hospital staff</div>
      </div>
    </main>
  )
}

function PatientDetailsDialog({ ticket, details, onClose }: { ticket: Ticket; details: PatientDetails; onClose: () => void }) {
  const rows: [string, string][] = [
    ['Full name', patientFullName(details)],
    ['Mobile number', details.mobileNumber],
  ]

  return (
    <div className="patient-details-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="patient-details-dialog" role="dialog" aria-modal="true" aria-labelledby="patient-details-title">
        <div className="patient-details-dialog-heading">
          <div><span className="eyebrow"><span className="eyebrow-line" /> PRIVATE PATIENT RECORD</span><h2 id="patient-details-title">Patient details</h2><p>Ticket #{ticket.code}</p></div>
          <button className="icon-button" onClick={onClose} aria-label="Close patient details"><X size={18} /></button>
        </div>
        <dl className="patient-details-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <p className="patient-details-access"><ShieldCheck size={14} /> Visible to staff assigned to this hospital.</p>
      </section>
    </div>
  )
}

type AppointmentAction = 'confirmed' | 'rescheduled' | 'declined'

function RequestInbox({ hospital, role, onBack, onError }: { hospital: Hospital | null; role: StaffRole | null; onBack: () => void; onError: (message: string) => void }) {
  const [requests, setRequests] = useState<AppointmentRequest[]>([])
  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [availableSlots, setAvailableSlots] = useState<AppointmentSlot[]>([])
  const [loading, setLoading] = useState(true)
  const [actionRequest, setActionRequest] = useState<{ id: string; action: AppointmentAction } | null>(null)
  const [actionDate, setActionDate] = useState('')
  const [actionDoctorId, setActionDoctorId] = useState('')
  const [actionSlotId, setActionSlotId] = useState('')
  const [staffNote, setStaffNote] = useState('')
  const [savingId, setSavingId] = useState('')
  const canUpdate = role === 'receptionist' || role === 'admin'

  useEffect(() => {
    if (!db || !hospital) {
      setRequests([])
      setLoading(false)
      return
    }
    const firestore = db
    const assignedHospital = hospital
    setLoading(true)
    let active = true
    const unsubscribeDoctors = onSnapshot(
      query(collection(firestore, 'doctors'), where('hospitalId', '==', assignedHospital.id)),
      (snapshot) => setDoctors(snapshot.docs.map(getDoctor)),
      (reason) => onError(`Unable to load hospital doctors: ${reason.message}`),
    )
    const unsubscribe = onSnapshot(
      query(collection(firestore, 'appointments'), where('hospitalId', '==', assignedHospital.id)),
      (snapshot) => {
        const appointments = snapshot.docs.map(toAppointment).filter((appointment) =>
          appointment.status === 'pending'
          || ((appointment.status === 'confirmed' || appointment.status === 'rescheduled')
            && (appointment.needsReschedule || appointment.patientAction === 'reschedule_requested')),
        )
        void Promise.all(appointments.map(async (appointment) => {
          const profile = await getDoc(doc(firestore, 'patients', appointment.patientId))
          const data = profile.data()
          return {
            ...appointment,
            patient: data && isPatientDetails(data.details) ? data.details : null,
          }
        })).then((nextRequests) => {
          if (!active) return
          setRequests(nextRequests.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0)))
          setLoading(false)
        }).catch((reason: unknown) => {
          if (!active) return
          setLoading(false)
          onError(reason instanceof Error ? `Unable to load appointment patient details: ${reason.message}` : 'Unable to load appointment patient details.')
        })
      },
      (reason) => {
        if (!active) return
        setLoading(false)
        onError(`Unable to load appointment requests: ${reason.message}`)
      },
    )
    return () => {
      active = false
      unsubscribe()
      unsubscribeDoctors()
    }
  }, [hospital, onError])

  useEffect(() => {
    if (!db || !hospital || !actionDoctorId || !actionDate) {
      setAvailableSlots([])
      setActionSlotId('')
      return
    }
    const firestore = db
    const hospitalId = hospital.id
    return onSnapshot(
      query(collection(firestore, 'slots'), where('hospitalId', '==', hospitalId), where('doctorId', '==', actionDoctorId), where('date', '==', actionDate)),
      (snapshot) => {
        const slots = snapshot.docs.map(getSlot).filter((slot) => slot.booked < slot.capacity)
        setAvailableSlots(slots.sort((a, b) => a.startTime.localeCompare(b.startTime)))
        setActionSlotId((current) => slots.some((slot) => slot.id === current) ? current : '')
      },
      (reason) => onError(`Unable to load available slots: ${reason.message}`),
    )
  }, [actionDoctorId, actionDate, onError])

  const startAction = (request: Appointment, action: AppointmentAction) => {
    setActionRequest({ id: request.id, action })
    setActionDate(request.assignedDate || request.requestedDate)
    setActionDoctorId(request.doctorId || request.requestedDoctorId || doctors.find((doctor) => doctor.department === request.department && doctor.status === 'available')?.id || '')
    setActionSlotId(request.slotId || request.requestedSlotId || '')
    setStaffNote('')
  }

  const submitAction = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!db || !actionRequest) return
    const { id, action } = actionRequest
    if (action !== 'declined' && (!actionDate || !actionDoctorId || !actionSlotId)) {
      onError('Choose a doctor and an available slot before confirming or suggesting a new time.')
      return
    }
    if (action === 'declined' && !staffNote.trim()) {
      onError('Add a reason before declining the request.')
      return
    }
    setSavingId(id)
    try {
      const firestore = db
      const appointmentRef = doc(firestore, 'appointments', id)
      await runTransaction(firestore, async (transaction) => {
        const appointmentSnapshot = await transaction.get(appointmentRef)
        if (!appointmentSnapshot.exists()) throw new Error('This appointment request is no longer available.')
        const appointmentData = appointmentSnapshot.data()
        const oldSlotId = String(appointmentData.slotId ?? '')
        const oldSlotRef = oldSlotId ? doc(firestore, 'slots', oldSlotId) : null
        const slotRef = action === 'declined' ? null : doc(firestore, 'slots', actionSlotId)
        const doctorRef = action === 'declined' ? null : doc(firestore, 'doctors', actionDoctorId)
        const trackingId = String(appointmentData.trackingId ?? '')
        const trackingRef = trackingId ? doc(firestore, 'appointmentTracking', trackingId) : null
        const oldSlotSnapshot = oldSlotRef && oldSlotId !== actionSlotId ? await transaction.get(oldSlotRef) : null
        const [slotSnapshot, doctorSnapshot, trackingSnapshot] = await Promise.all([
          slotRef ? transaction.get(slotRef) : Promise.resolve(null),
          doctorRef ? transaction.get(doctorRef) : Promise.resolve(null),
          trackingRef ? transaction.get(trackingRef) : Promise.resolve(null),
        ])
        if (action !== 'declined') {
          if (!slotSnapshot?.exists() || !doctorSnapshot?.exists()) throw new Error('The selected slot or doctor is no longer available.')
          const slotData = slotSnapshot.data()
          const doctorData = doctorSnapshot.data()
          if (slotData.doctorId !== actionDoctorId || slotData.date !== actionDate) throw new Error('The selected slot does not match the doctor and date.')
          if (doctorData.status !== 'available') throw new Error('This doctor is not currently available.')
          if (oldSlotId !== actionSlotId && Number(slotData.booked ?? 0) >= Number(slotData.capacity ?? 0)) throw new Error('This slot has just been filled. Please choose another time.')
        }
        if (!trackingRef || !trackingSnapshot?.exists()) throw new Error('Appointment tracking is unavailable. Please refresh the inbox.')
        if (oldSlotRef && oldSlotSnapshot?.exists()) {
          transaction.update(oldSlotRef, { booked: Math.max(0, Number(oldSlotSnapshot.data().booked ?? 0) - 1), lastReleasedAppointmentId: id })
        }
        if (slotRef && slotSnapshot?.exists() && oldSlotId !== actionSlotId) {
          transaction.update(slotRef, { booked: Number(slotSnapshot.data().booked ?? 0) + 1, lastBookedAppointmentId: id })
        }
        const assignedDoctor = doctors.find((doctor) => doctor.id === actionDoctorId)
        transaction.update(appointmentRef, {
          status: action,
          assignedDate: action === 'declined' ? '' : actionDate,
          assignedTime: action === 'declined' ? '' : String(slotSnapshot?.data()?.startTime ?? ''),
          doctorId: action === 'declined' ? '' : actionDoctorId,
          slotId: action === 'declined' ? '' : actionSlotId,
          staffNote: staffNote.trim(),
          needsReschedule: false,
          patientAction: 'none',
        })
        transaction.update(trackingRef, {
          status: action,
          assignedDate: action === 'declined' ? '' : actionDate,
          assignedTime: action === 'declined' ? '' : String(slotSnapshot?.data()?.startTime ?? ''),
          doctorName: action === 'declined' ? '' : assignedDoctor?.name ?? '',
          needsReschedule: false,
        })
      })
      setActionRequest(null)
      onError('')
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to update appointment: ${reason.message}` : 'Unable to update appointment.')
    } finally {
      setSavingId('')
    }
  }

  return (
    <main className="dashboard-page request-inbox-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to queue dashboard</button>
      <div className="dashboard-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> APPOINTMENT REQUESTS</div><h1>Request inbox<span>.</span></h1><p>Requests for {hospital?.name ?? 'your assigned hospital'}.</p></div>
        <div className="dashboard-actions"><span className="live-indicator"><span /> Live requests</span><span className="request-count">{requests.length} pending</span></div>
      </div>
      {!canUpdate && <div className="staff-note"><ShieldCheck size={17} /><span>Your role can review these requests but cannot change appointment status.</span></div>}
      {loading ? <div className="appointment-empty"><span className="spinner dark-spinner" /><p>Loading requests…</p></div> : requests.length ? (
        <div className="request-inbox-list">{requests.map((request) => {
          const isActionOpen = actionRequest?.id === request.id
          return (
            <article className={`request-card${request.urgent ? ' request-card-urgent' : ''}`} key={request.id}>
              <div className="request-card-heading">
                  <div><span className="appointment-status-pill pending">Pending</span>{request.urgent && <span className="urgent-label">Urgent</span>}<h2>{request.patient ? patientFullName(request.patient) : 'Patient details unavailable'}</h2><p>{request.patient?.mobileNumber ?? 'No mobile number'} · {request.department}</p></div>
                <span className="request-date">Preferred: {request.requestedDate}</span>
                </div>
                <dl className="request-details">
                  <div><dt>Reason for visit</dt><dd>{request.reason}</dd></div>
                  <div><dt>Companions</dt><dd>{request.companions}</dd></div>
                </dl>
              {canUpdate && <div className="request-actions">
                <button className="button button-dark" onClick={() => startAction(request, 'confirmed')}>Confirm <Check size={15} /></button>
                <button className="button button-outline" onClick={() => startAction(request, 'rescheduled')}>Suggest new time <CalendarDays size={15} /></button>
                <button className="button button-decline" onClick={() => startAction(request, 'declined')}>Decline <X size={15} /></button>
              </div>}
              {isActionOpen && <form className="request-action-form" onSubmit={submitAction}>
                <h3>{actionRequest.action === 'confirmed' ? 'Confirm appointment' : actionRequest.action === 'rescheduled' ? 'Suggest a new time' : 'Decline request'}</h3>
                {actionRequest.action !== 'declined' && <div className="appointment-fields-grid">
                  <label className="patient-field">Date<input required type="date" min={getLocalDateInputValue()} value={actionDate} onChange={(event) => setActionDate(event.target.value)} /></label>
                  <label className="patient-field">Doctor
                    <select required value={actionDoctorId} onChange={(event) => { setActionDoctorId(event.target.value); setActionSlotId('') }}>
                      <option value="">Choose doctor</option>
                      {doctors.filter((doctor) => doctor.status === 'available' && doctor.department === request.department).map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}
                    </select>
                  </label>
                  <label className="patient-field patient-field-wide">Available time
                    <select required value={actionSlotId} onChange={(event) => setActionSlotId(event.target.value)}>
                      <option value="">Choose available slot</option>
                      {availableSlots.map((slot) => <option key={slot.id} value={slot.id}>{slot.startTime} · {slot.capacity - slot.booked} available</option>)}
                    </select>
                  </label>
                  {!availableSlots.length && actionDoctorId && <p className="checkin-description patient-field-wide">No open slot for this doctor on this date. Add a slot in Slot Scheduler.</p>}
                </div>}
                <label className="patient-field">{actionRequest.action === 'declined' ? 'Reason for declining' : 'Note for patient (optional)'}<textarea required={actionRequest.action === 'declined'} maxLength={500} rows={2} value={staffNote} onChange={(event) => setStaffNote(event.target.value)} /></label>
                <div className="request-actions"><button className="button button-dark" type="submit" disabled={savingId === request.id}>{savingId === request.id ? <><span className="spinner" /> Saving…</> : 'Save update'}</button><button className="button button-outline" type="button" onClick={() => setActionRequest(null)}>Cancel</button></div>
              </form>}
            </article>
          )
        })}</div>
      ) : <div className="appointment-empty"><span className="empty-icon"><CalendarDays size={21} /></span><strong>Your request inbox is clear</strong><p>New appointment requests for this hospital will appear here automatically.</p></div>}
    </main>
  )
}

function SlotScheduler({ hospital, role, onBack, onError }: { hospital: Hospital | null; role: StaffRole | null; onBack: () => void; onError: (message: string) => void }) {
  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [slots, setSlots] = useState<AppointmentSlot[]>([])
  const [selectedDoctor, setSelectedDoctor] = useState('')
  const [selectedDate, setSelectedDate] = useState(getLocalDateInputValue)
  const [slotTime, setSlotTime] = useState('09:00')
  const [capacity, setCapacity] = useState(1)
  const [range, setRange] = useState<'day' | 'week'>('day')
  const [saving, setSaving] = useState(false)
  const canEdit = role === 'receptionist' || role === 'admin'

  useEffect(() => {
    if (!db || !hospital) return
    const unsubDoctors = onSnapshot(query(collection(db, 'doctors'), where('hospitalId', '==', hospital.id)), (snapshot) => {
      const next = snapshot.docs.map(getDoctor)
      setDoctors(next)
      setSelectedDoctor((current) => current || next[0]?.id || '')
    }, (reason) => onError(`Unable to load doctors: ${reason.message}`))
    const unsubSlots = onSnapshot(query(collection(db, 'slots'), where('hospitalId', '==', hospital.id)), (snapshot) => {
      setSlots(snapshot.docs.map(getSlot))
    }, (reason) => onError(`Unable to load appointment slots: ${reason.message}`))
    return () => { unsubDoctors(); unsubSlots() }
  }, [hospital, onError])

  const addSlot = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!db || !hospital || !selectedDoctor || !canEdit) return
    const firestore = db
    const slotId = `${selectedDoctor}_${selectedDate}_${slotTime.replace(':', '')}`
    setSaving(true)
    try {
      await runTransaction(firestore, async (transaction) => {
        const slotRef = doc(firestore, 'slots', slotId)
        const existing = await transaction.get(slotRef)
        if (existing.exists()) {
          const booked = Number(existing.data().booked ?? 0)
          if (capacity < booked) throw new Error(`Capacity cannot be lower than the ${booked} existing booking(s).`)
          transaction.update(slotRef, { capacity })
        } else {
          transaction.set(slotRef, {
            doctorId: selectedDoctor,
            hospitalId: hospital.id,
            date: selectedDate,
            startTime: slotTime,
            capacity,
            booked: 0,
            lastBookedAppointmentId: '',
            lastReleasedAppointmentId: '',
          })
        }
      })
      onError('')
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to save slot: ${reason.message}` : 'Unable to save slot.')
    } finally {
      setSaving(false)
    }
  }

  const date = new Date(`${selectedDate}T00:00:00`)
  const monday = new Date(date)
  monday.setDate(date.getDate() - ((date.getDay() + 6) % 7))
  const visibleDates = range === 'day' ? [selectedDate] : Array.from({ length: 7 }, (_, index) => {
    const value = new Date(monday)
    value.setDate(monday.getDate() + index)
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  })
  const selectedDoctorName = doctors.find((doctor) => doctor.id === selectedDoctor)?.name ?? 'doctor'
  const visibleSlots = slots.filter((slot) => slot.doctorId === selectedDoctor && visibleDates.includes(slot.date)).sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime))

  return (
    <main className="dashboard-page staff-tool-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to queue dashboard</button>
      <div className="appointment-page-heading"><div className="eyebrow"><span className="eyebrow-line" /> APPOINTMENT SCHEDULING</div><h1>Slot scheduler.</h1><p>Create appointment slots and review the selected doctor’s day or week.</p></div>
      <section className="staff-tool-card">
        <div className="queue-panel-header"><div><h2>Set slot timings</h2><p>Bookings cannot exceed the slot capacity.</p></div></div>
        {canEdit ? <form className="slot-create-form" onSubmit={addSlot}>
          <label className="patient-field">Doctor<select required value={selectedDoctor} onChange={(event) => setSelectedDoctor(event.target.value)}><option value="">Select doctor</option>{doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name} · {doctor.department}</option>)}</select></label>
          <label className="patient-field">Date<input required type="date" min={getLocalDateInputValue()} value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
          <label className="patient-field">Start time<input required type="time" value={slotTime} onChange={(event) => setSlotTime(event.target.value)} /></label>
          <label className="patient-field">Capacity<input required type="number" min={1} max={100} value={capacity} onChange={(event) => setCapacity(Number(event.target.value))} /></label>
          <button className="button button-dark" type="submit" disabled={saving || !doctors.length}>{saving ? 'Saving…' : <>Save slot <Plus size={15} /></>}</button>
        </form> : <div className="staff-note">Your role can view schedules but cannot create or change slots.</div>}
      </section>
      <section className="queue-panel scheduler-panel">
        <div className="queue-panel-header">
          <div><h2>{selectedDoctorName}’s schedule</h2><p>Booked counts update after each confirmed appointment.</p></div>
          <div className="scheduler-controls">
            <label className="filter-label">Doctor<select value={selectedDoctor} onChange={(event) => setSelectedDoctor(event.target.value)}>{doctors.map((doctor) => <option key={doctor.id} value={doctor.id}>{doctor.name}</option>)}</select></label>
            <label className="filter-label">Date<input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
            <div className="view-toggle"><button className={range === 'day' ? 'selected' : ''} onClick={() => setRange('day')}>Day</button><button className={range === 'week' ? 'selected' : ''} onClick={() => setRange('week')}>Week</button></div>
          </div>
        </div>
        <div className="slot-grid">{visibleSlots.map((slot) => (
          <article className="slot-card" key={slot.id}><span>{slot.date}</span><strong>{slot.startTime}</strong><small>{slot.booked} / {slot.capacity} booked</small><span className={slot.booked >= slot.capacity ? 'slot-full' : 'slot-open'}>{slot.booked >= slot.capacity ? 'Full' : `${slot.capacity - slot.booked} open`}</span></article>
        ))}{visibleSlots.length === 0 && <div className="appointment-empty"><span className="empty-icon"><CalendarDays size={21} /></span><strong>No slots for this view</strong><p>Choose another doctor or add a slot above.</p></div>}</div>
      </section>
    </main>
  )
}

function DoctorAvailability({ hospital, role, onBack, onError }: { hospital: Hospital | null; role: StaffRole | null; onBack: () => void; onError: (message: string) => void }) {
  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [name, setName] = useState('')
  const [department, setDepartment] = useState<Department>('General medicine')
  const [userId, setUserId] = useState('')
  const [saving, setSaving] = useState(false)
  const canEdit = role === 'receptionist' || role === 'admin'

  useEffect(() => {
    if (!db || !hospital) return
    return onSnapshot(query(collection(db, 'doctors'), where('hospitalId', '==', hospital.id)), (snapshot) => {
      setDoctors(snapshot.docs.map(getDoctor).sort((a, b) => a.name.localeCompare(b.name)))
    }, (reason) => onError(`Unable to load doctors: ${reason.message}`))
  }, [hospital, onError])

  const addDoctor = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!db || !hospital) return
    setSaving(true)
    try {
      const doctorRef = doc(collection(db, 'doctors'))
      await setDoc(doctorRef, {
        name: name.trim(),
        department,
        hospitalId: hospital.id,
        userId: userId.trim(),
        status: 'available',
        lateByMinutes: 0,
        note: '',
      })
      setName('')
      setUserId('')
      onError('')
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to add doctor: ${reason.message}` : 'Unable to add doctor.')
    } finally {
      setSaving(false)
    }
  }

  const changeAvailability = async (doctor: Doctor, status: DoctorStatus, lateByMinutes: number, note: string, linkedUserId: string) => {
    if (!db || !canEdit) return
    const firestore = db
    try {
      await updateDoc(doc(firestore, 'doctors', doctor.id), { status, lateByMinutes: status === 'late' ? lateByMinutes : 0, note: note.trim(), userId: linkedUserId.trim() })
      if (status !== 'available') {
        const snapshot = await getDocs(query(
          collection(firestore, 'appointments'),
          where('hospitalId', '==', doctor.hospitalId),
          where('doctorId', '==', doctor.id),
        ))
        const affected = snapshot.docs.map(toAppointment).filter((appointment) =>
          ['confirmed', 'rescheduled'].includes(appointment.status) && appointment.assignedDate >= getLocalDateInputValue(),
        )
        await Promise.all(affected.map(async (appointment) => {
          const trackingRef = doc(firestore, 'appointmentTracking', appointment.trackingId)
          const appointmentRef = doc(firestore, 'appointments', appointment.id)
          await runTransaction(firestore, async (transaction) => {
            const [appointmentSnapshot, trackingSnapshot] = await Promise.all([
              transaction.get(appointmentRef),
              transaction.get(trackingRef),
            ])
            if (!appointmentSnapshot.exists() || !trackingSnapshot.exists()) return
            transaction.update(appointmentRef, { needsReschedule: true })
            transaction.update(trackingRef, { needsReschedule: true })
          })
        }))
      }
      onError('')
    } catch (reason) {
      onError(reason instanceof Error ? `Availability saved, but appointment updates failed: ${reason.message}` : 'Unable to update doctor availability.')
    }
  }

  return (
    <main className="dashboard-page staff-tool-page">
      <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to queue dashboard</button>
      <div className="appointment-page-heading"><div className="eyebrow"><span className="eyebrow-line" /> DOCTOR STATUS</div><h1>Doctor availability.</h1><p>Availability changes flag upcoming appointments so patients see a live notice.</p></div>
      {canEdit && <form className="staff-tool-card doctor-create-form" onSubmit={addDoctor}>
        <h2>Add a doctor</h2><div className="slot-create-form"><label className="patient-field">Doctor name<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label><label className="patient-field">Department<select value={department} onChange={(event) => setDepartment(event.target.value as Department)}>{departments.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><label className="patient-field">Doctor staff user ID<input maxLength={128} value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="Staff user ID" /></label><button className="button button-dark" disabled={saving}>{saving ? 'Saving…' : <>Add doctor <Plus size={15} /></>}</button></div>
      </form>}
      <div className="doctor-list">{doctors.map((doctor) => (
        <article className="doctor-card" key={doctor.id}>
          <div className="doctor-card-summary"><span className="department-icon mint"><Stethoscope size={18} /></span><div><strong>{doctor.name}</strong><small>{doctor.department}</small></div><span className={`doctor-status-pill ${doctor.status}`}>{doctor.status.replace('_', ' ')}</span></div>
          {doctor.note && <p className="doctor-note">{doctor.note}</p>}
          {canEdit && <DoctorAvailabilityControls doctor={doctor} onSave={changeAvailability} />}
        </article>
      ))}{doctors.length === 0 && <div className="appointment-empty"><span className="empty-icon"><Stethoscope size={21} /></span><strong>No doctors have been added</strong><p>Add doctors to create appointment slots and assign bookings.</p></div>}</div>
    </main>
  )
}

function DoctorAvailabilityControls({ doctor, onSave }: { doctor: Doctor; onSave: (doctor: Doctor, status: DoctorStatus, lateByMinutes: number, note: string, userId: string) => Promise<void> }) {
  const [status, setStatus] = useState<DoctorStatus>(doctor.status)
  const [lateByMinutes, setLateByMinutes] = useState(doctor.lateByMinutes)
  const [note, setNote] = useState(doctor.note)
  const [userId, setUserId] = useState(doctor.userId)
  return <form className="doctor-availability-form" onSubmit={(event) => { event.preventDefault(); void onSave(doctor, status, lateByMinutes, note, userId) }}>
    <label className="patient-field">Availability<select value={status} onChange={(event) => setStatus(event.target.value as DoctorStatus)}><option value="available">Available</option><option value="late">Running late</option><option value="on_leave">On leave</option><option value="emergency_only">Emergency only</option></select></label>
    {status === 'late' && <label className="patient-field">Late by (minutes)<input type="number" min={1} max={1440} value={lateByMinutes} onChange={(event) => setLateByMinutes(Number(event.target.value))} /></label>}
    <label className="patient-field">Patient note<input maxLength={200} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional update" /></label>
    <label className="patient-field">Doctor staff user ID<input maxLength={128} value={userId} onChange={(event) => setUserId(event.target.value)} placeholder="Staff user ID" /></label>
    <button className="button button-outline" type="submit">Save availability</button>
  </form>
}

function PatientSearch({ hospital, onBack, onError, onOpenHistory }: { hospital: Hospital | null; onBack: () => void; onError: (message: string) => void; onOpenHistory: (patient: SelectedPatient) => void }) {
  const [lookup, setLookup] = useState('')
  const [patients, setPatients] = useState<SelectedPatient[]>([])
  const [loading, setLoading] = useState(false)

  const search = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!db || !hospital || !lookup.trim()) return
    setLoading(true)
    try {
      const value = lookup.trim()
      const isPhoneNumber = /^\+?[\d\s().-]+$/.test(value)
      const result = !isPhoneNumber
        ? await getDoc(doc(db, 'patients', value))
        : await getDocs(query(
          collection(db, 'patients'),
          where('hospitalIds', 'array-contains', hospital.id),
          where('mobileNumber', '==', value),
          limit(20),
        ))
      const docs = 'docs' in result ? result.docs : result.exists() ? [result] : []
      const nextPatients = docs.flatMap((snapshot) => {
        const data = snapshot.data()
        return data && isPatientDetails(data.details) && Array.isArray(data.hospitalIds) && data.hospitalIds.includes(hospital.id)
          ? [{ id: snapshot.id, details: data.details, mobileNumber: String(data.mobileNumber ?? '') }]
          : []
      })
      setPatients(nextPatients)
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to search patients: ${reason.message}` : 'Unable to search patients.')
    } finally {
      setLoading(false)
    }
  }

  return <main className="dashboard-page staff-tool-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to queue dashboard</button>
    <div className="appointment-page-heading"><div className="eyebrow"><span className="eyebrow-line" /> PATIENT LOOKUP</div><h1>Patient search.</h1><p>Search patients who have previously contacted {hospital?.name ?? 'your hospital'} by mobile number or patient ID.</p></div>
    <form className="patient-search-form" onSubmit={search}><label className="patient-field">Mobile number or patient ID<input value={lookup} onChange={(event) => setLookup(event.target.value)} required placeholder="Enter mobile number or patient ID" /></label><button className="button button-dark" disabled={loading}>{loading ? 'Searching…' : <><Search size={16} /> Search</>}</button></form>
    <div className="doctor-list">{patients.map((patient) => <article className="doctor-card" key={patient.id}><div className="doctor-card-summary"><span className="department-icon mint"><Users size={18} /></span><div><strong>{patientFullName(patient.details)}</strong><small>{patient.mobileNumber} · Patient ID: {patient.id}</small></div></div><dl className="request-details"><div><dt>Hospital</dt><dd>{hospital?.name}</dd></div></dl><button className="button button-outline" onClick={() => onOpenHistory(patient)}>Open patient history <ArrowRight size={15} /></button></article>)}{!loading && lookup && patients.length === 0 && <div className="appointment-empty"><span className="empty-icon"><Search size={21} /></span><strong>No patient found</strong><p>Check the mobile number or patient ID and try again.</p></div>}</div>
  </main>
}

function CreateRequestOnBehalf({ hospital, role, onBack, onError, onCreated }: { hospital: Hospital | null; role: StaffRole | null; onBack: () => void; onError: (message: string) => void; onCreated: (trackingId: string) => void }) {
  const [department, setDepartment] = useState<Department>('General medicine')
  const [requestedDate, setRequestedDate] = useState(getLocalDateInputValue)
  const [reason, setReason] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [companions, setCompanions] = useState(0)
  const [details, setDetails] = useState<PatientDetails>(emptyPatientDetails)
  const [consent, setConsent] = useState(false)
  const [recordsConsent, setRecordsConsent] = useState(false)
  const [saving, setSaving] = useState(false)
  const canCreate = role === 'receptionist' || role === 'admin'
  const updateDetails = (field: keyof PatientDetails, value: string) => setDetails((current) => ({ ...current, [field]: value }))

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!db || !auth?.currentUser || !hospital || !canCreate) {
      onError('Only a signed-in receptionist or administrator can create requests for callers.')
      return
    }
    const firestore = db
    const staffUid = auth.currentUser.uid
    const cleanDetails = normalizePatientDetails(details)
    if (!consent || !recordsConsent || !hasRequiredPatientDetails(cleanDetails) || !reason.trim()) {
      onError('Complete the patient and appointment details and confirm the caller’s consent for sharing and records storage.')
      return
    }
    setSaving(true)
    try {
      const patientRef = doc(collection(firestore, 'patients'))
      const appointmentRef = doc(collection(firestore, 'appointments'))
      const trackingRef = doc(collection(firestore, 'appointmentTracking'))
      await runTransaction(firestore, async (transaction) => {
        transaction.set(patientRef, {
          ownerUid: '',
          hospitalIds: [hospital.id],
          details: cleanDetails,
          mobileNumber: cleanDetails.mobileNumber,
          createdAt: serverTimestamp(),
        })
        transaction.set(appointmentRef, {
          trackingId: trackingRef.id,
          patientId: patientRef.id,
          ownerUid: '',
          createdBy: staffUid,
          hospitalId: hospital.id,
          department,
          doctorId: '',
          slotId: '',
          patientMobile: cleanDetails.mobileNumber,
          requestedDate,
          reason: reason.trim(),
          urgent,
          companions,
          status: 'pending',
          assignedDate: '',
          assignedTime: '',
          staffNote: '',
          needsReschedule: false,
          patientAction: 'none',
          recordId: '',
          createdAt: serverTimestamp(),
          consentAt: serverTimestamp(),
          recordsConsentAt: serverTimestamp(),
        })
        transaction.set(trackingRef, {
          appointmentId: appointmentRef.id,
          hospitalId: hospital.id,
          department,
          status: 'pending',
          requestedDate,
          assignedDate: '',
          assignedTime: '',
          doctorName: '',
          needsReschedule: false,
        })
      })
      onCreated(trackingRef.id)
    } catch (reasonValue) {
      onError(reasonValue instanceof Error ? `Unable to create request: ${reasonValue.message}` : 'Unable to create request.')
    } finally {
      setSaving(false)
    }
  }

  return <main className="appointment-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to queue dashboard</button>
    <section className="appointment-form-card">
      <div className="eyebrow"><span className="eyebrow-line" /> PHONE REQUEST</div><h1>Create request for caller.</h1><p className="appointment-intro">The status QR can be shared with the caller after creating the request. Confirm that the caller consents to sharing these details.</p>
      {!canCreate ? <div className="staff-note">Only receptionists and administrators can create requests on behalf of patients.</div> : <form className="patient-details-form" onSubmit={submit}>
        <label className="patient-field patient-field-wide">Hospital<input readOnly value={hospital?.name ?? ''} /></label>
        <div className="appointment-fields-grid">
          <label className="patient-field">Department<select value={department} onChange={(event) => setDepartment(event.target.value as Department)}>{departments.map((item) => <option key={item.name}>{item.name}</option>)}</select></label>
          <label className="patient-field">Preferred date<input type="date" required min={getLocalDateInputValue()} value={requestedDate} onChange={(event) => setRequestedDate(event.target.value)} /></label>
          <label className="patient-field patient-field-wide">Reason<textarea required maxLength={500} rows={2} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
          <label className="patient-field">Companions<input type="number" min={0} max={20} value={companions} onChange={(event) => setCompanions(Number(event.target.value))} /></label>
        </div>
        <label className="appointment-urgent"><input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} /><span><strong>Caller says request is urgent</strong><small>For emergencies, direct the caller to emergency services.</small></span></label>
        <h2 className="appointment-subheading">Patient details</h2><PatientDetailsFields patientDetails={details} updatePatientDetails={updateDetails} />
        <label className="patient-consent"><input type="checkbox" required checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>Caller gave consent to share their details and request with this hospital.</span></label>
        <label className="patient-consent"><input type="checkbox" required checked={recordsConsent} onChange={(event) => setRecordsConsent(event.target.checked)} /><span>Caller agrees to their medical records being stored securely and shared with their care team.</span></label>
        <button className="button button-dark appointment-submit" disabled={saving}>{saving ? 'Creating request…' : <>Create request <ArrowRight size={16} /></>}</button>
      </form>}
    </section>
  </main>
}

function NotificationQueuePage({ hospital, onBack, onError }: {
  hospital: Hospital | null
  onBack: () => void
  onError: (message: string) => void
}) {
  const [messages, setMessages] = useState<Array<{
    id: string
    type: string
    patientMobile: string
    patientLanguage: string
    assignedDate: string
    assignedTime: string
    expiresAt?: { seconds: number }
    message: string
  }>>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    if (!db || !hospital) {
      setMessages([])
      setLoading(false)
      return
    }
    return onSnapshot(query(
      collection(db, 'notifications'),
      where('hospitalId', '==', hospital.id),
      where('status', '==', 'queued'),
      limit(100),
    ), (snapshot) => {
      setMessages(snapshot.docs.map((item) => {
        const data = item.data()
        return {
          id: item.id,
          type: String(data.type ?? ''),
          patientMobile: String(data.patientMobile ?? ''),
          patientLanguage: String(data.patientLanguage ?? 'en'),
          assignedDate: String(data.assignedDate ?? ''),
          assignedTime: String(data.assignedTime ?? ''),
          expiresAt: data.expiresAt,
          message: String(data.message ?? ''),
        }
      }))
      setLoading(false)
    }, (reason) => {
      setLoading(false)
      onError(`Unable to load queued patient messages: ${reason.message}`)
    })
  }, [hospital?.id, onError])

  const markHandled = async (id: string) => {
    setBusyId(id)
    try {
      await markNotificationHandled(id)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to update this message.')
    } finally {
      setBusyId('')
    }
  }

  return <main className="dashboard-page staff-tool-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to queue dashboard</button>
    <div className="dashboard-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> PATIENT MESSAGES</div><h1>Messages to send<span>.</span></h1><p>Messages stay queued until staff opens WhatsApp and marks them handled.</p></div><span className="request-count">{messages.length} queued</span></div>
    <div className="staff-note"><MessageCircle size={17} /><span>No messaging vendor is configured. Sending happens only when staff opens WhatsApp; CareFlow does not send automatically.</span></div>
    {loading ? <div className="appointment-empty"><span className="spinner dark-spinner" /><p>Loading queued messages…</p></div>
      : messages.length === 0 ? <div className="appointment-empty"><span className="empty-icon"><CheckCircle2 size={21} /></span><strong>No messages waiting</strong><p>Appointment reminders and updates will appear here.</p></div>
        : <div className="request-inbox-list">{messages.map((item) => {
          const phone = item.patientMobile.replace(/\D/g, '')
          const label = item.type === 'reminder-24h' ? 'Day-before reminder'
            : item.type === 'reminder-2h' ? 'Two-hour reminder'
              : item.type === 'waitlist-offer' ? 'Waitlist time offer'
                : item.type === 'staff-message' ? 'Staff message' : 'Appointment update'
          return <article className="request-card" key={item.id}>
            <div className="request-card-heading"><div><span className="appointment-status-pill pending">Queued</span><h2>{label}</h2><p>{item.patientMobile || 'No mobile number'} · {item.patientLanguage.toUpperCase()}</p></div>
              <span className="request-date">{item.assignedDate} {item.assignedTime}{item.expiresAt ? ` · Expires ${new Date(item.expiresAt.seconds * 1000).toLocaleTimeString()}` : ''}</span></div>
            <p className="appointment-staff-note">{item.message}</p>
            <div className="request-actions">
              {phone
                ? <a className="button button-dark" href={getWhatsAppUrl(phone, item.message)} target="_blank" rel="noreferrer"><MessageCircle size={15} /> Open WhatsApp to send</a>
                : <span className="contact-not-configured"><MessageCircle size={15} /> No mobile number on file</span>}
              <button className="button button-outline" disabled={busyId === item.id} onClick={() => void markHandled(item.id)}>{busyId === item.id ? 'Saving…' : 'Mark handled'}</button>
            </div>
          </article>
        })}</div>}
  </main>
}

function PrivacyRequestsPage({ onBack, onError }: { onBack: () => void; onError: (message: string) => void }) {
  const [requests, setRequests] = useState<Array<{ id: string; type: 'export' | 'erase'; status: string; requestedAt: string }>>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const result = await listPrivacyRequests()
        if (active) {
          setRequests(result.requests)
          setLoading(false)
        }
      } catch (reason) {
        if (active) {
          setLoading(false)
          onError(reason instanceof Error ? `Unable to load privacy requests: ${reason.message}` : 'Unable to load privacy requests.')
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [onError])

  const approve = async (item: (typeof requests)[number]) => {
    if (item.type === 'erase' && !window.confirm('Permanently erase the patient data in this request? This cannot be undone.')) return
    setBusyId(item.id)
    try {
      const result = await approvePrivacyRequest(item.id)
      setRequests((current) => current.filter((entry) => entry.id !== item.id))
      if (item.type === 'export' && result.export) {
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.export, null, 2)], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `careflow-patient-export-${item.id}.json`
        anchor.click()
        URL.revokeObjectURL(url)
      }
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to approve privacy request: ${reason.message}` : 'Unable to approve privacy request.')
    } finally {
      setBusyId('')
    }
  }

  return <main className="dashboard-page staff-tool-page">
    <button className="back-link" onClick={onBack}><ArrowLeft size={16} /> Back to dashboard</button>
    <div className="dashboard-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> PRIVACY CONTROLS</div><h1>Privacy requests<span>.</span></h1><p>Review export and erasure requests for your hospital.</p></div></div>
    {loading ? <div className="appointment-empty"><span className="spinner dark-spinner" /><p>Loading requests…</p></div>
      : requests.length === 0 ? <div className="appointment-empty"><span className="empty-icon"><ShieldCheck size={21} /></span><strong>No pending requests</strong><p>New patient privacy requests will appear here.</p></div>
        : <div className="request-inbox-list">{requests.map((item) => <article className="request-card" key={item.id}>
          <div className="request-card-heading"><div><span className="appointment-status-pill pending">Pending</span><h2>{item.type === 'export' ? 'Data export' : 'Data erasure'}</h2><p>Request received {new Date(item.requestedAt).toLocaleString()}</p></div></div>
          <div className="request-actions"><button className="button button-dark" disabled={busyId === item.id} onClick={() => void approve(item)}>{busyId === item.id ? 'Processing…' : item.type === 'export' ? 'Approve and download' : 'Approve erasure'}</button></div>
        </article>)}</div>}
  </main>
}

function StaffDashboard({ tickets, hospital, role, onOpenInbox, onOpenScheduler, onOpenDoctors, onOpenSearch, onOpenToday, onCreateRequest, onOpenPrivacy, onOpenNotifications, onLogout, onError }: {
  tickets: Ticket[]
  hospital: Hospital | null
  role: StaffRole | null
  onOpenInbox: () => void
  onOpenScheduler: () => void
  onOpenDoctors: () => void
  onOpenSearch: () => void
  onOpenToday: () => void
  onCreateRequest: () => void
  onOpenPrivacy: () => void
  onOpenNotifications: () => void
  onLogout: () => void
  onError: (message: string) => void
}) {
  const [department, setDepartment] = useState<'All departments' | Department>('All departments')
  const [updatingId, setUpdatingId] = useState('')
  const [patientDetails, setPatientDetails] = useState<{ ticket: Ticket; details: PatientDetails } | null>(null)
  const [loadingDetailsId, setLoadingDetailsId] = useState('')
  const sortedTickets = useMemo(
    () => [...tickets].sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0)),
    [tickets],
  )
  const filtered = sortedTickets.filter((ticket) => department === 'All departments' || ticket.department === department)
  const waiting = tickets.filter((ticket) => ticket.status === 'waiting').length
  const called = tickets.filter((ticket) => ticket.status === 'called').length
  const completed = tickets.filter((ticket) => ticket.status === 'completed').length

  const viewPatientDetails = async (ticket: Ticket) => {
    if (!db) {
      onError('The local CareFlow server is not available, so patient details cannot be loaded.')
      return
    }
    setLoadingDetailsId(ticket.id)
    try {
      const snapshot = await getDoc(doc(db, 'patientDetails', ticket.id))
      const data = snapshot.data()
      if (!snapshot.exists() || !data || !isPatientDetails(data.details)) {
        throw new Error('No patient details are available for this ticket.')
      }
      setPatientDetails({ ticket, details: data.details })
    } catch (reason) {
      onError(reason instanceof Error ? `Unable to load patient details: ${reason.message}` : 'Unable to load patient details.')
    } finally {
      setLoadingDetailsId('')
    }
  }

  const updateStatus = async (ticket: Ticket, nextStatus: TicketStatus) => {
    if (!db) return
    setUpdatingId(ticket.id)
    try {
      const batch = writeBatch(db)
      batch.update(doc(db, 'tickets', ticket.id), { status: nextStatus })
      batch.update(doc(db, 'tracking', ticket.id), { status: nextStatus })
      await batch.commit()
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'Unable to update ticket status.')
    } finally {
      setUpdatingId('')
    }
  }

  return (
    <main className="dashboard-page">
      <div className="dashboard-heading">
        <div><div className="eyebrow"><span className="eyebrow-line" /> CARE TEAM OVERVIEW</div><h1>Good morning, team<span>.</span></h1><p>Queue for {hospital?.name ?? 'your assigned hospital'}.</p></div>
        <div className="dashboard-actions staff-tools-actions">
          <span className="live-indicator"><span /> Live queue</span>
          {role === 'doctor' && <button className="button button-outline" onClick={onOpenToday}>My patients today <ArrowRight size={14} /></button>}
          <button className="button button-outline" onClick={onOpenInbox}>Request inbox <ArrowRight size={14} /></button>
          <button className="button button-outline" onClick={onOpenScheduler}>Slot scheduler</button>
          <button className="button button-outline" onClick={onOpenDoctors}>Doctor availability</button>
          <button className="button button-outline" onClick={onOpenSearch}>Patient search</button>
          <button className="button button-outline" onClick={onCreateRequest}><UserPlus size={14} /> Create request</button>
          {role === 'admin' && <button className="button button-outline" onClick={onOpenPrivacy}>Privacy requests</button>}
          {(role === 'admin' || role === 'receptionist') && <button className="button button-outline" onClick={onOpenNotifications}>Patient messages</button>}
          <button className="button button-outline" onClick={onLogout}><LogOut size={15} /> Sign out</button>
        </div>
      </div>
      <div className="metric-grid">
        <Metric icon={<Users size={18} />} label="Waiting" value={waiting} detail="Patients in queue" theme="mint" />
        <Metric icon={<Bell size={18} />} label="Called in" value={called} detail="Ready to be seen" theme="peach" />
        <Metric icon={<CheckCircle2 size={18} />} label="Completed" value={completed} detail="Visits finished today" theme="lavender" />
        <Metric icon={<Activity size={18} />} label="Total tickets" value={tickets.length} detail="All visits today" theme="blue" />
      </div>
      <section className="queue-panel">
        <div className="queue-panel-header"><div><h2>Patient queue</h2><p>Update a ticket to notify the patient in real time.</p></div><label className="filter-label"><span>Showing</span><select value={department} onChange={(event) => setDepartment(event.target.value as typeof department)}><option>All departments</option>{departments.map((item) => <option key={item.name}>{item.name}</option>)}</select></label></div>
        <div className="queue-table-wrap">
          <table className="queue-table">
            <thead><tr><th>TICKET</th><th>DEPARTMENT</th><th>CHECKED IN</th><th>STATUS</th><th><span className="sr-only">Action</span></th></tr></thead>
            <tbody>{filtered.map((ticket) => <tr key={ticket.id}>
              <td><span className="table-ticket">#{ticket.code}</span></td><td>{ticket.department}</td><td>{formatTime(ticket.createdAt)}</td>
              <td><span className={`ticket-status ${ticket.status}`}><span />{statusLabels[ticket.status]}</span></td>
              <td><div className="queue-row-actions">
                <button className="queue-action details-action" onClick={() => viewPatientDetails(ticket)} disabled={loadingDetailsId !== ''}>{loadingDetailsId === ticket.id ? <span className="spinner dark-spinner" /> : <>Patient details <ArrowRight size={14} /></>}</button>
                {ticket.status === 'waiting' && <button className="queue-action call-action" onClick={() => updateStatus(ticket, 'called')} disabled={updatingId === ticket.id}>Call next <ArrowRight size={14} /></button>}
                {ticket.status === 'called' && <button className="queue-action call-action" onClick={() => updateStatus(ticket, 'arrived')} disabled={updatingId === ticket.id}>Arrived <Check size={14} /></button>}
                {(ticket.status === 'waiting' || ticket.status === 'called') && <button className="queue-action" onClick={() => updateStatus(ticket, 'no_show')} disabled={updatingId === ticket.id}>No-show</button>}
                {ticket.status === 'arrived' && <button className="queue-action call-action" onClick={() => updateStatus(ticket, 'completed')} disabled={updatingId === ticket.id}>Complete <Check size={14} /></button>}
                {(ticket.status === 'completed' || ticket.status === 'no_show') && <span className="queue-action"><Check size={15} /> Done</span>}
              </div></td>
            </tr>)}</tbody>
          </table>
          {filtered.length === 0 && <div className="empty-queue"><span className="empty-icon"><Users size={21} /></span><strong>{tickets.length ? 'No tickets in this department' : 'Your queue is clear.'}</strong><span>{tickets.length ? 'Choose another department to see more visits.' : 'New patient check-ins will appear here automatically.'}</span></div>}
        </div>
        <div className="queue-panel-footer"><span><span className="live-dot" /> Updates automatically</span><span>{filtered.length} {filtered.length === 1 ? 'ticket' : 'tickets'}</span></div>
      </section>
      <div className="staff-note"><ShieldCheck size={17} /><span><strong>Privacy reminder</strong> — Personal details are stored separately from public ticket tracking and are visible only to the patient and staff assigned to this hospital.</span></div>
      {patientDetails && <PatientDetailsDialog ticket={patientDetails.ticket} details={patientDetails.details} onClose={() => setPatientDetails(null)} />}
    </main>
  )
}

function Metric({ icon, label, value, detail, theme }: { icon: React.ReactNode; label: string; value: number; detail: string; theme: string }) {
  return <article className="metric-card"><span className={`metric-icon ${theme}`}>{icon}</span><span className="metric-label">{label}</span><strong className="metric-value">{value}</strong><span className="metric-detail">{detail}</span></article>
}
