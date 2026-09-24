import test from 'node:test'
import assert from 'node:assert/strict'
import {compareDraft,mergeDraft,saveDraftV3,discoverDraft,parseDraftV3,draftV3Key,draftIdentity,setDraftSession,type DraftIdentity} from '../src/draft-v3.ts'
import {persistFormDraft} from '../src/draft-recovery.ts'
const identity:DraftIdentity={userId:'alice',entityType:'task',entityId:'task_1',formId:'work-item',operationEpoch:'epoch1',formSchemaVersion:1,baseVersion:1}
function storage(){const data=new Map<string,string>();return {get length(){return data.size},key:(i:number)=>[...data.keys()][i]??null,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v)},removeItem:(k:string)=>{data.delete(k)}}}
test('three-way compares independent fields and never silently selects conflicting local text',()=>{
 const groups=compareDraft({title:'A',currentProgress:'old',nextAction:'old'},{title:'server',currentProgress:'old',nextAction:'server'},{title:'A',currentProgress:'local',nextAction:'local'})
 assert.equal(groups.find(g=>g.id==='title')?.choice,'server')
 assert.equal(groups.find(g=>g.id==='currentProgress')?.choice,'local')
 assert.equal(groups.find(g=>g.id==='nextAction')?.choice,null)
 assert.throws(()=>mergeDraft(groups,{}),/选择/)
 assert.deepEqual(mergeDraft(groups,{nextAction:'local'}),{title:'server',currentProgress:'local',nextAction:'local'})
})
test('completion fields merge as one group to prevent mixing incompatible state and explanation',()=>{
 const groups=compareDraft({status:'doing',completionNote:'',evidenceUrl:''},{status:'done',completionNote:'server completed',evidenceUrl:'https://server'},{status:'doing',completionNote:'my draft',evidenceUrl:''})
 assert.equal(groups.length,1);assert.equal(groups[0].choice,null)
 assert.deepEqual(mergeDraft(groups,{[groups[0].id]:'server'}),{status:'done',completionNote:'server completed',evidenceUrl:'https://server'})
})
test('legacy drafts have no fabricated baseline; matching values require no choice',()=>{
 const groups=compareDraft(null,{title:'same',description:'server'},{title:'same',description:'old local'})
 assert.equal(groups.find(g=>g.id==='title')?.choice,'server')
 assert.equal(groups.find(g=>g.id==='description')?.choice,null)
 assert.equal(groups.find(g=>g.id==='description')?.base,null)
})
test('schema3 finds a draft across versions while isolating user entity form and expiry',()=>{
 const cache=storage(),now=Date.now()
 assert.equal(saveDraftV3(cache,identity,{title:'base'},{title:'local'},now),true)
 const latest={...identity,baseVersion:9}
 assert.equal(discoverDraft(cache,latest,'work-item:alice:task_1:v9',now)?.baseVersion,1)
 assert.equal(discoverDraft(cache,{...latest,userId:'bob'},'work-item:bob:task_1:v9',now),null)
 assert.equal(discoverDraft(cache,{...latest,entityId:'task_2'},'work-item:alice:task_2:v9',now),null)
 assert.equal(discoverDraft(cache,latest,'work-item:alice:task_1:v9',now+8*86400000),null)
 assert.equal(parseDraftV3(cache.getItem(draftV3Key(identity)),{...identity,formSchemaVersion:2},now),null)
})
test('legacy schema2 discovery is exact and does not cross accounts or task prefixes',()=>{
 const cache=storage(),now=Date.now()
 persistFormDraft(cache,'work-item:alice:task_1:v1',{title:'old'},now)
 const found=discoverDraft(cache,{...identity,baseVersion:8},'work-item:alice:task_1:v8',now)
 assert.equal(found?.values.title,'old');assert.equal(found?.baseValues,null)
 assert.equal(discoverDraft(cache,{...identity,userId:'bob'},'work-item:bob:task_1:v8',now),null)
 assert.equal(discoverDraft(cache,{...identity,entityId:'task'},'work-item:alice:task:v8',now),null)
})
test('draft identity records epoch and cannot be inferred for another account',()=>{
 setDraftSession({userId:'alice',operationEpoch:'epoch2'})
 assert.deepEqual(draftIdentity('work-item:alice:task_1:v3'),{...identity,operationEpoch:'epoch2',baseVersion:3})
 assert.equal(draftIdentity('work-item:bob:task_1:v3'),null)
 setDraftSession(null)
})
test('quota failure removes stale v3 bytes and does not claim recovery',()=>{
 const cache=storage();saveDraftV3(cache,identity,{title:'base'},{title:'older'})
 assert.equal(saveDraftV3({...cache,setItem:()=>{throw new Error('QuotaExceededError')}},identity,{title:'base'},{title:'new'}),false)
 assert.equal(cache.getItem(draftV3Key(identity)),null)
})
test('repeated conflict compares against the last reviewed server baseline',()=>{
 const first=mergeDraft(compareDraft({title:'old',description:'old'},{title:'server1',description:'old'},{title:'old',description:'local'}),{})
 const second=compareDraft({title:'server1',description:'old'},{title:'server2',description:'server new'},first)
 assert.equal(second.find(g=>g.id==='title')?.choice,'server')
 assert.equal(second.find(g=>g.id==='description')?.choice,null)
 assert.equal(first.description,'local')
})
