import { expect, it } from 'vitest'
import { gradleRepositoryArguments, isManagedRepositoryFailure } from './gradleRepositoryPolicy'

it('keeps explicit official builds free of managed repository scripts', () => {
  expect(gradleRepositoryArguments('unused', true)).toEqual([])
})
it('allows one original-repository retry for mirror transport or artifact failure, never a Java compile error', () => {
  expect(isManagedRepositoryFailure("Could not GET 'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/example.jar'. Read timed out")).toBe(true)
  expect(isManagedRepositoryFailure("Could not resolve example. Could not HEAD 'https://repo.huaweicloud.com/repository/maven/example.pom'. Received status code 404")).toBe(true)
  expect(isManagedRepositoryFailure('Compilation failed at src/example.java:4')).toBe(false)
  expect(isManagedRepositoryFailure("Could not GET 'https://private.example.invalid/secret'")).toBe(false)
})
