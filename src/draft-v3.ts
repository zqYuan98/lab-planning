import { FORM_DRAFT_MAX_CHARS, parseFormDraft, type DraftValues } from './draft-recovery'

export interface DraftIdentity { userId: string; entityType: string; entityId: string; formId: string; operationEpoch: string; formSchemaVersion: number; baseVersion: number | null }
export interface DraftV3 extends DraftIdentity { schema: 3; baseValues: DraftValues; values: DraftValues; savedAt: number }
export interface DiscoveredDraft { storageKey: string; values: DraftValues; baseValues: DraftValues | null; baseVersion: number | null; savedAt: number; operationEpoch?: string }
let session: { userId: string; operationEpoch: string } | null = null
export function setDraftSession(value: typeof session) { session = value }
export function draftIdentity(key: string): DraftIdentity | null {
  if (!session) return null
  const parts = key.split(':'), userIndex = parts[0]===session.userId?0:parts[1]===session.userId?1:-1
  if (userIndex < 0) return null
  const formId = userIndex === 0 ? parts[1] : parts[0]
  const tail = parts.slice(userIndex === 0 ? 2 : userIndex + 1)
  const versionPart = tail.at(-1), version = /^v\d+$/.test(versionPart || '') ? Number(tail.pop()!.slice(1)) : null
  return { ...session, entityType: formId.startsWith('weekly') ? 'weeklyRecord' : formId.startsWith('monthly') ? 'monthlyPlan' : formId.startsWith('work-item') || formId.startsWith('task') ? 'task' : formId,
    entityId: tail.join(':') || 'new', formId, baseVersion: version, formSchemaVersion: 1 }
}
const identityKey = (identity: DraftIdentity) => [identity.userId, identity.entityType, identity.entityId, identity.formId].map(encodeURIComponent).join(':')
export const draftV3Key = (identity: DraftIdentity) => `workspace-draft:v3:${identityKey(identity)}:v${identity.baseVersion ?? 'new'}`
const indexKey = (identity: DraftIdentity) => `workspace-draft:index:v3:${identityKey(identity)}`
const validValues = (value: unknown): value is DraftValues => !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, val]) => !['__proto__','prototype','constructor'].includes(key) && (typeof val === 'string' || Array.isArray(val) && val.every(item => typeof item === 'string')))
export function parseDraftV3(raw: string | null, identity: DraftIdentity, now = Date.now()): DraftV3 | null {
  if (!raw || raw.length > FORM_DRAFT_MAX_CHARS) return null
  try {
    const value = JSON.parse(raw) as DraftV3
    if (value.schema !== 3 || !validValues(value.values) || !validValues(value.baseValues) || !Number.isFinite(value.savedAt) || now - value.savedAt > 7 * 86400000 || value.savedAt > now + 60000) return null
    if (value.userId !== identity.userId || value.entityId !== identity.entityId || value.entityType !== identity.entityType || value.formId !== identity.formId || value.formSchemaVersion !== identity.formSchemaVersion || typeof value.operationEpoch !== 'string') return null
    if (value.baseVersion !== null && (!Number.isInteger(value.baseVersion) || value.baseVersion < 1)) return null
    return value
  } catch { return null }
}
export function saveDraftV3(storage: Pick<Storage,'setItem'|'removeItem'>, identity: DraftIdentity, baseValues: DraftValues, values: DraftValues, now = Date.now()): boolean {
  const key = draftV3Key(identity)
  try {
    const raw = JSON.stringify({ ...identity, schema:3, baseValues, values, savedAt:now })
    if (!parseDraftV3(raw, identity, now)) throw new Error('Draft too large')
    storage.setItem(key, raw)
    // The index is a discovery accelerator; scanning still recovers a draft if quota prevents it.
    try { storage.setItem(indexKey(identity), JSON.stringify([key])) } catch { /* Main draft is saved. */ }
    return true
  } catch { try { storage.removeItem(key) } catch { /* Retain current input. */ } return false }
}
export function discoverDraft(storage: Pick<Storage,'length'|'key'|'getItem'>, identity: DraftIdentity, legacyKey: string, now = Date.now()): DiscoveredDraft | null {
  const candidates: DiscoveredDraft[] = []
  const legacyPrefix = `workspace-draft:v2:${legacyKey.replace(/:v\d+$/, '')}`
  for (let i=0; i<storage.length; i++) {
    const key = storage.key(i)!
    if (key.startsWith(`workspace-draft:v3:${identityKey(identity)}:v`)) {
      const value = parseDraftV3(storage.getItem(key), identity, now)
      if (value) candidates.push({storageKey:key,...value})
    } else if (key === legacyPrefix || key.startsWith(`${legacyPrefix}:v`) && /^\d+$/.test(key.slice(legacyPrefix.length+2))) {
      const value = parseFormDraft(storage.getItem(key), now)
      if (value) candidates.push({storageKey:key, values:value.values,baseValues:null,baseVersion:null,savedAt:value.savedAt})
    }
  }
  return candidates.sort((a,b)=>b.savedAt-a.savedAt)[0] || null
}

