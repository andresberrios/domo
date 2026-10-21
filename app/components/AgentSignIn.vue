<script setup lang="ts">
import type { AgentAdapter, AppSettingsView, SetupAgentStatus } from '~~/shared/types'
import { agentAdapterInfo } from '~~/shared/agent-adapters'

/**
 * How one coding agent signs in: what it is on now, what to do when that is
 * nothing, and the credentials it can use. The same on the agent's settings
 * page and in the setup guide, so the two never disagree.
 */
const props = defineProps<{
  adapter: AgentAdapter
  status: SetupAgentStatus | null
  settings: AppSettingsView | null
}>()
const emit = defineEmits<{ changed: [] }>()

const label = computed(() => agentAdapterInfo(props.adapter).label)

const ANTHROPIC_WARNING = 'Bills per token through the Anthropic API, not your Claude subscription. Inside Claude Code an API key '
  + 'overrides a subscription, so Domo gives it to Claude Code only when there is no Claude Code token and no Claude login. '
  + 'OpenCode uses it for its anthropic/… models.'
const OPENAI_WARNING = 'Bills per token through the OpenAI API, not your ChatGPT plan. Codex would save it as its login and stay on '
  + 'API billing, so Domo gives it to Codex only when Codex has no ChatGPT login. OpenCode uses it for its openai/… models, '
  + 'and so does the OpenAI voice engine.'
const XAI_WARNING = 'Bills per token through the xAI API, not your Grok plan. Domo gives it to Grok on this computer only '
  + 'when there is no Grok login here.'

const tone = computed(() => {
  const status = props.status
  if (!status) return { color: 'neutral' as const, icon: 'i-lucide-loader-circle', title: 'Checking…' }
  if (!status.installed) return { color: 'error' as const, icon: 'i-lucide-circle-x', title: `${label.value} is not installed` }
  switch (status.login) {
    case 'subscription': return { color: 'success' as const, icon: 'i-lucide-circle-check', title: 'Signed in' }
    case 'api-key': return { color: 'warning' as const, icon: 'i-lucide-receipt', title: 'Signed in with an API key' }
    case 'free': return { color: 'neutral' as const, icon: 'i-lucide-circle-dashed', title: 'Free models only' }
    default: return { color: 'error' as const, icon: 'i-lucide-circle-alert', title: 'Not signed in' }
  }
})

/** Whether to say how to sign in: nothing yet, a key where a subscription would do, or only this computer's login. */
const needsSteps = computed(() => !!props.status && props.status.installed
  && (props.status.login !== 'subscription' || !props.status.environments))
</script>

