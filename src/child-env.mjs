// Child processes get an explicit, functional environment. Secrets are only
// passed when a caller deliberately supplies them in `extra`.
const ALLOWED = new Set([
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'WINDIR',
  'COMSPEC', 'ComSpec', 'OS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL',
  'PYTHONIOENCODING', 'PYTHONUTF8', 'HEYI_WORKSPACE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
])

export function childEnv(extra = {}) {
  const env = {}
  for (const key of ALLOWED) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}
