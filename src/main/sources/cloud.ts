import { withCloudDistributionUtm } from '../lib/cloudUrl'
import { createUrlSource } from './common/urlSource'

export const cloud = createUrlSource({
  id: 'cloud',
  labelKey: 'cloud.label',
  descKey: 'cloud.desc',
  category: 'cloud',
  defaultUrl: 'https://cloud.comfy.org/',
  transformUrl: withCloudDistributionUtm,
})
