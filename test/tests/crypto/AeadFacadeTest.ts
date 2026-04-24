import o, { assertThrows } from "@tutao/otest"
import { AeadFacade, PADDING_BYTE, SymmetricCipherVersion } from "@tutao/crypto"
import { AeadSubKeys } from "@tutao/crypto/symmetric-key-deriver"
import { aes256RandomKey, INITIALIZATION_VECTOR_LENGTH_BYTES } from "@tutao/crypto/symmetric-cipher-utils"
import { _aes128RandomKey } from "./AesTest.js"
import { CryptoError } from "@tutao/crypto/error"
import { concat } from "@tutao/utils"
import { DEFAULT_BLAKE3_OUTPUT_LENGTH_BYTES } from "@tutao/crypto/blake3"
import { ParsedCiphertextAead, parseVersionedCiphertext } from "../../../src/crypto/encryption/symmetric/decryption/ParsedCiphertext"

o.spec("AeadFacadeTest", function () {
	let aeadFacade: AeadFacade
	let keys: AeadSubKeys
	const associatedData = Uint8Array.from([9, 8, 7, 6])
	const plaintext = Uint8Array.from([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
	const cipherVersion = SymmetricCipherVersion.AeadWithSessionKey
	o.beforeEach(function () {
		aeadFacade = new AeadFacade()
		const encryptionKey = aes256RandomKey()
		const authenticationKey = aes256RandomKey()
		keys = { cipherVersion, encryptionKey, authenticationKey }
	})
	o("encrypt roundtrip success", function () {
		const ciphertext = aeadFacade.encrypt(keys, plaintext, associatedData)
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), ciphertext)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const decrypted = aeadFacade.decrypt(keys, parsedCiphertext, associatedData)
		o(plaintext).deepEquals(decrypted)
	})

	o("encrypt_wrong_key_length", async function () {
		const subKeys = {
			cipherVersion: SymmetricCipherVersion.AeadWithSessionKey,
			encryptionKey: _aes128RandomKey(),
			authenticationKey: keys.authenticationKey,
		}
		const e = await assertThrows(CryptoError, async () => aeadFacade.encrypt(subKeys, plaintext, associatedData))
		o(e.message).equals("Illegal key length: 128 (expected: 256)")
	})

	o("decrypt_wrong_key_length", async function () {
		const subKeys = {
			cipherVersion: SymmetricCipherVersion.AeadWithSessionKey,
			encryptionKey: _aes128RandomKey(),
			authenticationKey: keys.authenticationKey,
		}
		const emptyAd = new Uint8Array()
		const ciphertext = aeadFacade.encrypt(keys, plaintext, emptyAd)
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), ciphertext)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const e = await assertThrows(CryptoError, async () => aeadFacade.decrypt(subKeys, parsedCiphertext, associatedData))
		o(e.message).equals("Illegal key length: 128 (expected: 256)")
	})

	o("decrypt_canonicalization_safe", async function () {
		// we make sure that data is treated differently depending on whether it is part of the associated data or the ciphertext. this ensures a canonical form.
		const taggedCiphertext = aeadFacade.encrypt(keys, plaintext, associatedData)
		const versionedCiphertext = concat(Uint8Array.of(SymmetricCipherVersion.AeadWithSessionKey), taggedCiphertext)
		const wrongVersionedCiphertext = versionedCiphertext.subarray(0, versionedCiphertext.length - 4)
		const wrongAssociatedData = concat(versionedCiphertext.subarray(versionedCiphertext.length - 4), associatedData)
		o(concat(versionedCiphertext, associatedData)).deepEquals(concat(wrongVersionedCiphertext, wrongAssociatedData))
		const parsedWrongCiphertext = parseVersionedCiphertext(wrongVersionedCiphertext) as ParsedCiphertextAead
		const e = await assertThrows(CryptoError, async () => aeadFacade.decrypt(keys, parsedWrongCiphertext, wrongAssociatedData))
		o(e.message).equals("invalid mac")
	})

	o("encrypt_empty_associated_data", async function () {
		const emptyAd = new Uint8Array()
		const ciphertext = aeadFacade.encrypt(keys, plaintext, emptyAd)
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), ciphertext)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const decrypted = aeadFacade.decrypt(keys, parsedCiphertext, emptyAd)
		o(plaintext).deepEquals(decrypted)
	})

	o("encrypt_empty_plaintext", async function () {
		const emptyPlaintext = new Uint8Array()
		const ciphertext = aeadFacade.encrypt(keys, emptyPlaintext, associatedData)
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), ciphertext)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const decrypted = aeadFacade.decrypt(keys, parsedCiphertext, associatedData)
		o(emptyPlaintext).deepEquals(decrypted)
	})

	o("decrypt_with_invalid_associated_data", async function () {
		const wrongAd = Uint8Array.from([2, 3, 4])
		const ciphertext = aeadFacade.encrypt(keys, plaintext, associatedData)
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), ciphertext)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const e = await assertThrows(CryptoError, async () => aeadFacade.decrypt(keys, parsedCiphertext, wrongAd))
		o(e.message).equals("invalid mac")
	})

	o("decrypt_wrong_mac", async function () {
		const ciphertext = aeadFacade.encrypt(keys, plaintext, associatedData)
		ciphertext[ciphertext.length - 1]++
		const versionedCiphertext = concat(Uint8Array.of(cipherVersion), ciphertext)
		const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
		const e = await assertThrows(CryptoError, async () => aeadFacade.decrypt(keys, parsedCiphertext, associatedData))
		o(e.message).equals("invalid mac")
	})

	o("encrypt_adds_padding", async function () {
		const overhead = DEFAULT_BLAKE3_OUTPUT_LENGTH_BYTES + INITIALIZATION_VECTOR_LENGTH_BYTES
		o(aeadFacade.encrypt(keys, Uint8Array.from(""), associatedData).length).equals(4 + overhead)
		o(aeadFacade.encrypt(keys, Uint8Array.from("1"), associatedData).length).equals(4 + overhead)
		o(aeadFacade.encrypt(keys, Uint8Array.from("22"), associatedData).length).equals(4 + overhead)
		o(aeadFacade.encrypt(keys, Uint8Array.from("333"), associatedData).length).equals(4 + overhead)
		o(aeadFacade.encrypt(keys, Uint8Array.from("4444"), associatedData).length).equals(8 + overhead)
		o(aeadFacade.encrypt(keys, Uint8Array.from("55555"), associatedData).length).equals(8 + overhead)
	})

	o.spec("decrypt_detects_wrong_padding", function () {
		let testDecryptionWithInvalidPadding: (plaintext: Uint8Array) => Promise<void>

		o.before(() => {
			testDecryptionWithInvalidPadding = async function (plaintext: Uint8Array) {
				const ciphertext = aeadFacade.encryptInternal(keys, plaintext, associatedData)
				const versionedCiphertext = concat(Uint8Array.of(cipherVersion), ciphertext)
				const parsedCiphertext = parseVersionedCiphertext(versionedCiphertext) as ParsedCiphertextAead
				const e = await assertThrows(CryptoError, async () => {
					aeadFacade.decrypt(keys, parsedCiphertext, associatedData)
				})
				o(e.message).equals("invalid padding")
			}
		})

		o.test("empty_plaintext", async function () {
			await testDecryptionWithInvalidPadding(Uint8Array.from(""))
		})
		o.test("plaintext_without_padding", async function () {
			await testDecryptionWithInvalidPadding(Uint8Array.from("no padding"))
		})
		o.test("plaintext_padded_without_padding_byte", async function () {
			await testDecryptionWithInvalidPadding(Uint8Array.from([1, 2, 0, 0]))
		})
		o.test("plaintext_padded_with_more_than_4_bytes", async function () {
			await testDecryptionWithInvalidPadding(Uint8Array.from([1, 2, 3, PADDING_BYTE, 0, 0, 0, 0]))
		})
	})
})
