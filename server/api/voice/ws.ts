import { voiceManager } from '../../lib/voice/runtime'
import type { VoiceClientMessage, VoiceServerMessage } from '../../../shared/types'

interface PeerState {
  sessionId: string
  detach: () => void
}

const peers = new WeakMap<object, PeerState>()

function sessionIdFor(peer: any): string | null {
  const raw = peer?.request?.url ?? peer?.url ?? ''
  try {
    const url = new URL(raw, 'http://localhost')
    return url.searchParams.get('sessionId')
  } catch {
    return null
  }
}

function send(peer: any, message: VoiceServerMessage) {
  try {
    peer.send(JSON.stringify(message))
  } catch {
    /* socket already gone */
  }
}

/**
 * The audio bridge: raw 16 kHz PCM up, 24 kHz PCM down, both base64 over one
 * WebSocket. The Gemini Live session itself lives on the server.
 */
export default defineWebSocketHandler({
  async open(peer) {
    const sessionId = sessionIdFor(peer)
    if (!sessionId) {
      send(peer, { type: 'error', message: 'Missing ?sessionId' })
      peer.close()
      return
    }

    const runtime = voiceManager.get(sessionId)
    const detach = runtime.addListener(message => send(peer, message))
    peers.set(peer as object, { sessionId, detach })

    send(peer, { type: 'status', status: runtime.live ? 'live' : 'idle' })
  },

  async message(peer, message) {
    const state = peers.get(peer as object)
    if (!state) return

    let parsed: VoiceClientMessage
    try {
      parsed = JSON.parse(message.text()) as VoiceClientMessage
    } catch {
      return
    }

    const runtime = voiceManager.get(state.sessionId)
    try {
      switch (parsed.type) {
        case 'start':
          await runtime.ensureConnected()
          break
        case 'audio':
          await runtime.sendAudioChunk(parsed.data)
          break
        case 'audio-stream-end':
          await runtime.sendAudioStreamEnd()
          break
        case 'text':
          await runtime.sendText(parsed.text)
          break
        case 'stop':
          await voiceManager.close(state.sessionId)
          break
        case 'ping':
          break
      }
    } catch (error) {
      send(peer, {
        type: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  },

  close(peer) {
    const state = peers.get(peer as object)
    state?.detach()
    peers.delete(peer as object)
    if (!state) return
    const runtime = voiceManager.peek(state.sessionId)
    // Nobody is listening any more: drop the upstream session so we stop paying
    // for an open mic nobody can hear.
    if (runtime && runtime.listenerCount === 0) {
      setTimeout(() => {
        const current = voiceManager.peek(state.sessionId)
        if (current && current.listenerCount === 0) void voiceManager.close(state.sessionId)
      }, 5000)
    }
  },

  error(peer, error) {
    console.error('[voice ws] error', error)
    const state = peers.get(peer as object)
    state?.detach()
  }
})
