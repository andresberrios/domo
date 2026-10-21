import { constants } from 'node:fs'
import { access } from 'node:fs/promises'

import { adapterEnv, adapterLaunch, hostGhToken } from './acp/adapter-process'
import { askOnce } from './acp/ask-once'
import { anthropicApiKey, claudeOauthToken, hasClaudeSubscriptionLogin } from './claude-credentials'
import { codexLogin } from './codex-credentials'
import { copilotGithubToken } from './copilot-credentials'
import { copilotHostLogin } from './acp/copilot'
import { grokHostLogin } from './acp/host-login'
import { xaiApiKey } from './grok-credentials'
import { openCodeCredentialState } from './opencode-credentials'
import { listUsageProviders } from './repo'
import { openAiApiKey } from './openai'
import { getSettings, patchSettings } from './settings'
import { speakerUnavailable } from './agent-voice/assistant-voice'
import { concatPcm16, synthesizeWith, transcribeWith, wavFromPcm16 } from './agent-voice/speech'
import { AGENT_ADAPTERS, agentAdapterInfo, TITLE_MODELS } from '../../shared/agent-adapters'
import type {
  AgentAdapter,
  AgentVoiceSettings,
  SetupAgentStatus,
  SetupCheckResult,
  SetupLogin,
  SetupProgress,
  SetupStatus,
  SetupTarget,
  SetupVoiceStatus,
  UsageProviderId
} from '../../shared/types'

/**
 * The setup guide's questions about each coding agent and voice: is it
 * installed, what does it sign in with, and — only when the person asks — can
 * it answer a real request. Whether something is installed or logged in is
 * read fresh every time from the same places the sessions read it; only what
 * the person did is kept (`SetupProgress`).
 */

interface LoginAnswer {
  login: SetupLogin
  loginDetail: string
  environments: boolean
}

/**
 * Claude Code's credential, in the order `adapterEnv` uses them: the
 * `setup-token` token, then this computer's own login, and an API key only
 * when there is neither.
 */
export function classifyClaude(input: { token: boolean, hostLogin: boolean, apiKey: boolean }): LoginAnswer {
  if (input.token) return { login: 'subscription', loginDetail: 'Your Claude subscription, through a Claude Code token.', environments: true }
  if (input.hostLogin) {
    return {
      login: 'subscription',
      loginDetail: 'Your Claude subscription, through the Claude login on this computer. Development environments need a Claude Code token.',
      environments: false
    }
  }
  if (input.apiKey) return { login: 'api-key', loginDetail: 'An Anthropic API key, billed per token.', environments: true }
  return { login: 'none', loginDetail: 'No Claude Code token, no Claude login on this computer, and no API key.', environments: false }
}

/** Codex: a ChatGPT login always wins; a key is only its fallback. */
export function classifyCodex(input: { login: 'chatgpt' | 'apikey' | null, apiKey: boolean }): LoginAnswer {
  if (input.login === 'chatgpt') return { login: 'subscription', loginDetail: 'Your ChatGPT plan, through codex login.', environments: true }
  if (input.login === 'apikey') return { login: 'api-key', loginDetail: 'An API key saved in Codex\'s own login, billed per token.', environments: true }
  if (input.apiKey) return { login: 'api-key', loginDetail: 'An OpenAI API key, billed per token.', environments: true }
  return { login: 'none', loginDetail: 'No ChatGPT login on this computer, and no API key.', environments: false }
}

/**
 * OpenCode works with no credential at all, on its free models. A console key
 * is what a container can use; a host login is only this computer's.
 */
export function classifyOpenCode(input: { key: boolean, hostLogin: boolean }): LoginAnswer {
  if (input.key) {
    return {
      login: 'subscription',
      loginDetail: 'An OpenCode console key: opencode-go/… models use your Go plan, opencode/… models bill your console credit per token.',
      environments: true
    }
  }
  if (input.hostLogin) {
    return {
      login: 'subscription',
      loginDetail: 'The OpenCode login on this computer. Development environments need a console key.',
      environments: false
    }
  }
  return { login: 'free', loginDetail: 'No account: only OpenCode\'s free models.', environments: true }
}

