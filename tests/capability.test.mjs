#!/usr/bin/env node
import assert from 'node:assert/strict'
import { classifyDomain, routeTask } from '../src/capability-router.mjs'

assert.equal(classifyDomain('请重构这段代码并补测试'), 'code')
assert.equal(classifyDomain('做一个舰桥界面和配色'), 'visual')
assert.equal(classifyDomain('分析这个决策的风险和权衡'), 'reasoning')
assert.equal(classifyDomain('把文档翻译成英文'), 'writing')
assert.equal(classifyDomain('界面 配色 排版 重构'), 'visual')
assert.equal(classifyDomain('界面 代码'), 'reasoning', 'an exact multi-domain tie must not fall back to alphabetical code')
assert.equal(classifyDomain('代码 代码 测试'), 'code')
const route = routeTask('请重构代码', { allowed: ['ds-flash', 'glm-flash'] })
assert.ok(route.primary)
assert.ok(route.reviewer)
console.log('PASS capability router Chinese regex counts and allowed roster')
