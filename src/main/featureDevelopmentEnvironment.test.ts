import {afterEach,describe,expect,it,vi} from 'vitest'
import path from 'node:path'

afterEach(()=>{vi.unstubAllEnvs();vi.resetModules();vi.doUnmock('electron')})
async function environment(packaged:boolean,requested?:string){
 vi.resetModules();const setPath=vi.fn();vi.doMock('electron',()=>({app:{isPackaged:packaged,getAppPath:()=>path.resolve('test-results/feature-development-environment'),setPath}}))
 if(requested)vi.stubEnv('MODMIND_FEATURE_DEV',requested);else vi.stubEnv('MODMIND_FEATURE_DEV','')
 vi.stubEnv('MODMIND_DEVELOPER_HOST_CONFIG','')
 return{...(await import('./featureDevelopmentEnvironment')),setPath}
}
describe('feature development environment gate',()=>{
 it('does nothing in a regular development session',async()=>{const value=await environment(false);expect(value.featureDevelopment).toBeNull();expect(value.setPath).not.toHaveBeenCalled()})
 it('ignores development loading in packaged releases and from unrelated paths',async()=>{
  const file=path.resolve('test-results/feature-development-environment/node_modules/.cache/modmind-feature-dev/ready.json')
  const packaged=await environment(true,file);expect(packaged.featureDevelopment).toBeNull();expect(packaged.setPath).not.toHaveBeenCalled()
  const unrelated=await environment(false,path.resolve('outside/ready.json'));expect(unrelated.featureDevelopment).toBeNull();expect(unrelated.setPath).not.toHaveBeenCalled()
 })
 it('sets the isolated development profile before services start',async()=>{
  const root=path.resolve('test-results/feature-development-environment/node_modules/.cache/modmind-feature-dev')
  const value=await environment(false,path.join(root,'ready.json'));expect(value.featureDevelopment?.profile).toBe(path.join(root,'profile'))
  expect(value.setPath.mock.calls).toEqual([['userData',path.join(root,'profile')],['sessionData',path.join(root,'profile')]])
 })
})
