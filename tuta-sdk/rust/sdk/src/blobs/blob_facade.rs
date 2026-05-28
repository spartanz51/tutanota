use crate::bindings::rest_client;
use crate::bindings::rest_client::HttpMethod::{GET, POST};
use crate::bindings::rest_client::RestClient;
use crate::bindings::rest_client::{RestClientOptions, RestResponse};
use crate::bindings::suspendable_rest_client::SuspensionBehavior;
use crate::blobs::binary_blob_wrapper_serializer::{
	serialize_new_blobs_in_binary_chunks, KeyedNewBlobWrapper, NewBlobWrapper,
	MAX_NUMBER_OF_BLOBS_IN_BINARY,
};
use crate::blobs::blob_access_token_cache::BlobWriteTokenKey;
#[cfg_attr(test, mockall_double::double)]
use crate::blobs::blob_access_token_facade::BlobAccessTokenFacade;
use crate::entities::generated::storage::{BlobGetIn, BlobId, BlobPostOut, BlobServerAccessInfo};
use crate::entities::generated::sys::{Blob, BlobReferenceTokenWrapper};
use crate::entities::Entity;
use crate::instance_mapper::InstanceMapper;
use crate::json_element::RawEntity;
use crate::json_serializer::JsonSerializer;
use crate::rest_error::HttpError;
use crate::tutanota_constants::{
	ArchiveDataType, MAX_BLOB_SERVICE_BYTES, MAX_UNENCRYPTED_BLOB_SIZE_BYTES,
};
use crate::type_model_provider::TypeModelProvider;
use crate::util::BASE64_EXT;
use crate::GeneratedId;
use crate::{crypto, ApiCallError, HeadersProvider, TypeRef};
use base64::Engine;
use crypto::sha256;
use crypto_primitives::aes::Iv;
use crypto_primitives::key::GenericAesKey;
use crypto_primitives::randomizer_facade::RandomizerFacade;
use std::collections::HashMap;
use std::sync::Arc;

const BLOB_SERVICE_REST_PATH: &str = "/rest/storage/blobservice";

#[derive(uniffi::Object)]
pub struct BlobFacade {
	pub(crate) blob_access_token_facade: BlobAccessTokenFacade,
	rest_client: Arc<dyn RestClient>,
	randomizer_facade: RandomizerFacade,
	auth_headers_provider: Arc<HeadersProvider>,
	instance_mapper: Arc<InstanceMapper>,
	json_serializer: Arc<JsonSerializer>,
	type_model_provider: Arc<TypeModelProvider>,
}

#[derive(PartialEq, Debug, Clone)]
pub struct FileData<'a> {
	pub session_key: GenericAesKey,
	pub data: &'a [u8],
}

impl BlobFacade {
	pub(crate) fn new(
		blob_access_token_facade: BlobAccessTokenFacade,
		rest_client: Arc<dyn RestClient>,
		randomizer_facade: RandomizerFacade,
		auth_headers_provider: Arc<HeadersProvider>,
		instance_mapper: Arc<InstanceMapper>,
		json_serializer: Arc<JsonSerializer>,
		type_model_provider: Arc<TypeModelProvider>,
	) -> Self {
		Self {
			blob_access_token_facade,
			rest_client,
			randomizer_facade,
			auth_headers_provider,
			instance_mapper,
			json_serializer,
			type_model_provider,
		}
	}

	/// Load a blob element from a blob server, trying each server URL in order.
	/// On `NotAuthorizedError` (HTTP 403), the token is evicted and the request
	/// is retried once with a fresh token.
	/// Mirrors TS `EntityRestClient.loadMultipleBlobElements()` +
	/// `doBlobRequestWithRetry()` + `tryServers()`.
	pub async fn load_blob_element(
		&self,
		type_ref: &TypeRef,
		archive_id: &GeneratedId,
		element_id: &GeneratedId,
		instance_list_id: &GeneratedId,
	) -> Result<Vec<u8>, ApiCallError> {
		let type_model = self
			.type_model_provider
			.resolve_client_type_ref(type_ref)
			.ok_or_else(|| {
				ApiCallError::internal(format!("type model not found for {}", type_ref))
			})?;
		let path = format!(
			"/rest/{app}/{name}/{list_id}",
			app = type_ref.app,
			name = type_model.name.to_lowercase(),
			list_id = instance_list_id,
		);

		let mut attempt = 0u8;
		loop {
			let access_info = self
				.blob_access_token_facade
				.request_read_token_archive(archive_id)
				.await?;

			let query_params = self.create_read_query_params(
				&access_info.blobAccessToken,
				element_id,
				type_model.version,
			);
			let encoded_query_params = rest_client::encode_query_params(query_params);

			let mut last_retriable_error: Option<ApiCallError> = None;
			let mut got_unauthorized = false;

			for server in &access_info.servers {
				let url = format!("{}{}{}", server.url, path, encoded_query_params);
				let maybe_response = self
					.rest_client
					.request_binary(
						url,
						GET,
						RestClientOptions {
							body: None,
							headers: Default::default(),
							suspension_behavior: None,
						},
					)
					.await;

				match maybe_response {
					Ok(RestResponse {
						status: 200 | 201,
						body,
						..
					}) => {
						return body.ok_or_else(|| {
							ApiCallError::internal("Empty response from blob server".to_owned())
						});
					},
					Ok(RestResponse { status, .. }) => {
						match HttpError::from_http_response(status, &Default::default()) {
							Ok(HttpError::NotAuthorizedError) => {
								got_unauthorized = true;
								break;
							},
							Ok(
								error @ (HttpError::ConnectionError
								| HttpError::InternalServerError
								| HttpError::NotFoundError),
							) => {
								last_retriable_error = Some(error.into());
								continue;
							},
							Ok(error) => return Err(error.into()),
							Err(error) => return Err(error),
						}
					},
					Err(error) => {
						last_retriable_error = Some(error.into());
						continue;
					},
				}
			}

			if got_unauthorized && attempt == 0 {
				self.blob_access_token_facade
					.evict_archive_token(archive_id);
				attempt += 1;
				continue;
			}

			return Err(last_retriable_error.unwrap_or_else(|| {
				if got_unauthorized {
					HttpError::NotAuthorizedError.into()
				} else {
					ApiCallError::InternalSdkError {
						error_message: "no blob servers available".to_owned(),
					}
				}
			}));
		}
	}

	/// Download every blob that makes up the binary content of an entity
	/// (typically a [`crate::entities::generated::tutanota::File`] attachment),
	/// decrypt each blob with the supplied `session_key`, and concatenate the
	/// pieces in the order of `blobs`. Mirrors TS
	/// `BlobFacade.downloadAndDecrypt()` for the common case where all blobs
	/// of one instance share a single archive — which is what file
	/// attachments always look like in practice.
	///
	/// `archive_data_type` is the kind of payload these blobs represent
	/// ([`ArchiveDataType::Attachments`] for files,
	/// [`ArchiveDataType::MailDetails`] for mail bodies). It scopes the read
	/// token request.
	pub async fn download_and_decrypt(
		&self,
		archive_data_type: ArchiveDataType,
		blobs: &[Blob],
		session_key: &GenericAesKey,
	) -> Result<Vec<u8>, ApiCallError> {
		let _ = archive_data_type; // archive token is keyed on archive id only
		if blobs.is_empty() {
			return Ok(Vec::new());
		}

		// Group blobs by archive id — TS does the same because in general
		// nothing prevents an instance's blobs from being spread across
		// archives, even if file attachments don't do that today.
		let mut by_archive: HashMap<&GeneratedId, Vec<&Blob>> = HashMap::new();
		for blob in blobs {
			by_archive.entry(&blob.archiveId).or_default().push(blob);
		}

		let mut encrypted_by_id: HashMap<GeneratedId, Vec<u8>> = HashMap::new();
		for (archive_id, archive_blobs) in by_archive {
			let mut attempt = 0u8;
			let downloaded = loop {
				match self
					.download_blobs_of_one_archive(archive_id, &archive_blobs)
					.await
				{
					Ok(map) => break map,
					Err(ApiCallError::ServerResponseError {
						source: HttpError::NotAuthorizedError,
					}) if attempt == 0 => {
						self.blob_access_token_facade
							.evict_archive_token(archive_id);
						attempt += 1;
						continue;
					},
					Err(e) => return Err(e),
				}
			};
			encrypted_by_id.extend(downloaded);
		}

		let mut out = Vec::new();
		for blob in blobs {
			let encrypted = encrypted_by_id.remove(&blob.blobId).ok_or_else(|| {
				ApiCallError::internal(format!(
					"Server did not return blob {} of archive {}",
					blob.blobId, blob.archiveId
				))
			})?;
			let decrypted = session_key.decrypt_data(&encrypted).map_err(|e| {
				ApiCallError::internal(format!(
					"Failed to decrypt blob {}: {e}",
					blob.blobId
				))
			})?;
			out.extend_from_slice(&decrypted);
		}
		Ok(out)
	}

