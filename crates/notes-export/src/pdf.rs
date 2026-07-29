mod layout;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::Path;

use image::codecs::{gif::GifDecoder, webp::WebPDecoder};
use image::{AnimationDecoder, RgbaImage};
use notes_application::{
    ExportError, ExportNode, ExportSnapshot, MAX_PDF_IMAGE_WORKING_BYTES, RenderedExport,
};
use printpdf::{
    Color, DictItem, FontId, Greyscale, Mm, Op, ParsedFont, PdfDocument, PdfFontHandle, PdfPage,
    PdfParseErrorSeverity, PdfSaveOptions, Point, Pt, RawImage, RawImageData, RawImageFormat,
    TextItem, XObject, XObjectId, XObjectTransform,
};

use self::layout::{
    PDF_PAGE_HEIGHT_MM, PDF_PAGE_WIDTH_MM, PdfPageDraft, PdfPlacedElement, PdfPlacedImage,
    PdfPlacedLine, PdfTextTone, build_pages,
};

const PDF_DOCUMENT_VERSION: &str = "1.5";
const DECODER_BYTES_PER_PIXEL: u64 = 16;
const RETAINED_RGBA_BYTES_PER_PIXEL: u64 = 4;
const MAX_SERIALIZED_PDF_BYTES: usize = MAX_PDF_IMAGE_WORKING_BYTES as usize + 64 * 1024 * 1024;

pub(crate) fn render(
    snapshot: &ExportSnapshot,
    font_path: &Path,
) -> Result<RenderedExport, ExportError> {
    validate_working_budget(&snapshot.root)?;
    let font_bytes = fs::read(font_path).map_err(|error| {
        ExportError::Failed(format!("Could not read the bundled PDF font: {error}"))
    })?;
    let mut font_warnings = Vec::new();
    let font = ParsedFont::from_bytes(&font_bytes, 0, &mut font_warnings).ok_or_else(|| {
        ExportError::Failed(format!(
            "Bundled PDF font could not be parsed: {font_warnings:?}"
        ))
    })?;
    let page_drafts = build_pages(&font, snapshot)?;
    let expected_page_count = page_drafts.len();
    let mut document = PdfDocument::new(&snapshot.title);
    let font_id = document.add_font(&font);
    let mut image_ids = HashMap::new();
    let pages = page_drafts
        .into_iter()
        .map(|page| build_page(&mut document, &font_id, &mut image_ids, page))
        .collect::<Result<Vec<_>, _>>()?;
    document.with_pages(pages);

    let mut save_warnings = Vec::new();
    let mut serialized = document.to_lopdf_document(&PdfSaveOptions::default(), &mut save_warnings);
    serialized.version = PDF_DOCUMENT_VERSION.into();
    let mut bytes = Vec::new();
    serialized.save_to(&mut bytes).map_err(|error| {
        ExportError::Failed(format!("Could not serialize the Notes PDF: {error}"))
    })?;
    if save_warnings
        .iter()
        .any(|warning| warning.severity == PdfParseErrorSeverity::Error)
    {
        return Err(ExportError::Failed(format!(
            "PDF serialization reported errors: {save_warnings:?}"
        )));
    }
    validate_serialized(&bytes, expected_page_count)?;
    Ok(RenderedExport::Pdf { document: bytes })
}

fn build_page(
    document: &mut PdfDocument,
    font_id: &FontId,
    image_ids: &mut HashMap<String, XObjectId>,
    page: PdfPageDraft,
) -> Result<PdfPage, ExportError> {
    let mut operations = Vec::new();
    for element in &page.elements {
        match element {
            PdfPlacedElement::Line(index) => {
                append_text(&mut operations, font_id, &page.lines[*index]);
            }
            PdfPlacedElement::Image(index) => {
                append_image(document, &mut operations, image_ids, &page.images[*index])?;
            }
        }
    }
    Ok(PdfPage::new(
        Mm(PDF_PAGE_WIDTH_MM),
        Mm(PDF_PAGE_HEIGHT_MM),
        operations,
    ))
}

fn append_text(operations: &mut Vec<Op>, font_id: &FontId, line: &PdfPlacedLine) {
    let grey = match line.tone {
        PdfTextTone::Primary => 0.12,
        PdfTextTone::Supporting => 0.48,
    };
    operations.extend([
        Op::StartTextSection,
        Op::SetTextCursor {
            pos: Point {
                x: Pt(line.x),
                y: Pt(line.y),
            },
        },
        Op::SetFont {
            font: PdfFontHandle::External(font_id.clone()),
            size: Pt(line.size),
        },
        Op::SetLineHeight {
            lh: Pt(line.line_height),
        },
        Op::SetFillColor {
            col: Color::Greyscale(Greyscale::new(grey, None)),
        },
        Op::ShowText {
            items: vec![TextItem::Text(line.text.clone())],
        },
        Op::EndTextSection,
    ]);
}

