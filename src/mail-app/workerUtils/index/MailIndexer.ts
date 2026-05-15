import { elementIdPart, entityUpdateUtils, listIdPart, sysTypeRefs, tutanotaTypeRefs } from "@tutao/typerefs"
import { assertNotNull, first } from "@tutao/utils"
import { isDraft } from "../../mail/model/MailChecks"
import { cryptoUtils } from "@tutao/crypto"
import * as restError from "@tutao/rest-client/error"
import { EntityClient } from "../../../common/api/common/EntityClient"
import { MailFacade } from "../../../common/api/worker/facades/lazy/MailFacade"
import { MailWithDetailsAndAttachments } from "./MailIndexerBackend"
import { EntityRestClient } from "../../../common/api/worker/rest/EntityRestClient"

export interface MailIndexer {
	readonly currentIndexTimestamp: number
	readonly mailIndexingEnabled: boolean

	init(user: sysTypeRefs.User): Promise<void>
	processEntityEvents(events: readonly entityUpdateUtils.EntityUpdateData[], groupId: Id, batchId: Id): Promise<void>
	beforeMailDeleted(mailid: IdTuple): Promise<void>
	afterMailDeleted(mailid: IdTuple): Promise<void>
	afterMailCreated(mailid: IdTuple): Promise<void>
	afterMailUpdated(mailid: IdTuple): Promise<void>
	rebuildIndex(user: sysTypeRefs.User): Promise<void>
	extendMailIndex(user: sysTypeRefs.User): Promise<void>
}

/**
 * Shared functionality for downloading new mail data.
 *
 * Note: The mail must be resolvable with its session key.
 */
export async function downloadNewMailData(
	mailId: IdTuple,
	entityClient: EntityClient | EntityRestClient,
	mailFacade: MailFacade,
): Promise<MailWithDetailsAndAttachments | null> {
	try {
		const mail = await entityClient.load(tutanotaTypeRefs.MailTypeRef, mailId)
		// Will be always there, if it was not updated yet, it will still be set by CryptoFacade
		const mailOwnerEncSessionKey = assertNotNull(mail._ownerEncSessionKey)
		let mailDetails: tutanotaTypeRefs.MailDetails
		if (isDraft(mail)) {
			const mailDetailsDraftId = assertNotNull(mail.mailDetailsDraft)
			mailDetails = await entityClient
				.loadMultiple(tutanotaTypeRefs.MailDetailsDraftTypeRef, listIdPart(mailDetailsDraftId), [elementIdPart(mailDetailsDraftId)], async () => ({
					key: mailOwnerEncSessionKey,
					encryptingKeyVersion: cryptoUtils.parseKeyVersion(mail._ownerKeyVersion ?? "0"),
				}))
				.then((d) => {
					const draft = first(d)
					if (draft == null) {
						throw new restError.NotFoundError(`MailDetailsDraft ${mailDetailsDraftId}`)
					}
					return draft.details
				})
		} else {
			const mailDetailsBlobId = assertNotNull(mail.mailDetails)
			mailDetails = await entityClient
				.loadMultiple(tutanotaTypeRefs.MailDetailsBlobTypeRef, listIdPart(mailDetailsBlobId), [elementIdPart(mailDetailsBlobId)], async () => ({
					key: mailOwnerEncSessionKey,
					encryptingKeyVersion: cryptoUtils.parseKeyVersion(mail._ownerKeyVersion ?? "0"),
				}))
				.then((d) => {
					const blob = first(d)
					if (blob == null) {
						throw new restError.NotFoundError(`MailDetailsBlob ${mailDetailsBlobId}`)
					}
					return blob.details
				})
		}
		// we do not use BulkMailLoader here because we actually do want to rely on cache
		const attachments = await mailFacade.loadAttachments(mail)
		return {
			mail,
			mailDetails,
			attachments,
		}
	} catch (e) {
		if (e instanceof restError.NotFoundError) {
			console.log("tried to index non existing mail", mailId)
			return null
		} else if (e instanceof restError.NotAuthorizedError) {
			console.log("tried to index mail without permission", mailId)
			return null
		} else {
			throw e
		}
	}
}
