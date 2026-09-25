import { useEffect, useRef, useState } from 'react'
import { api, ApiError, finishSaved, json } from './api'
import { LatestRead } from './latest-read'
import { captureMutationContext, subscribeMutationResponses } from './mutation-response'
import { assignmentAttempt, type SubmissionAttempt } from './notification-navigation'
import { queryAffected } from './query-invalidation'

/** Abort superseded reads and drop all cached content immediately when access is lost. */
export function useBusinessResource<T>(path:string, scope:string) {
  const [value,setValue]=useState<T|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false)
  const pathRef=useRef(path);pathRef.current=path
  const read=useRef<LatestRead<T>|null>(null)
  const attempts=useRef<Record<string,SubmissionAttempt>>({})
  if(!read.current)read.current=new LatestRead({load:signal=>api<T>(pathRef.current,{signal}),accept:next=>setValue(next),loading:setLoading,error:failure=>{if(failure instanceof ApiError && [401,403,404].includes(failure.status))setValue(null);setError(failure instanceof Error?failure.message:'')}})
  const refresh=()=>read.current!.read()
  useEffect(()=>{
    attempts.current={};setValue(null);setError('');setLoading(true);void refresh().catch(()=>{})
    const unsub=subscribeMutationResponses(event=>{if(event.context!==captureMutationContext()||!queryAffected(pathRef.current,event.path))return;read.current!.invalidate();void refresh().catch(()=>{})},()=>{read.current!.reset();setValue(null)})
    const focus=()=>{read.current!.invalidate();void refresh().catch(()=>{})};window.addEventListener('focus',focus)
    return()=>{unsub();window.removeEventListener('focus',focus);read.current!.reset()}
  },[path,scope])
  async function mutate(url:string,body:Record<string,unknown>,after?:()=>Promise<void>,method='POST') {
    const attempt=assignmentAttempt(attempts.current[url]??null,body);attempts.current[url]=attempt
    try { await api(url,json({...body,requestId:attempt.requestId},method)) }
    catch(failure) {
      if(failure instanceof ApiError && failure.status===409 && failure.code==='VERSION_CONFLICT') {
        // Only read the new decision. The form keeps its local input; no mutation retry.
        await refresh().catch(()=>{})
      }
      throw failure
    }
    delete attempts.current[url]
    await finishSaved(async()=>{await refresh();if(after)await after()})
  }
  return {value,error,loading,refresh,mutate}
}
