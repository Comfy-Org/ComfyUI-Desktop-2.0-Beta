import { createUrlSource } from './common/urlSource'

export const remote = createUrlSource({
  id: 'remote',
  labelKey: 'remote.label',
  descKey: 'remote.desc',
  category: 'remote',
  defaultUrl: 'http://localhost:8188',
  editableUrl: true,
  includeUntrack: true,
})
