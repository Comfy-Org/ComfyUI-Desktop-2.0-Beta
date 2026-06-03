import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

import { en } from '../../lib/i18nMessages.ts'
import SettingsSectionList from './SettingsSectionList.vue'
import type { DetailField } from '../../types/ipc'

function makeI18n() {
  return createI18n({ legacy: false, locale: 'en', messages: { en } })
}

function mountList(fields: DetailField[]) {
  return mount(SettingsSectionList, {
    props: { sections: [{ fields }] },
    global: { plugins: [makeI18n()] },
  })
}

describe('SettingsSectionList', () => {
  // Regression: the Chinese mirrors toggle's description was silently
  // dropped along the new title-popup pipeline (issue #779). When main
  // attaches a `description`, the renderer must surface it under the
  // control. (The OFF/ON gating itself lives main-side in
  // buildSettingsSections; the renderer just renders what it gets.)
  describe('field descriptions', () => {
    it('renders the description below the control when one is attached', () => {
      const wrapper = mountList([
        {
          id: 'useChineseMirrors',
          label: 'Use Chinese Mirrors (Git & PyPI)',
          value: true,
          editable: true,
          editType: 'boolean',
          description:
            'Git repositories clone from gitcode.com instead of github.com.',
        },
      ])
      const desc = wrapper.find('.settings-v2-field-description')
      expect(desc.exists()).toBe(true)
      expect(desc.text()).toContain('gitcode.com')
    })

    it('does not render the description block when none is attached', () => {
      const wrapper = mountList([
        {
          id: 'useChineseMirrors',
          label: 'Use Chinese Mirrors (Git & PyPI)',
          value: false,
          editable: true,
          editType: 'boolean',
        },
      ])
      expect(wrapper.find('.settings-v2-field-description').exists()).toBe(false)
    })

    it('renders descriptions for non-boolean field types too', () => {
      const wrapper = mountList([
        {
          id: 'pypiMirror',
          label: 'PyPI Mirror URL',
          value: '',
          editable: true,
          editType: 'text',
          placeholder: 'e.g. https://mirrors.aliyun.com/pypi/simple/',
          description: 'Overrides the default index when set.',
        },
      ])
      const desc = wrapper.find('.settings-v2-field-description')
      expect(desc.exists()).toBe(true)
      expect(desc.text()).toContain('default index')
    })

    it('renders an InfoTooltip trigger when a field has a tooltip', () => {
      const wrapper = mountList([
        {
          id: 'useChineseMirrors',
          label: 'Use Chinese Mirrors (Git & PyPI)',
          value: false,
          editable: true,
          editType: 'boolean',
          tooltip:
            'Git repositories clone from gitcode.com instead of github.com.',
        },
      ])
      const trigger = wrapper.find('.info-tooltip-trigger')
      expect(trigger.exists()).toBe(true)
      expect(trigger.attributes('aria-label')).toContain('gitcode.com')
    })
  })
})
