import test from 'node:test'
import assert from 'node:assert/strict'
import { workspaceQueryReader } from '../src/workspace-query-state.ts'
import { ApiError } from '../src/api.ts'
import { advanceMutationContext, captureMutationContext, publishMutationResponse } from '../src/mutation-response.ts'

test('page reader clears cached values on authorization loss and scope-invalid cursor', async () => {
  for (const failure of [new ApiError('expired',401),new ApiError('revoked',403),new ApiError('gone',404),new ApiError('scope changed',409,undefined,'WORKSPACE_CURSOR_STALE')]) {
    let cached: { secret: string } | null = null, reject = false
    const reader = workspaceQueryReader({ load: async()=>{if(reject)throw failure;return {secret:'visible-before-revocation'}}, accept: value=>{cached=value},clear:()=>{cached=null},error:()=>{},loading:()=>{} })
    await reader.read(); assert.ok(cached); reject=true
    await assert.rejects(reader.read(), error=>error===failure); assert.equal(cached,null); reader.dispose()
  }
})
test('identity generation clears synchronously and rejects stale page completions', async () => {
  let cached: string | null = 'old', resolve!: (value:string)=>void
  const reader = workspaceQueryReader({ load:()=>new Promise<string>(done=>{resolve=done}),accept:value=>{cached=value},clear:()=>{cached=null},error:()=>{},loading:()=>{} })
  const pending = reader.read(), rejected = assert.rejects(pending,/账号|范围/)
  advanceMutationContext(); assert.equal(cached,null); resolve('old-private-data'); await rejected
  await new Promise(done=>setImmediate(done)); assert.equal(cached,null); reader.dispose()
})
test('successful mutation receipt remains visible after its follow-up transport failure', async () => {
  let cached: { version:number } | null = null, reject = false
  const reader = workspaceQueryReader({ load:async()=>{if(reject)throw new Error('network');return {version:1}},accept:value=>{cached=value},clear:()=>{cached=null},merge:(_value,receipt)=>receipt as {version:number},error:()=>{},loading:()=>{} })
  await reader.read(); reject=true
  publishMutationResponse(captureMutationContext(),'/tasks/example',{version:2})
  await new Promise(done=>setImmediate(done)); assert.deepEqual(cached,{version:2}); reader.dispose()
})
