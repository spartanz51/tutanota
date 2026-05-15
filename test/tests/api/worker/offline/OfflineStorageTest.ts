import o, { verify } from "@tutao/otest"
import { OfflineStorage, TableDefinitions } from "../../../../../src/common/api/worker/offline/OfflineStorage.js"
import { instance, matchers, object, when } from "testdouble"
import {
	constructMailSetEntryId,
	deconstructMailSetEntryId,
	elementIdPart,
	Entity,
	listIdPart,
	ServerModelParsedInstance,
	storageTypeRefs,
	sysTypeRefs,
	tutanotaTypeRefs,
	Type as TypeId,
	TypeModelResolver,
} from "@tutao/typerefs"
import { assertNotNull, downcast, getTypeString, typedKeys, TypeRef } from "@tutao/utils"
import { OfflineStorageMigrator } from "../../../../../src/common/api/worker/offline/OfflineStorageMigrator.js"
import { InterWindowEventFacadeSendDispatcher } from "../../../../../src/common/native/common/generatedipc/InterWindowEventFacadeSendDispatcher.js"
import { SqlType } from "../../../../../src/common/api/worker/offline/SqlValue.js"
import { DesktopSqlCipher } from "../../../../../src/common/desktop/db/DesktopSqlCipher.js"
import { clientInitializedTypeModelResolver, createTestEntity, IdGenerator, modelMapperFromTypeModelResolver, removeOriginals } from "../../../TestUtils.js"
import { sql } from "../../../../../src/common/api/worker/offline/Sql.js"
import { CustomCacheHandler, CustomCacheHandlerMap } from "../../../../../src/common/api/worker/rest/cacheHandler/CustomCacheHandler"
import { ModelMapper } from "@tutao/instance-pipeline"
import { SqlCipherFacade } from "../../../../../src/common/native/common/generatedipc/SqlCipherFacade"
import { ApplicationTypesFacade } from "../../../../../src/common/api/worker/facades/ApplicationTypesFacade"
import { OfflineStorageLastProcessedEventBatchStorageFacade } from "../../../../../src/common/api/worker/LastProcessedEventBatchStorageFacade"

function incrementMailSetEntryId(mailSetEntryId, mailId, ms: number) {
	const { receiveDate } = deconstructMailSetEntryId(mailSetEntryId)
	return constructMailSetEntryId(new Date(receiveDate.getTime() + ms), mailId)
}

class MailSetEntryIdGenerator {
	constructor(private currentMailSetEntryId: Id) {}

	getNext(mailId: Id, incrementByMs: number = 60000) {
		this.currentMailSetEntryId = incrementMailSetEntryId(this.currentMailSetEntryId, mailId, incrementByMs)
		return this.currentMailSetEntryId
	}
}

const databasePath = ":memory:"
export const offlineDatabaseTestKey = Uint8Array.from([3957386659, 354339016, 3786337319, 3366334248])