	/// Download (encrypted) every blob of a single archive in one request,
	/// returning a map from blob id to the still-encrypted bytes. Mirrors
	/// TS `BlobFacade.downloadBlobsOfOneArchive()`. The caller is
	/// responsible for the per-blob decryption.
	async fn download_blobs_of_one_archive(
		&self,
		archive_id: &GeneratedId,
		blobs: &[&Blob],
	) -> Result<HashMap<GeneratedId, Vec<u8>>, ApiCallError> {
		let access_info = self
			.blob_access_token_facade
			.request_read_token_archive(archive_id)
			.await?;

		let blob_get_in = BlobGetIn {
			_format: 0,
			archiveId: archive_id.clone(),
			blobId: None,
			blobIds: blobs
				.iter()
				.map(|b| BlobId {
					_id: None,
					blobId: b.blobId.clone(),
				})
				.collect(),
		};
		let parsed = self
			.instance_mapper
			.serialize_entity(blob_get_in)
			.map_err(|e| {
				ApiCallError::internal(format!("Failed to serialize BlobGetIn: {e}"))
			})?;
		let raw = self
			.json_serializer
			.serialize(&BlobGetIn::type_ref(), parsed)?;
		let body = serde_json::to_vec(&raw).map_err(|e| {
			ApiCallError::internal(format!("Failed to JSON-encode BlobGetIn: {e}"))
		})?;

		let query_params = self.create_query_params_multiple_blobs(access_info.blobAccessToken);
		let encoded = rest_client::encode_query_params(query_params);

		let mut last_error: Option<ApiCallError> = None;
		let mut got_unauthorized = false;
		for server in &access_info.servers {
			let url = format!("{}{}{}", server.url, BLOB_SERVICE_REST_PATH, encoded);
			let response = self
				.rest_client
				.request_binary(
					url,
					GET,
					RestClientOptions {
						body: Some(body.clone()),
						headers: Default::default(),
						suspension_behavior: None,
					},
				)
				.await;

			match response {
				Ok(RestResponse {
					status: 200 | 201,
					body: Some(bytes),
					..
				}) => return parse_multiple_blobs_response(&bytes),
				Ok(RestResponse {
					status: 200 | 201,
					body: None,
					..
				}) => {
					last_error = Some(ApiCallError::internal(
						"Empty 2xx response from blob server".to_owned(),
					));
					continue;
				},
				Ok(RestResponse { status, .. }) => {
					match HttpError::from_http_response(status, &Default::default()) {
						Ok(HttpError::NotAuthorizedError) => {
							got_unauthorized = true;
							break;
						},
						Ok(
							err @ (HttpError::ConnectionError
							| HttpError::InternalServerError
							| HttpError::NotFoundError),
						) => {
							last_error = Some(err.into());
							continue;
						},
						Ok(other) => return Err(other.into()),
						Err(e) => return Err(e),
					}
				},
				Err(e) => {
					last_error = Some(e.into());
					continue;
				},
			}
		}

		if got_unauthorized {
			Err(HttpError::NotAuthorizedError.into())
		} else {
			Err(last_error.unwrap_or_else(|| ApiCallError::InternalSdkError {
				error_message: "no blob servers available".to_owned(),
			}))
		}
	}

	fn create_read_query_params(
		&self,
		blob_access_token: &str,
		element_id: &GeneratedId,
		entity_version: u64,
	) -> Vec<(String, String)> {
		let mut query_params: Vec<(String, String)> = vec![
			("ids".into(), element_id.to_string()),
			("blobAccessToken".into(), blob_access_token.to_owned()),
		];
		let auth_headers = self.auth_headers_provider.provide_headers(entity_version);
		query_params.extend(auth_headers);
		query_params
	}

