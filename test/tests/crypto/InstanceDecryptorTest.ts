import o from "@tutao/otest"
import {
	AeadFacade,
	aes256RandomKey,
	AesCbcFacade,
	AesCbcThenHmacSubKeys,
	InitializationVector,
	MacTag,
	SymmetricCipherFacade,
	SymmetricCipherVersion,
	SymmetricKeyDeriver,
	ValueDecryptor,
} from "@tutao/crypto"
import { matchers, object, verify, when } from "testdouble"
import { AppNameEnum, concat, KeyVersion } from "@tutao/utils"
import { KDF_NONCE_LENGTH_BYTES, validateInitializationVectorLength, validateKdfNonceLength } from "@tutao/crypto/symmetric-cipher-utils"
import { AeadWithGroupKeySubKeys, InstanceTypeId } from "@tutao/crypto/symmetric-key-deriver"

o.spec("InstanceDecryptorTest", () => {
	let symmetricKeyDeriver: SymmetricKeyDeriver
	let symmetricCipherFacade: SymmetricCipherFacade
	let aesCbcFacade: AesCbcFacade
	let aeadFacade: AeadFacade
	let aes256SubKeys: AesCbcThenHmacSubKeys
	let initializationVector: InitializationVector
	let macTag: MacTag
	let aeadGroupKey256SubKeys: AeadWithGroupKeySubKeys
	let instanceTypeId: InstanceTypeId

	o.beforeEach(function () {
		symmetricKeyDeriver = object()
		aesCbcFacade = object()
		aeadFacade = object()
		symmetricCipherFacade = new SymmetricCipherFacade(aesCbcFacade, aeadFacade, symmetricKeyDeriver)
		aes256SubKeys = { cipherVersion: SymmetricCipherVersion.AesCbcThenHmac, encryptionKey: aes256RandomKey(), authenticationKey: aes256RandomKey() }
		initializationVector = validateInitializationVectorLength(new Uint8Array(16))
		macTag = new Uint8Array(32) as MacTag
		aeadGroupKey256SubKeys = {
			cipherVersion: SymmetricCipherVersion.AeadWithGroupKey,
			groupKeyVersion: 0,
			encryptionKey: aes256RandomKey(),
			authenticationKey: aes256RandomKey(),
		}
		instanceTypeId = {
			applicationName: AppNameEnum.Tutanota,
			typeId: 0,
		}
	})

	o.test("Aes sub-keys get cached", () => {
		const cipherVersion = SymmetricCipherVersion.AesCbcThenHmac
		const differentAes256Key = aes256RandomKey()
		when(symmetricKeyDeriver.deriveSubKeys(differentAes256Key, cipherVersion)).thenReturn(aes256SubKeys)
		const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(differentAes256Key, null, instanceTypeId)
		const ciphertext = new Uint8Array()
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), initializationVector, ciphertext, macTag)
		const firstValueDecryptor = instanceDecryptor.getValueDecryptor(versionedCiphertext, "") as ValueDecryptor
		verify(symmetricKeyDeriver.deriveSubKeys(differentAes256Key, cipherVersion), { times: 0 })
		firstValueDecryptor.getValue(differentAes256Key)
		verify(symmetricKeyDeriver.deriveSubKeys(differentAes256Key, cipherVersion), { times: 1 })
		o.check(instanceDecryptor["instanceAesSubKeyCache"].get({ cipherVersion: cipherVersion, aesKey: differentAes256Key })).equals(aes256SubKeys)
		const secondValueDecryptor = instanceDecryptor.getValueDecryptor(versionedCiphertext, "") as ValueDecryptor
		secondValueDecryptor.getValue(differentAes256Key)
		verify(symmetricKeyDeriver.deriveSubKeys(differentAes256Key, cipherVersion), { times: 1 })
	})

	o.test("Aead sub-keys get cached", () => {
		const differentAes256Key = aes256RandomKey()
		const groupKeyVersion = 42 as KeyVersion
		const versionedDifferentAes256Key = { object: differentAes256Key, version: groupKeyVersion }
		const kdfNonce = validateKdfNonceLength(new Uint8Array(KDF_NONCE_LENGTH_BYTES))
		when(symmetricKeyDeriver.deriveSubKeysAeadFromGroupKey(versionedDifferentAes256Key, kdfNonce, matchers.anything())).thenReturn(aeadGroupKey256SubKeys)
		const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(null, kdfNonce, instanceTypeId)
		const keyVersionLengthByte = 0
		const cipherVersion = SymmetricCipherVersion.AeadWithGroupKey
		const ciphertext = new Uint8Array()
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion, keyVersionLengthByte, groupKeyVersion), initializationVector, ciphertext, macTag)
		const firstValueDecryptor = instanceDecryptor.getValueDecryptor(versionedCiphertext, "") as ValueDecryptor
		verify(symmetricKeyDeriver.deriveSubKeysAeadFromGroupKey(versionedDifferentAes256Key, kdfNonce, matchers.anything()), { times: 0 })
		firstValueDecryptor.getValue(differentAes256Key)
		verify(symmetricKeyDeriver.deriveSubKeysAeadFromGroupKey(versionedDifferentAes256Key, kdfNonce, matchers.anything()), { times: 1 })
		o.check(instanceDecryptor["instanceAeadSubKeyCache"].get({ cipherVersion: cipherVersion, aesKey: differentAes256Key })).equals(aeadGroupKey256SubKeys)
		const secondValueDecryptor = instanceDecryptor.getValueDecryptor(versionedCiphertext, "") as ValueDecryptor
		secondValueDecryptor.getValue(differentAes256Key)
		verify(symmetricKeyDeriver.deriveSubKeysAeadFromGroupKey(versionedDifferentAes256Key, kdfNonce, matchers.anything()), { times: 1 })
	})
})