o.spec("OfflineStorageDb", function () {
	const userId = "userId"
	const databaseKey = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])

	let dbFacade: DesktopSqlCipher
	let storage: OfflineStorage
	let migratorMock: OfflineStorageMigrator
	let interWindowEventSenderMock: InterWindowEventFacadeSendDispatcher
	let typeModelResolver: TypeModelResolver
	let modelMapper: ModelMapper
	let customCacheHandlerMap: CustomCacheHandlerMap
	let applicationTypesFacadeMock: ApplicationTypesFacade

	o.beforeEach(async function () {
		// integrity checks do not work with in-memory databases
		dbFacade = new DesktopSqlCipher(databasePath, false)
		applicationTypesFacadeMock = object<ApplicationTypesFacade>()
		migratorMock = instance(OfflineStorageMigrator)
		interWindowEventSenderMock = instance(InterWindowEventFacadeSendDispatcher)
		typeModelResolver = clientInitializedTypeModelResolver()
		modelMapper = modelMapperFromTypeModelResolver(typeModelResolver)
		customCacheHandlerMap = object()

		storage = new OfflineStorage(dbFacade, interWindowEventSenderMock, migratorMock, modelMapper, typeModelResolver, customCacheHandlerMap, {})
	})

	o.afterEach(async function () {
		await dbFacade.closeDb()
	})

	async function toStorableInstance(entity: Entity): Promise<ServerModelParsedInstance> {
		return downcast<ServerModelParsedInstance>(await modelMapper.mapToClientModelParsedInstance(entity._type, entity))
	}

	o.spec("additionalTables", () => {
		let sqlMock: SqlCipherFacade

		o.beforeEach(async () => {
			sqlMock = object()
			// to satisfy the external o.afterEach()
			// we won't actually use this storage instance for these tests, since we don't want to test with real facades
			await storage.init({ userId, databaseKey, forceNewDatabase: false })
		})

		o.test("init calls createTables which initializes all tables", async () => {
			const storageWithMockedSql = new OfflineStorage(sqlMock, object(), object(), object(), object(), object(), {
				some_table: {
					definition: "some statement will be run here",
					purgedWithCache: false,
				},
				another_table: {
					definition: "another statement will be run here",
					purgedWithCache: true,
				},
			})
			await storageWithMockedSql.init({ userId, databaseKey, forceNewDatabase: false })
			verify(sqlMock.run("some statement will be run here", []))
			verify(sqlMock.run("another statement will be run here", []))

			for (const table of typedKeys(TableDefinitions)) {
				verify(
					sqlMock.run(
						matchers.argThat((arg: string) => arg.startsWith(`CREATE TABLE IF NOT EXISTS ${table}`)),
						[],
					),
				)
			}
		})

		o.test("purgeStorage purges all purgeable tables", async () => {
			when(sqlMock.get(matchers.contains("SELECT COUNT(*) as metadata_exists"), matchers.anything())).thenResolve({
				metadata_exists: { type: SqlType.Number, value: 1 },
			})

			const storageWithMockedSql = new OfflineStorage(sqlMock, object(), object(), object(), object(), object(), {
				some_table: {
					definition: "some statement will be run here",
					purgedWithCache: false,
				},
				another_table: {
					definition: "another statement will be run here",
					purgedWithCache: true,
				},
			})
			await storageWithMockedSql.init({ userId, databaseKey, forceNewDatabase: false })
			await storageWithMockedSql.purgeStorage()
			verify(sqlMock.run("DROP TABLE IF EXISTS another_table", []))
			verify(sqlMock.run("DROP TABLE IF EXISTS some_table", []), { times: 0 })

			for (const table of typedKeys(TableDefinitions)) {
				verify(sqlMock.run(`DROP TABLE IF EXISTS ${table}`, []), {
					times: TableDefinitions[table].purgedWithCache ? 1 : 0,
				})
			}
		})

		o.test("purgeStorage calls onBeforePurged", async () => {
			when(sqlMock.get(matchers.contains("SELECT COUNT(*) as metadata_exists"), matchers.anything())).thenResolve({
				metadata_exists: { type: SqlType.Number, value: 1 },
			})

			const storageWithMockedSql = new OfflineStorage(sqlMock, object(), object(), object(), object(), object(), {
				some_table: {
					definition: "some statement will be run here",
					purgedWithCache: false,
					async onBeforePurged(sqlCipherFacade: SqlCipherFacade) {
						sqlCipherFacade.run("onBeforePurged was called", [])
					},
				},
				another_table: {
					definition: "another statement will be run here",
					purgedWithCache: true,
				},
			})
			await storageWithMockedSql.init({ userId, databaseKey, forceNewDatabase: false })
			await storageWithMockedSql.purgeStorage()
			verify(sqlMock.run("onBeforePurged was called", []), { times: 1 })
		})

		o.test("tables are created after migration", async function () {
			when(sqlMock.get(matchers.contains("SELECT COUNT(*) as metadata_exists"), matchers.anything())).thenResolve({
				metadata_exists: { type: SqlType.Number, value: 1 },
			})

			const storageWithMockedSql = new OfflineStorage(sqlMock, object(), object(), object(), object(), object(), {
				some_table: {
					definition: "some statement will be run here",
					purgedWithCache: false,
				},
			})

			when(migratorMock.migrate(storageWithMockedSql, dbFacade)).thenDo(() => {
				verify(sqlMock.run("some statement will be run here", []), { times: 1 })
			})
			await storageWithMockedSql.init({ userId, databaseKey, forceNewDatabase: false })
			verify(sqlMock.run("some statement will be run here", []), { times: 2 })
		})
	})

	o.spec("Unit test", function () {
		async function getAllIdsForType(typeRef: TypeRef<unknown>): Promise<Id[]> {
			const typeModel = await typeModelResolver.resolveClientTypeReference(typeRef)
			let preparedQuery
			switch (typeModel.type) {
				case TypeId.Element.valueOf():
					preparedQuery = sql`select *
                                        from element_entities
                                        where type = ${getTypeString(typeRef)}`
					break
				case TypeId.ListElement.valueOf():
					preparedQuery = sql`select *
                                        from list_entities
                                        where type = ${getTypeString(typeRef)}`
					break
				case TypeId.BlobElement.valueOf():
					preparedQuery = sql`select *
                                        from blob_element_entities
                                        where type = ${getTypeString(typeRef)}`
					break
				default:
					throw new Error("must be a persistent type")
			}
			return (await dbFacade.all(preparedQuery.query, preparedQuery.params)).map((r) => r.elementId.value as Id)
		}

		o.test("migrations are run", async function () {
			await storage.init({ userId, databaseKey, forceNewDatabase: false })
			verify(migratorMock.migrate(storage, dbFacade))
		})

		o.spec("custom cache handlers", function () {
			const userId = "userId1"

			o.beforeEach(async function () {
				await storage.init({ userId, databaseKey, forceNewDatabase: false })
			})

			o.test("put calls the cache handler", async function () {
				const user = createTestEntity(
					sysTypeRefs.UserTypeRef,
					{
						_id: userId,
						_ownerGroup: "ownerGroup",
					},
					{ populateAggregates: true },
				)
				user.userGroup._original = structuredClone(user.userGroup)
				user._original = structuredClone(user)
				const storableUser = await toStorableInstance(user)

				const userCacheHandler: CustomCacheHandler<sysTypeRefs.User> = object()
				when(customCacheHandlerMap.get(sysTypeRefs.UserTypeRef)).thenReturn(userCacheHandler)

				await storage.put(sysTypeRefs.UserTypeRef, storableUser)
				verify(userCacheHandler.onBeforeCacheUpdate?.(user))
			})

			o.test("putMultiple calls the cache handler", async function () {
				const user = createTestEntity(
					sysTypeRefs.UserTypeRef,
					{
						_id: userId,
						_ownerGroup: "ownerGroup",
					},
					{ populateAggregates: true },
				)
				user.userGroup._original = structuredClone(user.userGroup)
				user._original = structuredClone(user)
				const storableUser = await toStorableInstance(user)

				const userCacheHandler: CustomCacheHandler<sysTypeRefs.User> = object()
				when(customCacheHandlerMap.get(sysTypeRefs.UserTypeRef)).thenReturn(userCacheHandler)

				await storage.putMultiple(sysTypeRefs.UserTypeRef, [storableUser])
				verify(userCacheHandler.onBeforeCacheUpdate?.(user))
			})

			o.test("deleteIfExists calls the cache handler", async function () {
				const user = createTestEntity(
					sysTypeRefs.UserTypeRef,
					{
						_id: userId,
						_ownerGroup: "ownerGroup",
					},
					{ populateAggregates: true },
				)
				const storableUser = await toStorableInstance(user)

				const userCacheHandler: CustomCacheHandler<sysTypeRefs.User> = object()
				when(customCacheHandlerMap.get(sysTypeRefs.UserTypeRef)).thenReturn(userCacheHandler)

				await storage.put(sysTypeRefs.UserTypeRef, storableUser)

				await storage.deleteIfExists(sysTypeRefs.UserTypeRef, null, userId)
				verify(userCacheHandler.onBeforeCacheDeletion?.(userId))
			})

			o.spec("deleteAllOfType", function () {
				o.test("calls the cache handler for element types", async function () {
					const user = createTestEntity(
						sysTypeRefs.UserTypeRef,
						{
							_id: userId,
							_ownerGroup: "ownerGroup",
						},
						{ populateAggregates: true },
					)
					const storableUser = await toStorableInstance(user)

					const userCacheHandler: CustomCacheHandler<sysTypeRefs.User> = object()
					when(customCacheHandlerMap.get(sysTypeRefs.UserTypeRef)).thenReturn(userCacheHandler)

					await storage.init({ userId, databaseKey, forceNewDatabase: false })

					await storage.put(sysTypeRefs.UserTypeRef, storableUser)

					await storage.deleteAllOfType(sysTypeRefs.UserTypeRef)
					verify(userCacheHandler.onBeforeCacheDeletion?.(userId))
				})

				o.test("calls the cache handler for list element types", async function () {
					const id: IdTuple = ["listId", "id1"]
					const entityToStore = createTestEntity(
						tutanotaTypeRefs.MailTypeRef,
						{
							_id: id,
							_ownerGroup: "ownerGroup",
						},
						{ populateAggregates: true },
					)
					const storableMail = await toStorableInstance(entityToStore)

					const customCacheHandler: CustomCacheHandler<tutanotaTypeRefs.Mail> = object()
					when(customCacheHandlerMap.get(tutanotaTypeRefs.MailTypeRef)).thenReturn(customCacheHandler)

					await storage.put(tutanotaTypeRefs.MailTypeRef, storableMail)

					await storage.deleteAllOfType(tutanotaTypeRefs.MailTypeRef)
					verify(customCacheHandler.onBeforeCacheDeletion?.(id))
				})

				o.test("calls the cache handler for blob element types", async function () {
					const id: IdTuple = ["listId", "id1"]
					const entityToStore = createTestEntity(
						tutanotaTypeRefs.MailDetailsBlobTypeRef,
						{
							_id: id,
							_ownerGroup: "ownerGroup",
						},
						{ populateAggregates: true },
					)
					const storableDetails = await toStorableInstance(entityToStore)

					const customCacheHandler: CustomCacheHandler<tutanotaTypeRefs.MailDetailsBlob> = object()
					when(customCacheHandlerMap.get(tutanotaTypeRefs.MailDetailsBlobTypeRef)).thenReturn(customCacheHandler)

					await storage.put(tutanotaTypeRefs.MailDetailsBlobTypeRef, storableDetails)

					await storage.deleteAllOfType(tutanotaTypeRefs.MailDetailsBlobTypeRef)
					verify(customCacheHandler.onBeforeCacheDeletion?.(id))
				})
			})

			o.spec("deleteAllOwnedBy", function () {
				const userId = "id1"
				const groupId = "groupId"

				o.test("calls the cache handler for element types", async function () {
					const user = createTestEntity(
						sysTypeRefs.UserTypeRef,
						{
							_id: userId,
							_ownerGroup: groupId,
						},
						{ populateAggregates: true },
					)
					const storableUser = await toStorableInstance(user)

					const userCacheHandler: CustomCacheHandler<sysTypeRefs.User> = object()
					when(customCacheHandlerMap.get(sysTypeRefs.UserTypeRef)).thenReturn(userCacheHandler)

					await storage.put(sysTypeRefs.UserTypeRef, storableUser)

					await storage.deleteAllOwnedBy(groupId)
					verify(userCacheHandler.onBeforeCacheDeletion?.(userId))
				})

				o.test("calls the cache handler for list element types", async function () {
					const id: IdTuple = ["listId", "id1"]
					const entityToStore = createTestEntity(
						tutanotaTypeRefs.MailTypeRef,
						{
							_id: id,
							_ownerGroup: groupId,
						},
						{ populateAggregates: true },
					)
					const storableMail = await toStorableInstance(entityToStore)

					const customCacheHandler: CustomCacheHandler<tutanotaTypeRefs.Mail> = object()
					when(customCacheHandlerMap.get(tutanotaTypeRefs.MailTypeRef)).thenReturn(customCacheHandler)

					await storage.put(tutanotaTypeRefs.MailTypeRef, storableMail)

					await storage.deleteAllOwnedBy(groupId)
					verify(customCacheHandler.onBeforeCacheDeletion?.(id))
				})

				o.test("calls the cache handler for blob element types", async function () {
					const id: IdTuple = ["listId", "id1"]
					const entityToStore = createTestEntity(
						tutanotaTypeRefs.MailDetailsBlobTypeRef,
						{
							_id: id,
							_ownerGroup: groupId,
						},
						{ populateAggregates: true },
					)
					const storableDetailsBlob = await toStorableInstance(entityToStore)

					const customCacheHandler: CustomCacheHandler<tutanotaTypeRefs.MailDetailsBlob> = object()
					when(customCacheHandlerMap.get(tutanotaTypeRefs.MailDetailsBlobTypeRef)).thenReturn(customCacheHandler)

					await storage.put(tutanotaTypeRefs.MailDetailsBlobTypeRef, storableDetailsBlob)

					await storage.deleteAllOwnedBy(groupId)
					verify(customCacheHandler.onBeforeCacheDeletion?.(id))
				})
			})

			o.test("deleteIn calls the cache handler", async function () {
				const id: IdTuple = ["listId", "id1"]
				const entityToStore = createTestEntity(
					tutanotaTypeRefs.MailDetailsBlobTypeRef,
					{
						_id: id,
						_ownerGroup: "ownerGroup",
					},
					{ populateAggregates: true },
				)
				const storableDetailsBlob = await toStorableInstance(entityToStore)

				const customCacheHandler: CustomCacheHandler<tutanotaTypeRefs.MailDetailsBlob> = object()
				when(customCacheHandlerMap.get(tutanotaTypeRefs.MailDetailsBlobTypeRef)).thenReturn(customCacheHandler)

				await storage.put(tutanotaTypeRefs.MailDetailsBlobTypeRef, storableDetailsBlob)

				await storage.deleteIn(tutanotaTypeRefs.MailDetailsBlobTypeRef, "listId", ["id1"])
				verify(customCacheHandler.onBeforeCacheDeletion?.(id))
			})
		})

		o.spec("Offline storage round trip", function () {
			o.spec("ElementType", function () {
				o.test("deleteAllOfType", async function () {
					const userId = "id1"
					const user = createTestEntity(sysTypeRefs.UserTypeRef, {
						_id: userId,
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						userGroup: createTestEntity(sysTypeRefs.GroupMembershipTypeRef, {
							group: "groupId",
							groupInfo: ["groupInfoListId", "groupInfoElementId"],
							groupMember: ["groupMemberListId", "groupMemberElementId"],
						}),
						successfulLogins: "successfulLogins",
						failedLogins: "failedLogins",
						secondFactorAuthentications: "secondFactorAuthentications",
					})
					const storableUser = await toStorableInstance(user)

					await storage.init({ userId, databaseKey, forceNewDatabase: false })

					let storedUser = await storage.get(sysTypeRefs.UserTypeRef, null, userId)
					o.check(storedUser).equals(null)

					await storage.put(sysTypeRefs.UserTypeRef, storableUser)

					storedUser = await storage.get(sysTypeRefs.UserTypeRef, null, userId)
					o.check(storedUser!._id).equals(user._id)

					await storage.deleteAllOfType(sysTypeRefs.UserTypeRef)

					storedUser = await storage.get(sysTypeRefs.UserTypeRef, null, userId)
					o.check(storedUser).equals(null)
				})

				o.test("putMultiple and get", async function () {
					const userId1 = "id1"
					const userId2 = "id2"
					const storableUsers = [
						createTestEntity(sysTypeRefs.UserTypeRef, {
							_id: userId1,
							_ownerGroup: "ownerGroup",
							_permissions: "permissions",
							userGroup: createTestEntity(sysTypeRefs.GroupMembershipTypeRef, {
								group: "groupId",
								groupInfo: ["groupInfoListId", "groupInfoElementId"],
								groupMember: ["groupMemberListId", "groupMemberElementId"],
							}),
							successfulLogins: "successfulLogins",
							failedLogins: "failedLogins",
							secondFactorAuthentications: "secondFactorAuthentications",
						}),
						createTestEntity(sysTypeRefs.UserTypeRef, {
							_id: userId2,
							_ownerGroup: "ownerGroup",
							_permissions: "permissions",
							userGroup: createTestEntity(sysTypeRefs.GroupMembershipTypeRef, {
								group: "groupId",
								groupInfo: ["groupInfoListId", "groupInfoElementId"],
								groupMember: ["groupMemberListId", "groupMemberElementId"],
							}),
							successfulLogins: "successfulLogins",
							failedLogins: "failedLogins",
							secondFactorAuthentications: "secondFactorAuthentications",
						}),
					]

					await storage.init({ userId: userId1, databaseKey, forceNewDatabase: false })

					let storedUsers = [
						await storage.get(sysTypeRefs.UserTypeRef, null, userId1),
						await storage.get(sysTypeRefs.UserTypeRef, null, userId2),
					].filter((u) => u != null)
					o(storedUsers).deepEquals([])

					await storage.putMultiple(sysTypeRefs.UserTypeRef, await Promise.all(storableUsers.map(async (u) => await toStorableInstance(u))))

					storedUsers = [
						assertNotNull(await storage.get(sysTypeRefs.UserTypeRef, null, userId1)),
						assertNotNull(await storage.get(sysTypeRefs.UserTypeRef, null, userId2)),
					]
					o(storedUsers.map(removeOriginals)).deepEquals(storableUsers)
				})
			})

			o.spec("put", function () {
				o.test("when updating element types the rowid is preserved", async function () {
					await storage.init({ userId, databaseKey, forceNewDatabase: false })
					const id = "id1"
					const ownerGroup = "ownerGroup1"

					const entity = tutanotaTypeRefs.createContactList({
						_id: id,
						_ownerGroup: ownerGroup,
						_permissions: "permissions",
						_ownerEncSessionKey: null,
						_ownerKeyVersion: null,
						_kdfNonce: null,
						contacts: "contactsId",
						photos: null,
					})
					await storage.put(tutanotaTypeRefs.ContactListTypeRef, await toStorableInstance(entity))
					const rowIdQuery = sql`SELECT rowid
                                           FROM element_entities
                                           WHERE elementId = ${id}`
					const rowId = (await dbFacade.get(rowIdQuery.query, rowIdQuery.params))?.rowid.value

					await storage.put(tutanotaTypeRefs.ContactListTypeRef, await toStorableInstance(entity))

					const newRowId = (await dbFacade.get(rowIdQuery.query, rowIdQuery.params))?.rowid.value
					o.check(newRowId).equals(rowId)
				})

				o.test("when updating list element types the rowid is preserved", async function () {
					await storage.init({ userId, databaseKey, forceNewDatabase: false })
					const id: IdTuple = ["id1", "idPart2"]
					const ownerGroup = "ownerGroup1"

					const entity = storageTypeRefs.createBlobArchiveRef({
						_id: id,
						_ownerGroup: ownerGroup,
						_permissions: "permissions",
						archive: "archiveId",
					})

					await storage.put(storageTypeRefs.BlobArchiveRefTypeRef, await toStorableInstance(entity))
					const rowIdQuery = sql`SELECT rowid
                                           FROM list_entities
                                           WHERE listId = ${listIdPart(id)}
                                             AND elementId = ${elementIdPart(id)}`
					const rowId = (await dbFacade.get(rowIdQuery.query, rowIdQuery.params))?.rowid.value

					await storage.put(storageTypeRefs.BlobArchiveRefTypeRef, await toStorableInstance(entity))

					const newRowId = (await dbFacade.get(rowIdQuery.query, rowIdQuery.params))?.rowid.value
					o.check(newRowId).equals(rowId)
				})

				o.test("when updating blob element types the rowid is preserved", async function () {
					await storage.init({ userId, databaseKey, forceNewDatabase: false })
					const id: IdTuple = ["id1", "idPart2"]
					const ownerGroup = "ownerGroup1"

					const entity = createTestEntity(tutanotaTypeRefs.MailDetailsBlobTypeRef, {
						_id: id,
						_ownerGroup: ownerGroup,
					})

					await storage.put(tutanotaTypeRefs.MailDetailsBlobTypeRef, await toStorableInstance(entity))
					const rowIdQuery = sql`SELECT rowid
                                           FROM blob_element_entities
                                           WHERE listId = ${listIdPart(id)}
                                             AND elementId = ${elementIdPart(id)}`
					const rowId = (await dbFacade.get(rowIdQuery.query, rowIdQuery.params))?.rowid.value

					await storage.put(tutanotaTypeRefs.MailDetailsBlobTypeRef, await toStorableInstance(entity))

					const newRowId = (await dbFacade.get(rowIdQuery.query, rowIdQuery.params))?.rowid.value
					o.check(newRowId).equals(rowId)
				})
			})

			o.spec("ListElementType generatedId", function () {
				o.test("deleteAllOfType", async function () {
					const listId = "listId1"
					const elementId = "id1"
					const storableMail = await toStorableInstance(
						createTestEntity(tutanotaTypeRefs.MailTypeRef, {
							_id: [listId, elementId],
							_ownerGroup: "ownerGroup",
							_permissions: "permissions",
							sender: createTestEntity(tutanotaTypeRefs.MailAddressTypeRef, {
								name: "some name",
								address: "address@tuta.com",
							}),
							conversationEntry: ["listId", "listElementId"],
						}),
					)

					await storage.init({ userId: elementId, databaseKey, forceNewDatabase: false })

					let mail = await storage.get(tutanotaTypeRefs.MailTypeRef, listId, elementId)
					o.check(mail).equals(null)

					await storage.put(tutanotaTypeRefs.MailTypeRef, storableMail)
					await storage.setNewRangeForList(tutanotaTypeRefs.MailTypeRef, listId, elementId, elementId)

					mail = await storage.get(tutanotaTypeRefs.MailTypeRef, listId, elementId)
					o.check(mail!._id).deepEquals([listId, elementId])
					const rangeBefore = await storage.getRangeForList(tutanotaTypeRefs.MailTypeRef, listId)
					o.check(rangeBefore).deepEquals({ upper: elementId, lower: elementId })
					await storage.deleteAllOfType(tutanotaTypeRefs.MailTypeRef)

					mail = await storage.get(tutanotaTypeRefs.MailTypeRef, listId, elementId)
					o.check(mail).equals(null)
					const rangeAfter = await storage.getRangeForList(tutanotaTypeRefs.MailTypeRef, listId)
					o.check(rangeAfter).equals(null)
				})

				o.test("deleteRange", async function () {
					const listId = "listId1"
					const elementId = "id1"
					const storableMail = await toStorableInstance(
						createTestEntity(tutanotaTypeRefs.MailTypeRef, {
							_id: [listId, elementId],
							_ownerGroup: "ownerGroup",
							_permissions: "permissions",
							sender: createTestEntity(tutanotaTypeRefs.MailAddressTypeRef, {
								name: "some name",
								address: "address@tuta.com",
							}),
							conversationEntry: ["listId", "listElementId"],
						}),
					)

					const otherListId = "listId2"
					const otherElementId = "id2"
					const otherStorableMail = await toStorableInstance(
						createTestEntity(tutanotaTypeRefs.MailTypeRef, {
							_id: [otherListId, otherElementId],
							_ownerGroup: "ownerGroup",
							_permissions: "permissions",
							sender: createTestEntity(tutanotaTypeRefs.MailAddressTypeRef, {
								name: "other name",
								address: "other@tuta.com",
							}),
							conversationEntry: ["listId", "listElementId"],
						}),
					)

					await storage.init({ userId: elementId, databaseKey, forceNewDatabase: false })

					let mail = await storage.get(tutanotaTypeRefs.MailTypeRef, listId, elementId)
					o.check(mail).equals(null)

					await storage.put(tutanotaTypeRefs.MailTypeRef, storableMail)
					await storage.setNewRangeForList(tutanotaTypeRefs.MailTypeRef, listId, elementId, elementId)

					await storage.put(tutanotaTypeRefs.MailTypeRef, otherStorableMail)
					await storage.setNewRangeForList(tutanotaTypeRefs.MailTypeRef, otherListId, otherElementId, otherElementId)

					mail = await storage.get(tutanotaTypeRefs.MailTypeRef, listId, elementId)
					o.check(mail!._id).deepEquals([listId, elementId])
					mail = await storage.get(tutanotaTypeRefs.MailTypeRef, otherListId, otherElementId)
					o.check(mail!._id).deepEquals([otherListId, otherElementId])

					let rangeBefore = await storage.getRangeForList(tutanotaTypeRefs.MailTypeRef, listId)
					o.check(rangeBefore).deepEquals({ upper: elementId, lower: elementId })
					rangeBefore = await storage.getRangeForList(tutanotaTypeRefs.MailTypeRef, otherListId)
					o.check(rangeBefore).deepEquals({ upper: otherElementId, lower: otherElementId })

					await storage.deleteRange(tutanotaTypeRefs.MailTypeRef, listId)

					//Check that entities are still in cache and only range is deleted
					mail = await storage.get(tutanotaTypeRefs.MailTypeRef, listId, elementId)
					o.check(mail!._id).deepEquals([listId, elementId])
					mail = await storage.get(tutanotaTypeRefs.MailTypeRef, otherListId, otherElementId)
					o.check(mail!._id).deepEquals([otherListId, otherElementId])

					let rangeAfter = await storage.getRangeForList(tutanotaTypeRefs.MailTypeRef, listId)
					o.check(rangeAfter).equals(null)
					rangeAfter = await storage.getRangeForList(tutanotaTypeRefs.MailTypeRef, otherListId)
					o.check(rangeAfter).deepEquals({ upper: otherElementId, lower: otherElementId })
				})

				o.test("putMultiple and provideMultiple", async function () {
					const listId = "listId1"
					const elementId1 = "id1"
					const elementId2 = "id2"
					const storableMail1 = createTestEntity(tutanotaTypeRefs.MailTypeRef, {
						_id: [listId, elementId1],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						sender: createTestEntity(tutanotaTypeRefs.MailAddressTypeRef, {
							name: "some name",
							address: "address@tuta.com",
						}),
						conversationEntry: ["listId", "listElementId"],
					})
					const storableMail2 = createTestEntity(tutanotaTypeRefs.MailTypeRef, {
						_id: [listId, elementId2],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						sender: createTestEntity(tutanotaTypeRefs.MailAddressTypeRef, {
							name: "some name",
							address: "address@tuta.com",
						}),
						conversationEntry: ["listId", "listElementId"],
					})

					await storage.init({ userId: elementId1, databaseKey, forceNewDatabase: false })

					let mails = await storage.provideMultiple(tutanotaTypeRefs.MailTypeRef, listId, [elementId1])
					o.check(mails).deepEquals([])

					await storage.putMultiple(tutanotaTypeRefs.MailTypeRef, [await toStorableInstance(storableMail1)])

					mails = await storage.provideMultiple(tutanotaTypeRefs.MailTypeRef, listId, [elementId1, elementId2])
					mails.map(removeOriginals)
					o.check(mails).deepEquals([storableMail1])

					await storage.putMultiple(tutanotaTypeRefs.MailTypeRef, [await toStorableInstance(storableMail2)])

					mails = await storage.provideMultiple(tutanotaTypeRefs.MailTypeRef, listId, [elementId1, elementId2])
					mails.map(removeOriginals)
					o.check(mails).deepEquals([storableMail1, storableMail2])
				})
			})

			o.spec("ListElementType customId", function () {
				o.test("deleteAllOfType", async function () {
					const listId = "listId1"
					const elementId = constructMailSetEntryId(new Date(), "mailId")
					const storableMailSetEntry = createTestEntity(tutanotaTypeRefs.MailSetEntryTypeRef, {
						_id: [listId, elementId],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						mail: ["mailListId", "mailId"],
					})

					await storage.init({ userId: elementId, databaseKey, forceNewDatabase: false })

					let mailSetEntry = await storage.get(tutanotaTypeRefs.MailSetEntryTypeRef, listId, elementId)
					o.check(mailSetEntry).equals(null)

					await storage.put(tutanotaTypeRefs.MailSetEntryTypeRef, await toStorableInstance(storableMailSetEntry))
					await storage.setNewRangeForList(tutanotaTypeRefs.MailSetEntryTypeRef, listId, elementId, elementId)

					mailSetEntry = await storage.get(tutanotaTypeRefs.MailSetEntryTypeRef, listId, elementId)
					o.check(mailSetEntry!._id).deepEquals(storableMailSetEntry._id)
					const rangeBefore = await storage.getRangeForList(tutanotaTypeRefs.MailSetEntryTypeRef, listId)
					o.check(rangeBefore).deepEquals({ upper: elementId, lower: elementId })
					await storage.deleteAllOfType(tutanotaTypeRefs.MailSetEntryTypeRef)

					mailSetEntry = await storage.get(tutanotaTypeRefs.MailSetEntryTypeRef, listId, elementId)
					o.check(mailSetEntry).equals(null)
					const rangeAfter = await storage.getRangeForList(tutanotaTypeRefs.MailSetEntryTypeRef, listId)
					o.check(rangeAfter).equals(null)
				})

				o.test("putMultiple and provideMultiple", async function () {
					const listId = "listId1"
					const elementId1 = constructMailSetEntryId(new Date(1724675875113), "mailId1")
					const elementId2 = constructMailSetEntryId(new Date(1724675899978), "mailId2")
					const storableMailSetEntry1 = createTestEntity(tutanotaTypeRefs.MailSetEntryTypeRef, {
						_id: [listId, elementId1],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						mail: ["mailListId", "mailId"],
					})
					storableMailSetEntry1._original = structuredClone(storableMailSetEntry1)
					const storableMailSetEntry2 = createTestEntity(tutanotaTypeRefs.MailSetEntryTypeRef, {
						_id: [listId, elementId2],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						mail: ["mailListId", "mailId"],
					})
					storableMailSetEntry2._original = structuredClone(storableMailSetEntry2)

					await storage.init({ userId: elementId1, databaseKey, forceNewDatabase: false })

					let mails = await storage.provideMultiple(tutanotaTypeRefs.MailSetEntryTypeRef, listId, [elementId1])
					o.check(mails).deepEquals([])

					await storage.putMultiple(tutanotaTypeRefs.MailSetEntryTypeRef, [await toStorableInstance(storableMailSetEntry1)])

					mails = await storage.provideMultiple(tutanotaTypeRefs.MailSetEntryTypeRef, listId, [elementId1, elementId2])
					o.check(mails).deepEquals([storableMailSetEntry1])

					await storage.putMultiple(tutanotaTypeRefs.MailSetEntryTypeRef, [await toStorableInstance(storableMailSetEntry2)])

					mails = await storage.provideMultiple(tutanotaTypeRefs.MailSetEntryTypeRef, listId, [elementId1, elementId2])
					o.check(mails).deepEquals([storableMailSetEntry1, storableMailSetEntry2])
				})
			})

			o.spec("BlobElementType", function () {
				o.test("put, get and delete", async function () {
					const archiveId = "archiveId"
					const blobElementId = "id1"
					const storableMailDetails = createTestEntity(tutanotaTypeRefs.MailDetailsBlobTypeRef, {
						_id: [archiveId, blobElementId],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						details: createTestEntity(tutanotaTypeRefs.MailDetailsTypeRef, {
							recipients: createTestEntity(tutanotaTypeRefs.RecipientsTypeRef, {}),
							body: createTestEntity(tutanotaTypeRefs.BodyTypeRef, {}),
						}),
					})

					await storage.init({ userId, databaseKey, forceNewDatabase: false })

					let mailDetailsBlob = await storage.get(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, blobElementId)
					o.check(mailDetailsBlob).equals(null)

					await storage.put(tutanotaTypeRefs.MailDetailsBlobTypeRef, await toStorableInstance(storableMailDetails))

					mailDetailsBlob = await storage.get(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, blobElementId)
					removeOriginals(mailDetailsBlob)
					o.check(mailDetailsBlob).deepEquals(storableMailDetails)

					await storage.deleteIfExists(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, blobElementId)

					mailDetailsBlob = await storage.get(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, blobElementId)
					o.check(mailDetailsBlob).equals(null)
				})

				o.test("putMultiple, provideMultiple and deleteIn", async function () {
					const archiveId = "archiveId"
					const blobElementId1 = "id1"
					const blobElementId2 = "id2"
					const storableMailDetails = [
						createTestEntity(tutanotaTypeRefs.MailDetailsBlobTypeRef, {
							_id: [archiveId, blobElementId1],
							_ownerGroup: "ownerGroup",
							_permissions: "permissions",
							details: createTestEntity(tutanotaTypeRefs.MailDetailsTypeRef, {
								recipients: createTestEntity(tutanotaTypeRefs.RecipientsTypeRef, {}),
								body: createTestEntity(tutanotaTypeRefs.BodyTypeRef, {}),
							}),
						}),
						createTestEntity(tutanotaTypeRefs.MailDetailsBlobTypeRef, {
							_id: [archiveId, blobElementId2],
							_ownerGroup: "ownerGroup",
							_permissions: "permissions",
							details: createTestEntity(tutanotaTypeRefs.MailDetailsTypeRef, {
								recipients: createTestEntity(tutanotaTypeRefs.RecipientsTypeRef, {}),
								body: createTestEntity(tutanotaTypeRefs.BodyTypeRef, {}),
							}),
						}),
					]

					await storage.init({ userId, databaseKey, forceNewDatabase: false })

					let mailDetailsBlob = await storage.provideMultiple(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, [blobElementId1, blobElementId2])
					o.check(mailDetailsBlob).deepEquals([])

					await storage.putMultiple(
						tutanotaTypeRefs.MailDetailsBlobTypeRef,
						await Promise.all(storableMailDetails.map(async (smd) => await toStorableInstance(smd))),
					)

					mailDetailsBlob = await storage.provideMultiple(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, [blobElementId1, blobElementId2])
					o.check(mailDetailsBlob.map(removeOriginals)).deepEquals(storableMailDetails)

					await storage.deleteIn(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, [blobElementId1, blobElementId2])

					mailDetailsBlob = await storage.provideMultiple(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, [blobElementId1, blobElementId2])
					o.check(mailDetailsBlob).deepEquals([])
				})

				o.test("put, get and deleteAllOwnedBy", async function () {
					const archiveId = "archiveId"
					const blobElementId = "id1"
					const _ownerGroup = "ownerGroup"
					const storableMailDetails = createTestEntity(tutanotaTypeRefs.MailDetailsBlobTypeRef, {
						_id: [archiveId, blobElementId],
						_ownerGroup,
						_permissions: "permissions",
						details: createTestEntity(tutanotaTypeRefs.MailDetailsTypeRef, {
							recipients: createTestEntity(tutanotaTypeRefs.RecipientsTypeRef, {}),
							body: createTestEntity(tutanotaTypeRefs.BodyTypeRef, {}),
						}),
					})

					await storage.init({ userId, databaseKey, forceNewDatabase: false })

					await storage.put(tutanotaTypeRefs.MailDetailsBlobTypeRef, await toStorableInstance(storableMailDetails))

					await storage.deleteAllOwnedBy(_ownerGroup)

					const mailDetailsBlob = await storage.get(tutanotaTypeRefs.MailDetailsBlobTypeRef, archiveId, blobElementId)
					o.check(mailDetailsBlob).equals(null)
				})
			})
		})
	})

	o.spec("OfflineStorageLastProcessedEventBatchStorageFacade tests", function () {
		let offlineStorageLastProcessedEventBatchStorageFacade: OfflineStorageLastProcessedEventBatchStorageFacade
		const groupId1 = "groupId1"
		const lastProcessedEventBatchId1 = "lastProcessedEventBatchId1"
		o.beforeEach(async function () {
			await storage.init({ userId, databaseKey, forceNewDatabase: false })
			offlineStorageLastProcessedEventBatchStorageFacade = new OfflineStorageLastProcessedEventBatchStorageFacade(dbFacade)
		})
		o.test("getLastEntityEventBatchForGroup roundtrip works", async () => {
			await offlineStorageLastProcessedEventBatchStorageFacade.putLastEntityEventBatchForGroup(groupId1, lastProcessedEventBatchId1)
			const lastProcessedEventBatchIdFromDb = await offlineStorageLastProcessedEventBatchStorageFacade.getLastEntityEventBatchForGroup(groupId1)
			o.check(lastProcessedEventBatchIdFromDb).equals(lastProcessedEventBatchId1)
		})
		o.test("getLastEntityEventBatchForGroup returns null when there is no entry", async () => {
			const lastProcessedEventBatchIdFromDb = await offlineStorageLastProcessedEventBatchStorageFacade.getLastEntityEventBatchForGroup(groupId1)
			o.check(lastProcessedEventBatchIdFromDb).equals(null)
		})
	})

	o.spec("Integration", function () {
		const mailBagMailListId = "mailBagMailListId"

		function createMailList(
			numMails: number,
			idGenerator: IdGenerator,
			mailSetEntryIdGenerator: MailSetEntryIdGenerator,
			getSubject: (i: number) => string,
			getBody: (i: number) => string,
			folder: tutanotaTypeRefs.MailSet,
		): {
			mailSetEntries: Array<tutanotaTypeRefs.MailSetEntry>
			mails: Array<tutanotaTypeRefs.Mail>
			mailDetailsBlobs: Array<tutanotaTypeRefs.MailDetailsBlob>
		} {
			const mailSetEntries: Array<tutanotaTypeRefs.MailSetEntry> = []
			const mails: Array<tutanotaTypeRefs.Mail> = []
			const mailDetailsBlobs: Array<tutanotaTypeRefs.MailDetailsBlob> = []
			for (let i = 0; i < numMails; ++i) {
				const mailId = idGenerator.getNext()
				const mailDetailsId = idGenerator.getNext()
				const mailSetEntryElementId = mailSetEntryIdGenerator.getNext(mailId)
				const mailSetEntryId: IdTuple = [folder.entries, mailSetEntryElementId]
				mailSetEntries.push(
					createTestEntity(tutanotaTypeRefs.MailSetEntryTypeRef, {
						_id: mailSetEntryId,
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						mail: [mailBagMailListId, mailId],
					}),
				)
				mails.push(
					createTestEntity(tutanotaTypeRefs.MailTypeRef, {
						_id: [mailBagMailListId, mailId],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						subject: getSubject(i),
						sets: [folder._id],
						mailDetails: ["detailsListId", mailDetailsId],
						sender: createTestEntity(tutanotaTypeRefs.MailAddressTypeRef, {
							name: "some name",
							address: "address@tuta.com",
						}),
						conversationEntry: ["listId", "listElementId"],
					}),
				)
				mailDetailsBlobs.push(
					createTestEntity(tutanotaTypeRefs.MailDetailsBlobTypeRef, {
						_id: ["detailsListId", mailDetailsId],
						_ownerGroup: "ownerGroup",
						_permissions: "permissions",
						details: createTestEntity(tutanotaTypeRefs.MailDetailsTypeRef, {
							body: createTestEntity(tutanotaTypeRefs.BodyTypeRef, { text: getBody(i) }),
							recipients: createTestEntity(tutanotaTypeRefs.RecipientsTypeRef, {}),
						}),
					}),
				)
			}
			return { mailSetEntries, mails, mailDetailsBlobs }
		}
	})
})