	/// Encrypt and upload multiple file_data (i.e. files) in minimum amount of requests to
	/// the BlobService. Multiple blobs are serialized into one or more binary chunk(s) using
	/// {@link serialize_new_blobs_in_binary_chunks} and uploaded in less requests.
	/// * A single request may not exceed 10MiB in **request size**
	/// * A single blob (multiple concatenating blobs represent a single file) may not exceed 10MiB in size
	///
	/// @Returns: list of BlobReferenceTokenWrapper per FileData
	///
	/// Note: This method should completely replace {@link encrypt_and_upload_single} in the future.
	///
	/// Examples: "encrypt and upload multiple attachments"
	///
	/// Example 1: [a1: 9MiB, a2: 2MiB, a3: 3MiB] -> [[a1: token1], [a2: token1], [a3: token1]]
	/// * request 1: [a1: 9MiB] -> [a1: token1]
	/// * request 2: [a2: 2MiB, a3: 3MiB] -> [a2: token1, a3: token1]
	///
	/// Example 2: [a1: 13MiB, a2: 2MiB, a3: 3MiB] -> [[a1: token1, a1: token2], [a2:token1], [a3:token1]]
	/// * request 1: [a1.1: 10MiB] -> [a1:token1]
	/// * request 2: [a1.2: 3MiB, a2: 2MiB, a3: 3MiB] -> [a1: token2, a2:token1, a3:token1]
	///
	pub async fn encrypt_and_upload_multiple<'a>(
		&self,
		archive_data_type: ArchiveDataType,
		owner_group_id: &GeneratedId,
		file_data: impl Clone + Iterator<Item = &'a FileData<'a>>,
	) -> Result<Vec<Vec<BlobReferenceTokenWrapper>>, ApiCallError> {
		let mut session_key_to_reference_tokens =
			HashMap::<&GenericAesKey, Vec<BlobReferenceTokenWrapper>>::from_iter(
				file_data
					.clone()
					.map(|wrapper| (&wrapper.session_key, vec![])),
			);

		let keyed_new_blob_wrappers = self.encrypt_multiple_file_data(file_data.clone())?;
		let serialized_binaries = serialize_new_blobs_in_binary_chunks(
			keyed_new_blob_wrappers,
			MAX_BLOB_SERVICE_BYTES,
			MAX_NUMBER_OF_BLOBS_IN_BINARY,
		);
		for serialized_binary in serialized_binaries {
			let binary_slice = serialized_binary.binary.as_slice();
			let result = self
				.upload_multiple_blobs(archive_data_type, owner_group_id, binary_slice)
				.await;
			let blob_reference_tokens = match result {
				// token was probably expired, we're getting a new one and try again.
				Err(ApiCallError::ServerResponseError {
					source: HttpError::NotAuthorizedError,
				}) => {
					self.blob_access_token_facade
						.evict_access_token(&BlobWriteTokenKey::new(
							owner_group_id,
							archive_data_type,
						));
					self.upload_multiple_blobs(archive_data_type, owner_group_id, binary_slice)
						.await?
				},
				Err(err) => return Err(err),
				Ok(tokens) => tokens,
			};

			for (session_key, reference_token) in serialized_binary
				.session_keys
				.iter()
				.zip(blob_reference_tokens.into_iter())
			{
				session_key_to_reference_tokens
					.get_mut(session_key)
					.expect("file session key is missing")
					.push(reference_token);
			}
		}

		let mut reference_tokens_per_file_data: Vec<Vec<BlobReferenceTokenWrapper>> =
			Vec::with_capacity(session_key_to_reference_tokens.len());

		// We need to return our token vectors in the same order we got the file_data
		for file_datum in file_data {
			let reference_tokens = session_key_to_reference_tokens
				.remove(&file_datum.session_key)
				.expect("file session key is missing when sorting reference tokens");
			reference_tokens_per_file_data.push(reference_tokens);
		}

		Ok(reference_tokens_per_file_data)
	}

	pub fn encrypt_multiple_file_data<'a>(
		&self,
		file_data: impl Iterator<Item = &'a FileData<'a>>,
	) -> Result<Vec<KeyedNewBlobWrapper>, ApiCallError> {
		let mut keyed_new_blob_wrappers = Vec::new();
		for file_datum in file_data {
			let blobs = chunk_data(file_datum.data, MAX_UNENCRYPTED_BLOB_SIZE_BYTES);
			for blob in blobs {
				let encrypted_blob = file_datum
					.session_key
					.encrypt_data(blob, Iv::generate(&self.randomizer_facade))
					.map_err(|e| ApiCallError::internal_with_err(e, "Cannot encrypt blob"))?;
				let short_hash: Vec<u8> = sha256(&encrypted_blob).into_iter().take(6).collect();

				keyed_new_blob_wrappers.push(KeyedNewBlobWrapper {
					session_key: file_datum.session_key.clone(),
					new_blob_wrapper: NewBlobWrapper {
						hash: short_hash,
						data: encrypted_blob,
					},
				})
			}
		}

		Ok(keyed_new_blob_wrappers)
	}

	async fn upload_multiple_blobs(
		&self,
		archive_data_type: ArchiveDataType,
		owner_group_id: &GeneratedId,
		serialized_binary: &[u8],
	) -> Result<Vec<BlobReferenceTokenWrapper>, ApiCallError> {
		let BlobServerAccessInfo {
			servers,
			blobAccessToken: blob_access_token,
			..
		} = self
			.blob_access_token_facade
			.request_write_token(archive_data_type, owner_group_id)
			.await?;

		let query_params = self.create_query_params_multiple_blobs(blob_access_token);
		let encoded_query_params = rest_client::encode_query_params(query_params);

		for server in &servers {
			let maybe_response = self
				.rest_client
				.request_binary(
					format!(
						"{}{}{}",
						server.url, BLOB_SERVICE_REST_PATH, encoded_query_params
					),
					POST,
					RestClientOptions {
						headers: Default::default(),
						body: Some(serialized_binary.to_vec()),
						suspension_behavior: Some(SuspensionBehavior::Suspend),
					},
				)
				.await;

			match maybe_response {
				Ok(RestResponse {
					status: 200 | 201,
					body,
					..
				}) => {
					return self.handle_post_response_multiple(body);
				},
				Ok(RestResponse { status, .. }) => {
					match HttpError::from_http_response(status, &Default::default()) {
						// token was expired, we should evict & retry on this server.
						// in these cases, we want to try the next server
						Ok(
							HttpError::ConnectionError
							| HttpError::InternalServerError
							| HttpError::NotFoundError,
						) => continue,
						// other http codes we're not going to bother trying the next server for
						Ok(error) => return Err(error.into()),
						// this case is for unknown http codes and should not happen
						Err(error) => return Err(error),
					}
				},
				// actual network error, we didn't get a response
				Err(error) => return Err(error.into()),
			}
		}

		let formatted_servers_list = servers
			.into_iter()
			.map(|blob_server_url| blob_server_url.url)
			.collect::<Vec<_>>()
			.join(", ");

		Err(ApiCallError::InternalSdkError {
			error_message: format!("no servers to invoke: {}", formatted_servers_list),
		})
	}

	fn handle_post_response_multiple(
		&self,
		body: Option<Vec<u8>>,
	) -> Result<Vec<BlobReferenceTokenWrapper>, ApiCallError> {
		let response_bytes = body.expect("no body");
		let response_entity = serde_json::from_slice::<RawEntity>(response_bytes.as_slice())
			.map_err(|e| ApiCallError::internal_with_err(e, "Failed to serialize instance"))?;
		let output_type_ref = &BlobPostOut::type_ref();
		let parsed_entity = self
			.json_serializer
			.parse(output_type_ref, response_entity)?;

		let blob_post_out = self
			.instance_mapper
			.parse_entity::<BlobPostOut>(parsed_entity)
			.map_err(|error| {
				ApiCallError::internal_with_err(
					error,
					"Failed to parse unencrypted entity into proper types",
				)
			})?;
		Ok(blob_post_out.blobReferenceTokens)
	}

	fn create_query_params_multiple_blobs(
		&self,
		blob_access_token: String,
	) -> Vec<(String, String)> {
		let model_version = self
			.type_model_provider
			.resolve_client_type_ref(&BlobGetIn::type_ref())
			.expect("no type model for BlobGetIn?")
			.version;
		let mut query_params: Vec<(String, String)> =
			vec![("blobAccessToken".into(), blob_access_token)];
		let auth_headers = self.auth_headers_provider.provide_headers(model_version);
		query_params.extend(auth_headers);
		query_params
	}

	async fn encrypt_and_upload_blob_single_legacy(
		&self,
		archive_data_type: ArchiveDataType,
		owner_group_id: &GeneratedId,
		session_key: &GenericAesKey,
		blob: &[u8],
	) -> Result<BlobReferenceTokenWrapper, ApiCallError> {
		let BlobServerAccessInfo {
			servers,
			blobAccessToken: blob_access_token,
			..
		} = self
			.blob_access_token_facade
			.request_write_token(archive_data_type, owner_group_id)
			.await?;

		let encrypted_blob = session_key
			.encrypt_data(blob, Iv::generate(&self.randomizer_facade))
			.map_err(|_e| ApiCallError::internal(String::from("failed to encrypt blob")))?;
		let query_params =
			self.create_query_params_single_blob_legacy(&encrypted_blob, blob_access_token);
		let encoded_query_params = rest_client::encode_query_params(query_params);

		for server in &servers {
			let maybe_response = self
				.rest_client
				.request_binary(
					format!(
						"{}{}{}",
						server.url, BLOB_SERVICE_REST_PATH, encoded_query_params
					),
					POST,
					RestClientOptions {
						headers: Default::default(),
						body: Some(encrypted_blob.clone()),
						suspension_behavior: Some(SuspensionBehavior::Suspend),
					},
				)
				.await;

			match maybe_response {
				Ok(RestResponse {
					status: 200 | 201,
					body,
					..
				}) => {
					return self.handle_post_response_single_legacy(body);
				},
				Ok(RestResponse { status, .. }) => {
					match HttpError::from_http_response(status, &Default::default()) {
						// token was expired, we should evict & retry on this server.
						// in these cases, we want to try the next server
						Ok(
							HttpError::ConnectionError
							| HttpError::InternalServerError
							| HttpError::NotFoundError,
						) => continue,
						// other http codes we're not going to bother trying the next server for
						Ok(error) => return Err(error.into()),
						// this case is for unknown http codes and should not happen
						Err(error) => return Err(error),
					}
				},
				// actual network error, we didn't get a response
				Err(error) => return Err(error.into()),
			}
		}

		let formatted_servers_list = servers
			.into_iter()
			.map(|blob_server_url| blob_server_url.url)
			.collect::<Vec<_>>()
			.join(", ");

		Err(ApiCallError::InternalSdkError {
			error_message: format!("no servers to invoke: {}", formatted_servers_list),
		})
	}

	pub async fn encrypt_and_upload_single_legacy(
		&self,
		archive_data_type: ArchiveDataType,
		owner_group_id: &GeneratedId,
		session_key: &GenericAesKey,
		data: &[u8],
	) -> Result<Vec<BlobReferenceTokenWrapper>, ApiCallError> {
		let blobs = chunk_data(data, MAX_UNENCRYPTED_BLOB_SIZE_BYTES);
		let mut blob_reference_token_wrappers: Vec<BlobReferenceTokenWrapper> =
			Vec::with_capacity(blobs.len());

		for blob in blobs {
			let wrapper_result = self
				.encrypt_and_upload_blob_single_legacy(
					archive_data_type,
					owner_group_id,
					session_key,
					blob,
				)
				.await;
			let wrapper = match wrapper_result {
				// token was probably expired, we're getting a new one and try again.
				Err(ApiCallError::ServerResponseError {
					source: HttpError::NotAuthorizedError,
				}) => {
					self.blob_access_token_facade
						.evict_access_token(&BlobWriteTokenKey::new(
							owner_group_id,
							archive_data_type,
						));
					self.encrypt_and_upload_blob_single_legacy(
						archive_data_type,
						owner_group_id,
						session_key,
						blob,
					)
					.await?
				},
				Err(err) => return Err(err),
				Ok(wrapper) => wrapper,
			};
			blob_reference_token_wrappers.push(wrapper)
		}

		Ok(blob_reference_token_wrappers)
	}

	fn handle_post_response_single_legacy(
		&self,
		body: Option<Vec<u8>>,
	) -> Result<BlobReferenceTokenWrapper, ApiCallError> {
		let response_bytes = body.expect("no body");
		let response_entity = serde_json::from_slice::<RawEntity>(response_bytes.as_slice())
			.map_err(|e| ApiCallError::internal_with_err(e, "Failed to serialize instance"))?;
		let output_type_ref = &BlobPostOut::type_ref();
		let parsed_entity = self
			.json_serializer
			.parse(output_type_ref, response_entity)?;

		let blob_post_out = self
			.instance_mapper
			.parse_entity::<BlobPostOut>(parsed_entity)
			.map_err(|error| {
				ApiCallError::internal_with_err(
					error,
					"Failed to parse unencrypted entity into proper types",
				)
			})?;
		Ok(BlobReferenceTokenWrapper {
			_id: None,
			blobReferenceToken: blob_post_out
				.blobReferenceToken
				.expect("missing blob reference token for blob post single"),
		})
	}

	fn create_query_params_single_blob_legacy(
		&self,
		encrypted_blob: &[u8],
		blob_access_token: String,
	) -> Vec<(String, String)> {
		let short_hash: Vec<u8> = sha256(encrypted_blob).into_iter().take(6).collect();
		let blob_hash_b64 = base64::prelude::BASE64_STANDARD.encode(short_hash.as_slice());
		let model_version = self
			.type_model_provider
			.resolve_client_type_ref(&BlobGetIn::type_ref())
			.expect("no type model for BlobGetIn?")
			.version;
		let mut query_params: Vec<(String, String)> = vec![
			("blobHash".into(), blob_hash_b64),
			("blobAccessToken".into(), blob_access_token),
		];
		let auth_headers = self.auth_headers_provider.provide_headers(model_version);
		query_params.extend(auth_headers);
		query_params
	}
}

