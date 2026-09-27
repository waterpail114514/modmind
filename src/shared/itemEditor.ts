export type ManagedItemKind = 'item' | 'sword' | 'pickaxe' | 'axe' | 'shovel' | 'hoe' | 'armor'
export type VanillaItemKind = ManagedItemKind | 'block'
export type ManagedItemTier = 'wood' | 'stone' | 'iron' | 'gold' | 'diamond' | 'netherite'
export type ManagedArmorSlot = 'helmet' | 'chestplate' | 'leggings' | 'boots'
export type ManagedArmorMaterial = 'leather' | 'chain' | 'iron' | 'gold' | 'diamond' | 'netherite'

export interface ManagedItem {
  id: string
  name: string
  englishName: string
  kind: ManagedItemKind
  stackSize: number
  durability: number
  texture: string
  tier?: ManagedItemTier
  attackDamage?: number
  attackSpeed?: number
  armorSlot?: ManagedArmorSlot
  armorMaterial?: ManagedArmorMaterial
}

export interface ItemEditorState {
  supported: boolean
  reason?: string
  revision: number
  items: ManagedItem[]
  textures: string[]
}

export interface VanillaItem {
  id: string
  name: string
  englishName: string
  kind: VanillaItemKind
  stackSize: number
  maxDurability?: number
}

export interface ItemEditorSaveInput {
  revision: number
  item: ManagedItem
}

export interface ItemEditorApi {
  list: (projectPath: string) => Promise<ItemEditorState>
  catalog: (projectPath: string) => Promise<VanillaItem[]>
  save: (projectPath: string, input: ItemEditorSaveInput) => Promise<ItemEditorState>
  remove: (projectPath: string, id: string, revision: number) => Promise<ItemEditorState>
  importTexture: (projectPath: string) => Promise<string | null>
}
