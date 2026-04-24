import {
	AssociationType,
	AttributeModel,
	Cardinality,
	ClientModelEncryptedParsedInstance,
	ClientModelParsedInstance,
	ClientTypeModel,
	ClientTypeReferenceResolver,
	EncryptedModelValue,
	hasError,
	ModelValue,
	ParsedValue,
	ServerModelEncryptedParsedInstance,
	ServerModelParsedInstance,
	ServerTypeModel,
	ServerTypeReferenceResolver,
	ValueType,
} from "@tutao/typerefs"
import {
	Base64,
	base64ToUint8Array,
	concat,
	KeyVersion,
	lazy,
	Nullable,
	stringToUtf8Uint8Array,
	TypeRef,
	uint8ArrayToBase64,
	utf8Uint8ArrayToString,
} from "@tutao/utils"
import { CryptoError, SessionKeyNotFoundError } from "@tutao/crypto/error"
import {
	AEAD_ATTRIBUTE_ON_UNAUTHENTICATED_INSTANCE_GROUP_KEY_DOMAIN,
	AEAD_ATTRIBUTE_ON_UNAUTHENTICATED_INSTANCE_SESSION_KEY_DOMAIN,
	AeadSubKeys,
	AesKey,
	DomainSeparator,
	InstanceDecryptor,
	MissingSessionKey,
	SymmetricCipherFacade,
	SymmetricCipherVersion,
	VersionedKey,
} from "@tutao/crypto"
import { convertDbToJsType, convertJsToDbType, decompressString, ModelMapper, valueToDefault } from "./ModelMapper.js"
import { isWebClient, ProgrammingError } from "@tutao/app-env"
import { EntityAdapter } from "./EntityAdapter.js"
import { KdfNonce } from "../crypto/encryption/symmetric/SymmetricCipherUtils"
import { SubKeyInfo, SubKeyProvider } from "../crypto/encryption/symmetric/encryption/SubKeyProvider"

import { InstanceTypeId } from "../crypto/encryption/symmetric/SymmetricKeyDeriver"

export interface SymmetricGroupKeyLoader {
	loadSymGroupKey(groupId: Id, requestedVersion: KeyVersion, currentGroupKey?: VersionedKey): Promise<AesKey>
}

export class CryptoMapper {
	constructor(
		private readonly clientTypeReferenceResolver: ClientTypeReferenceResolver,
		private readonly serverTypeReferenceResolver: ServerTypeReferenceResolver | ClientTypeReferenceResolver,
		private readonly symmetricCipherFacade: SymmetricCipherFacade,
		private readonly symGroupKeyLoader: lazy<SymmetricGroupKeyLoader>,
		private readonly modelMapper: ModelMapper,
	) {
		if (isWebClient() && serverTypeReferenceResolver === clientTypeReferenceResolver) {
			throw new ProgrammingError("initializing server type reference resolver with client type reference resolver on webapp is not allowed!")
		}
	}

	async getInputKey(requiredGroupKeyVersion: "none" | KeyVersion, groupId: Nullable<Id>): Promise<Nullable<AesKey>> {
		if (requiredGroupKeyVersion === "none") {
			return null
		}
		if (groupId === null) {
			throw new CryptoError("Cannot load group key. Missing group Id.")
		}
		return this.symGroupKeyLoader().loadSymGroupKey(groupId, requiredGroupKeyVersion)
	}

	public async decryptParsedInstance(
		serverTypeModel: ServerTypeModel | ClientTypeModel,
		encryptedInstance: ServerModelEncryptedParsedInstance,
		sessionKey: Nullable<AesKey>,
		kdfNonce: Nullable<KdfNonce>,
		ownerGroupId: Nullable<Id>,
		fieldPathPrefix: string = "",
	): Promise<ServerModelParsedInstance> {
		const instanceTypeId: InstanceTypeId = {
			applicationName: serverTypeModel.app,
			typeId: serverTypeModel.id,
		}
		const instanceDecryptor = this.symmetricCipherFacade.getInstanceDecryptor(sessionKey, kdfNonce, instanceTypeId)

		return this.decryptParsedInstanceInternal(serverTypeModel, encryptedInstance, instanceDecryptor, ownerGroupId, fieldPathPrefix)
	}