<template>
  <div class="space-y-4">
    <UAlert
      :color="tone.color"
      variant="subtle"
      :icon="tone.icon"
      :title="tone.title"
      :description="status?.installed === false ? (status.installProblem ?? undefined) : status?.loginDetail"
    />

    <template v-if="needsSteps && adapter === 'claude-code'">
      <div class="space-y-2 text-sm">
        <p class="font-medium">Sign in with your Claude subscription</p>
        <ol class="list-decimal space-y-2 ps-5 text-muted">
          <li>On the computer Domo runs on, open a terminal and run:<CopyCommand command="claude setup-token" class="mt-1" /></li>
          <li>Sign in with your Claude account in the browser window it opens.</li>
          <li>Paste the token it prints (it starts with <code>sk-ant-oat</code>) into <span class="text-default">Claude Code token</span> below.</li>
        </ol>
        <p class="text-xs text-muted">
          No <code>claude</code> command there?
          <ULink to="https://docs.anthropic.com/en/docs/claude-code/setup" target="_blank" class="text-primary">Install Claude Code</ULink>
          first. The token lasts a year and also lets Domo show your plan limits.
        </p>
      </div>
    </template>

    <template v-if="needsSteps && adapter === 'codex'">
      <div class="space-y-2 text-sm">
        <p class="font-medium">Sign in with your ChatGPT plan</p>
        <ol class="list-decimal space-y-2 ps-5 text-muted">
          <li>On the computer Domo runs on, open a terminal and run:<CopyCommand command="codex login" class="mt-1" /></li>
          <li>Sign in with your ChatGPT account in the browser window it opens, then check again here.</li>
        </ol>
        <UButton label="Check again" icon="i-lucide-refresh-cw" color="neutral" variant="subtle" size="sm" @click="emit('changed')" />
        <p class="text-xs text-muted">
          No browser on that computer? Run <code>codex login --device-auth</code> and enter the code it shows on any device.
          No <code>codex</code> command?
          <ULink to="https://github.com/openai/codex#installing-and-running-codex-cli" target="_blank" class="text-primary">Install Codex</ULink>
          first.
        </p>
      </div>
    </template>

    <template v-if="needsSteps && adapter === 'opencode'">
      <div class="space-y-2 text-sm">
        <p class="font-medium">Add an OpenCode account</p>
        <ol class="list-decimal space-y-2 ps-5 text-muted">
          <li>
            Open the
            <ULink to="https://opencode.ai/console" target="_blank" class="text-primary">OpenCode console</ULink>
            and sign in.
          </li>
          <li>Create an API key, and paste it into <span class="text-default">Console key</span> below.</li>
        </ol>
        <p class="text-xs text-muted">
          A console key works everywhere, development environments included, and lets Domo show your Go plan limits.
          Without one, OpenCode still runs its free models.
        </p>
      </div>
    </template>

    <template v-if="needsSteps && adapter === 'copilot'">
      <div class="space-y-2 text-sm">
        <p class="font-medium">Sign in with your Copilot plan</p>
        <ol class="list-decimal space-y-2 ps-5 text-muted">
          <li>
            Open
            <ULink to="https://github.com/settings/personal-access-tokens/new" target="_blank" class="text-primary">a new fine-grained token</ULink>
            on GitHub. Under <span class="text-default">Permissions</span>, add <span class="text-default">Copilot Requests</span>.
          </li>
          <li>Generate it, and paste it (it starts with <code>github_pat_</code>) into <span class="text-default">GitHub token</span> below.</li>
        </ol>
        <p class="text-xs text-muted">
          The token works everywhere, development environments included, and lets Domo show your Copilot limits and models.
          On this computer only, signing in with Copilot itself also works:
        </p>
        <CopyCommand command="npx @github/copilot login" />
        <UButton label="Check again" icon="i-lucide-refresh-cw" color="neutral" variant="subtle" size="sm" @click="emit('changed')" />
      </div>
    </template>

    <template v-if="needsSteps && adapter === 'grok'">
      <div class="space-y-2 text-sm">
        <p class="font-medium">Sign in with your Grok plan</p>
        <ol class="list-decimal space-y-2 ps-5 text-muted">
          <li>On the computer Domo runs on, open a terminal and run:<CopyCommand command="npx @xai-official/grok login" class="mt-1" /></li>
          <li>Sign in with your Grok account in the browser window it opens, then check again here.</li>
        </ol>
        <UButton label="Check again" icon="i-lucide-refresh-cw" color="neutral" variant="subtle" size="sm" @click="emit('changed')" />
        <p class="text-xs text-muted">
          No browser on that computer? Add <code>--device-auth</code> and enter the code it shows on any device.
          That login stays on this computer. Development environments sign in with an
          <ULink to="https://console.x.ai" target="_blank" class="text-primary">xAI API key</ULink>
          instead, saved below.
        </p>
      </div>
    </template>

    <template v-if="adapter === 'claude-code'">
      <CredentialField
        :settings="settings"
        credential="claudeCodeOauthToken"
        label="Claude Code token"
        help="From claude setup-token, billed to your Claude subscription. Claude Code signs in with it everywhere, development environments included."
        placeholder="sk-ant-oat…"
        @saved="emit('changed')"
      />
      <UCollapsible :default-open="settings?.credentialSources?.anthropicApiKey != null" class="space-y-3">
        <UButton
          label="Anthropic API key (optional)"
          color="neutral"
          variant="link"
          trailing-icon="i-lucide-chevron-down"
          class="px-0"
        />
        <template #content>
          <CredentialField
            :settings="settings"
            credential="anthropicApiKey"
            label="Anthropic API key"
            placeholder="sk-ant-api…"
            :warning="ANTHROPIC_WARNING"
            @saved="emit('changed')"
          />
        </template>
      </UCollapsible>
    </template>

    <template v-if="adapter === 'codex'">
      <UCollapsible :default-open="settings?.credentialSources?.openAiApiKey != null" class="space-y-3">
        <UButton
          label="OpenAI API key (optional fallback)"
          color="neutral"
          variant="link"
          trailing-icon="i-lucide-chevron-down"
          class="px-0"
        />
        <template #content>
          <CredentialField
            :settings="settings"
            credential="openAiApiKey"
            label="OpenAI API key"
            placeholder="sk-…"
            :warning="OPENAI_WARNING"
            @saved="emit('changed')"
          />
        </template>
      </UCollapsible>
    </template>

    <template v-if="adapter === 'copilot'">
      <CredentialField
        :settings="settings"
        credential="copilotGithubToken"
        label="GitHub token"
        :help="settings?.hasCopilotAuth
          ? 'Sessions on this computer already use your Copilot login. A token is what a development environment signs in with, because that login is never copied into one.'
          : 'A fine-grained token with the Copilot Requests permission, billed to your Copilot plan. Copilot signs in with it everywhere, development environments included.'"
        placeholder="github_pat_…"
        @saved="emit('changed')"
      />
    </template>

    <template v-if="adapter === 'grok'">
      <CredentialField
        :settings="settings"
        credential="xaiApiKey"
        label="xAI API key"
        :help="settings?.hasGrokAuth
          ? 'Sessions on this computer already use your Grok login. A key is what a development environment signs in with, because that login is never copied into one.'
          : 'From the xAI console. Grok signs in with it everywhere, development environments included.'"
        placeholder="xai-…"
        :warning="XAI_WARNING"
        @saved="emit('changed')"
      />
    </template>

    <template v-if="adapter === 'opencode'">
      <CredentialField
        :settings="settings"
        credential="openCodeApiKey"
        label="Console key"
        :help="settings?.hasOpenCodeAuth
          ? 'Sessions on this computer already use your opencode auth login. A console key is what a development environment can use, because that login cannot be copied into one.'
          : 'An API key from the OpenCode console. opencode-go/… models use your Go plan; opencode/… models bill your console credit per token.'"
        placeholder="oc_sk_…"
        @saved="emit('changed')"
      />
      <UCollapsible
        :default-open="settings?.credentialSources?.openAiApiKey != null || settings?.credentialSources?.anthropicApiKey != null"
        class="space-y-3"
      >
        <UButton
          label="OpenAI and Anthropic keys (optional)"
          color="neutral"
          variant="link"
          trailing-icon="i-lucide-chevron-down"
          class="px-0"
        />
        <template #content>
          <div class="space-y-4">
            <CredentialField
              :settings="settings"
              credential="openAiApiKey"
              label="OpenAI API key"
              help="For OpenCode's openai/… models."
              placeholder="sk-…"
              :warning="OPENAI_WARNING"
              @saved="emit('changed')"
            />
            <CredentialField
              :settings="settings"
              credential="anthropicApiKey"
              label="Anthropic API key"
              help="For OpenCode's anthropic/… models."
              placeholder="sk-ant-api…"
              :warning="ANTHROPIC_WARNING"
              @saved="emit('changed')"
            />
          </div>
        </template>
      </UCollapsible>
    </template>
  </div>
</template>