/**
 * Copilot: the token saved in Domo, else this computer's `copilot login`.
 * An environment without a saved token signs in with the `gh` token it gets
 * for git, which works unless it is a classic token, which Copilot refuses.
 */
export function classifyCopilot(input: { token: boolean, hostLogin: boolean, ghToken: string | null }): LoginAnswer {
  if (input.token) return { login: 'subscription', loginDetail: 'Your Copilot plan, through the GitHub token saved in Domo.', environments: true }
  const environments = !!input.ghToken && !input.ghToken.startsWith('ghp_')
  if (input.hostLogin) {
    return {
      login: 'subscription',
      loginDetail: environments
        ? 'Your Copilot plan, through the Copilot login on this computer. Development environments use your GitHub CLI login.'
        : 'Your Copilot plan, through the Copilot login on this computer. Development environments need a GitHub token.',
      environments
    }
  }
  return { login: 'none', loginDetail: 'No Copilot login on this computer, and no GitHub token.', environments: false }
}

/**
 * Grok: this computer's `grok login` (a grok.com plan), which environments
 * borrow access tokens from (`grok-token.ts`), else the xAI API key saved in
 * Domo.
 */
export function classifyGrok(input: { hostLogin: boolean, apiKey: boolean }): LoginAnswer {
  if (input.hostLogin) {
    return {
      login: 'subscription',
      loginDetail: 'Your Grok plan, through the Grok login on this computer. Development environments use it too, through Domo.',
      environments: true
    }
  }
  if (input.apiKey) return { login: 'api-key', loginDetail: 'An xAI API key, billed per token.', environments: true }
  return { login: 'none', loginDetail: 'No Grok login on this computer, and no xAI API key.', environments: false }
}