/// Parse the binary response of a multi-blob `GET /rest/storage/blobservice`
/// request. Mirrors TS `parseMultipleBlobsResponse`. Wire format:
///
/// ```text
///   [4 bytes: blob count (big-endian i32)]
///   per blob:
///     [9 bytes: blob id (raw bytes, encoded as base64ext for the GeneratedId)]
///     [6 bytes: blob hash — ignored on read]
///     [4 bytes: blob size (big-endian i32)]
///     [`blob size` bytes: encrypted blob payload]
/// ```
pub(crate) fn parse_multiple_blobs_response(
	data: &[u8],
) -> Result<HashMap<GeneratedId, Vec<u8>>, ApiCallError> {
	if data.len() < 4 {
		return Err(ApiCallError::internal(
			"Blob response too short to contain blob count".to_owned(),
		));
	}
	let blob_count = i32::from_be_bytes([data[0], data[1], data[2], data[3]]);
	if blob_count < 0 {
		return Err(ApiCallError::internal(format!(
			"Invalid blob count: {blob_count}"
		)));
	}
	let blob_count = blob_count as usize;
	if blob_count == 0 {
		return Ok(HashMap::new());
	}

	let mut result = HashMap::with_capacity(blob_count);
	let mut offset = 4usize;
	while offset < data.len() {
		if offset + 19 > data.len() {
			return Err(ApiCallError::internal(
				"Blob response truncated inside an entry header".to_owned(),
			));
		}
		let blob_id_bytes = &data[offset..offset + 9];
		let blob_id = GeneratedId(BASE64_EXT.encode(blob_id_bytes));
		// 6-byte hash at offset+9..offset+15 — not used on the read path
		let blob_size = i32::from_be_bytes([
			data[offset + 15],
			data[offset + 16],
			data[offset + 17],
			data[offset + 18],
		]);
		if blob_size < 0 {
			return Err(ApiCallError::internal(format!(
				"Invalid blob size: {blob_size}"
			)));
		}
		let data_start = offset + 19;
		let data_end = data_start + blob_size as usize;
		if data_end > data.len() {
			return Err(ApiCallError::internal(format!(
				"Blob response truncated: declared size {blob_size}, remaining {}",
				data.len() - data_start
			)));
		}
		result.insert(blob_id, data[data_start..data_end].to_vec());
		offset = data_end;
	}
	if result.len() != blob_count {
		return Err(ApiCallError::internal(format!(
			"Blob response declared {blob_count} blob(s) but parsed {}",
			result.len()
		)));
	}
	Ok(result)
}

