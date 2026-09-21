import { Router } from 'express'
import type { ChannelOperation, ExternalObjectLink, CallbackInbox } from '../shared/native-actions.ts'
import { Store, HttpError } from './store.ts'
import { createDingTalkNativeClient, type DingTalkNativeClient } from './dingtalk-native.ts'
import { nativeManager, nativeSettingsView, updateNativeSettings, verifyNativeIdentity } from './native-settings.ts'
import { recreateNativeLink, enqueueNativeOperation, linkEligible } from './native-service.ts'
import { createNativeIntent, confirmNativeIntent } from './native-commands.ts'

/** Mount after requireAuth. There is intentionally no unauthenticated callback HTTP endpoint. */
export function nativeRouter(store: Store, client: DingTalkNativeClient = createDingTalkNativeClient(), clock = () => new Date()) {
  const router = Router()
  router.get('/native/settings', (req, res) => res.json(nativeSettingsView(store, req.user, client)))
  router.put('/native/settings', (req, res) => { updateNativeSettings(store, req.user, req.body, client, clock()); res.json(nativeSettingsView(store, req.user, client)) })
  router.post('/native/identities/:userId/verify', async (req, res) => { const identity = await verifyNativeIdentity(store, req.user, String(req.params.userId), client, clock()); res.json({ userId: identity.userId, verified: true, verifiedAt: identity.verifiedAt }) })
  router.get('/native/operations', (req, res) => {
    nativeManager(store, req.user)
    const operations = store.list<ChannelOperation>('nativeOperations').slice(-100).reverse().map(({ id, linkId, kind, recipientId, status, attempts, nextAttemptAt, lastError, createdAt, updatedAt }) => ({ id, linkId, kind, recipientId, status, attempts, nextAttemptAt, lastError, createdAt, updatedAt }))
    const links = store.list<ExternalObjectLink>('nativeLinks').slice(-100).reverse().map(({ id, recipientId, action, channel, state, desired, generation, lastSyncedAt, lastError }) => ({ id, recipientId, action, channel, state, title: desired.title, done: desired.done, generation, lastSyncedAt, lastError }))
    const callbacks = store.list<CallbackInbox>('nativeCallbackInbox').slice(-100).reverse().map(({ id, eventType, status, receivedAt, result }) => ({ id, eventType, status, receivedAt, result }))
    res.json({ operations, links, callbacks })
  })
  router.post('/native/links/:id/reconcile', (req, res) => {
    nativeManager(store, req.user)
    const link = store.get<ExternalObjectLink>('nativeLinks', String(req.params.id))
    if (!link || link.channel !== 'todo' || !linkEligible(store, link, client)) throw new HttpError(409, '当前对象不可发起对账')
    store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { reconcileAt: clock().toISOString() }); res.json({ queued: true })
  })
  router.post('/native/links/:id/recreate', (req, res) => { const link = recreateNativeLink(store, req.user, String(req.params.id), client, clock()); res.status(201).json({ id: link.id, state: link.state, generation: link.generation }) })
  router.post('/native/links/:id/delete', (req, res) => {
    nativeManager(store, req.user)
    const link = store.get<ExternalObjectLink>('nativeLinks', String(req.params.id))
    if (!link || link.channel !== 'todo' || !link.providerId || !link.desired.done || !linkEligible(store, link, client) || req.body?.version !== link.version) throw new HttpError(409, '仅可删除版本一致且平台已完成的原生待办')
    res.json({ id: enqueueNativeOperation(store, link, 'todo_delete', clock()).id, queued: true })
  })
  router.post('/native/intents', (req, res) => res.status(201).json(createNativeIntent(store, req.user, req.body, client, clock())))
  router.post('/native/intents/:id/confirm', (req, res) => { if (typeof req.body?.token !== 'string') throw new HttpError(400, '请提供动作凭据'); res.json(confirmNativeIntent(store, req.user, String(req.params.id), req.body.token, client, clock())) })
  return router
}
