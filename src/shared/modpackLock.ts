export interface ModpackLockResult {
  success: boolean
  canRepair: boolean
  repaired: boolean
  records: number
  files: number
  duplicateFiles: string[]
  errors: Array<{ fileName: string; message: string; actualSha256?: string }>
  backupPath?: string
}
