import path from 'node:path'

// Writable application data belongs somewhere the installer can write. The
// environment override is set by Electron packaged builds; CLI and portable
// runs keep their historical cwd-relative behavior.
export function resolveDataRoot(env = process.env) {
  return path.resolve(String(env.MEETINGBOT_DATA_DIR || process.cwd()))
}
