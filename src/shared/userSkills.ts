export interface UserSkill {
  name: string
  description: string
  enabled: boolean
  revision: string
}

export interface UserSkillDocument extends UserSkill {
  content: string
}

export interface UserSkillSaveInput {
  name?: string
  content: string
  revision?: string
}
