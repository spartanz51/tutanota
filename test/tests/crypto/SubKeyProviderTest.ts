import o, { assertThrows } from "@tutao/otest"
import { aes256RandomKey, KdfNonce, SymmetricCipherVersion, SymmetricKeyDeriver, VersionedKey } from "@tutao/crypto"
import { object } from "testdouble"
import { SubKeyInfo, SubKeyProvider } from "../../../src/crypto/encryption/symmetric/encryption/SubKeyProvider"
import { ClientTypeModel } from "@tutao/typerefs"
import { CryptoError } from "@tutao/crypto/error"
import { generateKdfNonce } from "@tutao/crypto/symmetric-cipher-utils"
import { AppNameEnum } from "@tutao/utils"

o.spec("SubKeyProviderTest", () => {
	let symmetricKeyDeriver: SymmetricKeyDeriver
	let clientTypeModel: ClientTypeModel
	let versionedKey: VersionedKey
	let kdfNonce: KdfNonce

	o.before(() => {
		symmetricKeyDeriver = object()
		clientTypeModel = object()
		clientTypeModel.app = AppNameEnum.Tutanota
		clientTypeModel.name = "name"
		versionedKey = { object: aes256RandomKey(), version: 0 }
		kdfNonce = generateKdfNonce()
	})

	o.test("subKeyInfo must be set when calling getSubKeys", async () => {
		const subKeyInfo: SubKeyInfo = null
		const subKeyProvider: SubKeyProvider = new SubKeyProvider(subKeyInfo, symmetricKeyDeriver, clientTypeModel)
		const e = await assertThrows(CryptoError, async () => {
			subKeyProvider.getSubKeys()
		})
		o.check(e.message).equals("Encrypting tutanota/name requires a cipher version and a key!")
	})

	o.test("AesCbcThenHmac requires a sessionKey", async () => {
		const subKeyInfo: SubKeyInfo = {
			cipherVersion: SymmetricCipherVersion.AesCbcThenHmac,
			sessionKey: null,
		}
		const subKeyProvider: SubKeyProvider = new SubKeyProvider(subKeyInfo, symmetricKeyDeriver, clientTypeModel)
		const e = await assertThrows(CryptoError, async () => {
			subKeyProvider.getSubKeys()
		})
		o.check(e.message).equals("Encrypting tutanota/name requires a session key!")
	})

	o.test("AeadWithGroupKey requires a groupKey", async () => {
		const subKeyInfo: SubKeyInfo = {
			cipherVersion: SymmetricCipherVersion.AeadWithGroupKey,
			groupKey: versionedKey,
			kdfNonce: null,
		}
		const subKeyProvider: SubKeyProvider = new SubKeyProvider(subKeyInfo, symmetricKeyDeriver, clientTypeModel)
		const e = await assertThrows(CryptoError, async () => {
			subKeyProvider.getSubKeys()
		})
		o.check(e.message).equals("Encrypting tutanota/name requires a group key and KDF nonce!")
	})

	o.test("AeadWithGroupKey requires a kdfNonce", async () => {
		const subKeyInfo: SubKeyInfo = {
			cipherVersion: SymmetricCipherVersion.AeadWithGroupKey,
			groupKey: null,
			kdfNonce: kdfNonce,
		}
		const subKeyProvider: SubKeyProvider = new SubKeyProvider(subKeyInfo, symmetricKeyDeriver, clientTypeModel)
		const e = await assertThrows(CryptoError, async () => {
			subKeyProvider.getSubKeys()
		})
		o.check(e.message).equals("Encrypting tutanota/name requires a group key and KDF nonce!")
	})

	o.test("AeadWithSessionKey requires a sessionKey", async () => {
		const subKeyInfo: SubKeyInfo = {
			cipherVersion: SymmetricCipherVersion.AeadWithSessionKey,
			sessionKey: null,
		}
		const subKeyProvider: SubKeyProvider = new SubKeyProvider(subKeyInfo, symmetricKeyDeriver, clientTypeModel)
		const e = await assertThrows(CryptoError, async () => {
			subKeyProvider.getSubKeys()
		})
		o.check(e.message).equals("Encrypting tutanota/name requires a session key!")
	})
})
