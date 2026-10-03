//! Interface-only Iroh boundary for LocalMesh.
//!
//! This crate deliberately has no Iroh dependency yet. It gives the scheduler
//! and artifact layers a typed capability gate while a separately configured
//! runtime owns endpoint discovery, authentication, encryption, and network
//! I/O.

#![forbid(unsafe_code)]

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IrohTransportCapability {
	EndpointDiscovery,
	AuthenticatedTransfer,
	BlobTransfer,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlobTransferRequest {
	pub content_sha256: String,
	pub size_bytes:     u64,
	pub target_node_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlobTransferReceipt {
	pub content_sha256: String,
	pub transfer_id:    String,
	pub accepted_at:    String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IrohTransportError {
	MissingCapabilities(Vec<IrohTransportCapability>),
	Transport(String),
}

impl fmt::Display for IrohTransportError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::MissingCapabilities(missing) => {
				write!(formatter, "Iroh transport missing capabilities: {missing:?}")
			},
			Self::Transport(message) => write!(formatter, "Iroh transport error: {message}"),
		}
	}
}

impl std::error::Error for IrohTransportError {}

/// Implemented by the host-owned Iroh runtime. This crate intentionally does
/// not open endpoints, manage keys, or perform a transfer itself.
pub trait IrohTransferClient {
	fn capabilities(&self) -> &[IrohTransportCapability];

	fn send_blob(
		&self,
		request: BlobTransferRequest,
	) -> Result<BlobTransferReceipt, IrohTransportError>;
}

pub const REQUIRED_BLOB_TRANSFER_CAPABILITIES: &[IrohTransportCapability] = &[
	IrohTransportCapability::EndpointDiscovery,
	IrohTransportCapability::AuthenticatedTransfer,
	IrohTransportCapability::BlobTransfer,
];

pub fn require_blob_transfer_capabilities(
	capabilities: &[IrohTransportCapability],
) -> Result<(), IrohTransportError> {
	let missing = REQUIRED_BLOB_TRANSFER_CAPABILITIES
		.iter()
		.copied()
		.filter(|required| !capabilities.contains(required))
		.collect::<Vec<_>>();
	if missing.is_empty() {
		Ok(())
	} else {
		Err(IrohTransportError::MissingCapabilities(missing))
	}
}

#[cfg(test)]
mod tests {
	use super::{IrohTransportCapability, IrohTransportError, require_blob_transfer_capabilities};

	#[test]
	fn fails_closed_without_authenticated_transfer() {
		let error = require_blob_transfer_capabilities(&[
			IrohTransportCapability::EndpointDiscovery,
			IrohTransportCapability::BlobTransfer,
		])
		.expect_err("missing authentication must block transfer");

		assert_eq!(
			error,
			IrohTransportError::MissingCapabilities(vec![
				IrohTransportCapability::AuthenticatedTransfer
			])
		);
	}
}
