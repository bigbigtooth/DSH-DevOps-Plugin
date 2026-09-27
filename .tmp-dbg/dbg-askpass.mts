import { mkdtempSync, readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeSsh, fakeSshEnv } from '../tests/helpers/fake-ssh.ts'
import { OpenSshTransport, renderPrivateConfig } from '../src/host/ssh/openssh-transport.ts'

const setup = installFakeSsh()
const workDir = mkdtempSync(join(tmpdir(), 'dbg-'))
const envRef = fakeSshEnv(setup)
const transport = new OpenSshTransport({
  workDir,
  resolveSecrets: async () => ({ targetSecret: setup.password, jumpSecrets: [] }),
  spawnEnv: envRef,
  probeTimeoutMs: 15000,
})
const serverId = 'dbg'
const cfg = renderPrivateConfig({
  host: '127.0.0.1', port: 22, user: setup.username, authKind: 'password',
  knownHostsFile: transport['knownHostsPath'](serverId), connectTimeoutSeconds: 10,
})
transport.writeServerConfig(serverId, cfg)
try {
  const r = await transport.verify({
    host: '127.0.0.1', port: 22, user: setup.username,
    authKind: 'password', secret: setup.password, acceptUnknownFingerprint: true, timeoutMs: 8000,
  })
  console.log('VERIFY OK', r)
} catch (e) {
  console.log('VERIFY FAILED:', (e as Error).message)
}
// 找 channel 目录并检查 prompts.log
for (const d of readdirSync(workDir)) {
  const p = join(workDir, d)
  if (d.startsWith('exec') || d.includes('chan')) {
    console.log('dir', d, existsSync(join(p,'prompts.log')) ? JSON.stringify(readFileSync(join(p,'prompts.log'),'utf8')) : 'no prompts.log')
  }
}
console.log('askpass.sh:'); console.log(readFileSync(join(workDir,'askpass.sh'),'utf8'))