fn append_image(
    document: &mut PdfDocument,
    operations: &mut Vec<Op>,
    image_ids: &mut HashMap<String, XObjectId>,
    image: &PdfPlacedImage,
) -> Result<(), ExportError> {
    let image_id = if let Some(existing) = image_ids.get(&image.content_hash) {
        existing.clone()
    } else {
        let rgba = decode_rgba(&image.bytes, &image.mime_type)?;
        if rgba.width() != image.intrinsic_width || rgba.height() != image.intrinsic_height {
            return Err(ExportError::Failed(
                "A PDF image no longer matches its snapshot dimensions.".into(),
            ));
        }
        let raw = RawImage {
            pixels: RawImageData::U8(rgba.into_raw()),
            width: image.intrinsic_width as usize,
            height: image.intrinsic_height as usize,
            data_format: RawImageFormat::RGBA8,
            tag: image.content_hash.as_bytes().to_vec(),
        };
        let image_id = XObjectId::new();
        document
            .resources
            .xobjects
            .map
            .insert(image_id.clone(), XObject::Image(raw));
        image_ids.insert(image.content_hash.clone(), image_id.clone());
        image_id
    };
    let alt = DictItem::Dict {
        map: BTreeMap::from([(
            "Alt".into(),
            DictItem::from_lopdf(&lopdf::text_string(&image.original_name)),
        )]),
    };
    operations.push(Op::BeginMarkedContentWithProperties {
        tag: "Span".into(),
        properties: alt,
    });
    operations.push(Op::UseXobject {
        id: image_id,
        transform: XObjectTransform {
            translate_x: Some(Pt(image.x)),
            translate_y: Some(Pt(image.y)),
            scale_x: Some(image.width / image.intrinsic_width as f32),
            scale_y: Some(image.height / image.intrinsic_height as f32),
            dpi: Some(72.0),
            ..XObjectTransform::default()
        },
    });
    operations.push(Op::EndMarkedContent);
    Ok(())
}

fn validate_working_budget(root: &ExportNode) -> Result<(), ExportError> {
    fn visit(
        node: &ExportNode,
        hashes: &mut HashSet<String>,
        working_bytes: &mut u64,
    ) -> Result<(), ExportError> {
        if let Some(image) = &node.image
            && hashes.insert(image.metadata.content_hash().into())
        {
            let bytes = image
                .bytes
                .as_ref()
                .ok_or_else(|| ExportError::Failed("PDF image bytes were not hydrated.".into()))?;
            if bytes.len() as u64 != image.metadata.byte_length() {
                return Err(ExportError::Failed(
                    "PDF image bytes do not match their snapshot metadata.".into(),
                ));
            }
            let pixels = u64::from(image.metadata.pixel_width())
                .checked_mul(u64::from(image.metadata.pixel_height()))
                .ok_or_else(|| ExportError::TooLarge("PDF image dimensions overflowed.".into()))?;
            let decoded = pixels
                .checked_mul(DECODER_BYTES_PER_PIXEL + RETAINED_RGBA_BYTES_PER_PIXEL)
                .ok_or_else(|| ExportError::TooLarge("PDF image memory overflowed.".into()))?;
            *working_bytes = working_bytes
                .checked_add(image.metadata.byte_length())
                .and_then(|value| value.checked_add(decoded))
                .ok_or_else(|| ExportError::TooLarge("PDF image memory overflowed.".into()))?;
            if *working_bytes > MAX_PDF_IMAGE_WORKING_BYTES {
                return Err(ExportError::TooLarge(
                    "PDF image working memory exceeds the 256 MiB limit.".into(),
                ));
            }
        }
        for child in &node.children {
            visit(child, hashes, working_bytes)?;
        }
        Ok(())
    }
    visit(root, &mut HashSet::new(), &mut 0)
}