/// The ".chunks" function returns an empty iterator if the data length
/// is zero, we prefer an iterator with one empty element.
fn chunk_data<'slice>(
	data: &'slice [u8],
	chunk_size: usize,
) -> Box<dyn ExactSizeIterator<Item = &'slice [u8]> + 'slice> {
	if data.is_empty() {
		let empty_slice = &data[..0];
		Box::new(vec![empty_slice].into_iter())
	} else {
		Box::new(data.chunks(chunk_size))
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::bindings::file_client::MockFileClient;
	use crate::bindings::rest_client::RestClientOptions;
	use crate::bindings::rest_client::RestResponse;
	use crate::bindings::rest_client::{encode_query_params, MockRestClient};
	use crate::blobs::binary_blob_wrapper_serializer::deserialize_new_blobs;
	use crate::blobs::blob_access_token_facade::MockBlobAccessTokenFacade;
	use crate::entities::generated::storage::BlobPostOut;
	use crate::entities::generated::storage::{BlobServerAccessInfo, BlobServerUrl};
	use crate::entities::generated::sys::BlobReferenceTokenWrapper;
	use crate::tutanota_constants::ArchiveDataType;
	use crate::type_model_provider::TypeModelProvider;
	use crate::util::test_utils::create_test_entity;
	use crate::CustomId;
	use crate::GeneratedId;
	use crate::HeadersProvider;
	use crate::InstanceMapper;
	use crate::JsonSerializer;
	use crypto_primitives::key::GenericAesKey;
	use crypto_primitives::randomizer_facade::test_util::DeterministicRng;
	use crypto_primitives::randomizer_facade::RandomizerFacade;
	use hyper::Uri;
	use mockall::predicate;
	use std::collections::HashMap;
	use std::sync::Arc;

	fn make_blob_access_token_facade_mock(
		owner_group_id: &GeneratedId,
	) -> MockBlobAccessTokenFacade {
		let blob_access_info = BlobServerAccessInfo {
			blobAccessToken: "123".to_string(),
			servers: Vec::from([BlobServerUrl {
				url: "https://w1.api.tuta.com".to_string(),
				..create_test_entity()
			}]),
			..create_test_entity()
		};
		let mut blob_access_token_facade = MockBlobAccessTokenFacade::default();
		blob_access_token_facade
			.expect_request_write_token()
			.with(
				predicate::eq(ArchiveDataType::Attachments),
				predicate::eq(owner_group_id.clone()),
			)
			.return_const(Ok(blob_access_info));
		blob_access_token_facade
	}

	fn make_blob_service_response(
		expected_reference_tokens: Vec<BlobReferenceTokenWrapper>,
		type_model_provider: &Arc<TypeModelProvider>,
	) -> Vec<u8> {
		let blob_service_response = BlobPostOut {
			blobReferenceTokens: expected_reference_tokens.clone(),
			..create_test_entity()
		};
		let parsed = InstanceMapper::new(type_model_provider.clone())
			.serialize_entity(blob_service_response)
			.unwrap();
		let raw = JsonSerializer::new(type_model_provider.clone())
			.serialize(&BlobPostOut::type_ref(), parsed)
			.unwrap();
		serde_json::to_vec::<RawEntity>(&raw).unwrap()
	}

	fn make_session_key(randomizer_facade: RandomizerFacade) -> GenericAesKey {
		GenericAesKey::from_bytes(
			randomizer_facade
				.generate_random_array::<{ crypto_primitives::aes::AES_256_KEY_SIZE }>()
				.as_slice(),
		)
		.unwrap()
	}

	/// Four attachments which can be easily concatenated into view request efficiently,
	/// leading to a total of 1 requests to the BlobService
	/// [a1: 2 KiB, a2: 2 MiB, a3: 2 KiB, a4: 2 KiB] ->
	/// * request 1: [a1: 2 KiB, a2: 2 MiB, a3: 2 KiB, a4: 2 KiB] -> [a1:token1, a2:token1, a3:token1, a4:token1]
	#[tokio::test]
	async fn encrypt_and_upload_multiple_attachments() {
		let owner_group_id = GeneratedId(String::from("ownerGroupId"));
		let blob_access_token_facade = make_blob_access_token_facade_mock(&owner_group_id);

		let first_attachment: Vec<u8> = vec![0; 2048];
		let second_attachment: Vec<u8> = vec![0; 2 * 1024 * 1024];
		let third_attachment: Vec<u8> = vec![0; 2048];
		let fourth_attachment: Vec<u8> = vec![0; 2048];

		let randomizer_facade1 = RandomizerFacade::from_core(DeterministicRng(1));
		let randomizer_facade2 = RandomizerFacade::from_core(DeterministicRng(2));
		let randomizer_facade3 = RandomizerFacade::from_core(DeterministicRng(3));
		let randomizer_facade4 = RandomizerFacade::from_core(DeterministicRng(4));

		let session_key_first_attachment = make_session_key(randomizer_facade1);
		let session_key_second_attachment = make_session_key(randomizer_facade2);
		let session_key_third_attachment = make_session_key(randomizer_facade3);
		let session_key_fourth_attachment = make_session_key(randomizer_facade4);

		let file_data1 = FileData {
			session_key: session_key_first_attachment,
			data: &first_attachment,
		};
		let file_data2 = FileData {
			session_key: session_key_second_attachment,
			data: &second_attachment,
		};
		let file_data3 = FileData {
			session_key: session_key_third_attachment,
			data: &third_attachment,
		};
		let file_data4 = FileData {
			session_key: session_key_fourth_attachment,
			data: &fourth_attachment,
		};
		let file_data: Vec<&FileData> = vec![&file_data1, &file_data2, &file_data3, &file_data4];

		let first_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "first_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let second_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "first_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let third_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "third_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let fourth_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "second_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};

		let expected_reference_tokens = vec![
			first_attachment_token.clone(),
			second_attachment_token.clone(),
			third_attachment_token.clone(),
			fourth_attachment_token.clone(),
		];

		let type_model_provider = Arc::new(TypeModelProvider::new_test(
			Arc::new(MockRestClient::new()),
			Arc::new(MockFileClient::new()),
			"http://localhost:9000".to_string(),
		));
		let response_binary =
			make_blob_service_response(expected_reference_tokens, &type_model_provider);

		let mut rest_client = MockRestClient::default();
		rest_client
			.expect_request_binary()
			.times(1)
			.withf(move |path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let body = body.clone().unwrap();
				let new_blob_wrappers = deserialize_new_blobs(body).unwrap();
				assert_eq!(new_blob_wrappers.len(), 4);
				true
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(response_binary),
			}));

		let randomizer_facade = RandomizerFacade::from_core(DeterministicRng(42));
		let blob_facade = BlobFacade {
			blob_access_token_facade,
			rest_client: Arc::new(rest_client),
			randomizer_facade: randomizer_facade.clone(),
			auth_headers_provider: Arc::new(HeadersProvider { access_token: None }),
			instance_mapper: Arc::new(InstanceMapper::new(type_model_provider.clone())),
			json_serializer: Arc::new(JsonSerializer::new(Arc::clone(&type_model_provider))),
			type_model_provider,
		};

		let reference_tokens = blob_facade
			.encrypt_and_upload_multiple(
				ArchiveDataType::Attachments,
				&owner_group_id,
				file_data.into_iter(),
			)
			.await
			.unwrap();
		assert_eq!(
			vec![first_attachment_token],
			reference_tokens.first().unwrap().clone()
		);
		assert_eq!(
			vec![second_attachment_token],
			reference_tokens.get(1).unwrap().clone()
		);
		assert_eq!(
			vec![third_attachment_token],
			reference_tokens.get(2).unwrap().clone()
		);
		assert_eq!(
			vec![fourth_attachment_token],
			reference_tokens.get(3).unwrap().clone()
		);
	}

	/// Four attachments (including one large) which can be easily concatenated into view request efficiently,
	/// leading to a total of 2 requests to the BlobService
	/// [a1: 12 MiB, a2: 2 MiB, a3: 2 MiB, a4: 2 MiB] ->
	/// * request 1: [a1.1: 10MiB] -> [a1:token1]
	/// * request 2: [a1.2: 2MiB, a2: 2 MiB, a3: 2 MiB, a4: 2 MiB] -> [a1:token2, a2:token1, a3:token1, a4:token1]
	#[tokio::test]
	async fn encrypt_and_upload_multiple_attachments_including_one_large() {
		let owner_group_id = GeneratedId(String::from("ownerGroupId"));
		let blob_access_token_facade = make_blob_access_token_facade_mock(&owner_group_id);

		let first_attachment: Vec<u8> = vec![0; 12 * 1024 * 1024];
		let second_attachment: Vec<u8> = vec![0; 2 * 1024 * 1024];
		let third_attachment: Vec<u8> = vec![0; 2 * 1024 * 1024];
		let fourth_attachment: Vec<u8> = vec![0; 1024 * 1024];

		let randomizer_facade1 = RandomizerFacade::from_core(DeterministicRng(1));
		let randomizer_facade2 = RandomizerFacade::from_core(DeterministicRng(2));
		let randomizer_facade3 = RandomizerFacade::from_core(DeterministicRng(3));
		let randomizer_facade4 = RandomizerFacade::from_core(DeterministicRng(4));

		let session_key_first_attachment = make_session_key(randomizer_facade1);
		let session_key_second_attachment = make_session_key(randomizer_facade2);
		let session_key_third_attachment = make_session_key(randomizer_facade3);
		let session_key_fourth_attachment = make_session_key(randomizer_facade4);

		let file_data1 = FileData {
			session_key: session_key_first_attachment,
			data: &first_attachment,
		};
		let file_data2 = FileData {
			session_key: session_key_second_attachment,
			data: &second_attachment,
		};
		let file_data3 = FileData {
			session_key: session_key_third_attachment,
			data: &third_attachment,
		};
		let file_data4 = FileData {
			session_key: session_key_fourth_attachment,
			data: &fourth_attachment,
		};
		let file_data: Vec<&FileData> = vec![&file_data1, &file_data2, &file_data3, &file_data4];

		let first_attachment_first_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "first_attachment_token1".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let first_attachment_second_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "first_attachment_token2".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let second_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "second_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let third_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "third_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let fourth_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "fourth_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};

		let expected_reference_tokens1 = vec![first_attachment_first_token.clone()];
		let expected_reference_tokens2 = vec![
			first_attachment_second_token.clone(),
			second_attachment_token.clone(),
			third_attachment_token.clone(),
			fourth_attachment_token.clone(),
		];
		let type_model_provider = Arc::new(TypeModelProvider::new_test(
			Arc::new(MockRestClient::new()),
			Arc::new(MockFileClient::new()),
			"http://localhost:9000".to_string(),
		));
		let binary1: Vec<u8> =
			make_blob_service_response(expected_reference_tokens1, &type_model_provider);
		let binary2: Vec<u8> =
			make_blob_service_response(expected_reference_tokens2, &type_model_provider);

		let mut rest_client = MockRestClient::default();
		// first request
		rest_client
			.expect_request_binary()
			.withf(move |path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let body = body.clone().unwrap();
				let new_blob_wrappers = deserialize_new_blobs(body).unwrap();
				new_blob_wrappers.len() == 1
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(binary1),
			}));

		// second request
		rest_client
			.expect_request_binary()
			.withf(move |path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let body = body.clone().unwrap();
				let new_blob_wrappers = deserialize_new_blobs(body).unwrap();
				new_blob_wrappers.len() == 4
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(binary2),
			}));

		let randomizer_facade = RandomizerFacade::from_core(DeterministicRng(42));
		let blob_facade = BlobFacade {
			blob_access_token_facade,
			rest_client: Arc::new(rest_client),
			randomizer_facade: randomizer_facade.clone(),
			auth_headers_provider: Arc::new(HeadersProvider { access_token: None }),
			instance_mapper: Arc::new(InstanceMapper::new(type_model_provider.clone())),
			json_serializer: Arc::new(JsonSerializer::new(Arc::clone(&type_model_provider))),
			type_model_provider,
		};

		let reference_tokens = blob_facade
			.encrypt_and_upload_multiple(
				ArchiveDataType::Attachments,
				&owner_group_id,
				file_data.into_iter(),
			)
			.await
			.unwrap();
		assert_eq!(
			vec![first_attachment_first_token, first_attachment_second_token],
			reference_tokens.first().unwrap().clone()
		);
		assert_eq!(
			vec![second_attachment_token,],
			reference_tokens.get(1).unwrap().clone()
		);
		assert_eq!(
			vec![third_attachment_token,],
			reference_tokens.get(2).unwrap().clone()
		);
		assert_eq!(
			vec![fourth_attachment_token,],
			reference_tokens.get(3).unwrap().clone()
		);
	}

	/// Three attachments which **cannot** be easily concatenated into view request efficiently,
	/// leading to a total of 4 requests to the BlobService
	/// [a1: 14 MiB, a2: 9 MiB, a3: 2 MiB] ->
	/// * request 1: [a1.1: 10MiB] -> [a1:token1]
	/// * request 2: [a1.2: 4MiB] -> [a1:token2]
	/// * request 3: [a2: 9MiB] -> [a2:token1]
	/// * request 4: [a3: 2MiB] -> [a3:token1]
	#[tokio::test]
	async fn encrypt_and_upload_multiple_attachments_worst_case() {
		let owner_group_id = GeneratedId(String::from("ownerGroupId"));
		let blob_access_token_facade = make_blob_access_token_facade_mock(&owner_group_id);

		let first_attachment: Vec<u8> = vec![0; 14 * 1024 * 1024];
		let second_attachment: Vec<u8> = vec![0; 9 * 1024 * 1024];
		let third_attachment: Vec<u8> = vec![0; 2 * 1024 * 1024];

		let randomizer_facade1 = RandomizerFacade::from_core(DeterministicRng(1));
		let randomizer_facade2 = RandomizerFacade::from_core(DeterministicRng(2));
		let randomizer_facade3 = RandomizerFacade::from_core(DeterministicRng(3));

		let session_key_first_attachment = make_session_key(randomizer_facade1);
		let session_key_second_attachment = make_session_key(randomizer_facade2);
		let session_key_third_attachment = make_session_key(randomizer_facade3);

		let file_data1 = FileData {
			session_key: session_key_first_attachment,
			data: &first_attachment,
		};
		let file_data2 = FileData {
			session_key: session_key_second_attachment,
			data: &second_attachment,
		};
		let file_data3 = FileData {
			session_key: session_key_third_attachment,
			data: &third_attachment.clone(),
		};

		let file_data: Vec<&FileData> = vec![&file_data1, &file_data2, &file_data3];

		let first_attachment_first_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "first_attachment_token1".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let first_attachment_second_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "first_attachment_token2".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let second_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "second_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};
		let third_attachment_token = BlobReferenceTokenWrapper {
			blobReferenceToken: "third_attachment_token".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		};

		// expected reference tokens for requests 1,2,3 and 4
		let expected_reference_tokens1 = vec![first_attachment_first_token.clone()];
		let expected_reference_tokens2 = vec![first_attachment_second_token.clone()];
		let expected_reference_tokens3 = vec![second_attachment_token.clone()];
		let expected_reference_tokens4 = vec![third_attachment_token.clone()];

		let type_model_provider = Arc::new(TypeModelProvider::new_test(
			Arc::new(MockRestClient::new()),
			Arc::new(MockFileClient::new()),
			"http://localhost:9000".to_string(),
		));
		let binary1: Vec<u8> =
			make_blob_service_response(expected_reference_tokens1, &type_model_provider);
		let binary2: Vec<u8> =
			make_blob_service_response(expected_reference_tokens2, &type_model_provider);
		let binary3: Vec<u8> =
			make_blob_service_response(expected_reference_tokens3, &type_model_provider);
		let binary4: Vec<u8> =
			make_blob_service_response(expected_reference_tokens4, &type_model_provider);

		let mut rest_client = MockRestClient::default();

		// first request
		rest_client
			.expect_request_binary()
			.withf(move |path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let body = body.clone().unwrap();
				let new_blob_wrappers = deserialize_new_blobs(body).unwrap();
				// account for 65 byte encryption overhead per blob
				new_blob_wrappers.first().unwrap().data.len()
					== MAX_UNENCRYPTED_BLOB_SIZE_BYTES + 65
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(binary1),
			}));

		// second request (first attachment second part)
		rest_client
			.expect_request_binary()
			.withf(|path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let body = body.clone().unwrap();
				let new_blob_wrappers = deserialize_new_blobs(body).unwrap();
				// account for 65 byte encryption overhead per blob
				new_blob_wrappers.first().unwrap().data.len() == 4 * 1024 * 1024 + 65
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(binary2),
			}));

		// third request (second attachment)
		let second_attachment_clone = second_attachment.clone();
		rest_client
			.expect_request_binary()
			.withf(move |path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let body = body.clone().unwrap();
				let new_blob_wrappers = deserialize_new_blobs(body).unwrap();
				// account for 65 byte encryption overhead per blob
				new_blob_wrappers.first().unwrap().data.len() == second_attachment_clone.len() + 65
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(binary3),
			}));

		// fourth request (third attachment)
		rest_client
			.expect_request_binary()
			.withf(move |path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let body = body.clone().unwrap();
				let new_blob_wrappers = deserialize_new_blobs(body).unwrap();
				// account for 65 byte encryption overhead per blob
				new_blob_wrappers.first().unwrap().data.len() == third_attachment.clone().len() + 65
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(binary4),
			}));

		let randomizer_facade = RandomizerFacade::from_core(DeterministicRng(42));
		let blob_facade = BlobFacade {
			blob_access_token_facade,
			rest_client: Arc::new(rest_client),
			randomizer_facade: randomizer_facade.clone(),
			auth_headers_provider: Arc::new(HeadersProvider { access_token: None }),
			instance_mapper: Arc::new(InstanceMapper::new(type_model_provider.clone())),
			json_serializer: Arc::new(JsonSerializer::new(Arc::clone(&type_model_provider))),
			type_model_provider,
		};

		let reference_tokens = blob_facade
			.encrypt_and_upload_multiple(
				ArchiveDataType::Attachments,
				&owner_group_id,
				file_data.into_iter(),
			)
			.await
			.unwrap();
		assert_eq!(
			vec![first_attachment_first_token, first_attachment_second_token],
			reference_tokens.first().unwrap().clone()
		);
		assert_eq!(
			vec![second_attachment_token,],
			reference_tokens.get(1).unwrap().clone()
		);
		assert_eq!(
			vec![third_attachment_token,],
			reference_tokens.get(2).unwrap().clone()
		);
	}

	#[tokio::test]
	async fn encrypt_and_upload_single_blob_legacy() {
		let owner_group_id = GeneratedId(String::from("ownerGroupId"));
		let blob_access_token_facade = make_blob_access_token_facade_mock(&owner_group_id);

		let blob_data: Vec<u8> = Vec::from([1, 2, 3]);
		let randomizer_facade1 = RandomizerFacade::from_core(DeterministicRng(1));
		let session_key = make_session_key(randomizer_facade1);

		let blob_data_matcher = blob_data.clone();
		let session_key_matcher = session_key.clone();

		let expected_reference_tokens = vec![BlobReferenceTokenWrapper {
			blobReferenceToken: "blobRefToken".to_string(),
			_id: Some(CustomId("hello_aggregate".to_owned())),
		}];

		let type_model_provider = Arc::new(TypeModelProvider::new_test(
			Arc::new(MockRestClient::new()),
			Arc::new(MockFileClient::new()),
			"http://localhost:9000".to_string(),
		));
		let blob_service_response = BlobPostOut {
			blobReferenceToken: Some(expected_reference_tokens[0].blobReferenceToken.clone()),
			..create_test_entity()
		};
		let parsed = InstanceMapper::new(type_model_provider.clone())
			.serialize_entity(blob_service_response)
			.unwrap();
		let raw = JsonSerializer::new(type_model_provider.clone())
			.serialize(&BlobPostOut::type_ref(), parsed)
			.unwrap();
		let binary: Vec<u8> = serde_json::to_vec::<RawEntity>(&raw).unwrap();

		let mut rest_client = MockRestClient::default();
		rest_client
			.expect_request_binary()
			.withf(move |path, method, options| {
				let uri = path.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert_eq!(BLOB_SERVICE_REST_PATH, uri.path_and_query().unwrap().path());
				assert_eq!(&POST, method);
				let RestClientOptions { body, .. } = options;
				let decrypted_body = body.clone().unwrap();
				let decrypted_body = session_key_matcher
					.decrypt_data(decrypted_body.as_slice())
					.unwrap();
				assert_eq!(blob_data_matcher, decrypted_body);
				true
			})
			.return_const(Ok(RestResponse {
				status: 200,
				headers: HashMap::new(),
				body: Some(binary),
			}));

		let randomizer_facade = RandomizerFacade::from_core(DeterministicRng(42));
		let blob_facade = BlobFacade {
			blob_access_token_facade,
			rest_client: Arc::new(rest_client),
			randomizer_facade: randomizer_facade.clone(),
			auth_headers_provider: Arc::new(HeadersProvider { access_token: None }),
			instance_mapper: Arc::new(InstanceMapper::new(type_model_provider.clone())),
			json_serializer: Arc::new(JsonSerializer::new(Arc::clone(&type_model_provider))),
			type_model_provider,
		};

		let reference_tokens = blob_facade
			.encrypt_and_upload_single_legacy(
				ArchiveDataType::Attachments,
				&owner_group_id,
				&session_key,
				&blob_data,
			)
			.await
			.unwrap();
		assert_eq!(
			expected_reference_tokens
				.into_iter()
				.map(|rt| BlobReferenceTokenWrapper {
					_id: None,
					blobReferenceToken: rt.blobReferenceToken
				})
				.collect::<Vec<_>>(),
			reference_tokens
		);
	}

	fn make_read_token_mock(archive_id: GeneratedId, token: &str) -> MockBlobAccessTokenFacade {
		let blob_access_info = BlobServerAccessInfo {
			blobAccessToken: token.to_string(),
			servers: vec![BlobServerUrl {
				url: "https://w1.api.tuta.com".to_string(),
				..create_test_entity()
			}],
			..create_test_entity()
		};
		let mut facade = MockBlobAccessTokenFacade::default();
		facade
			.expect_request_read_token_archive()
			.with(predicate::eq(archive_id))
			.return_once(move |_| Ok(blob_access_info));
		facade
	}

	#[tokio::test]
	async fn load_blob_element_success() {
		let archive_id = GeneratedId("archId".to_owned());
		let element_id = GeneratedId("elemId".to_owned());
		let expected_body = b"decrypted blob data".to_vec();

		let mut mock_token = make_read_token_mock(archive_id.clone(), "accessToken123");
		mock_token.expect_evict_archive_token().never();

		let expected_body_clone = expected_body.clone();
		let list_id_check = archive_id.clone();
		let element_id_check = element_id.clone();
		let mut rest_client = MockRestClient::default();
		rest_client
			.expect_request_binary()
			.times(1)
			.withf(move |url, method, _opts| {
				let uri = url.parse::<Uri>().unwrap();
				assert_eq!("w1.api.tuta.com", uri.host().unwrap());
				assert!(
					uri.path().contains(&format!("/maildetailsblob/{list_id_check}")),
					"path should contain list_id, got: {}",
					uri.path()
				);
				let query = uri.query().unwrap_or("");
				assert!(
					query.contains(&format!("ids={element_id_check}")),
					"query should contain ids param, got: {query}"
				);
				assert!(
					query.contains("blobAccessToken=accessToken123"),
					"query should contain blobAccessToken, got: {query}"
				);
				assert_eq!(&GET, method);
				true
			})
			.return_once(move |_, _, _| {
				Ok(RestResponse {
					status: 200,
					headers: HashMap::new(),
					body: Some(expected_body_clone),
				})
			});

		let type_model_provider = Arc::new(TypeModelProvider::new_test(
			Arc::new(MockRestClient::new()),
			Arc::new(MockFileClient::new()),
			"http://localhost:9000".to_string(),
		));
		let blob_facade = BlobFacade {
			blob_access_token_facade: mock_token,
			rest_client: Arc::new(rest_client),
			randomizer_facade: RandomizerFacade::from_core(DeterministicRng(42)),
			auth_headers_provider: Arc::new(HeadersProvider { access_token: None }),
			instance_mapper: Arc::new(InstanceMapper::new(type_model_provider.clone())),
			json_serializer: Arc::new(JsonSerializer::new(type_model_provider.clone())),
			type_model_provider,
		};

		use crate::entities::generated::tutanota::MailDetailsBlob;
		let result = blob_facade
			.load_blob_element(&MailDetailsBlob::type_ref(), &archive_id, &element_id, &archive_id)
			.await
			.expect("should succeed");
		assert_eq!(expected_body, result);
	}

	#[tokio::test]
	async fn load_blob_element_retries_on_403() {
		let archive_id = GeneratedId("archId".to_owned());
		let element_id = GeneratedId("elemId".to_owned());
		let expected_body = b"retry succeeded".to_vec();

		// first token returns 403, second succeeds
		let access_info_first = BlobServerAccessInfo {
			blobAccessToken: "expiredToken".to_string(),
			servers: vec![BlobServerUrl {
				url: "https://w1.api.tuta.com".to_string(),
				..create_test_entity()
			}],
			..create_test_entity()
		};
		let access_info_second = BlobServerAccessInfo {
			blobAccessToken: "freshToken".to_string(),
			servers: vec![BlobServerUrl {
				url: "https://w1.api.tuta.com".to_string(),
				..create_test_entity()
			}],
			..create_test_entity()
		};

		let mut mock_token = MockBlobAccessTokenFacade::default();
		mock_token
			.expect_request_read_token_archive()
			.times(1)
			.with(predicate::eq(archive_id.clone()))
			.return_once(move |_| Ok(access_info_first));
		mock_token
			.expect_request_read_token_archive()
			.times(1)
			.with(predicate::eq(archive_id.clone()))
			.return_once(move |_| Ok(access_info_second));
		mock_token
			.expect_evict_archive_token()
			.times(1)
			.with(predicate::eq(archive_id.clone()))
			.return_const(());

		let expected_body_clone = expected_body.clone();
		let mut rest_client = MockRestClient::default();
		// First request: 403 (NotAuthorizedError)
		rest_client
			.expect_request_binary()
			.times(1)
			.withf(|url, _, _| url.contains("expiredToken"))
			.return_once(|_, _, _| {
				Ok(RestResponse {
					status: 403,
					headers: HashMap::new(),
					body: None,
				})
			});
		// Second request (after retry): 200
		rest_client
			.expect_request_binary()
			.times(1)
			.withf(|url, _, _| url.contains("freshToken"))
			.return_once(move |_, _, _| {
				Ok(RestResponse {
					status: 200,
					headers: HashMap::new(),
					body: Some(expected_body_clone),
				})
			});

		let type_model_provider = Arc::new(TypeModelProvider::new_test(
			Arc::new(MockRestClient::new()),
			Arc::new(MockFileClient::new()),
			"http://localhost:9000".to_string(),
		));
		let blob_facade = BlobFacade {
			blob_access_token_facade: mock_token,
			rest_client: Arc::new(rest_client),
			randomizer_facade: RandomizerFacade::from_core(DeterministicRng(42)),
			auth_headers_provider: Arc::new(HeadersProvider { access_token: None }),
			instance_mapper: Arc::new(InstanceMapper::new(type_model_provider.clone())),
			json_serializer: Arc::new(JsonSerializer::new(type_model_provider.clone())),
			type_model_provider,
		};

		use crate::entities::generated::tutanota::MailDetailsBlob;
		let result = blob_facade
			.load_blob_element(&MailDetailsBlob::type_ref(), &archive_id, &element_id, &archive_id)
			.await
			.expect("should succeed after retry");
		assert_eq!(expected_body, result);
	}

	#[tokio::test]
	async fn load_blob_element_returns_server_error_without_retry() {
		// When all servers return retriable errors (Connection/InternalServer/NotFound)
		// without a 403, the original error is returned without retrying — matching TS
		// `tryServers` which throws the last error, and `doBlobRequestWithRetry` which
		// only retries on `NotAuthorizedError`.
		let archive_id = GeneratedId("archId".to_owned());
		let element_id = GeneratedId("elemId".to_owned());

		let mut mock_token = make_read_token_mock(archive_id.clone(), "token");
		// Critical: token must NOT be evicted, retry must NOT happen.
		mock_token.expect_evict_archive_token().never();

		let mut rest_client = MockRestClient::default();
		rest_client
			.expect_request_binary()
			.times(1)
			.return_once(|_, _, _| {
				Ok(RestResponse {
					status: 500,
					headers: HashMap::new(),
					body: None,
				})
			});

		let type_model_provider = Arc::new(TypeModelProvider::new_test(
			Arc::new(MockRestClient::new()),
			Arc::new(MockFileClient::new()),
			"http://localhost:9000".to_string(),
		));
		let blob_facade = BlobFacade {
			blob_access_token_facade: mock_token,
			rest_client: Arc::new(rest_client),
			randomizer_facade: RandomizerFacade::from_core(DeterministicRng(42)),
			auth_headers_provider: Arc::new(HeadersProvider { access_token: None }),
			instance_mapper: Arc::new(InstanceMapper::new(type_model_provider.clone())),
			json_serializer: Arc::new(JsonSerializer::new(type_model_provider.clone())),
			type_model_provider,
		};

		use crate::entities::generated::tutanota::MailDetailsBlob;
		let err = blob_facade
			.load_blob_element(&MailDetailsBlob::type_ref(), &archive_id, &element_id, &archive_id)
			.await
			.expect_err("should return error");

		match err {
			ApiCallError::ServerResponseError {
				source: HttpError::InternalServerError,
			} => {},
			other => panic!("expected InternalServerError, got: {other:?}"),
		}
	}

	#[test]
	fn encode_query_params_works() {
		assert_eq!("", encode_query_params([("", ""); 0]));
		assert_eq!("", encode_query_params([("", "b"), ("c", "")]));
		assert_eq!("?c=d+d+d", encode_query_params([("", "b"), ("c", "d d d")]));
		assert_eq!(
			"?%26%25%3D_%3A=%26%25%3D_%3A%3F",
			encode_query_params([("&%=_:", "&%=_:?")])
		);

		// vec as input
		assert_eq!("?a=b", encode_query_params(vec![("a", "b")]));

		// owned keys
		assert_eq!(
			"?c=d",
			encode_query_params([("".to_owned(), "b"), ("c".to_owned(), "d")])
		);

		// byte array values
		assert_eq!("?a=b&c=d", encode_query_params([("a", b"b"), ("c", b"d")]));

		// a hash map as input
		assert_eq!("", encode_query_params(HashMap::<String, &[u8]>::default()))
	}

	/// Helper for the parser tests: lays out one entry's worth of bytes in
	/// the exact wire format we expect from the blob server.
	fn make_blob_entry(blob_id_bytes: [u8; 9], data: &[u8]) -> Vec<u8> {
		let mut buf = Vec::with_capacity(19 + data.len());
		buf.extend_from_slice(&blob_id_bytes);
		buf.extend_from_slice(&[0u8; 6]); // 6-byte hash, unused on read
		buf.extend_from_slice(&(data.len() as i32).to_be_bytes());
		buf.extend_from_slice(data);
		buf
	}

	#[test]
	fn parse_multiple_blobs_response_empty() {
		let mut data = Vec::new();
		data.extend_from_slice(&0i32.to_be_bytes());
		let result = parse_multiple_blobs_response(&data).unwrap();
		assert!(result.is_empty());
	}

	#[test]
	fn parse_multiple_blobs_response_single() {
		let mut data = Vec::new();
		data.extend_from_slice(&1i32.to_be_bytes());
		let payload = b"hello blob world";
		data.extend_from_slice(&make_blob_entry([1, 2, 3, 4, 5, 6, 7, 8, 9], payload));
		let result = parse_multiple_blobs_response(&data).unwrap();
		assert_eq!(result.len(), 1);
		let id = GeneratedId(BASE64_EXT.encode([1u8, 2, 3, 4, 5, 6, 7, 8, 9]));
		assert_eq!(result.get(&id).unwrap().as_slice(), payload);
	}

	#[test]
	fn parse_multiple_blobs_response_multiple_preserves_ids() {
		let mut data = Vec::new();
		data.extend_from_slice(&3i32.to_be_bytes());
		data.extend_from_slice(&make_blob_entry([0u8; 9], b"first"));
		data.extend_from_slice(&make_blob_entry([0xFFu8; 9], b"second is bigger"));
		data.extend_from_slice(&make_blob_entry([0x42u8; 9], &vec![0xAB; 1024]));
		let result = parse_multiple_blobs_response(&data).unwrap();
		assert_eq!(result.len(), 3);
		assert_eq!(
			result.get(&GeneratedId(BASE64_EXT.encode([0u8; 9]))).unwrap().as_slice(),
			b"first"
		);
		assert_eq!(
			result.get(&GeneratedId(BASE64_EXT.encode([0xFFu8; 9]))).unwrap().as_slice(),
			b"second is bigger"
		);
		assert_eq!(
			result.get(&GeneratedId(BASE64_EXT.encode([0x42u8; 9]))).unwrap().len(),
			1024
		);
	}

	#[test]
	fn parse_multiple_blobs_response_rejects_short_buffer() {
		let err = parse_multiple_blobs_response(&[0u8, 0, 0]).unwrap_err();
		assert!(format!("{err}").contains("too short"));
	}

	#[test]
	fn parse_multiple_blobs_response_rejects_truncated_entry() {
		let mut data = Vec::new();
		data.extend_from_slice(&1i32.to_be_bytes());
		data.extend_from_slice(&[0u8; 9]); // blob id
		data.extend_from_slice(&[0u8; 6]); // hash
		data.extend_from_slice(&100i32.to_be_bytes()); // declares 100 bytes…
		data.extend_from_slice(&[0u8; 10]); // …but only 10 are there
		let err = parse_multiple_blobs_response(&data).unwrap_err();
		assert!(format!("{err}").contains("truncated"));
	}

	#[test]
	fn parse_multiple_blobs_response_rejects_negative_count() {
		let mut data = Vec::new();
		data.extend_from_slice(&(-5i32).to_be_bytes());
		let err = parse_multiple_blobs_response(&data).unwrap_err();
		assert!(format!("{err}").contains("Invalid blob count"));
	}

	#[test]
	fn chunk_data_works() {
		const CHUNK_SIZE: usize = 1024;
		assert_eq!(1, chunk_data(&[], CHUNK_SIZE).len());
		assert_eq!(1, chunk_data(&[1u8; 100], CHUNK_SIZE).len());
		assert_eq!(1, chunk_data(&[0u8; CHUNK_SIZE], CHUNK_SIZE).len());
		assert_eq!(2, chunk_data(&[5u8; CHUNK_SIZE + 1], CHUNK_SIZE).len());
		assert_eq!(3, chunk_data(&[3u8; CHUNK_SIZE * 2 + 1], CHUNK_SIZE).len());
		assert_eq!(1, chunk_data(&[0u8; 105], CHUNK_SIZE).len());
		assert_eq!(1, chunk_data(&[0u8; 2], CHUNK_SIZE).len());
		assert_eq!(1, chunk_data(&[0u8; 1], CHUNK_SIZE).len());
	}
}
