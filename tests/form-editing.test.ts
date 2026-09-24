import test from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError, SavedResultError } from '../src/api.ts'
import { editingUnavailable, editableComparisonValues, readEditableObject, currentRelatedTask } from '../src/form-editing.ts'
import { saveWeeklyProgress } from '../src/components/WeeklyProgressForm.tsx'
import { advanceMutationContext, MutationContextChangedError } from '../src/mutation-response.ts'
import { compareDraft, mergeDraft } from '../src/draft-v3.ts'

test('editing becomes copy-only after access loss, task cancellation, deleted week or account change',()=>{
  for(const status of [401,403,404])assert.equal(editingUnavailable(new ApiError('无权限',status)),true)
  for(const code of ['TASK_CANCELLED','WEEKLY_RECORD_DELETED'])assert.equal(editingUnavailable(new ApiError('对象已失效',409,undefined,code)),true)
  assert.equal(editingUnavailable(new MutationContextChangedError()),true)
  for(const code of ['VERSION_CONFLICT','IDEMPOTENCY_MISMATCH'])assert.equal(editingUnavailable(new ApiError('冲突',409,undefined,code)),false)
  assert.equal(editingUnavailable(new ApiError('网络未知',0)),false)
})

test('an editable projection started by the old account cannot become a merge baseline',async t=>{
  let resolve!:(value:Response)=>void
  t.mock.method(globalThis,'fetch',()=>new Promise<Response>(done=>{resolve=done}))
  const pending=readEditableObject('/tasks/example/editable')
  advanceMutationContext()
  resolve(new Response(JSON.stringify({version:2,values:{title:'旧账号内容'},operationEpoch:'epoch'}),{status:200}))
  await assert.rejects(pending,MutationContextChangedError)
})

test('weekly and related task completion changes require one explicit conflict choice',()=>{
  const base={status:'doing',actualOutcome:'',__completeTask:'',__taskStatus:'doing',__taskCompletionNote:''}
  const local={...base,status:'done',actualOutcome:'我的完成说明',__completeTask:'yes'}
  const current={version:3,operationEpoch:'epoch',values:{status:'doing',actualOutcome:''},relatedTask:{id:'task',version:8,status:'done' as const,completionNote:'另一位管理员已确认完成'}}
  const server=editableComparisonValues(current,local)
  assert.equal(server.__taskStatus,'done')
  assert.equal(server.__taskCompletionNote,'另一位管理员已确认完成')
  assert.equal(server.__completeTask,'')
  const groups=compareDraft(base,server,local)
  assert.equal(groups.length,1)
  assert.equal(groups[0].choice,null)
  assert.throws(()=>mergeDraft(groups,{}),/选择/)
  assert.equal(mergeDraft(groups,{[groups[0].id]:'local'}).actualOutcome,'我的完成说明')
  assert.equal(mergeDraft(groups,{[groups[0].id]:'server'}).__completeTask,'')
})

test('fresh task completion supersedes the older task projection retained during comparison',()=>{
  const compared={id:'task',version:2,status:'doing'}
  const refreshed={id:'task',version:3,status:'done'}
  assert.equal(currentRelatedTask(refreshed,compared)?.status,'done')
  assert.equal(currentRelatedTask({...refreshed,version:1},compared),compared)
  assert.equal(currentRelatedTask(refreshed,{...compared,id:'another-task',version:4}),refreshed)
})

test('weekly save retains the receipt version before failed refresh and retries only reads before the next edit',async t=>{
  const requests:{method:string;version?:number}[]=[]
  let storedVersion=7,failRead=true,localVersion=7
  t.mock.method(globalThis,'fetch',async (_url:string,options:RequestInit={})=>{
    const method=options.method||'GET'
    if(method==='PATCH') {
      const body=JSON.parse(String(options.body));requests.push({method,version:body.version})
      if(body.version!==storedVersion)return new Response(JSON.stringify({error:'版本冲突',code:'VERSION_CONFLICT'}),{status:409})
      return new Response(JSON.stringify({id:'week',version:++storedVersion}),{status:200})
    }
    requests.push({method})
    if(failRead){failRead=false;return new Response(JSON.stringify({error:'暂时无法读取'}),{status:503})}
    return new Response('{}',{status:200})
  })
  const onSaved=async (record:{version:number})=>{localVersion=record.version;await api('/tasks/task/view')}
  let saved:SavedResultError|undefined
  try {await saveWeeklyProgress('week',{version:localVersion},onSaved)}
  catch(error){assert.ok(error instanceof SavedResultError);saved=error}
  assert.ok(saved)
  assert.equal(localVersion,8)
  assert.equal(saved.savedVersion,8)
  await saved.retry()
  assert.deepEqual(requests.map(row=>row.method),['PATCH','GET','GET'])
  const confirmedVersion=await saveWeeklyProgress('week',{version:saved.savedVersion},onSaved)
  assert.equal(confirmedVersion,9)
  assert.equal(localVersion,9)
  assert.deepEqual(requests.filter(row=>row.method==='PATCH').map(row=>row.version),[7,8])
})
