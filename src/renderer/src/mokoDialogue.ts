import type { DeviceConnectionState } from '../../shared/types'
import type { OnboardingGoal, OnboardingIntroStep, OnboardingModelChoice } from './onboarding'

export type MokoPose = 'welcome' | 'think' | 'happy'
export interface MokoLine { text: string; pose: MokoPose; motion?: 'hop' }

export const mokoGoalReplies: Record<OnboardingGoal, string> = {
  mod: '想给 Minecraft 加点自己的东西呀。我们可以从第一个物品开始。',
  modpack: '把喜欢的模组凑在一起，再做出自己的玩法。这个我也很期待！',
  server: '给服务器定点新规则？先做一条属于你的指令怎么样？',
  shader: '想让熟悉的世界换个样子呀。我们先从一处小变化开始。'
}

/** A custom API connection is usable AI, but is not a signed-in ModMind identity. */
export function mokoAccountLine(account: DeviceConnectionState): MokoLine {
  if (account.status === 'connected') {
    if (account.provider === 'custom') return { text: '你已经准备好自己的 AI 了呀！', pose: 'welcome' }
    const name = account.username?.trim()
    return { text: name ? `啊，${name}！` : '登录好啦！', pose: 'happy', motion: 'hop' }
  }
  if (account.status === 'authorizing') return { text: '好，我在这里等你。\n在浏览器里完成登录，就可以回来啦。', pose: 'think' }
  if (account.status === 'error') return { text: '账号暂时没连上。\n可以再试一次，也可以先去看看。', pose: 'think' }
  return { text: '我还不知道你是谁呢。\n点这里登录一下账号吧！', pose: 'think' }
}

export function mokoIntroLine(step: OnboardingIntroStep, account: DeviceConnectionState, modelChoice?: OnboardingModelChoice): MokoLine {
  switch (step) {
    case 'hello': return { text: '你好，我是茉可！', pose: 'welcome' }
    case 'experience': return { text: '你是第一次用 ModMind 吗？', pose: 'welcome' }
    case 'new': return { text: '那今天就由我带路啦！', pose: 'happy', motion: 'hop' }
    case 'returning': return { text: '那你应该已经有想做的东西了吧？\n我们可以走快一点。', pose: 'welcome' }
    case 'checking': return { text: '让我看看……', pose: 'think' }
    case 'account': return mokoAccountLine(account)
    case 'helper': return { text: '接下来，我给你找个帮手吧！', pose: 'welcome' }
    case 'helpers': return { text: '有了她，我们就能一边聊想法，\n一边把想做的东西做出来啦。', pose: 'happy' }
    case 'model': return { text: '选一个模型，来帮你干活吧！', pose: 'welcome' }
    case 'modelReply': return modelChoice === 'deepseek'
      ? { text: '大肥鱼可以免费帮忙，不过免费额度有限哟。\n要是暂时用不了，就换条线路，或者找大白龙吧！', pose: 'welcome' }
      : { text: '那就请大白龙来帮你啦！\n她会按实际使用扣费，记得留意余额哟。', pose: 'welcome' }
    case 'invitation': return { text: '你是想从零开始做一个项目，\n还是接着修改在别处做好的项目？', pose: 'welcome' }
  }
}
