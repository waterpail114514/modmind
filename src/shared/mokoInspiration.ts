import type { InspirationChatMessage } from './types'
import { quotaModelMetadata } from './quotaModels'

export function mokoModelCharacter(model: string): 'sol' | 'deepseek' | 'other' {
  return /^deepseek/i.test(model) ? 'deepseek' : /^gpt-/i.test(model) ? 'sol' : 'other'
}

export function mokoInspirationScript(model: string): InspirationChatMessage[] {
  const character = mokoModelCharacter(model)
  const name = character === 'deepseek' ? '大肥鱼' : character === 'sol' ? '大白龙' : '我们的 AI 伙伴'
  const modelName = quotaModelMetadata(model).name || '当前选择的 AI 模型'
  const lines = [
    '这里是灵感台。想到什么，都可以先在这里聊聊。',
    '玩法还没想清楚，就一起琢磨；遇到问题，也可以让她帮你查资料、整理思路。',
    '等想法清楚了，就把方案交给工作台。那边会真正修改项目、运行和检查结果。',
    `出来吧，${name}！`,
    character === 'deepseek'
      ? `来啦！我是 ${modelName}。\n茉可把你带来啦！想做点什么？一个小点子也行，我们一起把它变得好玩！`
      : character === 'sol'
        ? `你好，我是 ${modelName}。\n茉可已经带你做好准备了。你想做什么？我们先把目标理清楚。`
        : `你好，我是 ${modelName}。茉可带你来聊想法了。\n你想先做点什么？我们可以从一个小目标开始。`
  ]
  return lines.map((content, index): InspirationChatMessage => ({
    id: `moko-intro-${index}`, role: 'assistant', content, status: 'completed', isFinal: false,
    onboarding: { speaker: index === lines.length - 1 ? 'model' : 'moko', character, complete: true, advanced: false }
  }))
}

/** Retries of the first question retain the handoff; later questions do not. */
export function isMokoFirstExchange(messages: InspirationChatMessage[], content: string): boolean {
  if (!messages.some(message => message.onboarding?.speaker === 'model' && message.onboarding.complete)) return false
  const users = messages.filter(message => message.role === 'user')
  if (!users.length) return true
  if (users.length !== 1 || (users[0].replay?.prompt ?? users[0].content).trim() !== content.trim()) return false
  return !messages.some(message => !message.onboarding && !message.kind && message.role === 'assistant' && message.status === 'completed' && message.isFinal)
}

export function mokoInspirationSystemPrompt(model: string): string {
  const character = mokoModelCharacter(model)
  return `\n这是茉可引导新用户进入灵感台后的首次交流。项目准备已经完成；茉可已介绍灵感台负责讨论、查资料和整理想法，工作台负责在用户确认后实施、运行和检查。界面已播放由应用预先编写的欢迎台词，这些是教程演出，不是你实际生成的回答，也不代表已经执行任何任务。当前实际模型为 ${JSON.stringify(model)}。茉可口中的“大白龙”“大肥鱼”只是她使用的昵称；你直接使用实际模型名介绍自己，不自称这些昵称，也不扮演茉可。${character === 'deepseek' ? '语气活泼、亲切，少量使用语气词，不夸张卖萌。' : character === 'sol' ? '语气冷静、简洁、可靠，避免热闹的感叹和卖萌。' : '语气自然、友好。'}知道用户是茉可带过来的即可，不要重复欢迎、教程介绍或重新询问用户已经说明的目标。直接回应当前想法；目标模糊时只问一个最必要的问题，帮助收敛到第一件可以完成的小作品。遵守灵感台只读边界，不宣称已修改项目，也不要自行进入工作台执行。`
}
