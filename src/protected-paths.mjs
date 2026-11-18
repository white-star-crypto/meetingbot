import os from 'node:os'
import path from 'node:path'
import { vaultPaths } from './key-vault.mjs'
import { canonicalPath as canonical } from './path-canonical.mjs'

// One source of truth for credentials/control files. Keep this list shared by
// fs guards, Python's audit hook, key-vault and bundle export.
export function protectedPathsFor({ root = process.cwd(), dataRoot = root } = {}) {
  const home = os.homedir()
  const data = path.resolve(dataRoot)
  const files = [
    path.join(data, 'state', 'permissions.json'),
    path.join(data, 'state', 'roster.json'),
    path.join(data, 'state', 'audit.jsonl'),
    path.join(data, 'state', 'sessions.json'),
    path.join(data, 'state', 'groups.json'),
    path.join(data, 'state', 'policy.json'),
    path.join(data, 'state', 'decision-approvals.json'),
    path.join(data, 'state', 'export-key.pem'),
    path.join(data, 'state', 'export-key.pub.pem'),
    path.join(data, 'config', 'providers.vault.json'),
    path.join(data, 'config', 'providers.vault.key'),
    path.join(data, 'config', 'providers.vault.key.prev'),
    path.join(root, 'state', 'permissions.json'),
    path.join(root, 'state', 'roster.json'),
    path.join(root, 'state', 'audit.jsonl'),
    path.join(root, 'state', 'sessions.json'),
    path.join(root, 'state', 'groups.json'),
    path.join(root, 'state', 'policy.json'),
    path.join(root, 'state', 'export-key.pem'),
    path.join(root, 'state', 'export-key.pub.pem'),
    path.join(root, 'config', 'providers.vault.json'),
    path.join(root, 'config', 'providers.vault.key'),
    path.join(root, 'config', 'providers.vault.key.prev'),
    vaultPaths.VAULT_FILE,
    vaultPaths.MASTER_FILE,
    vaultPaths.MASTER_FILE + '.prev',
    process.env.MEETINGBOT_EXPORT_KEY_FILE || path.join(root, 'state', 'export-key.pem'),
    process.env.MEETINGBOT_EXPORT_PUBKEY_FILE || path.join(root, 'state', 'export-key.pub.pem'),
    path.join(root, '.env'),
    path.join(root, '.env.local'),
    path.join(root, '.env.development'),
    path.join(root, '.env.production'),
    path.join(root, '.env.test'),
    path.join(root, '.env.staging'),
    path.join(root, '.npmrc'),
    path.join(root, '.git-credentials'),
    path.join(home, '.ssh', 'id_rsa'),
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.aws', 'credentials'),
    path.join(home, '.config', 'gcloud', 'credentials.db'),
    path.join(home, '.config', 'gcloud', 'application_default_credentials.json'),
    path.join(home, '.config', 'gh', 'hosts.yml'),
    path.join(home, '.netrc'),
    path.join(home, '.config', 'netrc'),
    path.join(home, '.azure', 'accessTokens.json'),
    path.join(home, '.npmrc'),
    path.join(home, '.yarnrc'),
    path.join(home, '.yarnrc.yml'),
    path.join(home, '.git-credentials'),
    path.join(home, '.config', 'git', 'credentials'),
    path.join(home, '.docker', 'config.json'),
    path.join(home, '.kube', 'config'),
    path.join(home, '.pypirc'),
    path.join(home, '.pgpass'),
    path.join(home, '.my.cnf'),
    path.join(home, '.gitconfig'),
    path.join(home, '.cargo', 'credentials.toml'),
    path.join(home, '.config', 'pip', 'pip.conf'),
    path.join(home, '.config', 'containers', 'auth.json'),
    path.join(home, '.msmtprc'),
    path.join(home, '.authinfo'),
    path.join(home, '.terraformrc'),
    path.join(home, '.config', 'sops', 'age', 'keys.txt'),
    path.join(home, '.config', 'rclone', 'rclone.conf'),
    path.join(home, '.databrickscfg'),
  ]
  const dirs = [
    path.join(home, '.gnupg'),
    path.join(home, '.ssh'),
    path.join(home, '.aws'),
    path.join(home, '.kube'),
    path.join(home, '.docker'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.config', 'git'),
    path.join(home, '.config', 'gcloud'),
    path.join(home, '.config', 'pip'),
    path.join(home, '.config', 'containers'),
    path.join(home, '.config', 'heroku'),
    path.join(home, '.config', 'sops'),
    path.join(home, '.config', 'rclone'),
  ]
  return {
    files: [...new Set(files.map(canonical))],
    dirs: [...new Set(dirs.map(canonical))],
  }
}

export function isProtectedPath(target, options = {}) {
  const absolute = canonical(target)
  const { files, dirs } = protectedPathsFor(options)
  return files.includes(absolute) || dirs.some((dir) => absolute === dir || absolute.startsWith(dir + path.sep))
}
