/** A release is named by its version; one an older install built from git, by its commit, shown short. */
export function releaseLabel(release: string): string {
  return /^[0-9a-f]{40}$/.test(release) ? release.slice(0, 7) : release
}