export interface MergeGroup { id:string; fields:string[]; base:DraftValues|null; server:DraftValues; local:DraftValues; choice:'server'|'local'|null }
const equal = (a: unknown,b: unknown) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '')
export const workFieldGroups = [
  ['status','taskStatus','__status','completionNote','evidenceUrl','__completeTask','actualOutcome','__taskStatus','__taskCompletionNote'],
  ['blocker','blockerReason','blockerImpact','supportNeeded'],
  ['ownerId','collaboratorIds','collaborators','participantIds'],
  ['workSource','__source'], ['priority','__priority'], ['waitingForFeedback','__waiting'],
]
export function compareDraft(base:DraftValues|null, server:DraftValues, local:DraftValues, groups:string[][]=workFieldGroups):MergeGroup[] {
  const keys = new Set([...Object.keys(base || {}),...Object.keys(server),...Object.keys(local)])
  const pick=(values:DraftValues, fields:string[])=>Object.fromEntries(fields.map(key=>[key,values[key]??'']))
  const fieldGroups = [...groups.map(group=>group.filter(key=>keys.has(key))).filter(group=>group.length), ...[...keys].filter(key=>!groups.some(group=>group.includes(key))).map(key=>[key])]
  return fieldGroups.map(fields=>{
    const b=base?pick(base,fields):null,s=pick(server,fields),l=pick(local,fields)
    return { id:fields.join('|'),fields,base:b,server:s,local:l,choice:equal(l,s)?'server':b && equal(l,b)?'server':b && equal(s,b)?'local':null }
  })
}
export function mergeDraft(groups:MergeGroup[], choices:Record<string,'server'|'local'>):DraftValues {
  const result:DraftValues={}
  for (const group of groups) { const choice=choices[group.id] || group.choice; if (!choice) throw new Error('请先选择每组冲突字段'); Object.assign(result,group[choice]) }
  return result
}
export function editableDraftValues(values:Record<string,unknown>, current:DraftValues):DraftValues {
  const aliases:Record<string,string>={taskStatus:'status',__status:'status',__source:'workSource',__priority:'priority',__waiting:'waitingForFeedback'}
  const editableFields=new Set(['title','description','dueDate','status','completionNote','evidenceUrl','blockerReason','blockerImpact','supportNeeded','nextAction','workSource','assignedBy','assignedOn','requestedOutcome','priority','estimatedEffort','remainingEffortDays','plannedEffortDays','actualEffortDays','currentProgress','decisionNeeded','waitingForFeedback','commitment','actualOutcome','blocker','submitted'])
  return Object.fromEntries(Object.entries(current).map(([key,value])=>{
    const field=aliases[key]||key
    if (!Object.hasOwn(values,field) && !editableFields.has(field)) return [key,value]
    const server=values[field]
    return [key,key==='__waiting'?(server?'yes':''):Array.isArray(value)?(typeof server==='boolean'?(server?['on']:[]):Array.isArray(server)?server.map(String):[]):server==null?'':String(server)]
  }))
}