	async decryptParsedInstanceInternal(
		serverTypeModel: ServerTypeModel | ClientTypeModel,
		encryptedInstance: ServerModelEncryptedParsedInstance,
		instanceDecryptor: InstanceDecryptor,
		ownerGroupId: Nullable<Id>,
		fieldPathPrefix: string = "",
	): Promise<ServerModelParsedInstance> {
		const decrypted: ServerModelParsedInstance = {} as ServerModelParsedInstance
		for (const [valueIdStr, valueInfo] of Object.entries(serverTypeModel.values)) {
			const valueId = parseInt(valueIdStr)
			const valueName = valueInfo.name
			const encryptedValue = encryptedInstance[valueId]

			try {
				if (!valueInfo.encrypted) {
					decrypted[valueId] = encryptedValue
				} else {
					const encryptedValueInfo = valueInfo as EncryptedModelValue
					const encryptedString = encryptedValue as Base64
					const fieldPath = `${fieldPathPrefix}${valueInfo.id}`
					decrypted[valueId] = await this.decryptValue(encryptedValueInfo, encryptedString, instanceDecryptor, ownerGroupId, fieldPath)
				}
			} catch (e) {
				if (decrypted._errors == null) {
					decrypted._errors = {}
				}
				decrypted[valueId] = valueToDefault(valueInfo.type)
				if (e instanceof SessionKeyNotFoundError) {
					const skAttrId = AttributeModel.getAttributeId(serverTypeModel, "_ownerEncSessionKey")
					if (skAttrId) {
						decrypted._errors[skAttrId] = "Probably temporary SessionKeyNotFound"
					}
				} else {
					decrypted._errors[valueId] = JSON.stringify(e)
					console.error("error when decrypting value on type:", `[${serverTypeModel.app},${serverTypeModel.name}]`, "valueName:", valueName, e)
				}
			}
		}

		for (const associationId of Object.keys(serverTypeModel.associations).map(Number)) {
			let associationType = serverTypeModel.associations[associationId]
			const encryptedInstanceValue = encryptedInstance[associationId]
			if (associationType.type === AssociationType.Aggregation) {
				const appName = associationType.dependency ?? serverTypeModel.app
				const associationTypeModel = await this.serverTypeReferenceResolver(new TypeRef(appName, associationType.refTypeId))
				const fieldPathPrefixForThisAssociation = `${fieldPathPrefix}${associationId}/`
				const decryptedAggregates = await this.decryptAggregateAssociation(
					associationTypeModel,
					encryptedInstanceValue as Array<ServerModelEncryptedParsedInstance>,
					instanceDecryptor,
					ownerGroupId,
					fieldPathPrefixForThisAssociation,
				)
				decrypted[associationId] = decryptedAggregates
				if (this.containErrors(decryptedAggregates)) {
					// we must propagate up to the top level of the instance that there is an error somewhere in an aggregated type.
					// this indicates to the caller whether decryption succeeded.
					// e.g. in order to decide whether an instance should be cached or not.
					if (decrypted._errors == null) {
						decrypted._errors = {}
					}
					// we cannot leave the object empty here, because empty objects are not consistently treated as errors
					// see the _errors properties in the nested aggregates for more details about the error
					decrypted._errors[associationId] = "Aggregated type decrypted with errors"
				}
			} else {
				decrypted[associationId] = encryptedInstanceValue
			}
		}
		return decrypted
	}

	/**
	 * Returns true if at least one of the instances contains _errors at the top level.
	 * Useful for ATs.
	 */
	public containErrors(instances: ServerModelParsedInstance[]): boolean {
		return instances.some((instance) => hasError(instance))
	}

