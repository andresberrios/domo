import { agentVoiceManager } from '../../lib/agent-voice/runtime'
import type { AgentVoiceClientMessage, AgentVoiceServerMessage } from '../../../shared/types'

interface PeerState {
  agentSessionId: string
  detach: () => void
}

const peers = new WeakMap<object, PeerState>()

function agentSessionIdFor(peer: any): string | null {
  const raw = peer?.request?.url ?? peer?.url ?? ''
  try {
    return new URL(raw, 'http://localhost').searchParams.get('agentSessionId')
  } catch {
    return null
  }
}

function send(peer: any, message: AgentVoiceServerMessage) {
  try {
    peer.send(JSON.stringify(message))
  } catch {
    /* socket already gone */
  }
}

/**
 * The audio bridge for talking to a coding agent: 16 kHz PCM up, whatever the
 * speech model produces down, both base64 over one WebSocket. Everything that
 * hears, transcribes and speaks lives in `agent-voice/runtime.ts`.
 */
export default defineWebSocketHandler({
  open(peer) {
    const agentSessionId = agentSessionIdFor(peer)
    if (!agentSessionId) {
      send(peer, { type: 'error', message: 'Missing ?agentSessionId' })
      peer.close()
      return
    }
    const runtime = agentVoiceManager.get(agentSessionId)
    const detach = runtime.addListener(message => send(peer, message))
    peers.set(peer as object, { agentSessionId, detach })
  },

  async message(peer, message) {
    const state = peers.get(peer as object)
    if (!state) return

    let parsed: AgentVoiceClientMessage
    try {
      parsed = JSON.parse(message.text()) as AgentVoiceClientMessage
    } catch {
      return
    }

    const runtime = agentVoiceManager.get(state.agentSessionId)
    try {
      switch (parsed.type) {
        case 'audio':
          runtime.addAudio(parsed.data)
          break
        case 'segment-end':
          await runtime.segmentEnd(parsed.final === true)
          break
        case 'send':
          await runtime.send()
          break
        case 'discard':
          runtime.discard()
          break
        case 'hush':
          runtime.hush()
          break
        case 'cancel':
          await runtime.cancel()
          break
        case 'speak':
          runtime.setSpeak(parsed.enabled !== false)
          break
        case 'dictated':
          if (typeof parsed.text === 'string') runtime.addDictation(parsed.text)
          break
        case 'dictation-log':
          console.log(`[agent-voice:${state.agentSessionId}] device: ${String(parsed.message).slice(0, 300)}`)
          break
      }
    } catch (error) {
      send(peer, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  },

  close(peer) {
    const state = peers.get(peer as object)
    state?.detach()
    peers.delete(peer as object)
    if (!state) return
    // Nobody is listening any more. A moment's grace, because a page reload
    // reconnects at once and would otherwise lose the words being held.
    setTimeout(() => {
      const runtime = agentVoiceManager.peek(state.agentSessionId)
      if (runtime && runtime.listenerCount === 0) agentVoiceManager.close(state.agentSessionId)
    }, 5000)
  },

  error(peer, error) {
    console.error('[agent voice ws] error', error)
    peers.get(peer as object)?.detach()
  }
})
