import { describe, expect, it } from 'vitest'
import { parseProviderSnapshot, providerOwnerKey } from './providerSync'
import { providerFixture } from './__fixtures__/providerSync'

describe('provider sync v2', () => {
  it('changes the paid group using its own key when the session default is free',async()=>{
    const f=providerFixture();f.flags.sessionDefaultFree=true
    await f.service.select('qwen3.8-flash',{scope:'settings',billing:'free',account:'trial:one'})
    await expect(f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok'})
    const requests=f.network.filter(r=>r.url.includes('/group'))
    expect(requests.every(r=>new Headers(r.init?.headers).get('Authorization')==='Bearer paid-secret')).toBe(true)
    expect(f.session()?.pending).toBeUndefined()
  })
  it('does not retain recovery after a rejected group mutation',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=409
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.select('gpt-6.1-sol',{scope:'settings',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok',catalog:{recoveryRequired:false}})
    await expect(f.service.resolve()).resolves.toMatchObject({model:'gpt-6.1-sol'})
  })
  it('clears a leftover pending record before selecting an already active model',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    expect(f.session()?.pending).toBeDefined()
    f.flags.failRecovery=false
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok',catalog:{recoveryRequired:false}})
    await expect(f.service.resolve()).resolves.toMatchObject({model:'gemini-3.8-flash'})
    expect(f.network.filter(r=>r.url.includes('/group')&&r.init?.method==='POST')).toHaveLength(1)
  })
  it('refreshes cancelled paid connections and clears their pending record without charging another provider',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    f.flags.failRecovery=false;f.flags.next={...f.owner().sync,selectionRevision:5,defaultAccount:'trial:one',connections:f.owner().sync.connections.filter(c=>c.kind==='free')}
    const catalog=await f.service.catalog(true)
    expect(catalog.recoveryRequired).toBe(false);expect(catalog.models.every(m=>m.billing==='free')).toBe(true)
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.select('qwen3.8-flash',{scope:'settings',billing:'free',account:'trial:one'})).resolves.toMatchObject({status:'ok'})
    await expect(f.service.resolve()).resolves.toMatchObject({model:'qwen3.8-flash',connection:{kind:'free'}})
  })
  it('recovers a completed paid group change after an ambiguous response without sending account or posting twice',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502
    const result=await f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})
    expect(result.status).toBe('ok');expect(f.session()?.pending).toBeUndefined()
    const posts=f.network.filter(r=>r.url.includes('/group')&&r.init?.method==='POST')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({group:'Gemini',expectedAccount:'secondary',expectedGroup:'gpt-pro（混池）'})
    expect(f.owner().sync.connections[0].apiKey).toBe('paid-secret')
  })
  it('retains pending recovery and blocks paid execution until refresh verifies the group',async()=>{
    const f=providerFixture();f.flags.groupPostStatus=502;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow()
    await expect(f.service.resolve()).rejects.toThrow('尚未确认')
    expect((await f.service.catalog()).recoveryRequired).toBe(true)
    f.flags.failRecovery=false;await f.service.refresh()
    expect(f.session()?.pending).toBeUndefined()
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).resolves.toMatchObject({status:'ok'})
    expect(f.network.filter(r=>r.url.includes('/group')&&r.init?.method==='POST')).toHaveLength(1)
  })
  it('rejects a refresh that returns after the user has changed and resets only the requested surface',async()=>{
    const f=providerFixture()
    await f.service.select('gpt-6-astra',{scope:'workspace',billing:'quota',account:'secondary'})
    await f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    await f.service.resetBinding('inspiration')
    expect(f.owner().sync.bindings?.inspiration).toBeUndefined();expect(f.owner().sync.bindings?.workspace?.model).toBe('gpt-6-astra')
    const before=structuredClone(f.owner().sync)
    f.flags.changeUserOnRefresh=true;await expect(f.service.refresh()).rejects.toThrow('账号已切换')
    expect(f.owner().username).toBe('bob');expect(f.owner().sync).toEqual(before)
  })
  it('keeps different keys at the same URL and rejects invalid whole collections', () => {
    const f=providerFixture(),sync=f.owner().sync
    expect(sync.connections).toHaveLength(3)
    expect(sync.connections[1].apiKey).not.toBe(sync.connections[2].apiKey)
    expect(()=>parseProviderSnapshot({...sync,defaultAccount:'missing'})).toThrow()
    expect(()=>parseProviderSnapshot({...sync,connections:[sync.connections[0],sync.connections[0]]})).toThrow()
    expect(()=>parseProviderSnapshot({...sync,connections:[{...sync.connections[0],inferenceBaseUrl:'javascript:bad'}]})).toThrow()
  })
  it('independently binds surfaces, uses the right key, and never mutates upstream for free selection',async()=>{
    const f=providerFixture()
    await f.service.select('gpt-6-astra',{scope:'workspace',billing:'quota',account:'secondary'})
    await f.service.select('deepseek-v4.1-flash',{scope:'inspiration',billing:'free',account:'trial:two'})
    const bindings=f.owner().sync.bindings!
    const selected=await Promise.all([f.service.resolve(bindings.workspace),f.service.resolve(bindings.inspiration)])
    expect(selected[0].connection.apiKey).toBe('paid-secret')
    expect(selected[1].connection.apiKey).toBe('free-secret-two')
    expect(f.network.every(r=>!r.init?.method||r.init.method==='GET')).toBe(true)
    expect(f.preferences().model).toBe('gpt-6-astra')
    expect(JSON.stringify(await f.service.catalog())).not.toMatch(/paid-secret|free-secret|session-secret/)
  })
  it('settings clears both bindings and updates the account as well as the model',async()=>{
    const f=providerFixture()
    await f.service.select('deepseek-v4.1-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    await f.service.select('qwen3.8-flash',{scope:'settings',billing:'free',account:'trial:two'})
    expect(f.owner().sync.bindings).toEqual({})
    expect(f.preferences()).toMatchObject({model:'qwen3.8-flash',account:'trial:two',billing:'free'})
  })
  it('refresh removes cancelled providers, preserves bindings and stops requests instead of billing paid',async()=>{
    const f=providerFixture()
    await f.service.select('deepseek-v4.1-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    f.flags.next={...f.owner().sync,selectionRevision:5,connections:f.owner().sync.connections.filter(c=>c.account!=='trial:one')}
    await f.service.refresh()
    expect(f.owner().sync.bindings?.inspiration?.account).toBe('trial:one')
    await expect(f.service.resolve(f.owner().sync.bindings?.inspiration)).rejects.toThrow('已移除')
    expect(f.session()?.owner).toBe(providerOwnerKey(f.owner()))
    const refresh=f.network.find(r=>r.url.includes('credentials=1'))!
    expect(new Headers(refresh.init?.headers).get('Authorization')).toBe('Bearer session-secret')
  })
  it('preserves explicit bindings when defaults change and keys rotate',async()=>{
    const f=providerFixture()
    await f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:one'})
    f.flags.next={...f.owner().sync,defaultAccount:'trial:two',selectionRevision:5,connections:f.owner().sync.connections.map(c=>c.account==='trial:one'?{...c,apiKey:'rotated-secret'}:c)}
    await f.service.refresh()
    expect((await f.service.resolve(f.owner().sync.bindings?.inspiration)).connection.apiKey).toBe('rotated-secret')
    expect(f.preferences().account).toBe('secondary')
  })
  it('protects paid groups and allows a free binding while paid is busy',async()=>{
    const f=providerFixture();f.flags.busy=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'settings',billing:'quota',account:'secondary'})).rejects.toThrow('正在运行')
    await expect(f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:one'})).resolves.toMatchObject({status:'ok'})
    f.flags.busy=false
    const result=await f.service.select('gemini-3.8-flash',{scope:'inspiration',billing:'quota',account:'secondary'})
    expect(result.linkedSelections?.workspace?.model).toBe('gemini-3.8-flash')
    expect(f.owner().sync.bindings?.workspace?.model).toBe('gemini-3.8-flash')
    expect(f.owner().sync.bindings?.inspiration?.model).toBe('gemini-3.8-flash')
  })
  it.each(['workspace','inspiration'] as const)('links the other paid surface on a family change from %s without changing settings defaults',async scope=>{
    const f=providerFixture(),other=scope==='workspace'?'inspiration':'workspace'
    await f.service.select('gpt-6-luna',{scope:other,billing:'quota',account:'secondary'})
    const result=await f.service.select('gemini-3.8-flash',{scope,billing:'quota',account:'secondary'})
    expect(result.linkedSelections?.[other]).toMatchObject({model:'gemini-3.8-flash',reasoningLevel:'auto'})
    expect(f.owner().sync.bindings?.[other]?.model).toBe('gemini-3.8-flash')
    expect(f.preferences().model).toBe('gpt-6-astra')
    expect((await f.service.resolve(f.owner().sync.bindings?.[other])).model).toBe('gemini-3.8-flash')
  })
  it('preserves a free surface and same-family paid choices',async()=>{
    const f=providerFixture()
    await f.service.select('qwen3.8-flash',{scope:'inspiration',billing:'free',account:'trial:two'})
    const result=await f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})
    expect(result.linkedSelections).toBeUndefined()
    expect(f.owner().sync.bindings?.inspiration).toMatchObject({model:'qwen3.8-flash',account:'trial:two',billing:'free'})
    const g=providerFixture()
    await g.service.select('gpt-6-luna',{scope:'inspiration',billing:'quota',account:'secondary'})
    expect((await g.service.select('gpt-6.1-sol',{scope:'workspace',billing:'quota',account:'secondary'})).linkedSelections).toBeUndefined()
    expect(g.owner().sync.bindings?.inspiration?.model).toBe('gpt-6-luna')
  })
  it('keeps both paid choices when a family switch is busy or fails before validation',async()=>{
    const f=providerFixture()
    await f.service.select('gpt-6-luna',{scope:'inspiration',billing:'quota',account:'secondary'})
    const before=structuredClone(f.owner().sync.bindings)
    f.flags.busy=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})).rejects.toThrow('正在运行')
    expect(f.owner().sync.bindings).toEqual(before)
    f.flags.busy=false;f.flags.failRecovery=true
    await expect(f.service.select('gemini-3.8-flash',{scope:'workspace',billing:'quota',account:'secondary'})).rejects.toThrow()
    expect(f.owner().sync.bindings).toEqual(before)
  })
  it('rejects stale revisions and retains saved configuration on persistence failure',async()=>{
    const f=providerFixture(),before=structuredClone(f.owner().sync)
    f.flags.next={...before,selectionRevision:3}
    await expect(f.service.refresh()).rejects.toThrow('旧')
    expect(f.owner().sync).toEqual(before)
    f.flags.next={...before,selectionRevision:5};f.flags.failWrite=true
    await expect(f.service.refresh()).rejects.toThrow()
    expect(f.owner().sync).toEqual(before)
  })
})