	/**
	 * Returns an array of the decrypted aggregates, each of which may contain decryption errors.
	 * The caller is responsible for handling the _errors property on each aggregate if it is set.
	 */
	public async decryptAggregateAssociation(
		associationServerTypeModel: ServerTypeModel | ClientTypeModel,
		encryptedInstanceValues: Array<ServerModelEncryptedParsedInstance>,
		instanceDecryptor: InstanceDecryptor,
		ownerGroupId: Nullable<Id>,
		fieldPathPrefix: string,
	): Promise<Array<ServerModelParsedInstance>> {
		const decryptedAggregates: Array<ServerModelParsedInstance> = []
		for (const encryptedAggregate of encryptedInstanceValues) {
			const entityAdapter = await EntityAdapter.from(associationServerTypeModel, encryptedAggregate, this.modelMapper)
			const fieldPathPrefixForThisAssociation = `${fieldPathPrefix}${entityAdapter._id as Id}/`
			const decryptedAggregate = await this.decryptParsedInstanceInternal(
				associationServerTypeModel,
				encryptedAggregate,
				instanceDecryptor,
				ownerGroupId,
				fieldPathPrefixForThisAssociation,
			)
			decryptedAggregates.push(decryptedAggregate)
		}
		return decryptedAggregates
	}

	public async encryptParsedInstance(
		clientTypeModel: ClientTypeModel,
		parsedInstance: ClientModelParsedInstance,
		subKeyInfo: SubKeyInfo | SubKeyProvider,
		fieldPathPrefix: string = "",
	): Promise<ClientModelEncryptedParsedInstance> {
		const encrypted: ClientModelEncryptedParsedInstance = {} as ClientModelEncryptedParsedInstance

		let subKeyProvider: SubKeyProvider
		if (subKeyInfo instanceof SubKeyProvider) {
			subKeyProvider = subKeyInfo
		} else {
			subKeyProvider = this.symmetricCipherFacade.getSubKeyProvider(subKeyInfo, clientTypeModel)
		}

		for (let valueId of Object.keys(clientTypeModel.values).map(Number)) {
			const valueType = clientTypeModel.values[valueId]
			const value = parsedInstance[valueId] as Nullable<ParsedValue>

			let encryptedValue
			if (valueType.encrypted) {
				const fieldPath = `${fieldPathPrefix}${valueId}`
				encryptedValue = this.encryptValue(valueType as EncryptedModelValue, value, subKeyProvider, fieldPath)
			} else {
				encryptedValue = value
			}

			encrypted[valueId] = encryptedValue
		}

		for (const associationId of Object.keys(clientTypeModel.associations).map(Number)) {
			const associationType = clientTypeModel.associations[associationId]
			if (associationType.type === AssociationType.Aggregation) {
				const appName = associationType.dependency ?? clientTypeModel.app
				const aggregateTypeModel = await this.clientTypeReferenceResolver(new TypeRef(appName, associationType.refTypeId))
				const aggregate = parsedInstance[associationId] as Array<ClientModelParsedInstance>
				const fieldPathPrefixForThisAssociation = `${fieldPathPrefix}${associationId}/`
				encrypted[associationId] = await this.encryptAggregateAssociation(
					aggregateTypeModel,
					aggregate,
					subKeyProvider,
					fieldPathPrefixForThisAssociation,
				)
			} else {
				encrypted[associationId] = parsedInstance[associationId]
			}
		}
		return encrypted
	}

	private async encryptAggregateAssociation(
		associationClientTypeModel: ClientTypeModel,
		aggregateValues: Array<ClientModelParsedInstance>,
		subKeyProvider: SubKeyProvider,
		fieldPathPrefix: string,
	): Promise<Array<ClientModelEncryptedParsedInstance>> {
		let encryptedAggregates: Array<ClientModelEncryptedParsedInstance> = []
		for (const aggregate of aggregateValues) {
			const entityAdapter = await EntityAdapter.from(associationClientTypeModel, aggregate, this.modelMapper)
			fieldPathPrefix = `${fieldPathPrefix}${entityAdapter._id as Id}/`
			encryptedAggregates.push(await this.encryptParsedInstance(associationClientTypeModel, aggregate, subKeyProvider, fieldPathPrefix))
		}

		return encryptedAggregates
	}

