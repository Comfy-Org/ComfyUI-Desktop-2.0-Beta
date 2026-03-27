import { lsRemoteLatestTag, lsRemoteRef } from './git'
import { getComfyUIRemoteUrl } from './github-mirror'
import * as settings from '../settings'

const REPO = 'Comfy-Org/ComfyUI'

/**
 * Find the latest semver tag via `git ls-remote --tags` (Git protocol).
 * No GitHub REST API calls — works against both github.com and gitcode.com.
 */
async function fetchLatestTag(): Promise<string | null> {
  const url = getComfyUIRemoteUrl(settings.get('useChineseMirrors') === true)
  try {
    return (await lsRemoteLatestTag(url)) ?? null
  } catch {
    return null
  }
}

export async function fetchLatestRelease(
  channel: string
): Promise<Record<string, unknown> | null> {
  const mirrorEnabled = settings.get('useChineseMirrors') === true
  const remoteUrl = getComfyUIRemoteUrl(mirrorEnabled)

  if (channel === 'latest') {
    const [headSha, latestTag] = await Promise.all([
      lsRemoteRef(remoteUrl, 'refs/heads/master'),
      fetchLatestTag(),
    ])
    if (!headSha) return null
    return {
      tag_name: headSha.slice(0, 7),
      commitSha: headSha,
      baseTag: latestTag || undefined,
      // commitsAhead is resolved locally after git fetch
      body: '',
      html_url: `https://github.com/${REPO}/commit/${headSha}`,
      _commit: true,
    }
  }

  // Stable channel: build synthetic release from latest tag
  const latestTag = await fetchLatestTag()
  if (!latestTag) return null
  return {
    tag_name: latestTag,
    name: latestTag,
    body: '',
    html_url: `https://github.com/${REPO}/releases/tag/${latestTag}`,
    baseTag: latestTag,
    commitsAhead: 0,
  }
}

export function truncateNotes(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + '\n\n… (truncated)'
}
