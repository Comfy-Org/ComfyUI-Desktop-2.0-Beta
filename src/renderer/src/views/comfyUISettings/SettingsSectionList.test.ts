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
  // dropped along the new title-popup pipeline (issue #779). The
  // renderer must surface it whenever main attaches one — and in both
  // boolean states so users know what flipping the toggle will do
  // *before* they touch it.
  describe('field descriptions', () => {
    const description =
      'Git repositories clone from gitcode.com instead of github.com.'

    function makeBooleanField(value: boolean): DetailField {
      return {
        id: 'useChineseMirrors',
        label: 'Use Chinese Mirrors (Git & PyPI)',
        value,
        editable: true,
        editType: 'boolean',
        description,
      }
    }

    it('renders the description below the control when the boolean is OFF', () => {
      const wrapper = mountList([makeBooleanField(false)])
      const desc = wrapper.find('.settings-v2-field-description')
      expect(desc.exists()).toBe(true)
      expect(desc.text()).toContain('gitcode.com')
    })

    it('renders the description below the control when the boolean is ON', async () => {
      const wrapper = mountList([makeBooleanField(true)])
      const desc = wrapper.find('.settings-v2-field-description')
      expect(desc.exists()).toBe(true)
      expect(desc.text()).toContain('gitcode.com')
    })

    it('does not render the description block for fields without one', () => {
      const wrapper = mountList([
        {
          id: 'autoInstallUpdates',
          label: 'Auto-install updates',
          value: true,
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
  })
})