	async decryptValue(
		valueType: ModelValue & {
			encrypted: true
		},
		value: Nullable<Base64>,
		instanceDecryptor: InstanceDecryptor,
		groupId: Nullable<Id>,
		fieldPath: string,
	): Promise<Nullable<ParsedValue>> {
		if (value == null) {
			return null
		} else if (valueType.cardinality === Cardinality.ZeroOrOne && value === "") {
			// Might happen if cardinality was changed from ZeroOrOne -> One -> ZeroOrOne
			console.warn(`Found an encrypted attribute (${valueType.id}:${valueType.name}) with a Cardinality.ZeroOrOne and an empty value`)
			return null
		} else if (valueType.cardinality === Cardinality.One && value === "") {
			// Migration for values added after the Type has been defined initially
			return valueToDefault(valueType.type)
		}
		const ciphertext = base64ToUint8Array(value)
		const valueDecryptor = instanceDecryptor.getValueDecryptor(ciphertext, fieldPath)
		if (valueDecryptor === MissingSessionKey) {
			throw new SessionKeyNotFoundError("")
		}
		const inputKey = await this.getInputKey(valueDecryptor.requiredGroupKeyVersion, groupId)
		const decryptedBytes = valueDecryptor.getValue(inputKey)

		if (valueType.type === ValueType.Bytes) {
			return decryptedBytes
		} else if (valueType.type === ValueType.CompressedString) {
			return decompressString(decryptedBytes)
		} else {
			return convertDbToJsType(valueType.type, utf8Uint8ArrayToString(decryptedBytes))
		}
	}

	encryptValue(
		valueType: ModelValue & {
			encrypted: true
		},
		value: Nullable<ParsedValue>,
		subKeyProvider: SubKeyProvider,
		fieldPath: string,
	): Nullable<Base64> {
		if (value == null) {
			return null
		}
		const dbValue = convertJsToDbType(valueType.type, value)!
		const bytes = typeof dbValue === "string" ? stringToUtf8Uint8Array(dbValue) : dbValue
		const subKeys = subKeyProvider.getSubKeys()
		let encryptedBytes
		if (subKeys.cipherVersion === SymmetricCipherVersion.AesCbcThenHmac) {
			encryptedBytes = this.symmetricCipherFacade.encryptBytes(subKeys, bytes)
		} else {
			let domainSpecifier: DomainSeparator
			if (subKeys.cipherVersion === SymmetricCipherVersion.AeadWithGroupKey) {
				domainSpecifier = AEAD_ATTRIBUTE_ON_UNAUTHENTICATED_INSTANCE_GROUP_KEY_DOMAIN
			} else {
				domainSpecifier = AEAD_ATTRIBUTE_ON_UNAUTHENTICATED_INSTANCE_SESSION_KEY_DOMAIN
			}
			const associatedData = stringToUtf8Uint8Array(domainSpecifier + fieldPath)
			encryptedBytes = this.symmetricCipherFacade.encryptBytesWithAead(subKeys, bytes, associatedData)
			encryptedBytes = concat(this.taggedCiphertextToVersionedCiphertext(subKeys), encryptedBytes)
		}
		return uint8ArrayToBase64(encryptedBytes)
	}

	private taggedCiphertextToVersionedCiphertext(subKeys: AeadSubKeys): Uint8Array {
		switch (subKeys.cipherVersion) {
			case SymmetricCipherVersion.AeadWithSessionKey:
				return Uint8Array.of(subKeys.cipherVersion)
			case SymmetricCipherVersion.AeadWithGroupKey: {
				const keyVersionLengthByte = 0
				if (subKeys.groupKeyVersion == null) {
					throw new ProgrammingError("AEAD encryption with group key requires a group key version")
				}
				return Uint8Array.of(subKeys.cipherVersion, keyVersionLengthByte, subKeys.groupKeyVersion)
			}
		}
	}
}
