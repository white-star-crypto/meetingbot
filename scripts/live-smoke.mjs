import fs from 'node:fs'
const base = process.argv[2] || 'http://127.0.0.1:58459'
const brief = `请用 3 位参会模型评审合议桌面端的一个小改动：把“最近会议”拆成群聊/私聊两个历史列表，并在私聊输入框旁增加模型与推理档位选择。请判断这个改动是否值得做、有什么交互风险、给出最多 3 条验收标准。只输出简短结论，不要写代码。`
const start = await fetch(base + '/api/meetings/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ brief }),
})
const started = await start.json()
console.log('START', start.status, started)
if (!start.ok || !started.ok) process.exit(1)
const id = started.id
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const r = await fetch(base + '/api/meetings/' + encodeURIComponent(id))
  const data = await r.json()
  console.log('POLL', i, data.status, data.error || '')
  if (data.status === 'done') {
    fs.writeFileSync('runs-live/live-smoke-result.json', JSON.stringify(data, null, 2), 'utf8')
    console.log('DONE', JSON.stringify({
      runDir: data.result?.runDir,
      foreman: data.result?.foreman?.id,
      durationMs: data.result?.durationMs,
      budget: data.result?.budget,
      decisionKeys: Object.keys(data.result?.decision || {}),
      proposals: data.result?.proposals?.length,
      errors: data.result?.errors,
    }, null, 2))
    console.log('DECISION', JSON.stringify(data.result?.decision, null, 2).slice(0, 6000))
    process.exit(0)
  }
  if (data.status === 'failed') { console.log('FAILED', data.error); process.exit(2) }
}
console.log('TIMEOUT')
process.exit(3)
