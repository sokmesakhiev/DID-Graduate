import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import bcrypt from "bcryptjs";

export interface IssuedCredential {
  credentialRecordId: string;
  degree: string;
  graduationDate: string;
  gpa?: number;
  issuedAt: string;
  /** true only after the student wallet has acknowledged the revocation */
  revoked: boolean;
  /** set when revocation is initiated on the agent — wallet confirmation pending */
  revocationPendingAt?: string;
  /** set when the student wallet confirms it has processed the revocation */
  revocationConfirmedAt?: string;
  /** human-readable reason provided by the issuer */
  revocationReason?: string;
  /** Cardano transaction hash for the on-chain VC hash anchor */
  cardanoTxHash?: string;
  /** Preprod/mainnet Cardanoscan URL for the anchor tx */
  cardanoscanUrl?: string;
  /** Cardano transaction hash for the on-chain revocation notice */
  cardanoRevocationTxHash?: string;
  /** Cardanoscan URL for the revocation tx */
  cardanoRevocationUrl?: string;
  /**
   * Original issuance parameters — stored so we can re-issue if the
   * DIDComm offer was dropped and the wallet never received it.
   */
  issuingDid?: string;
  schemaId?: string;
  studentName?: string;
  studentIdField?: string;
  universityName?: string;
  /**
   * Last known Cloud Agent state for this credential record.
   * e.g. OfferSent | RequestReceived | CredentialSent | ProblemReportReceived
   * Populated / refreshed by the delivery-status endpoint.
   */
  deliveryState?: string;
  /** ISO timestamp of the last delivery-state sync */
  deliveryCheckedAt?: string;
  /** Set when the student wallet confirms it has stored the credential */
  walletConfirmedAt?: string;
  /** Set when the credential is considered undeliverable */
  failedAt?: string;
  /** Human-readable reason for delivery failure */
  failureReason?: string;
}

export interface Student {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  studentNumber: string;
  connectionId?: string;
  createdAt: string;
  // Server-side wallet backup — enables device-independent access.
  // walletSeed: the HD seed bytes used to derive all DID keys.
  // walletBackup: serialised Pluto database (credentials + DIDComm state).
  walletSeed?: number[];
  walletBackup?: unknown;
  walletDid?: string;
  issuedCredentials?: IssuedCredential[];
}

const DATA_DIR = resolve(__dirname, "../../data");
const STORE_PATH = resolve(DATA_DIR, "students.json");

function loadStudents(): Student[] {
  if (!existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf-8")) as Student[];
  } catch {
    return [];
  }
}

function saveStudents(students: Student[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(students, null, 2), "utf-8");
}

export function findByEmail(email: string): Student | undefined {
  return loadStudents().find((s) => s.email === email.toLowerCase());
}

export function findById(id: string): Student | undefined {
  return loadStudents().find((s) => s.id === id);
}

export async function createStudent(
  email: string,
  password: string,
  name: string,
  studentNumber: string
): Promise<Student> {
  const students = loadStudents();
  if (students.find((s) => s.email === email.toLowerCase())) {
    throw new Error("Email already registered");
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const student: Student = {
    id: randomUUID(),
    email: email.toLowerCase(),
    passwordHash,
    name,
    studentNumber,
    createdAt: new Date().toISOString(),
  };
  students.push(student);
  saveStudents(students);
  return student;
}

export async function verifyPassword(
  student: Student,
  password: string
): Promise<boolean> {
  return bcrypt.compare(password, student.passwordHash);
}

export function updateConnection(id: string, connectionId: string): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === id);
  if (!student) throw new Error("Student not found");
  student.connectionId = connectionId;
  saveStudents(students);
}

export function clearConnection(id: string): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === id);
  if (!student) throw new Error("Student not found");
  delete student.connectionId;
  saveStudents(students);
}

export function listStudents(): Omit<Student, "passwordHash" | "walletSeed" | "walletBackup">[] {
  return loadStudents().map(({ passwordHash: _pw, walletSeed: _s, walletBackup: _b, ...rest }) => rest);
}

export function getWalletData(id: string): { seed: number[] | null; backup: unknown | null } {
  const student = findById(id);
  if (!student) return { seed: null, backup: null };
  return { seed: student.walletSeed ?? null, backup: student.walletBackup ?? null };
}

export function updateWalletData(id: string, seed: number[], backup: unknown): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === id);
  if (!student) throw new Error("Student not found");
  student.walletSeed = seed;
  student.walletBackup = backup;
  saveStudents(students);
}

export function updateWalletSeed(id: string, seed: number[]): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === id);
  if (!student) throw new Error("Student not found");
  student.walletSeed = seed;
  saveStudents(students);
}

export function updateWalletDid(id: string, walletDid: string): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === id);
  if (!student) throw new Error("Student not found");
  student.walletDid = walletDid;
  saveStudents(students);
}

// ── Pending Diplomas ──────────────────────────────────────────────────────────
// Diplomas queued by the issuer for students who haven't connected yet.
// Auto-issued by students.ts when the student saves their connectionId.

