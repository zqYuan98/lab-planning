import { SavedResultError } from './api'
import { captureMutationContext, MutationContextChangedError } from './mutation-response'

export type SavedRefreshState = 'idle' | 'saving' | 'refreshing' | 'failed'
/** Lives above version-keyed forms, so replacing a form cannot lose a saved receipt. */
export class SavedRefresh {
  private state: SavedRefreshState = 'idle'
  private sequence = 0
  private reload: (() => Promise<void>) | null = null
  constructor(private changed: (state: SavedRefreshState) => void) {}
  private set(state: SavedRefreshState) { this.state = state; this.changed(state) }
  reset(notify = true) { this.sequence++; this.reload = null; this.state = 'idle'; if (notify) this.changed('idle') }
  async run<T>(save: () => Promise<T>, refresh: () => Promise<void>): Promise<T> {
    if (this.state !== 'idle') throw new Error('保存仍在处理或已成功，请先重新加载已保存结果。')
    const sequence = ++this.sequence, context = captureMutationContext()
    const current = () => sequence === this.sequence && context === captureMutationContext()
    this.set('saving')
    let result: T
    try { result = await save() } catch (error) { if (current()) this.set('idle'); throw error }
    if (!current()) throw new MutationContextChangedError()
    this.reload = refresh
    await this.retry()
    return result
  }
  async retry(): Promise<void> {
    if (!this.reload) return
    if (this.state === 'refreshing') return
    const sequence = this.sequence, context = captureMutationContext(), reload = this.reload
    const current = () => sequence === this.sequence && context === captureMutationContext()
    this.set('refreshing')
    try {
      await reload()
      if (!current()) throw new MutationContextChangedError()
      this.reload = null; this.set('idle')
    } catch (error) {
      if (!current()) throw error
      this.set('failed')
      throw new SavedResultError(() => this.retry())
    }
  }
}
