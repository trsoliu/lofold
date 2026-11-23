import assert from 'node:assert/strict'
import test from 'node:test'
import { applicableMemories, soleRecipient } from '../src/writing-context.ts'

const common = { id: 'one', text: '谢谢。', recipient: '' }
const contact = { id: 'two', text: '小组留两席。', recipient: 'Reader@EXAMPLE.test' }
const profile = { memories: [common, contact] }

test('只为单独写给匹配邮箱的草稿提供该联系人的表述', () => {
  assert.deepEqual(applicableMemories(profile, ' Reader@example.test ', '', ''), [common, contact])
  for (const [to, cc, bcc] of [
    ['', '', ''], ['reader@example.test', '', ''],
    ['Reader@example.test', 'copy@example.test', ''], ['Reader@example.test', '', 'blind@example.test'],
    ['Reader@example.test，other@example.test', '', ''], ['Reader@example.test;other@example.test', '', ''],
    ['小林 <Reader@example.test>', '', ''], ['Reader@example.test\nother@example.test', '', ''],
  ]) {
    assert.deepEqual(applicableMemories(profile, to, cc, bcc), [common])
  }
})

test('支持国际化邮箱与引号本地部分，拒绝歧义及不完整输入', () => {
  assert.equal(soleRecipient('读者@例子.测试', '', ''), '读者@例子.测试')
  assert.equal(soleRecipient('"reading group"@EXAMPLE.test', '', ''), '"reading group"@example.test')
  for (const input of ['foo@@example.test', 'foo..a@example.test', 'name <a@example.test>','a@localhost.', 'a@', 'a@-example.test']) {
    assert.equal(soleRecipient(input, '', ''), null)
  }
})