export interface PendingDiploma {
  id: string;
  studentId: string;
  studentName: string;
  studentIdField: string;
  degree: string;
  graduationDate: string;
  gpa?: number;
  issuingDid: string;
  schemaId: string;
  universityName: string;
  createdAt: string;
}

const PENDING_PATH = resolve(DATA_DIR, "pending-diplomas.json");

function loadPending(): PendingDiploma[] {
  if (!existsSync(PENDING_PATH)) return [];
  try {
    return JSON.parse(readFileSync(PENDING_PATH, "utf-8")) as PendingDiploma[];
  } catch {
    return [];
  }
}

function savePending(items: PendingDiploma[]): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PENDING_PATH, JSON.stringify(items, null, 2), "utf-8");
}

export function addPendingDiploma(diploma: Omit<PendingDiploma, "id" | "createdAt">): PendingDiploma {
  const items = loadPending();
  const entry: PendingDiploma = { ...diploma, id: randomUUID(), createdAt: new Date().toISOString() };
  items.push(entry);
  savePending(items);
  return entry;
}

export function getPendingDiplomas(studentId: string): PendingDiploma[] {
  return loadPending().filter((d) => d.studentId === studentId);
}

export function removePendingDiploma(id: string): void {
  savePending(loadPending().filter((d) => d.id !== id));
}

// ── Issued Credentials ────────────────────────────────────────────────────────
// Credentials that have been issued via the Cloud Agent, tracked for revocation.

export function getIssuedCredentials(studentId: string): IssuedCredential[] {
  const student = findById(studentId);
  return student?.issuedCredentials ?? [];
}

export function addIssuedCredential(studentId: string, cred: IssuedCredential): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  if (!student.issuedCredentials) student.issuedCredentials = [];
  student.issuedCredentials.push(cred);
  saveStudents(students);
}

export function markCredentialRevoked(studentId: string, credentialRecordId: string): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  const cred = student.issuedCredentials?.find((c) => c.credentialRecordId === credentialRecordId);
  if (!cred) throw new Error("Credential not found");
  cred.revoked = true;
  saveStudents(students);
}

/** Update the cached Cloud Agent delivery state for a credential. */
export function updateDeliveryState(
  studentId: string,
  credentialRecordId: string,
  deliveryState: string
): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  const cred = student.issuedCredentials?.find((c) => c.credentialRecordId === credentialRecordId);
  if (!cred) throw new Error("Credential not found");
  cred.deliveryState = deliveryState;
  cred.deliveryCheckedAt = new Date().toISOString();
  if (deliveryState === "WalletConfirmed" && !cred.walletConfirmedAt) {
    cred.walletConfirmedAt = new Date().toISOString();
  }
  saveStudents(students);
}

/** Mark a credential as failed (undeliverable). */
export function markCredentialFailed(
  studentId: string,
  credentialRecordId: string,
  reason: string
): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  const cred = student.issuedCredentials?.find((c) => c.credentialRecordId === credentialRecordId);
  if (!cred) throw new Error("Credential not found");
  cred.failedAt = new Date().toISOString();
  cred.failureReason = reason;
  saveStudents(students);
}

/** Mark a credential as pending revocation (agent bit set, waiting for wallet ack). */
export function markRevocationPending(
  studentId: string,
  credentialRecordId: string,
  reason?: string
): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  const cred = student.issuedCredentials?.find((c) => c.credentialRecordId === credentialRecordId);
  if (!cred) throw new Error("Credential not found");
  cred.revocationPendingAt = new Date().toISOString();
  if (reason) cred.revocationReason = reason;
  // revoked stays false until wallet confirms
  saveStudents(students);
}

/** Store the Cardano revocation tx data for an issued credential. */
export function updateIssuedCredentialRevocationCardano(
  studentId: string,
  credentialRecordId: string,
  txHash: string,
  cardanoscanUrl: string
): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  const cred = student.issuedCredentials?.find((c) => c.credentialRecordId === credentialRecordId);
  if (!cred) throw new Error("Credential not found");
  cred.cardanoRevocationTxHash = txHash;
  cred.cardanoRevocationUrl = cardanoscanUrl;
  saveStudents(students);
}

/** Store the Cardano on-chain anchor data for an issued credential. */
export function updateIssuedCredentialCardano(
  studentId: string,
  credentialRecordId: string,
  cardanoTxHash: string,
  cardanoscanUrl: string
): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  const cred = student.issuedCredentials?.find((c) => c.credentialRecordId === credentialRecordId);
  if (!cred) throw new Error("Credential not found");
  cred.cardanoTxHash = cardanoTxHash;
  cred.cardanoscanUrl = cardanoscanUrl;
  saveStudents(students);
}

/** Called when the student wallet signals it has processed the revocation. */
export function confirmRevocation(studentId: string, credentialRecordId: string): void {
  const students = loadStudents();
  const student = students.find((s) => s.id === studentId);
  if (!student) throw new Error("Student not found");
  const cred = student.issuedCredentials?.find((c) => c.credentialRecordId === credentialRecordId);
  if (!cred) throw new Error("Credential not found");
  cred.revoked = true;
  cred.revocationConfirmedAt = new Date().toISOString();
  saveStudents(students);
}
