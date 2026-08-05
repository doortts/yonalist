use serde::{Deserialize, Serialize};

use crate::DomainError;

pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 40_000_000;
pub const MIN_IMAGE_DISPLAY_WIDTH: u32 = 120;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NoteImage {
    content_hash: String,
    relative_path: String,
    original_name: String,
    mime_type: String,
    byte_length: u64,
    pixel_width: u32,
    pixel_height: u32,
    display_width: u32,
}

impl NoteImage {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        content_hash: impl Into<String>,
        relative_path: impl Into<String>,
        original_name: impl Into<String>,
        mime_type: impl Into<String>,
        byte_length: u64,
        pixel_width: u32,
        pixel_height: u32,
        display_width: u32,
    ) -> Result<Self, DomainError> {
        let content_hash = content_hash.into();
        let relative_path = relative_path.into();
        let original_name = original_name.into();
        let mime_type = mime_type.into();
        if content_hash.len() != 64
            || !content_hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid_image("content hash must be lowercase SHA-256"));
        }
        let extension = extension_for_mime(&mime_type)
            .ok_or_else(|| invalid_image("image MIME type is unsupported"))?;
        if relative_path != format!("{content_hash}.{extension}") {
            return Err(invalid_image(
                "relative image path must be derived from its content hash",
            ));
        }
        if original_name.is_empty()
            || original_name.len() > 1_024
            || original_name.chars().any(char::is_control)
        {
            return Err(invalid_image("original image name is invalid"));
        }
        if !(1..=MAX_IMAGE_BYTES).contains(&byte_length) {
            return Err(invalid_image(
                "image byte length is outside the supported range",
            ));
        }
        let pixels = u64::from(pixel_width)
            .checked_mul(u64::from(pixel_height))
            .ok_or_else(|| invalid_image("decoded image pixel count overflowed"))?;
        if pixel_width == 0 || pixel_height == 0 || pixels > MAX_IMAGE_PIXELS {
            return Err(invalid_image(
                "decoded image dimensions are outside the supported range",
            ));
        }
        if display_width < MIN_IMAGE_DISPLAY_WIDTH {
            return Err(invalid_image("image display width is too small"));
        }
        Ok(Self {
            content_hash,
            relative_path,
            original_name,
            mime_type,
            byte_length,
            pixel_width,
            pixel_height,
            display_width,
        })
    }

    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    pub fn relative_path(&self) -> &str {
        &self.relative_path
    }

    pub fn original_name(&self) -> &str {
        &self.original_name
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub fn byte_length(&self) -> u64 {
        self.byte_length
    }

    pub fn pixel_width(&self) -> u32 {
        self.pixel_width
    }

    pub fn pixel_height(&self) -> u32 {
        self.pixel_height
    }

    pub fn display_width(&self) -> u32 {
        self.display_width
    }

    pub(crate) fn set_display_width(&mut self, display_width: u32) -> Result<(), DomainError> {
        if display_width < MIN_IMAGE_DISPLAY_WIDTH {
            return Err(invalid_image("image display width is too small"));
        }
        self.display_width = display_width;
        Ok(())
    }
}

fn extension_for_mime(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn invalid_image(message: impl Into<String>) -> DomainError {
    DomainError::InvalidImage(message.into())
}
