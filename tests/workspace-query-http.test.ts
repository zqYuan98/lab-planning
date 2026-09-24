import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'
import type { Task, Report } from '../shared/types.ts'

test('HTTP workspace shell and queries enforce fresh roles, bounded metadata and exact observer fence', async t => {
  const store = new Store(':memory:')
  const user = (id:string,role:StoredUser['role'])=>store.insert<StoredUser>('users',{id,role,name:id,email:`${id}@workspace.invalid`,position:'',active:true,passwordHash:'secret-hash',credentialVersion:1})
  const manager=user('manager','manager'),member=user('member','member'),peer=user('peer','member'),observer=user('observer','observer')
  for (const owner of [member,peer]) for(let i=0;i<3;i++) store.insert<Task>('tasks',{title:`${owner.id}-task-${i}`,ownerId:owner.id,monthlyPlanId:null,dueDate:'',status:'doing',description:'',isTemporary:true,temporaryReason:'test'})
  const report=store.insert<Report>('reports',{type:'monthly',period:'2026-09',title:'report-metadata',status:'draft',revision:1,narrative:'PRIVATE_REPORT_BODY',snapshot:{tasks:[],plans:[],weeklyRecords:[],nextPlans:[],nextWeeklyRecords:[],annualGoals:[],projects:[],users:[],publications:[],changes:[]},authorId:manager.id,finalizedAt:null})
  const server=createApp({store,enableScheduler:false}).listen(0,'127.0.0.1');await once(server,'listening')
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close()})
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const cookies=new Map([manager,member,peer,observer].map(actor=>[actor.id,`lab_session=${createSession(store,actor)}`]))
  const get=(actor:StoredUser,path:string)=>fetch(base+path,{headers:{cookie:cookies.get(actor.id)!}})
  assert.equal((await fetch(base+'/workspace')).status,401)
  for(const actor of [manager,member,observer]) {
    const response=await get(actor,'/workspace');assert.equal(response.status,200)
    const body=await response.text();assert.ok(Buffer.byteLength(body)<102400);assert.equal(body.includes('secret-hash'),false);assert.equal(body.includes('PRIVATE_REPORT_BODY'),false)
  }
  for(const path of ['/workspace/tasks','/workspace/register','/workspace/reports','/workspace/candidates?kind=user','/workspace/history?taskId=none','/workspace/progress?taskId=none']) assert.equal((await get(observer,path)).status,404,path)
  const first=await (await get(member,'/workspace/tasks?limit=1')).json() as {items:Task[];total:number;nextCursor:string}
  assert.equal(first.total,3);assert.equal(first.items.length,1);assert.ok(first.items.every(task=>task.ownerId===member.id))
  const metadata=await (await get(manager,'/workspace/reports')).text();assert.equal(metadata.includes('PRIVATE_REPORT_BODY'),false);assert.equal(metadata.includes('snapshot'),false)
  assert.equal((await get(member,`/workspace/reports/${report.id}`)).status,403)
  assert.equal((await get(manager,`/workspace/reports/${report.id}`)).status,200)
  store.update<StoredUser>('users',member.id,member.version,{position:'scope change'})
  assert.equal((await get(member,`/workspace/tasks?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status,409)
  store.update<StoredUser>('users',manager.id,manager.version,{role:'observer'})
  assert.equal((await get(manager,`/workspace/reports/${report.id}`)).status,404)
})