fn decode_rgba(bytes: &[u8], mime_type: &str) -> Result<RgbaImage, ExportError> {
    let first_frame = |mut frames: image::Frames<'_>, format: &str| {
        frames
            .next()
            .ok_or_else(|| ExportError::Failed(format!("PDF {format} image contains no frames.")))?
            .map(|frame| frame.into_buffer())
            .map_err(|error| {
                ExportError::Failed(format!("Could not decode PDF {format} image: {error}"))
            })
    };
    match mime_type {
        "image/gif" => {
            let decoder = GifDecoder::new(Cursor::new(bytes)).map_err(|error| {
                ExportError::Failed(format!("Could not open PDF GIF image: {error}"))
            })?;
            first_frame(decoder.into_frames(), "GIF")
        }
        "image/webp" => {
            let decoder = WebPDecoder::new(Cursor::new(bytes)).map_err(|error| {
                ExportError::Failed(format!("Could not open PDF WebP image: {error}"))
            })?;
            if decoder.has_animation() {
                first_frame(decoder.into_frames(), "WebP")
            } else {
                image::load_from_memory(bytes)
                    .map(|decoded| decoded.into_rgba8())
                    .map_err(|error| {
                        ExportError::Failed(format!("Could not decode PDF WebP image: {error}"))
                    })
            }
        }
        "image/png" | "image/jpeg" => image::load_from_memory(bytes)
            .map(|decoded| decoded.into_rgba8())
            .map_err(|error| ExportError::Failed(format!("Could not decode PDF image: {error}"))),
        _ => Err(ExportError::Failed(
            "A PDF image has an unsupported MIME type.".into(),
        )),
    }
}

fn validate_serialized(bytes: &[u8], page_count: usize) -> Result<(), ExportError> {
    let trimmed_end = bytes
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map_or(&[][..], |last| &bytes[..=last]);
    if bytes.len() > MAX_SERIALIZED_PDF_BYTES
        || !bytes.starts_with(b"%PDF-")
        || !trimmed_end.ends_with(b"%%EOF")
    {
        return Err(invalid_pdf());
    }
    let parsed = lopdf::Document::load_mem(bytes).map_err(|error| {
        ExportError::Failed(format!("Generated PDF could not be parsed: {error}"))
    })?;

    let root_id = parsed
        .trailer
        .get(b"Root")
        .and_then(lopdf::Object::as_reference)
        .map_err(|_| invalid_pdf())?;
    let catalog = parsed.get_dictionary(root_id).map_err(|_| invalid_pdf())?;
    if !catalog.has_type(b"Catalog") {
        return Err(invalid_pdf());
    }
    let pages_id = catalog
        .get(b"Pages")
        .and_then(lopdf::Object::as_reference)
        .map_err(|_| invalid_pdf())?;
    let page_tree = parsed.get_dictionary(pages_id).map_err(|_| invalid_pdf())?;
    let declared_pages = page_tree
        .get(b"Count")
        .and_then(lopdf::Object::as_i64)
        .ok()
        .and_then(|count| usize::try_from(count).ok())
        .ok_or_else(invalid_pdf)?;
    let pages = parsed.get_pages();
    if declared_pages != page_count || pages.len() != page_count {
        return Err(invalid_pdf());
    }
    for page_id in pages.values() {
        if !parsed
            .get_dictionary(*page_id)
            .is_ok_and(|page| page.has_type(b"Page"))
        {
            return Err(invalid_pdf());
        }
    }

    let mut type0_fonts = 0_usize;
    let mut embedded_font = false;
    let mut stream_bytes = 0_usize;
    for object in parsed.objects.values() {
        let dictionary = match object {
            lopdf::Object::Dictionary(dictionary) => Some(dictionary),
            lopdf::Object::Stream(stream) => {
                if stream.content.len() > MAX_PDF_IMAGE_WORKING_BYTES as usize {
                    return Err(invalid_pdf());
                }
                stream_bytes = stream_bytes
                    .checked_add(stream.content.len())
                    .ok_or_else(invalid_pdf)?;
                Some(&stream.dict)
            }
            _ => None,
        };
        let Some(dictionary) = dictionary else {
            continue;
        };
        if dictionary.has_type(b"Font")
            && dictionary
                .get(b"Subtype")
                .and_then(lopdf::Object::as_name)
                .is_ok_and(|subtype| subtype == b"Type0")
        {
            type0_fonts += 1;
        }
        if dictionary.has_type(b"FontDescriptor") {
            for key in [b"FontFile2".as_slice(), b"FontFile3".as_slice()] {
                if let Ok(reference) = dictionary.get(key).and_then(lopdf::Object::as_reference)
                    && parsed
                        .get_object(reference)
                        .is_ok_and(|object| matches!(object, lopdf::Object::Stream(_)))
                {
                    embedded_font = true;
                }
            }
        }
    }
    if stream_bytes > MAX_SERIALIZED_PDF_BYTES || type0_fonts != 1 || !embedded_font {
        return Err(invalid_pdf());
    }
    Ok(())
}

fn invalid_pdf() -> ExportError {
    ExportError::Failed("PDF serialization returned an invalid document.".into())
}
