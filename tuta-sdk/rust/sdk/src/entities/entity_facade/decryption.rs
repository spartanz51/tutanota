//! Attribute decryption follows the instance type and field paths used by CryptoMapper.
use crate::ApiCallError;
use crypto_primitives::aead_facade::{AeadFacade, AeadSubKeys};
use crypto_primitives::key::GenericAesKey;
use crypto_primitives::randomizer_facade::RandomizerFacade;
use std::cell::OnceCell;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CipherVersion {
	Legacy,
	GroupKey(u64),
	SessionKey,
}

/// Even-length ciphertexts have no version byte, including those starting with 2 or 3.
pub(crate) fn cipher_version(bytes: &[u8]) -> Result<CipherVersion, ApiCallError> {
	if bytes.len() % 2 == 0 {
		return Ok(CipherVersion::Legacy);
	}
	match bytes[0] {
		0 | 1 => Ok(CipherVersion::Legacy),
		2 => {
			if bytes.len() < 3 || bytes[1] != 0 {
				return Err(ApiCallError::internal(
					"Invalid AEAD group key version header".into(),
				));
			}
			Ok(CipherVersion::GroupKey(u64::from(bytes[2])))
		},
		3 => Ok(CipherVersion::SessionKey),
		_ => Err(ApiCallError::internal(
			"Unsupported symmetric cipher version".into(),
		)),
	}
}

pub(super) struct InstanceDecryptor<'a> {
	session_key: &'a GenericAesKey,
	instance_type: String,
	aead: AeadFacade,
	session_subkeys: OnceCell<AeadSubKeys>,
}

impl<'a> InstanceDecryptor<'a> {
	pub(super) fn new(
		session_key: &'a GenericAesKey,
		instance_type: String,
		randomizer: RandomizerFacade,
	) -> Self {
		Self {
			session_key,
			instance_type,
			aead: AeadFacade::new(randomizer),
			session_subkeys: OnceCell::new(),
		}
	}

	pub(super) fn decrypt(
		&self,
		ciphertext: &[u8],
		field_path: Option<&str>,
	) -> Result<Vec<u8>, ApiCallError> {
		match cipher_version(ciphertext)? {
			CipherVersion::Legacy => self
				.session_key
				.decrypt_data(ciphertext)
				.map_err(|e| ApiCallError::internal(e.to_string())),
			CipherVersion::SessionKey => {
				let GenericAesKey::Aes256(key) = self.session_key else {
					return Err(ApiCallError::internal(
						"AEAD session keys must be 256 bits".into(),
					));
				};
				let path = field_path.ok_or_else(|| {
					ApiCallError::internal("Missing aggregate ID for AEAD field path".into())
				})?;
				let keys = self
					.session_subkeys
					.get_or_init(|| AeadSubKeys::derive_from_session_key(key, &self.instance_type));
				self.aead
					.decrypt(
						keys,
						ciphertext,
						format!("attributeEncSK\u{001f}{path}").as_bytes(),
					)
					.map_err(|e| ApiCallError::internal(format!("AEAD session attribute: {e}")))
			},
			CipherVersion::GroupKey(_) => Err(ApiCallError::internal(
				"AEAD group key context is required".into(),
			)),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use base64::{prelude::BASE64_STANDARD, Engine};
	use crypto_primitives::aes::{Aes128Key, Aes256Key};
	use serde_json::Value;

	#[test]
	fn distinguishes_versions_without_misreading_legacy_ivs() {
		for first in [0, 1, 2, 3, 255] {
			assert_eq!(cipher_version(&[first; 32]).unwrap(), CipherVersion::Legacy);
		}
		assert_eq!(cipher_version(&[1; 65]).unwrap(), CipherVersion::Legacy);
		assert_eq!(cipher_version(&[3; 53]).unwrap(), CipherVersion::SessionKey);
		assert_eq!(
			cipher_version(&[2, 0, 7]).unwrap(),
			CipherVersion::GroupKey(7)
		);
		for bytes in [vec![2], vec![2, 1, 7], vec![255]] {
			assert!(cipher_version(&bytes).is_err());
		}
	}

	#[test]
	fn decrypts_official_ts_session_vectors_and_rejects_wrong_context() {
		let vectors: Vec<Value> = serde_json::from_str(include_str!(
			"../../../tests/fixtures/aead_attributes_ts.json"
		))
		.unwrap();
		for vector in vectors.iter().filter(|v| v["version"] == 3) {
			let key = GenericAesKey::from_bytes(
				&BASE64_STANDARD
					.decode(vector["key"].as_str().unwrap())
					.unwrap(),
			)
			.unwrap();
			let ciphertext = BASE64_STANDARD
				.decode(vector["ciphertext"].as_str().unwrap())
				.unwrap();
			let decryptor = InstanceDecryptor::new(
				&key,
				"tutanota/97".into(),
				RandomizerFacade::from_core(rand_core::OsRng),
			);
			assert_eq!(
				decryptor
					.decrypt(&ciphertext, vector["path"].as_str())
					.unwrap(),
				vector["plaintext"].as_str().unwrap().as_bytes()
			);
			assert!(decryptor.decrypt(&ciphertext, Some("wrong")).is_err());
			assert!(decryptor.decrypt(&ciphertext, None).is_err());
			let wrong_type = InstanceDecryptor::new(
				&key,
				"tutanota/98".into(),
				RandomizerFacade::from_core(rand_core::OsRng),
			);
			assert!(wrong_type
				.decrypt(&ciphertext, vector["path"].as_str())
				.is_err());
			let mut corrupt = ciphertext.clone();
			*corrupt.last_mut().unwrap() ^= 1;
			assert!(decryptor
				.decrypt(&corrupt, vector["path"].as_str())
				.is_err());
		}
	}

	#[test]
	fn malformed_aead_and_128_bit_session_keys_fail_without_fallback() {
		let short_key = GenericAesKey::Aes128(Aes128Key::from_bytes(&[0x11; 16]).unwrap());
		let decryptor = InstanceDecryptor::new(
			&short_key,
			"tutanota/97".into(),
			RandomizerFacade::from_core(rand_core::OsRng),
		);
		assert!(decryptor
			.decrypt(&[3; 53], Some("105"))
			.unwrap_err()
			.to_string()
			.contains("256 bits"));
		let key = GenericAesKey::Aes256(Aes256Key::from_bytes(&[0x11; 32]).unwrap());
		let decryptor = InstanceDecryptor::new(
			&key,
			"tutanota/97".into(),
			RandomizerFacade::from_core(rand_core::OsRng),
		);
		for len in [1, 3, 17, 31, 49] {
			assert!(decryptor.decrypt(&vec![3; len], Some("105")).is_err());
		}
	}
}
