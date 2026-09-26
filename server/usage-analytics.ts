import { DatabaseSync } from 'node:sqlite'
import { createHmac, randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canUseAccount } from '../shared/auth-policy.ts'
import type { User } from '../shared/types.ts'
import { usageActions, usagePages, type UsageAction, type UsagePage, type UsagePolicy, type UsageSettings, type UsageSettingsView, type UsageSummary } from '../shared/usage-analytics.ts'
import { HttpError } from './store.ts'
import { isMember } from './authorization.ts'

interface StoredSettings extends UsageSettings { operationEpoch: string; observedVersion: string; observationStartedAt: string | null; observationEndedAt: string | null }
export const usageDay = (date: Date) => new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
const daysBefore = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
export function exactUsageFields(input: unknown, allowed: readonly string[]): asserts input is Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, '使用率请求仅接受规定字段')
}
function validDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}

/** Independent local sidecar: no business collections, payloads, network calls or timers. */
export class UsageAnalyticsStore {
  private db: DatabaseSync
  private settings: StoredSettings
  private secret: string
  private excluded: Set<string>
  private cleanedDay = ''
  readonly version: string
  readonly unavailable: boolean
  constructor(path = ':memory:', options: { version?: string; clock?: () => Date; unavailable?: boolean } = {}) {
    this.unavailable = options.unavailable === true
    this.version = options.version ?? process.env.APP_BUILD_VERSION ?? 'development'
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(this.version)) throw new Error('Usage build version must be a short release identifier')
    this.clock = options.clock ?? (() => new Date())
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS usage_config (id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL, secret TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_events (
        day TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('page','action')),
        name TEXT NOT NULL, member_key TEXT NOT NULL, operation_key TEXT NOT NULL,
        PRIMARY KEY(version,kind,name,member_key,operation_key));
      CREATE INDEX IF NOT EXISTS usage_events_day ON usage_events(day);
      CREATE UNIQUE INDEX IF NOT EXISTS usage_actions_once ON usage_events(kind,name,member_key,operation_key) WHERE kind='action';
      CREATE INDEX IF NOT EXISTS usage_events_summary ON usage_events(version,day,member_key);`)
    const saved = this.db.prepare('SELECT settings,secret FROM usage_config WHERE id=1').get()
    this.settings = saved ? JSON.parse(saved.settings as string) as StoredSettings : { version: 0, enabled: false, retentionDays: 90, excludedUserIds: [], operationEpoch: '', observedVersion: this.version, observationStartedAt: null, observationEndedAt: null }
    this.secret = saved ? saved.secret as string : randomBytes(32).toString('hex')
    this.excluded = new Set(this.settings.excludedUserIds)
    if (!saved) this.db.prepare('INSERT INTO usage_config VALUES(1,?,?)').run(JSON.stringify(this.settings), this.secret)
    if (this.settings.observedVersion !== this.version) {
      this.settings = { ...this.settings, observedVersion: this.version, observationStartedAt: this.settings.enabled ? this.clock().toISOString() : null, observationEndedAt: null }
      this.db.prepare('UPDATE usage_config SET settings=? WHERE id=1').run(JSON.stringify(this.settings))
    }
    this.cleanup()
    } catch (error) { this.db.close(); throw error }
  }
  private clock: () => Date
  close() { this.db.close() }
  /** Fast disabled gate for middleware; it does not query either database. */
  get configuredEnabled() { return !this.unavailable && this.settings.enabled }
  private key(...parts: string[]) { return createHmac('sha256', this.secret).update(JSON.stringify(parts)).digest('hex') }
  private eligible(actor: User) { return isMember(actor) && canUseAccount(actor) && !this.excluded.has(actor.id) }
  view(epoch: string): UsageSettingsView {
    const { operationEpoch, observedVersion: _version, observationStartedAt: _start, observationEndedAt: _end, ...settings } = this.settings
    return { settings: structuredClone(settings), effectiveEnabled: !this.unavailable && settings.enabled && operationEpoch === epoch, activationRequired: settings.enabled && operationEpoch !== epoch, buildVersion: this.version, ...(this.unavailable ? { storageUnavailable: true } : {}) }
  }
  policy(actor: User, epoch: string): UsagePolicy { return { enabled: this.view(epoch).effectiveEnabled && this.eligible(actor), version: this.version } }
  update(input: unknown, users: User[], epoch: string): UsageSettingsView {
    if (this.unavailable) throw new HttpError(503, '统计存储不可用，请先恢复统计存储后重试；业务功能不受影响')
    exactUsageFields(input, ['version', 'enabled', 'retentionDays', 'excludedUserIds'])
    if (input.version !== this.settings.version) throw new HttpError(409, '使用率设置已变化，请刷新后重试')
    if (typeof input.enabled !== 'boolean' || ![30, 90].includes(input.retentionDays as number) || !Array.isArray(input.excludedUserIds) || input.excludedUserIds.length > 10_000 || input.excludedUserIds.some(id => typeof id !== 'string' || !users.some(user => user.id === id && isMember(user)))) throw new HttpError(400, '使用率设置无效')
    const now = this.clock().toISOString(), freshWindow = input.enabled && (!this.settings.enabled || this.settings.operationEpoch !== epoch)
    const next: StoredSettings = { version: this.settings.version + 1, enabled: input.enabled, retentionDays: input.retentionDays as 30 | 90, excludedUserIds: [...new Set(input.excludedUserIds as string[])].sort(), operationEpoch: epoch,
      observedVersion: this.version, observationStartedAt: freshWindow ? now : this.settings.observationStartedAt,
      observationEndedAt: input.enabled ? null : this.settings.observationEndedAt ?? now }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Restored/cloned environments need explicit activation and a fresh measurement period.
      if (this.settings.operationEpoch && this.settings.operationEpoch !== epoch) this.db.exec('DELETE FROM usage_events')
      for (const id of next.excludedUserIds) this.db.prepare('DELETE FROM usage_events WHERE member_key=?').run(this.key('member', id))
      this.db.prepare('UPDATE usage_config SET settings=? WHERE id=1').run(JSON.stringify(next))
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.settings = next; this.excluded = new Set(next.excludedUserIds)
    this.cleanup(true)
    return this.view(epoch)
  }
  cleanup(force = false) {
    const today = usageDay(this.clock())
    if (!force && this.cleanedDay === today) return
    this.db.prepare('DELETE FROM usage_events WHERE day<?').run(daysBefore(today, this.settings.retentionDays - 1))
    this.cleanedDay = today
  }
  page(actor: User, epoch: string, input: unknown): void {
    exactUsageFields(input, ['page', 'version', 'userId'])
    if (!usagePages.includes(input.page as UsagePage) || input.version !== this.version || input.userId !== actor.id) throw new HttpError(400, '页面或当前身份已变化')
    if (!this.policy(actor, epoch).enabled) return
    this.insert(actor, 'page', input.page as UsagePage, usageDay(this.clock()))
  }
  /** Called only with an operation fingerprint extracted from a successful server mutation. */
  action(actor: User, epoch: string, action: UsageAction, operationId: string, occurredAt = this.clock().toISOString()) {
    if (!usageActions.includes(action) || !/^[a-f0-9]{64}$/.test(operationId)) throw new Error('Invalid internal usage operation')
    if (!this.policy(actor, epoch).enabled) return
    if (!Number.isFinite(Date.parse(occurredAt))) return
    const timestamp = new Date(occurredAt).toISOString(), startedAt = this.settings.observationStartedAt
    if (!startedAt || timestamp < startedAt || timestamp > this.clock().toISOString()) return
    const day = usageDay(new Date(timestamp))
    const today = usageDay(this.clock())
    if (!validDay(day) || day > today || day < daysBefore(today, this.settings.retentionDays - 1)) return
    this.insert(actor, 'action', action, this.key(epoch, operationId), day)
  }
  private insert(actor: User, kind: 'page' | 'action', name: UsagePage | UsageAction, operation: string, day = usageDay(this.clock())) {
    this.cleanup()
    this.db.prepare('INSERT OR IGNORE INTO usage_events VALUES(?,?,?,?,?,?)').run(day, this.version, kind, name, this.key('member', actor.id), operation)
  }
  summary(users: User[], epoch: string, query: unknown): UsageSummary {
    exactUsageFields(query, ['from', 'to', 'version'])
    this.cleanup()
    const today = usageDay(this.clock()), earliest = daysBefore(today, this.settings.retentionDays - 1)
    const from = query.from ?? daysBefore(today, Math.min(28, this.settings.retentionDays) - 1), to = query.to ?? today, version = query.version ?? this.version
    if (!validDay(from) || !validDay(to) || from < earliest || to > today || from > to || typeof version !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(version)) throw new HttpError(400, '请选择保留期内的有效统计区间与版本')
    const members = users.filter(user => this.eligible(user)), keys = members.map(user => this.key('member', user.id))
    // No old-environment statistics are presented as this environment's usage.
    const usable = !this.unavailable && (!this.settings.operationEpoch || this.settings.operationEpoch === epoch)
    const predicate = `version=? AND day>=? AND day<=? AND member_key IN (${keys.map(() => '?').join(',')})`
    const values = [version, from, to, ...keys]
    const totals = keys.length && usable ? this.db.prepare(`SELECT COUNT(DISTINCT member_key) AS members,COUNT(DISTINCT day) AS days FROM usage_events WHERE ${predicate}`).get(...values)! : { members: 0, days: 0 }
    const activeMembers = Number(totals.members), observedDays = Number(totals.days)
    const startedOn = this.settings.observationStartedAt ? usageDay(new Date(this.settings.observationStartedAt)) : null
    const endedOn = this.settings.observationEndedAt ? usageDay(new Date(this.settings.observationEndedAt)) : today
    const start = startedOn && startedOn > from ? startedOn : from, end = endedOn < to ? endedOn : to
    const observationDays = usable && startedOn && this.settings.observedVersion === version && start <= end ? Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1 : 0
    const groups = keys.length && usable ? this.db.prepare(`SELECT kind,name,COUNT(*) AS count,COUNT(DISTINCT member_key) AS members FROM usage_events WHERE ${predicate} GROUP BY kind,name`).all(...values) : []
    const rows = (kind: string, names: readonly (UsagePage | UsageAction)[]) => names.map(name => {
      const row = groups.find(row => row.kind === kind && row.name === name), members = Number(row?.members ?? 0)
      return { name, count: Number(row?.count ?? 0), members, memberRate: activeMembers ? members / activeMembers : 0 }
    })
    return { from, to, version, retentionDays: this.settings.retentionDays, eligibleMembers: members.length, activeMembers, observedDays, observationDays, denominator: 'active_members_in_period', insufficientData: observationDays < 28 || activeMembers < 5, pages: rows('page', usagePages), actions: rows('action', usageActions) }
  }
}
