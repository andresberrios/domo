import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'

import InlineTitle from '~/components/InlineTitle.vue'

async function editing(value = 'Fix the login') {
  const wrapper = await mountSuspended(InlineTitle, { props: { value } })
  await wrapper.get('button').trigger('click')
  await nextTick()
  return { wrapper, input: wrapper.get('input') }
}

describe('a title renamed in place', () => {
  it('saves on Enter, once, even though leaving the field follows', async () => {
    const { wrapper, input } = await editing()
    expect(input.element.value).toBe('Fix the login')
    await input.setValue('  Login fix  ')
    // Before the field is gone, as a browser blurs it on removal.
    void input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    expect(wrapper.emitted('save')).toEqual([['Login fix']])
    expect(wrapper.find('input').exists()).toBe(false)
  })

  it('saves when the field is left', async () => {
    const { wrapper, input } = await editing()
    await input.setValue('Login fix')
    await input.trigger('blur')
    expect(wrapper.emitted('save')).toEqual([['Login fix']])
  })

  it('saves nothing on Escape, on an empty value or on an unchanged one', async () => {
    for (const [value, key] of [['Other', 'Escape'], ['   ', 'Enter'], ['Fix the login', 'Enter']] as const) {
      const { wrapper, input } = await editing()
      await input.setValue(value)
      await input.trigger('keydown', { key })
      await input.trigger('blur')
      expect(wrapper.emitted('save')).toBeUndefined()
      expect(wrapper.get('button').text()).toBe('Fix the login')
    }
  })
})