/** Whether the adapter's program is where Domo will start it from. */
async function installed(adapter: AgentAdapter): Promise<string | null> {
  try {
    const launch = adapterLaunch(adapter)
    // A JavaScript adapter is its script; a native one is the command itself.
    const file = launch.command === process.execPath && launch.args[0] ? launch.args[0] : launch.command
    await access(file, file === launch.command ? constants.X_OK : constants.R_OK)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function login(adapter: AgentAdapter): Promise<LoginAnswer> {
  if (adapter === 'claude-code') {
    return classifyClaude({
      token: !!claudeOauthToken(),
      hostLogin: await hasClaudeSubscriptionLogin().catch(() => false),
      apiKey: !!anthropicApiKey()
    })
  }
  if (adapter === 'codex') {
    return classifyCodex({
      login: await codexLogin(false),
      apiKey: !!openAiApiKey()
    })
  }
  if (adapter === 'copilot') {
    return classifyCopilot({
      token: !!copilotGithubToken(),
      hostLogin: await copilotHostLogin(),
      ghToken: process.env.NUXT_GH_TOKEN || process.env.GH_TOKEN || await hostGhToken()
    })
  }
  if (adapter === 'grok') return classifyGrok({ hostLogin: await grokHostLogin(), apiKey: !!xaiApiKey() })
  return classifyOpenCode(await openCodeCredentialState())
}

/** Grok has none: no limit of its plan or its key can be read. */
const USAGE_PROVIDER: Record<AgentAdapter, UsageProviderId | null> = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode', copilot: 'copilot', grok: null }

/** Why an engine cannot hear or speak as set up, in the words the guide shows. */
export function voiceProblem(voice: Pick<AgentVoiceSettings, 'transcriber' | 'speaker'>, base: AgentVoiceSettings): string | null {
  for (const engine of new Set([voice.transcriber, voice.speaker])) {
    // The device's own dictation, and a Kyutai server only Domo's own use can prove.
    if (engine === 'browser' || engine === 'kyutai') continue
    const problem = speakerUnavailable(engine, base)
    if (problem) return problem
  }
  return null
}

export async function setupStatus(): Promise<SetupStatus> {
  const settings = await getSettings()
  const usage = await listUsageProviders().catch(() => [])
  const agents = await Promise.all(AGENT_ADAPTERS.map(async ({ id }): Promise<SetupAgentStatus> => {
    const [problem, answer] = await Promise.all([installed(id), login(id)])
    const poll = USAGE_PROVIDER[id] ? usage.find(row => row.provider === USAGE_PROVIDER[id]) : undefined
    return {
      id,
      installed: !problem,
      installProblem: problem,
      ...answer,
      testModel: TITLE_MODELS[id],
      usage: poll ? { state: poll.state, message: poll.message } : null
    }
  }))
  const voice: SetupVoiceStatus = {
    transcriber: settings.agentVoice.transcriber,
    speaker: settings.agentVoice.speaker,
    problem: voiceProblem(settings.agentVoice, settings.agentVoice)
  }
  return { agents, voice, progress: settings.setup }
}

/** Merge a step's result, a skip or the end of the guide into what is kept. */
export async function updateSetup(change: {
  finished?: boolean
  skip?: SetupTarget
  unskip?: SetupTarget
  check?: { target: SetupTarget, result: SetupCheckResult }
}): Promise<SetupProgress> {
  const current = (await getSettings()).setup
  const next: SetupProgress = { ...current, skipped: [...current.skipped], checks: { ...current.checks } }
  if (change.finished !== undefined) next.finishedAt = change.finished ? new Date().toISOString() : null
  if (change.skip && !next.skipped.includes(change.skip)) next.skipped.push(change.skip)
  if (change.unskip) next.skipped = next.skipped.filter(target => target !== change.unskip)
  // A check that started before the one already kept finished after it (the
  // first of two clicks, slow on a cold start): it is not news.
  const kept = change.check && current.checks[change.check.target]
  if (change.check && !(kept && kept.at > change.check.result.at)) {
    next.checks[change.check.target] = change.check.result
    // Done is not skipped.
    if (change.check.result.ok) next.skipped = next.skipped.filter(target => target !== change.check!.target)
  }
  return (await patchSettings({ setup: next })).setup
}

const CHECK_INSTRUCTIONS = 'This is a connection test. Reply with only the word: ready'
const CHECK_TIMEOUT_MS = 90_000

/**
 * The model the live check runs on: the harness's cheap one, or for OpenCode
 * without an account, one of its free ones. Never a full-price default.
 */
export function checkModel(adapter: AgentAdapter, offered: string[]): string | null {
  const cheap = TITLE_MODELS[adapter]
  if (offered.includes(cheap)) return cheap
  // An account's list can move on past the older model; any of Grok's will do, at its lowest effort.
  if (adapter === 'grok') return offered[0] ?? null
  if (adapter !== 'opencode') return null
  return offered.find(id => /free/i.test(id)) ?? null
}

/** A failed check, said the way the guide can act on. */
export function explainCheckFailure(adapter: AgentAdapter, message: string): string {
  const label = agentAdapterInfo(adapter).label
  if (/missing from this Domo install|ENOENT/i.test(message)) return `${label} is not installed with this Domo. Update or reinstall Domo.`
  if (/does not offer/i.test(message)) return `${label} started, but its account does not offer a cheap model to test with.`
  if (/no answer within/i.test(message)) return `${label} did not answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`
  if (/auth|log ?in|logged|401|403|unauthori[sz]ed|credential|api key|token/i.test(message)) {
    return `${label} could not sign in: ${firstLine(message)}. ${SIGN_IN_AGAIN[adapter]}`
  }
  return `${label} failed: ${firstLine(message)}`
}

const SIGN_IN_AGAIN: Record<AgentAdapter, string> = {
  'claude-code': 'Run claude setup-token again and paste the new token.',
  codex: 'Run codex login again on the computer Domo runs on.',
  opencode: 'Check the console key, or create a new one in the OpenCode console.',
  copilot: 'Run copilot login on the computer Domo runs on, or save a new GitHub token.',
  grok: 'Run grok login on the computer Domo runs on, or save a new xAI API key.'
}

function firstLine(message: string): string {
  const line = message.split('\n').map(part => part.trim()).find(Boolean) ?? message
  const short = line.length > 240 ? `${line.slice(0, 239)}…` : line
  return short.replace(/[.\s]+$/, '')
}

/**
 * One real request, on the credential a session of this harness would use —
 * the key included when that is all there is, which the guide says before
 * the person presses the button.
 */
export async function checkAgent(adapter: AgentAdapter): Promise<SetupCheckResult & { reply: string | null }> {
  const started = Date.now()
  const at = new Date(started).toISOString()
  try {
    const { answer, model } = await askOnce({
      adapter,
      model: offered => checkModel(adapter, offered),
      instructions: CHECK_INSTRUCTIONS,
      message: 'Are you there?',
      env: await adapterEnv(adapter, false),
      timeoutMs: CHECK_TIMEOUT_MS,
      timeoutMessage: `no answer within ${CHECK_TIMEOUT_MS / 1000}s`
    })
    const reply = answer.trim()
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    if (!reply) return result(false, `${agentAdapterInfo(adapter).label} started on ${model} but answered nothing.`, null, at)
    return result(true, `${model} answered in ${seconds} s.`, reply, at)
  } catch (error) {
    return result(false, explainCheckFailure(adapter, error instanceof Error ? error.message : String(error)), null, at)
  }
}

function result(ok: boolean, summary: string, reply: string | null, at: string) {
  return { ok, summary, at, reply }
}

export const VOICE_CHECK_TEXT = 'Domo can hear you and talk back.'

/** Whether a transcript is the test sentence, give or take punctuation and a word. */
export function heardRight(expected: string, heard: string): boolean {
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const want = words(expected)
  const got = new Set(words(heard))
  return want.filter(word => got.has(word)).length >= Math.ceil(want.length * 0.6)
}

/**
 * Voice end to end: the speaker says the test sentence and the transcriber
 * hears it back. When the device's own dictation hears, that half is the
 * browser's to check.
 */
export async function checkVoice(): Promise<SetupCheckResult & { audio: string | null, heard: string | null }> {
  const at = new Date().toISOString()
  const settings = (await getSettings()).agentVoice
  const problem = voiceProblem(settings, settings)
  if (problem) return { ...result(false, problem, null, at), audio: null, heard: null }
  try {
    const chunks: Int16Array[] = []
    let rate = 0
    await synthesizeWith(settings, VOICE_CHECK_TEXT, (chunk) => {
      rate ||= chunk.sampleRate
      const bytes = Buffer.from(chunk.data, 'base64')
      chunks.push(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 2))))
    })
    if (!rate) return { ...result(false, 'The voice answered with no sound.', null, at), audio: null, heard: null }
    const samples = concatPcm16(chunks)
    const audio = wavFromPcm16(samples, rate).toString('base64')
    if (settings.transcriber === 'browser') {
      return { ...result(true, 'Domo spoke. This device does the listening, so try the microphone in a session.', null, at), audio, heard: null }
    }
    const heard = (await transcribeWith(settings, samples, rate)).trim()
    if (!heardRight(VOICE_CHECK_TEXT, heard)) {
      return { ...result(false, heard ? `Domo spoke, but heard it back as “${heard}”.` : 'Domo spoke, but heard nothing back.', null, at), audio, heard }
    }
    return { ...result(true, `Domo spoke and heard itself back: “${heard}”.`, null, at), audio, heard }
  } catch (error) {
    return { ...result(false, `Voice failed: ${firstLine(error instanceof Error ? error.message : String(error))}`, null, at), audio: null, heard: null }
  }
}
