import { mountSuspended } from '@nuxt/test-utils/runtime'
import { UApp } from '#components'
import { defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'

import ConversationSummary from '~/components/ConversationSummary.vue'

/**
 * The transcript keeps every message; what the model is handed on a reconnect
 * is this summary plus the recent tail. Showing it is how a user finds out
 * what Domo will and will not remember of a long conversation.
 */
const Harness = defineComponent({
  props: { summary: { type: String, required: true }, folded: { type: Number, required: true } },
  setup: props => () => h(UApp, null, {
    default: () => h(ConversationSummary, { summary: props.summary, folded: props.folded })
  })
})

describe('ConversationSummary', () => {
  it('says how much of the conversation it stands in for', async () => {
    const component = await mountSuspended(Harness, {
      props: { summary: 'They are chasing a flaky invoice test.', folded: 24 }
    })

    expect(component.text()).toContain('Earlier context summarised (24 messages)')
  })

  it('counts one message in the singular', async () => {
    const component = await mountSuspended(Harness, { props: { summary: 'x', folded: 1 } })

    expect(component.text()).toContain('(1 message)')
  })

  it('shows the summary itself once opened', async () => {
    const component = await mountSuspended(Harness, {
      props: { summary: 'They are chasing a flaky invoice test.', folded: 24 }
    })

    await component.find('button').trigger('click')

    expect(component.text()).toContain('They are chasing a flaky invoice test.')
  })
})
