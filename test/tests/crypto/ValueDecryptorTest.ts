import {
	InitializationVectorVariant,
	ParsedCiphertextAead,
	ParsedCiphertextAesCbc,
	parseVersionedCiphertext,
} from "../../../src/crypto/encryption/symmetric/decryption/ParsedCiphertext"
import {
	AeadFacade,
	Aes256Key,
	aes256RandomKey,
	AesCbcFacade,
	InitializationVector,
	MacTag,
	MissingSessionKey,
	SymmetricCipherFacade,
	SymmetricCipherVersion,
	SymmetricKeyDeriver,
	ValueDecryptor,
} from "@tutao/crypto"
import { symmetricCipherVersionToUint8Array } from "@tutao/crypto/symmetric-cipher-version"
import { PaddingStandard } from "@tutao/crypto/aes-cbc-facade"
import { matchers, object, when } from "testdouble"
import { AppNameEnum, concat, stringToUtf8Uint8Array } from "@tutao/utils"
import { KDF_NONCE_LENGTH_BYTES, validateInitializationVectorLength, validateKdfNonceLength } from "@tutao/crypto/symmetric-cipher-utils"
import { CryptoError } from "@tutao/crypto/error"
import o, { assertThrows } from "@tutao/otest"
import { InstanceTypeId } from "@tutao/crypto/symmetric-key-deriver"

o.spec("ValueDecryptorTest", () => {
	let symmetricCipherFacade: SymmetricCipherFacade
	let aesCbcFacade: AesCbcFacade
	let aeadFacade: AeadFacade
	let symmetricKeyDeriver: SymmetricKeyDeriver
	let aes256Key: Aes256Key
	let macTag: MacTag
	let initializationVector: InitializationVector
	let instanceTypeId: InstanceTypeId

	o.beforeEach(function () {
		aesCbcFacade = object()
		aeadFacade = object()
		symmetricKeyDeriver = object()
		symmetricCipherFacade = new SymmetricCipherFacade(aesCbcFacade, aeadFacade, symmetricKeyDeriver)
		aes256Key = aes256RandomKey()
		macTag = new Uint8Array(32) as MacTag
		initializationVector = validateInitializationVectorLength(new Uint8Array(16))
		instanceTypeId = {
			applicationName: AppNameEnum.Tutanota,
			typeId: 0,
		}
	})

	o.test("AesCbc, unauthenticated with session key present", () => {
		const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(aes256Key, null, instanceTypeId)
		const parsedCiphertext: ParsedCiphertextAesCbc = {
			cipherVersion: SymmetricCipherVersion.UnusedReservedUnauthenticated,
			initializationVector,
			ciphertext: new Uint8Array([1, 2]),
			initializationVectorVariant: InitializationVectorVariant.Random,
		}
		const ciphertext = concat(symmetricCipherVersionToUint8Array(parsedCiphertext.cipherVersion), initializationVector, parsedCiphertext.ciphertext)
		const valueDecryptor = instanceDecryptor.getValueDecryptor(ciphertext, "") as ValueDecryptor
		o.check(valueDecryptor.requiredGroupKeyVersion).equals("none")
		valueDecryptor.getValue(null)
		const plaintext = stringToUtf8Uint8Array("AesCbc with session key present plaintext")

		when(aesCbcFacade.decrypt(matchers.anything(), parsedCiphertext, PaddingStandard.Pkcs5)).thenReturn(plaintext)
		o.check(valueDecryptor.getValue(aes256Key)).equals(plaintext)
	})

	o.test("AesCbcThenHmac, with session key present", () => {
		const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(aes256Key, null, instanceTypeId)
		const parsedCiphertext: ParsedCiphertextAesCbc = {
			cipherVersion: SymmetricCipherVersion.AesCbcThenHmac,
			initializationVector,
			ciphertext: new Uint8Array([1, 2]),
			macTag,
			initializationVectorVariant: InitializationVectorVariant.Random,
		}
		const ciphertext = concat(symmetricCipherVersionToUint8Array(parsedCiphertext.cipherVersion), initializationVector, parsedCiphertext.ciphertext, macTag)
		const valueDecryptor = instanceDecryptor.getValueDecryptor(ciphertext, "") as ValueDecryptor
		o.check(valueDecryptor.requiredGroupKeyVersion).equals("none")
		valueDecryptor.getValue(null)
		const plaintext = stringToUtf8Uint8Array("AesCbc with session key present plaintext")

		when(aesCbcFacade.decrypt(matchers.anything(), parsedCiphertext, PaddingStandard.Pkcs5)).thenReturn(plaintext)
		o.check(valueDecryptor.getValue(aes256Key)).equals(plaintext)
	})

	o.test("AesCbc with session key missing", () => {
		for (const cipherVersion of [SymmetricCipherVersion.UnusedReservedUnauthenticated, SymmetricCipherVersion.AesCbcThenHmac]) {
			const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(null, null, instanceTypeId)
			const ciphertext = concat(Uint8Array.of(cipherVersion), initializationVector, macTag)
			const valueDecryptor = instanceDecryptor.getValueDecryptor(ciphertext, "")
			o.check(valueDecryptor).equals(MissingSessionKey)
		}
	})

	o.test("AeadWithGroupKey", async () => {
		const kdfNonce = validateKdfNonceLength(new Uint8Array(KDF_NONCE_LENGTH_BYTES))
		const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(null, kdfNonce, instanceTypeId)
		const keyVersionLengthByte = 0
		const groupKeyVersion = 0
		const ciphertext = new Uint8Array()
		const versionedCiphertext = concat(
			Uint8Array.of(SymmetricCipherVersion.AeadWithGroupKey, keyVersionLengthByte, groupKeyVersion),
			initializationVector,
			ciphertext,
			macTag,
		)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const valueDecryptor = instanceDecryptor.getValueDecryptor(versionedCiphertext, "") as ValueDecryptor
		o.check(valueDecryptor.requiredGroupKeyVersion).equals(groupKeyVersion)
		await assertThrows(CryptoError, async () => valueDecryptor.getValue(null))
		const plaintext = stringToUtf8Uint8Array("AeadWithGroupKey plaintext")
		when(aeadFacade.decrypt(matchers.anything(), parsedCiphertext, matchers.anything())).thenReturn(plaintext)
		o.check(valueDecryptor.getValue(aes256Key)).equals(plaintext)
	})

	o.test("AeadWithSessionKey with session key present", () => {
		const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(aes256Key, null, instanceTypeId)
		const cipherVersion = SymmetricCipherVersion.AeadWithSessionKey
		const ciphertext = new Uint8Array()
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), initializationVector, ciphertext, macTag)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const valueDecryptor = instanceDecryptor.getValueDecryptor(versionedCiphertext, "") as ValueDecryptor
		o.check(valueDecryptor.requiredGroupKeyVersion).equals("none")
		valueDecryptor.getValue(null)
		const plaintext = stringToUtf8Uint8Array("AeadWithSessionKey with session key present plaintext")
		when(aeadFacade.decrypt(matchers.anything(), parsedCiphertext, matchers.anything())).thenReturn(plaintext)
		o.check(valueDecryptor.getValue(aes256Key)).equals(plaintext)
	})

	o.test("AeadWithSessionKey with session key missing", () => {
		const instanceDecryptor = symmetricCipherFacade.getInstanceDecryptor(null, null, instanceTypeId)
		const cipherVersion = SymmetricCipherVersion.AeadWithSessionKey
		const ciphertext = new Uint8Array()
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), initializationVector, ciphertext, macTag)
		const valueDecryptor = instanceDecryptor.getValueDecryptor(versionedCiphertext, "")
		o.check(valueDecryptor).equals(MissingSessionKey)
	})
})
